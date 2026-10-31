import { Database } from "bun:sqlite";

/**
 * The subset of Node's synchronous SQLite API used by the server. Bun's
 * statements already expose the same prepare/get/all/run/iterate contract;
 * only the constructor option spelling, the transaction flag and the
 * DatabaseSync class name differ.
 *
 * Anything else Node offers is refused loudly rather than read as `undefined`:
 * a missing `isTransaction` once made every nested transaction look like none.
 *
 * `exec` keeps Node's contract: statements run in order and the first one
 * that fails throws, with none after it run and the caller's transaction left
 * to the caller. It differs from Node in two loud refusals: a script holding
 * U+000B or U+FEFF anywhere, and a statement with parameters.
 */
const DATABASE_OPTIONS = new Set(["readOnly", "enableForeignKeyConstraints"]);
const DATABASE_MEMBERS = new Set(["prepare", "exec", "close", "isTransaction"]);
const STATEMENT_METHODS = new Set(["all", "get", "run", "iterate"]);

function unsupported(member) {
  return new TypeError(
    `node:sqlite ${member} is not supported by the Bun SQLite adapter.`,
  );
}

/** The named-parameter grammar the adapter supports. */
const SUPPORTED_NAME = /^[:$@][A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The named parameters `sql` declares, as written (`:x`, `$x`, `@x`), found
 * outside string literals, quoted identifiers and comments. Each token is
 * taken as SQLite delimits it, embedded `$`, a `$name::suffix` and a trailing
 * `(…)` included. Like SQLite's tokenizer, every non-ASCII code point is part
 * of the name, combining marks included. One outside {@link SUPPORTED_NAME}
 * (those forms, or a non-ASCII name) is refused rather than recorded as a
 * shorter name that would misreport every bind.
 */
function declaredNames(sql) {
  const names = new Set();
  const token =
    /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|([:$@](?:[A-Za-z0-9_$\u0080-\u{10FFFF}]|::)+(?:\([^)]*\))?)/gu;
  for (const match of sql.matchAll(token)) {
    const name = match[1];
    if (!name) continue;
    if (!SUPPORTED_NAME.test(name))
      throw new TypeError(
        `Unsupported named parameter syntax "${name}": the Bun SQLite adapter binds only [:$@] followed by an ASCII identifier.`,
      );
    names.add(name);
  }
  return names;
}

/**
 * Node's named-parameter rules, which Bun would otherwise loosen: a bare name
 * is refused here (Node would match it to any prefix, Bun to none, so it would
 * silently bind NULL), and a name the statement does not declare is Node's
 * "Unknown named parameter" rather than Bun's silent NULL.
 */
function checkNamedParameters(parameters, declared) {
  for (const parameter of parameters) {
    if (
      parameter === null ||
      typeof parameter !== "object" ||
      Array.isArray(parameter) ||
      ArrayBuffer.isView(parameter)
    )
      continue;
    for (const name of Object.keys(parameter)) {
      if (!/^[$:@]/.test(name))
        throw new TypeError(
          `Bare named parameter "${name}" is not supported by the Bun SQLite adapter.`,
        );
      if (!declared().has(name))
        throw new Error(`Unknown named parameter '${name}'`);
    }
  }
}

/**
 * Bun reads integers as bigints (`safeIntegers`) so that one past 2^53 can be
 * refused as Node refuses it without `readBigInts`, instead of rounded.
 */
function toNumber(value) {
  if (typeof value !== "bigint") return value;
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new RangeError(
      `Value is too large to be represented as a JavaScript number: ${value}`,
    );
  return Number(value);
}

function toNumbers(row) {
  if (row === null || row === undefined) return undefined;
  for (const key in row)
    if (typeof row[key] === "bigint") row[key] = toNumber(row[key]);
  return row;
}

function* numberRows(rows) {
  for (const row of rows) yield toNumbers(row);
}

/*
 * The statements of an `exec` script, split as SQLite 3.53.2 splits them:
 * `sqlite3_complete`'s state machine (complete.c) finds where a statement
 * ends, triggers' inner `;` included, and between statements the whitespace,
 * comments and empty statements `sqlite3_exec` (legacy.c) skips are dropped.
 *
 * complete.c and the tokenizer (tokenize.c) disagree on exactly two
 * characters, U+FEFF and U+000B, and `exec` refuses both before splitting.
 * Without them, whitespace is [ \t\n\f\r] everywhere, so one drop rule serves
 * every position. A `/*` with nothing after it is not a comment: the tokenizer
 * reads `/` and `*`, a syntax error. A piece is never trimmed, so SQLite
 * compiles each byte of it; `exec` refuses any piece SQLite reads differently.
 */
const SEMI = 0;
const WS = 1;
const OTHER = 2;
const EXPLAIN = 3;
const CREATE = 4;
const TEMP = 5;
const TRIGGER = 6;
const END = 7;
const START = 1;
const KEYWORDS = new Map([
  ["explain", EXPLAIN],
  ["create", CREATE],
  ["temp", TEMP],
  ["temporary", TEMP],
  ["trigger", TRIGGER],
  ["end", END],
]);
/** complete.c's `trans[state][token]`. */
const TRANSITIONS = [
  /* INVALID */ [1, 0, 2, 3, 4, 2, 2, 2],
  /* START   */ [1, 1, 2, 3, 4, 2, 2, 2],
  /* NORMAL  */ [1, 2, 2, 2, 2, 2, 2, 2],
  /* EXPLAIN */ [1, 3, 3, 2, 4, 2, 2, 2],
  /* CREATE  */ [1, 4, 2, 2, 2, 4, 5, 2],
  /* TRIGGER */ [6, 5, 5, 5, 5, 5, 5, 5],
  /* SEMI    */ [6, 6, 5, 5, 5, 5, 5, 7],
  /* END     */ [1, 7, 5, 5, 5, 5, 5, 5],
];
const QUOTE_CLOSE = { "'": "'", '"': '"', "`": "`", "[": "]" };

