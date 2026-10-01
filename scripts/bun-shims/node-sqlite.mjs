import { Database } from "bun:sqlite";

/**
 * The subset of Node's synchronous SQLite API used by the server. Bun's
 * statements already expose the same prepare/get/all/run/iterate contract;
 * only the constructor option spelling, the transaction flag and the
 * DatabaseSync class name differ.
 *
 * Anything else Node offers is refused loudly rather than read as `undefined`:
 * a missing `isTransaction` once made every nested transaction look like none.
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

  exec(sql) {
    // Node accepts a comments-only script as a no-op. Bun reports SQLITE_MISUSE.
    if (!sql.replace(/^\s*--.*$/gm, "").trim()) return;
    this.#database.exec(sql);
  }

  close() {
    this.#database.close();
  }
}
