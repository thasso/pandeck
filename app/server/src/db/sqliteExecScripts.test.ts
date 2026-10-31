/**
 * `DatabaseSync.exec` runs a script as Node does: the first failing statement
 * throws and nothing after it runs, empty statements and comment remainders
 * are skipped, and statements are split where SQLite splits them. Under Bun,
 * the suite's `node:sqlite` alias puts the adapter in Node's place
 * (`docs/deployment.md`, "Running the server suite under Bun"), and the
 * adapter's two refusals are checked too. On Node:
 *   pnpm --filter @assistant/server test src/db/sqliteExecScripts.test.ts
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import {
  EXEC_PARITY_CASES,
  EXEC_REFUSAL_CASES,
  execCaseProblem,
} from "./sqliteExecCases.ts";

const open = () => new DatabaseSync(":memory:");

describe("exec runs a script as Node does", () => {
  test.each(EXEC_PARITY_CASES)("$name", (execCase) => {
    expect(execCaseProblem(open, execCase)).toBeUndefined();
  });
});

// Node may run these; the Bun adapter refuses each before running anything.
describe.runIf(process.versions.bun)("the Bun adapter's exec refusals", () => {
  test.each(EXEC_REFUSAL_CASES)("$name", (execCase) => {
    expect(execCaseProblem(open, execCase)).toBeUndefined();
  });
});
