#!/usr/bin/env node
// Runs knip and holds each finding category against the high-water marks in
// config/deadcode-budgets.json. Every number comes from that file: this script
// owns the rules, never the values. Policy lives in docs/linting.md.
//
// knip itself has no numeric threshold — it exits non-zero on the first finding
// — so the ratchet is here: count per category, fail only on a category that
// EXCEEDS its budget. A category with no budget entry is gated at zero.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function usage(message) {
  if (message) console.error(`${message}\n`);
  console.error(
    [
      "Usage: node scripts/check-deadcode.mjs [options]",
      "",
      "  --config <path>  Budget config (default config/deadcode-budgets.json).",
      "  --list           Print every finding, grouped by category.",
      "  --help           Show this help.",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { config: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--list") options.list = true;
    else if (arg === "--config")
      options.config = argv[++i] ?? usage("--config needs a path.");
    else usage(`Unknown argument: ${arg}`);
  }
  options.config = resolve(
    options.config ?? join(repoRoot, "config/deadcode-budgets.json"),
  );
  return options;
}

// --- config access ----------------------------------------------------------
// Every lookup is required: a missing key is a config error, not a default.

function configError(message) {
  console.error(`Invalid budget config: ${message}`);
  process.exit(2);
}

function loadConfig(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    configError(`cannot read ${relative(repoRoot, path)} (${error.message}).`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    configError(
      `${relative(repoRoot, path)} is not valid JSON (${error.message}).`,
    );
  }

  const categories = config.categories;
  if (!Array.isArray(categories) || categories.length === 0) {
    configError('"categories" must be a non-empty array.');
  }
  const declared = new Map();
  for (const category of categories) {
    if (!category || typeof category.id !== "string" || !category.id) {
      configError('every "categories" entry needs a non-empty "id".');
    }
    if (typeof category.label !== "string" || !category.label) {
      configError(`category "${category.id}" needs a "label".`);
    }
    if (typeof category.covers !== "string" || !category.covers) {
      configError(`category "${category.id}" needs a "covers".`);
    }
    if (declared.has(category.id)) {
      configError(`category "${category.id}" is declared twice.`);
    }
    declared.set(category.id, category);
  }

  const budgets = config.budgets;
  if (
    budgets === null ||
    typeof budgets !== "object" ||
    Array.isArray(budgets)
  ) {
    configError('"budgets" must be an object.');
  }
  for (const [id, value] of Object.entries(budgets)) {
    if (!declared.has(id)) {
      configError(`budget "${id}" has no entry in "categories".`);
    }
    if (!Number.isInteger(value) || value < 0) {
      configError(`budget "${id}" must be a non-negative integer.`);
    }
    if (value === 0) {
      configError(
        `budget "${id}" is 0: delete the entry instead, so the category is gated at zero for good.`,
      );
    }
  }

  const percent = config.slackWarnAtPercentOfBudget;
  if (typeof percent !== "number" || percent <= 0 || percent > 100) {
    configError('"slackWarnAtPercentOfBudget" must be a number in (0, 100].');
  }

  const changes = config.changes;
  if (!Array.isArray(changes)) configError('"changes" must be an array.');
  const last = new Map();
  for (const change of changes) {
    if (
      !change ||
      typeof change.budget !== "string" ||
      !declared.has(change.budget)
    ) {
      configError('every "changes" entry needs a "budget" naming a category.');
    }
    if (!Number.isInteger(change.to) || change.to < 0) {
      configError(`change for "${change.budget}" needs an integer "to".`);
    }
    if (typeof change.why !== "string" || change.why.trim().length < 10) {
      configError(
        `change for "${change.budget}" needs a "why" that says what moved the number.`,
      );
    }
    last.set(change.budget, change.to);
  }
  // The log is append-ordered, so the last entry for a category must match its
  // current number. That is what stops it going stale.
  for (const [id, to] of last) {
    const current = budgets[id] ?? 0;
    if (to !== current) {
      configError(
        `the last "changes" entry for "${id}" records ${to} but the budget is ${current}. Append an entry for the newer number.`,
      );
    }
  }

  return { declared, budgets, percent };
}

// --- knip -------------------------------------------------------------------

// `cycles` is the one category knip does not report by default, and its
// `--include` NARROWS the report rather than adding to it (verified: with
// `include: ["cycles"]` an unused export stops being reported). Enumerating
// every wanted type in `include` would fix that, but it would also mean a knip
// upgrade that adds a category lands silently — exactly what the undeclared
// category guard below exists to prevent. So the default report stays open and
// cycles come from a second pass, ~2.5s.
function runKnip(extraArgs = []) {
  const bin = join(repoRoot, "node_modules/.bin/knip");
  const result = spawnSync(
    bin,
    ["--reporter", "json", "--no-progress", ...extraArgs],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) {
    console.error(
      `Could not run knip (${result.error.message}). Is the workspace installed?`,
    );
    process.exit(2);
  }
  // knip exits 1 whenever it found anything, which is the normal case here;
  // only an unparseable stdout means it actually failed.
  try {
    return JSON.parse(result.stdout);
  } catch {
    console.error("knip produced no JSON report. Its output was:\n");
    console.error(result.stdout || result.stderr || "(nothing)");
    process.exit(2);
  }
}

// A finding is a `{ name, line }` for a symbol, an array of them for a
// duplicate-export group, and the file itself for an unused file.
function describe(entry) {
  if (Array.isArray(entry)) return entry.map(describe).join(" | ");
  if (typeof entry.name !== "string") return "(whole file)";
  return entry.line ? `${entry.name}:${entry.line}` : entry.name;
}

function tally(report) {
  if (!report || !Array.isArray(report.issues)) {
    console.error("knip's JSON report has no `issues` array.");
    process.exit(2);
  }
  const counts = new Map();
  const findings = new Map();
  for (const issue of report.issues) {
    for (const [id, list] of Object.entries(issue)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      counts.set(id, (counts.get(id) ?? 0) + list.length);
      const seen = findings.get(id) ?? [];
      for (const entry of list) {
        seen.push({ file: issue.file, name: describe(entry) });
      }
      findings.set(id, seen);
    }
  }
  return { counts, findings };
}

// --- report -----------------------------------------------------------------

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { declared, budgets, percent } = loadConfig(options.config);
  const { counts, findings } = tally(runKnip());
  // The second pass, for the one non-default category. Merged rather than
  // reported apart: a cycle is a finding like any other here, held against the
  // same budget rule and the same undeclared-category guard.
  const cycles = tally(runKnip(["--cycles"]));
  for (const [id, count] of cycles.counts)
    counts.set(id, (counts.get(id) ?? 0) + count);
  for (const [id, list] of cycles.findings)
    findings.set(id, [...(findings.get(id) ?? []), ...list]);

  const errors = [];
  const warnings = [];
  const rows = [];

  for (const id of counts.keys()) {
    if (!declared.has(id)) {
      errors.push(
        `knip reports a category this config does not declare: "${id}" (${counts.get(id)}). Add it to "categories" — a knip upgrade that grows the report is a decision, not a silent pass.`,
      );
    }
  }

  for (const [id, category] of declared) {
    const count = counts.get(id) ?? 0;
    const budget = budgets[id] ?? 0;
    rows.push({ id, label: category.label, count, budget });
    if (count > budget) {
      errors.push(
        `${category.label} (${id}): ${count} findings, budget ${budget}. ` +
          (budget === 0
            ? "This category is gated at zero."
            : `${count - budget} more than the committed high-water mark.`),
      );
    } else if (budget > 0 && count <= Math.floor((budget * percent) / 100)) {
      warnings.push(
        `${category.label} (${id}): ${count} findings against a budget of ${budget}. Lower the budget to ${count} so the slack cannot be refilled.`,
      );
    }
  }

  rows.sort((a, b) => b.budget - a.budget || b.count - a.count);
  const width = Math.max(...rows.map((row) => row.label.length));
  console.log(
    `Dead-code findings (knip via knip.json, budgets from ${relative(repoRoot, options.config)}):`,
  );
  for (const row of rows) {
    if (row.count === 0 && row.budget === 0) continue;
    console.log(
      `  ${row.label.padEnd(width)}  ${String(row.count).padStart(4)} / ${String(row.budget).padStart(4)}`,
    );
  }
  const zeroed = rows.filter((row) => row.count === 0 && row.budget === 0);
  console.log(`  ${zeroed.length} further categories gated at zero and clean.`);

  if (options.list) {
    for (const row of rows) {
      const list = findings.get(row.id);
      if (!list) continue;
      console.log(`\n${row.label} (${list.length}):`);
      for (const finding of list) {
        console.log(
          finding.name === finding.file
            ? `  ${finding.file}`
            : `  ${finding.file}: ${finding.name}`,
        );
      }
    }
  }

  // One stream for the whole report so CI logs stay in order; only the verdict
  // goes to stderr.
  for (const warning of warnings) console.log(`\nwarning: ${warning}`);
  for (const error of errors) console.log(`\nerror: ${error}`);

  if (errors.length > 0) {
    console.error(
      `\n${errors.length} dead-code budget breach${errors.length === 1 ? "" : "es"}. ` +
        "Run `node scripts/check-deadcode.mjs --list` to see the findings, or `pnpm exec knip` for knip's own report. See docs/linting.md.",
    );
    process.exit(1);
  }
  console.log(
    warnings.length > 0
      ? `\nDead-code budgets OK (${warnings.length} warning(s)).`
      : "\nDead-code budgets OK.",
  );
}

main();