function isSpace(char) {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\f" ||
    char === "\r"
  );
}

function isWordUnit(char) {
  return /[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) >= 0x80;
}

/** The kind of the token at `start` and the index just past it. */
function scriptToken(sql, start) {
  const char = sql[start];
  if (isSpace(char)) {
    let end = start + 1;
    while (end < sql.length && isSpace(sql[end])) end += 1;
    return [WS, end];
  }
  if (char === "-" && sql[start + 1] === "-") {
    const newline = sql.indexOf("\n", start + 2);
    return [WS, newline === -1 ? sql.length : newline];
  }
  if (char === "/" && sql[start + 1] === "*" && start + 2 < sql.length) {
    const close = sql.indexOf("*/", start + 2);
    return [WS, close === -1 ? sql.length : close + 2];
  }
  if (char === ";") return [SEMI, start + 1];
  const quote = QUOTE_CLOSE[char];
  if (quote) {
    const close = sql.indexOf(quote, start + 1);
    return [OTHER, close === -1 ? sql.length : close + 1];
  }
  if (isWordUnit(char)) {
    let end = start + 1;
    while (end < sql.length && isWordUnit(sql[end])) end += 1;
    const word = sql.slice(start, end);
    return [
      (/^[A-Za-z]+$/.test(word) && KEYWORDS.get(word.toLowerCase())) || OTHER,
      end,
    ];
  }
  return [OTHER, start + 1];
}

function* scriptStatements(sql) {
  let start = 0;
  while (start < sql.length) {
    const [kind, next] = scriptToken(sql, start);
    if (kind === WS || kind === SEMI) {
      start = next;
      continue;
    }
    let state = START;
    let end = start;
    do {
      const [token, after] = scriptToken(sql, end);
      state = TRANSITIONS[state][token];
      end = after;
      if (token === SEMI && state === START) break;
    } while (end < sql.length);
    yield sql.slice(start, end);
    start = end;
  }
}

export class DatabaseSync {
  #database;
  #counts;

  constructor(location, options = {}) {
    for (const option of Object.keys(options))
      if (!DATABASE_OPTIONS.has(option))
        throw unsupported(`DatabaseSync option "${option}"`);
    this.#database = new Database(location, {
      ...(options.readOnly ? { readonly: true } : {}),
      safeIntegers: true,
    });
    this.#database.exec(
      options.enableForeignKeyConstraints === false
        ? "PRAGMA foreign_keys = OFF"
        : "PRAGMA foreign_keys = ON",
    );
    // Members run against the target: a private field is not reachable
    // through the proxy.
    return new Proxy(this, {
      get(target, property) {
        if (
          typeof property === "string" &&
          property !== "then" &&
          !DATABASE_MEMBERS.has(property) &&
          !Object.hasOwn(target, property)
        )
          throw unsupported(`DatabaseSync.${property}`);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  get isTransaction() {
    return this.#database.inTransaction;
  }

  prepare(sql) {
    const statement = this.#database.prepare(sql);
    const counts = () =>
      (this.#counts ??= this.#database.prepare(
        "SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid",
      ));
    let names;
    const declared = () => (names ??= declaredNames(sql));
    return new Proxy(statement, {
      get(target, property) {
        if (typeof property !== "string" || property === "then")
          return Reflect.get(target, property, target);
        if (!STATEMENT_METHODS.has(property))
          throw unsupported(`StatementSync.${property}`);
        return (...parameters) => {
          checkNamedParameters(parameters, declared);
          const result = target[property](...parameters);
          switch (property) {
            // Bun counts the rows foreign-key actions and triggers changed as
            // well; Node reports sqlite3_changes(), the statement's own rows.
            case "run":
              return toNumbers(counts().get());
            case "get":
              return toNumbers(result);
            case "all":
              for (const row of result) toNumbers(row);
              return result;
            // STATEMENT_METHODS admits nothing else. Lazy like Node's
            // iterator, and a generator carries the same Iterator helpers.
            case "iterate":
              return numberRows(result);
          }
        };
      },
    });
  }

  /**
   * bun:sqlite's own `exec` goes on past a non-final statement's step error,
   * a trigger's `RAISE(ABORT)` included, and rejects the empty statements and
   * comment-only remainders Node skips. So each statement is run on its own,
   * and only once SQLite has compiled exactly that text as one statement.
   */
  exec(sql) {
    if (sql.includes("\u000B") || sql.includes("﻿"))
      throw new TypeError(
        "node:sqlite exec() of a script containing U+000B or U+FEFF is not supported by the Bun SQLite adapter.",
      );
    for (const piece of scriptStatements(sql)) {
      const statement = this.#database.prepare(piece);
      let parameters;
      let text;
      try {
        parameters = statement.paramsCount;
        text = statement.toString();
      } finally {
        statement.finalize();
      }
      if (parameters !== 0)
        throw new TypeError(
          "node:sqlite exec() of a statement with parameters is not supported by the Bun SQLite adapter.",
        );
      if (text !== piece)
        throw new Error(
          `The Bun SQLite adapter's exec() split a script where SQLite read a different statement boundary, at ${JSON.stringify(piece.slice(0, 80))}.`,
        );
      this.#database.exec(piece);
    }
  }

  close() {
    this.#database.close();
  }
}
