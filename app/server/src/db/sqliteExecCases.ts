/**
 * `DatabaseSync.exec` scripts with the outcome Node gives them, shared by
 * `sqliteExecScripts.test.ts` (Node, and the Bun SQLite adapter under the
 * suite's alias) and the packaged install check
 * (`scripts/test-bun-server-bundle.mjs`), which drives the adapter directly.
 *
 * Every case starts on a fresh fixture: `t` holds 1, 2 and 3, `uniq` holds 1,
 * and `guard_refuses` aborts an insert of 0 into `guard` with `refused`. Node
 * is the oracle (Experiments X1/X2 of Task-1232, measured from an empty `t`
 * for X1, so its counts here are 3 higher).
 */
import type { DatabaseSync } from "node:sqlite";

/** What a script left behind: row counts, temp objects, the transaction. */
interface ExecState {
  guard: number;
  tail: number;
  t: number;
  uniq: number[];
  temp: string[];
  inTransaction: boolean;
}

interface ExecCase {
  name: string;
  sql: string;
  /** Run `BEGIN IMMEDIATE` first; the transaction stays open around the script. */
  inTransaction?: boolean;
  /**
   * A substring of the message thrown, `true` where the runtimes word it
   * differently, or absent when `exec` returns `undefined`.
   */
  throws?: string | true;
  /** Fields of the state the script must leave; `unchanged` is every field. */
  expect: Partial<ExecState> | "unchanged";
}

const FIXTURE = [
  "CREATE TABLE guard(x)",
  "CREATE TABLE tail(x)",
  "CREATE TABLE t(x)",
  "CREATE TABLE uniq(x INTEGER UNIQUE)",
  "CREATE TABLE checked(x CHECK (x > 0))",
  "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
  "CREATE TABLE child(parent_id REFERENCES parent(id))",
  "CREATE TRIGGER guard_refuses BEFORE INSERT ON guard WHEN NEW.x = 0 BEGIN SELECT RAISE(ABORT, 'refused'); END",
  "INSERT INTO uniq VALUES(1)",
  "INSERT INTO t VALUES(1), (2), (3)",
];

function count(db: DatabaseSync, table: string): number {
  return Number(
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
  );
}

