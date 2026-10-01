/**
 * `pnpm run check:prompts` — hold the assembled prompt and the eager tool block
 * against the budgets in `config/prompt-budgets.json` (Task 288).
 *
 * Prints every persona/harness against every budgeted limit, then the findings.
 * Exits 1 on a breach, a stale size snapshot, or a malformed config; a limit at
 * the warn threshold prints and still exits 0.
 *
 *   pnpm run check:prompts             # the budget report
 *   pnpm run check:prompts -- --json   # rows and findings as JSON
 *
 * The same numbers are asserted by `promptBudgets.test.ts`, so `pnpm run test`
 * fails on a breach too. Update the snapshot with
 * `pnpm --filter @assistant/server test -u src/promptBudgets.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  budgetFindings,
  budgetRows,
  committedBaseline,
  loadPromptBudgets,
  measureForBudgets,
  num,
  relativeConfigPath,
  renderSizeSnapshot,
  type BudgetFinding,
  type BudgetRow,
} from "./promptBudgets.ts";
import { REPO_ROOT } from "./promptInventory.ts";

function reportTable(rows: BudgetRow[]): string[] {
  const label = (row: BudgetRow) =>
    `${row.agentType}/${row.harness} ${row.limit.label}`;
  const width = Math.max(...rows.map((row) => label(row).length));
  return rows.map((row) => {
    const mark =
      row.status === "over" ? "✗" : row.status === "warn" ? "!" : " ";
    return (
      `  ${mark} ${label(row).padEnd(width)}  ${num(row.chars).padStart(7)} / ` +
      `${num(row.budget).padStart(7)}  ${row.percent.toFixed(0).padStart(3)}%`
    );
  });
}

async function main(): Promise<void> {
  const config = loadPromptBudgets();
  const report = await measureForBudgets(config);
  const rows = budgetRows(config, report);

  // The snapshot is the review artifact for a size delta, so a stale one is a
  // failure of its own; growth is attributed against the COMMITTED sizes, which
  // the working tree's snapshot no longer holds once it has been regenerated.
  const snapshotFile = join(REPO_ROOT, config.snapshotPath);
  const expected = renderSizeSnapshot(config, report);
  let committed: string | undefined;
  try {
    committed = readFileSync(snapshotFile, "utf8");
  } catch {
    committed = undefined;
  }
  const findings: BudgetFinding[] = budgetFindings(
    config,
    rows,
    await committedBaseline(config),
  );
  if (committed !== expected)
    findings.push({
      level: "error",
      message:
        `${config.snapshotPath} is ${committed === undefined ? "missing" : "stale"}. Run ` +
        "`pnpm --filter @assistant/server test -u src/promptBudgets.test.ts` and review the delta.",
    });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ rows, findings }, null, 2));
  } else {
    console.log(
      `Prompt budgets in ${config.unit} (from ${relativeConfigPath(config)}, measured against config/prompts at cwd ${config.cwdLabel}):`,
    );
    for (const line of reportTable(rows)) console.log(line);
    for (const finding of findings)
      console.log(`\n${finding.level}: ${finding.message}`);
  }

  const errors = findings.filter((finding) => finding.level === "error");
  if (errors.length > 0) {
    console.error(
      `\n${errors.length} prompt budget violation${errors.length === 1 ? "" : "s"}. See docs/prompt-budgets.md.`,
    );
    process.exitCode = 1;
  } else if (!process.argv.includes("--json")) {
    console.log("\nPrompt budgets OK.");
  }
}

await main();