function stateOf(db: DatabaseSync): ExecState {
  return {
    guard: count(db, "guard"),
    tail: count(db, "tail"),
    t: count(db, "t"),
    uniq: (
      db.prepare("SELECT x FROM uniq ORDER BY x").all() as Array<{ x: number }>
    ).map((row) => Number(row.x)),
    temp: (
      db
        .prepare("SELECT name FROM sqlite_temp_master ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
    inTransaction: db.isTransaction,
  };
}

/** Each failure, non-final and followed by an insert that must not run. */
const STEP_FAILURES: Array<[string, string, string | true]> = [
  ["trigger RAISE(ABORT)", "INSERT INTO guard VALUES(0)", "refused"],
  ["CHECK", "INSERT INTO checked VALUES(0)", true],
  ["UNIQUE", "INSERT INTO uniq VALUES(1)", "UNIQUE constraint failed"],
  ["foreign key", "INSERT INTO child VALUES(99)", true],
];

/** Migration 0097's guard: a TEMP table, a TEMP trigger, a guard INSERT. */
const GUARD_0097 = `
CREATE TEMP TABLE drop_guard (table_name TEXT NOT NULL, row_count INTEGER NOT NULL);
CREATE TEMP TRIGGER drop_guard_rows
BEFORE INSERT ON drop_guard
WHEN NEW.row_count > 0
BEGIN
  SELECT RAISE(ABORT, 'refused');
END;
INSERT INTO drop_guard (table_name, row_count) SELECT 't', count(*) FROM t;
DROP TABLE drop_guard;
INSERT INTO tail VALUES(1);
`;

export const EXEC_PARITY_CASES: ExecCase[] = [
  ...[false, true].flatMap((inTransaction) => [
    ...STEP_FAILURES.map(([what, failing, throws]): ExecCase => ({
      name: `a non-final ${what} failure${inTransaction ? " in a transaction" : ""} stops the script`,
      sql: `INSERT INTO t VALUES(4); ${failing}; INSERT INTO tail VALUES(1);`,
      inTransaction,
      throws,
      expect: { t: 4, tail: 0, uniq: [1], inTransaction },
    })),
    {
      name: `an 0097-shaped guard${inTransaction ? " in a transaction" : ""} refuses and leaves its trigger`,
      sql: GUARD_0097,
      inTransaction,
      throws: "refused",
      expect: {
        tail: 0,
        t: 3,
        temp: ["drop_guard", "drop_guard_rows"],
        inTransaction,
      },
    },
  ]),
  {
    name: "a single statement failing on a later row keeps the earlier rows out",
    sql: "INSERT INTO uniq SELECT v FROM (SELECT 2 AS v UNION ALL SELECT 1)",
    throws: "UNIQUE constraint failed",
    expect: { uniq: [1] },
  },

  // Empty statements (X1 E3).
  ...["", "  \n", ";", ";;", "/* c */;", "-- c\n;"].map((sql): ExecCase => ({
    name: `${JSON.stringify(sql)} is a no-op`,
    sql,
    expect: "unchanged",
  })),
  {
    name: "a leading empty statement",
    sql: "; INSERT INTO t VALUES(4);",
    expect: { t: 4 },
  },
  {
    name: "an intervening empty statement",
    sql: "INSERT INTO t VALUES(4);; INSERT INTO t VALUES(5);",
    expect: { t: 5 },
  },
  {
    name: "a trailing empty statement",
    sql: "INSERT INTO t VALUES(4);;",
    expect: { t: 4 },
  },
  {
    name: "comments around empty statements",
    sql: "INSERT INTO t VALUES(4); /* c */ ; -- d\n; INSERT INTO t VALUES(5)",
    expect: { t: 5 },
  },

  // Comments (X2): a `/*` with nothing after it is not one.
  { name: "a01 /*", sql: "/*", throws: "syntax error", expect: { t: 3 } },
  { name: "a02 /*x", sql: "/*x", expect: "unchanged" },
  {
    name: "a03 DELETE FROM t/*",
    sql: "DELETE FROM t/*",
    throws: "syntax error",
    expect: { t: 3 },
  },
  { name: "a04 DELETE FROM t/*x", sql: "DELETE FROM t/*x", expect: { t: 0 } },
  {
    name: "a05 DELETE FROM t; /*",
    sql: "DELETE FROM t; /*",
    throws: "syntax error",
    expect: { t: 0 },
  },
  {
    name: "a06 DELETE FROM t; /*x",
    sql: "DELETE FROM t; /*x",
    expect: { t: 0 },
  },
  {
    name: "a07 DELETE FROM t /*",
    sql: "DELETE FROM t /*",
    throws: "syntax error",
    expect: { t: 3 },
  },
  {
    name: "a12 a trailing line comment",
    sql: "INSERT INTO t VALUES(9) -- c",
    expect: { t: 4 },
  },
  {
    name: "a13 a trailing open block comment",
    sql: "INSERT INTO t VALUES(9) /* c",
    expect: { t: 4 },
  },
  {
    name: "a15 a trailing -",
    sql: "DELETE FROM t WHERE x = 1 -",
    throws: "incomplete input",
    expect: { t: 3 },
  },
  {
    name: "a16 a trailing /",
    sql: "DELETE FROM t WHERE x = 1 /",
    throws: "incomplete input",
    expect: { t: 3 },
  },

  // Splitting: statements stay whole.
  {
    name: "a mixed-case trigger with inner statements and CASE … END",
    sql: `cReAtE TeMpOrArY tRiGgEr ending AFTER INSERT ON guard BEGIN
  INSERT INTO tail SELECT CASE WHEN NEW.x > 0 THEN 1 ELSE 0 END AS created;
  INSERT INTO tail SELECT temp_x FROM (SELECT 2 AS temp_x, 3 AS triggers);
eNd;
INSERT INTO guard VALUES(5);`,
    expect: { guard: 1, tail: 2, temp: ["ending"] },
  },
  {
    name: "EXPLAIN CREATE TEMP TRIGGER creates nothing and the next statement runs",
    sql: "EXPLAIN CREATE TEMP TRIGGER explained AFTER INSERT ON guard BEGIN INSERT INTO tail VALUES(1); END; INSERT INTO guard VALUES(6);",
    expect: { guard: 1, tail: 0, temp: [] },
  },
  {
    name: "a ; inside strings and quoted identifiers",
    sql: "INSERT INTO t VALUES('a;b'); INSERT INTO t VALUES('it''s; -- x'); CREATE TEMP TABLE quoted(\"col;name\", [a;b], `c;d`); INSERT INTO quoted VALUES(1, 2, 3);",
    expect: { t: 5, temp: ["quoted"] },
  },
  {
    name: "a ; inside mid-script comments",
    sql: "INSERT INTO t VALUES(4); -- c ;\nINSERT INTO t /* ; */ VALUES(5);",
    expect: { t: 5 },
  },
  {
    name: "a final statement without ;",
    sql: "INSERT INTO t VALUES(4); INSERT INTO t VALUES(5)",
    expect: { t: 5 },
  },
  {
    name: "a trailing comment after the last ;",
    sql: "INSERT INTO t VALUES(4); -- done",
    expect: { t: 4 },
  },
];

const VT = "\u000B";
const BOM = "﻿";
const D = "DELETE FROM t";

/**
 * Scripts the Bun adapter refuses where Node may run them: each must throw
 * before anything runs, the earlier statements included.
 */
export const EXEC_REFUSAL_CASES: ExecCase[] = [
  ...[
    ["U+000B", VT],
    ["U+FEFF", BOM],
  ].flatMap(([label, x]) =>
    Object.entries({
      "at entry": `${x}${D}`,
      "after a comment": `/*c*/${x}${D}`,
      "after an empty statement": `;${x}${D}`,
      "after an executed statement": `${D} WHERE x = 1;${x}${D}`,
      "inside a trigger body": `CREATE TEMP TRIGGER g BEFORE INSERT ON guard BEGIN SELECT RAISE(ABORT,'refused');${x} END; INSERT INTO guard VALUES(1); ${D};`,
      "inside a string literal": `${D} WHERE x = '${x}'`,
    }).map(([position, sql]): ExecCase => ({
      name: `${label} ${position}`,
      sql,
      throws: "exec() of a script containing U+000B or U+FEFF",
      expect: "unchanged",
    })),
  ),
  ...Object.entries({
    X1_E2: `CREATE TEMP TRIGGER reject_guard BEFORE INSERT ON guard BEGIN SELECT RAISE(ABORT,'refused'); ${BOM} END; INSERT INTO guard VALUES(1); INSERT INTO tail VALUES(1);`,
    X1_E2b: `INSERT INTO t VALUES(1);${BOM}INSERT${BOM}INTO t VALUES(2);`,
    X1_E8: `SELECT${VT}1 AS v`,
    X2_a08: `${D} WHERE x = ${VT}1`,
    X2_a09: `${D} WHERE x =${VT}1`,
    X2_a10: `${D} WHERE x = 1;${VT}`,
    X2_a11: `${D} WHERE x = 1; ${VT}`,
    X2_a14: `${BOM}${BOM}${D} WHERE x = 1`,
    X2_b08: `${BOM}SELECT 1;`,
    X2_b09: `SELECT 1 ${VT};`,
    X3_c01: `${VT}${D}`,
    X3_c02: ` ${VT}${D}`,
    X3_c03: `/*c*/${VT}${D}`,
    X3_c04: `${BOM}${VT}${D}`,
    X3_c05: `-- c\n${VT}${D}`,
    X3_c06: `/*c*/ ${VT}${D}`,
    X3_c07: `;${VT}${D}`,
    X3_c08: `; ${VT}${D}`,
    X3_c09: `SELECT 1;${VT}${D}`,
    X3_c10: `SELECT 1;${VT}${VT} ${D}`,
    X3_c11: `SELECT 1; /*c*/${VT}${D}`,
    X3_c12: `SELECT 1;${VT}/*c*/${VT}${D}`,
    X3_c13: `SELECT 1;;${VT}${D}`,
    X3_c14: `SELECT 1; ${BOM}${VT}${D}`,
    X3_c15: `SELECT 1;${BOM} ${VT}${D}`,
    X3_c16: `SELECT 1;${VT}${BOM}${D}`,
    X3_c17: `${D} WHERE x = 1; /*c*/${VT}${D}`,
  }).map(([name, sql]): ExecCase => ({
    name,
    sql,
    throws: "exec() of a script containing U+000B or U+FEFF",
    expect: "unchanged",
  })),
  ...[
    "SELECT ? AS a",
    "INSERT INTO t VALUES(?)",
    "INSERT INTO t VALUES(:x)",
  ].map((sql): ExecCase => ({
    name: `parameters in ${sql}`,
    sql,
    throws: "exec() of a statement with parameters",
    expect: "unchanged",
  })),
];

/**
 * Run `execCase` on a fresh fixture from `open`, and describe how its outcome
 * differs from the expected one, or answer `undefined` when it matches.
 */
export function execCaseProblem(
  open: () => DatabaseSync,
  execCase: ExecCase,
): string | undefined {
  const db = open();
  try {
    for (const statement of FIXTURE) db.prepare(statement).run();
    if (execCase.inTransaction) db.exec("BEGIN IMMEDIATE");
    const before = stateOf(db);
    let thrown: string | undefined;
    let returned: unknown;
    try {
      returned = db.exec(execCase.sql);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    const after = stateOf(db);
    const expected = execCase.expect === "unchanged" ? before : execCase.expect;
    const problems: string[] = [];
    if (execCase.throws === undefined) {
      if (thrown !== undefined) problems.push(`threw ${thrown}`);
      else if (returned !== undefined)
        problems.push(`returned ${String(returned)}`);
    } else if (thrown === undefined) problems.push("did not throw");
    else if (
      typeof execCase.throws === "string" &&
      !thrown.includes(execCase.throws)
    )
      problems.push(`threw ${thrown}`);
    for (const [field, value] of Object.entries(expected))
      if (
        JSON.stringify(after[field as keyof ExecState]) !==
        JSON.stringify(value)
      )
        problems.push(
          `${field} is ${JSON.stringify(after[field as keyof ExecState])}, expected ${JSON.stringify(value)}`,
        );
    return problems.length > 0
      ? `${execCase.name}: ${problems.join("; ")}`
      : undefined;
  } finally {
    db.close();
  }
}
