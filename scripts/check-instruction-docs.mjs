#!/usr/bin/env node
// Enforces the instruction-document policy in docs/instruction-docs.md. Every
// number comes from config/instruction-budgets.json: this script owns the rules,
// never the values.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function usage(message) {
  if (message) console.error(`${message}\n`);
  console.error(
    [
      "Usage: node scripts/check-instruction-docs.mjs [options]",
      "",
      "  --root <dir>     Scan this directory instead of the repository root.",
      "  --config <path>  Budget config (default config/instruction-budgets.json).",
      "  --help           Show this help.",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { root: repoRoot, config: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--root")
      options.root = argv[++i] ?? usage("--root needs a directory.");
    else if (arg === "--config")
      options.config = argv[++i] ?? usage("--config needs a path.");
    else usage(`Unknown argument: ${arg}`);
  }
  options.root = resolve(options.root);
  options.config = resolve(
    options.config ?? join(repoRoot, "config/instruction-budgets.json"),
  );
  return options;
}

// --- config access ----------------------------------------------------------
// Every lookup is required: a missing key is a config error, not a default.

function configError(message) {
  console.error(`Invalid budget config: ${message}`);
  process.exit(2);
}

function pick(config, path) {
  let value = config;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object" || !(key in value)) {
      configError(`missing "${path}".`);
    }
    value = value[key];
  }
  return value;
}

function num(config, path) {
  const value = pick(config, path);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    configError(`"${path}" must be a number.`);
  }
  return value;
}

function bool(config, path) {
  const value = pick(config, path);
  if (typeof value !== "boolean") configError(`"${path}" must be a boolean.`);
  return value;
}

function str(config, path) {
  const value = pick(config, path);
  if (typeof value !== "string" || value.length === 0) {
    configError(`"${path}" must be a non-empty string.`);
  }
  return value;
}

function strings(config, path) {
  const value = pick(config, path);
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    configError(`"${path}" must be an array of strings.`);
  }
  return value;
}

// --- globs ------------------------------------------------------------------

function globToRegExp(glob) {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          pattern += "(?:[^/]*/)*";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

function collectFiles(root, includeGlobs, excludeGlobs) {
  const include = includeGlobs.map(globToRegExp);
  const exclude = excludeGlobs.map(globToRegExp);
  // An exclude of the form `dir/**` also prunes the walk, so we never descend
  // into node_modules or the user's data directory.
  const prune = excludeGlobs
    .filter((glob) => glob.endsWith("/**"))
    .map((glob) => globToRegExp(glob.slice(0, -3)));

  const files = [];
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        if (prune.some((re) => re.test(rel))) continue;
        walk(join(absDir, entry.name), rel);
      } else if (entry.isFile()) {
        if (!include.some((re) => re.test(rel))) continue;
        if (exclude.some((re) => re.test(rel))) continue;
        files.push(rel);
      }
    }
  };
  walk(root, "");
  // Root file first, then path order: the same order an agent loads them in.
  return files.sort((a, b) => {
    if (a.includes("/") !== b.includes("/")) return a.includes("/") ? 1 : -1;
    return a.localeCompare(b);
  });
}

// --- exception markers ------------------------------------------------------

function parseMarker(line, spec) {
  const shape = new RegExp(`^<!--\\s*${spec.marker}\\s*:\\s*(.*?)\\s*-->$`);
  const match = shape.exec(line.trim());
  if (!match) {
    return {
      errors: [
        `malformed exception marker: expected \`<!-- ${spec.marker}: ${spec.requiredFields
          .map((field) => `${field}=`)
          .join(" ")} -->\` on line 1.`,
      ],
    };
  }

  const body = match[1];
  const fields = new Map();
  const token = /([A-Za-z][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let found;
  while ((found = token.exec(body)) !== null) {
    fields.set(found[1], found[2] ?? found[3] ?? found[4]);
  }
  const errors = [];
  const leftover = body.replace(token, "").trim();
  if (leftover.length > 0) {
    errors.push(`exception marker has unparsable text: "${leftover}".`);
  }
  for (const field of spec.requiredFields) {
    if (!fields.has(field))
      errors.push(`exception marker is missing \`${field}=\`.`);
  }
  for (const field of fields.keys()) {
    if (!spec.requiredFields.includes(field)) {
      errors.push(`exception marker has unknown field \`${field}\`.`);
    }
  }

  const bytes = Number(fields.get("bytes"));
  if (fields.has("bytes") && (!Number.isInteger(bytes) || bytes <= 0)) {
    errors.push(
      `exception marker \`bytes=${fields.get("bytes")}\` is not a positive integer.`,
    );
  }
  const reason = fields.get("reason") ?? "";
  if (fields.has("reason") && reason.trim().length < spec.minReasonChars) {
    errors.push(
      `exception reason is ${reason.trim().length} chars; at least ${spec.minReasonChars} are required.`,
    );
  }
  const task = fields.get("task") ?? "";
  if (fields.has("task") && task.trim().length === 0) {
    errors.push("exception marker `task=` is empty.");
  }
  const date = fields.get("date") ?? "";
  if (fields.has("date") && !isCalendarDate(date)) {
    errors.push(`exception marker \`date=${date}\` is not a YYYY-MM-DD date.`);
  }

  return { errors, bytes, reason, task, date };
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

// --- file analysis ----------------------------------------------------------

function splitLines(text) {
  return text.split(/\r?\n/);
}

function isFence(line) {
  return /^\s*(?:`{3,}|~{3,})/.test(line);
}

function overlongLines(lines, rules) {
  const offenders = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (isFence(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence && rules.exemptFencedCode) return;
    if (rules.exemptTableRows && line.trimStart().startsWith("|")) return;
    // The exception marker is one unwrappable HTML comment on line 1; Prettier
    // leaves it alone and a useful reason would blow the backstop.
    if (
      index === 0 &&
      rules.exemptExceptionMarker &&
      rules.isExceptionMarker(line)
    )
      return;
    if (line.length > rules.maxLength) {
      offenders.push({ line: index + 1, length: line.length });
    }
  });
  return offenders;
}

function paragraphs(lines) {
  const blocks = [];
  let current = [];
  let inFence = false;
  const flush = () => {
    if (current.length > 0) blocks.push(current.join(" "));
    current = [];
  };
  for (const line of lines) {
    if (isFence(line)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;
    if (line.trim().length === 0) flush();
    else current.push(line.trim());
  }
  flush();
  return blocks;
}

function normalizeParagraph(text) {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[-*+]\s+/, "")
    .trim();
}

// --- checks -----------------------------------------------------------------

function formatBytes(bytes) {
  return bytes.toLocaleString("en-US");
}

function percentOf(bytes, budget) {
  return budget > 0 ? (bytes / budget) * 100 : Infinity;
}

function ancestorDirs(relFile) {
  const dir = dirname(relFile);
  if (dir === "." || dir === "") return ["."];
  const parts = dir.split("/");
  return parts
    .map((_, index) => parts.slice(0, index + 1).join("/"))
    .concat(["."]);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.config)) usage(`Config not found: ${options.config}`);
  if (!existsSync(options.root) || !statSync(options.root).isDirectory()) {
    usage(`Root is not a directory: ${options.root}`);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(options.config, "utf8"));
  } catch (error) {
    configError(`${options.config} is not valid JSON (${error.message}).`);
  }

  const budgets = {
    root: num(config, "budgets.rootBytes"),
    child: num(config, "budgets.childBytes"),
    chain: num(config, "budgets.chainBytes"),
    warnPercent: num(config, "budgets.warnAtPercentOfBudget"),
  };
  const lineRules = {
    maxLength: num(config, "lines.maxLength"),
    exemptTableRows: bool(config, "lines.exemptTableRows"),
    exemptFencedCode: bool(config, "lines.exemptFencedCode"),
    exemptExceptionMarker: bool(config, "lines.exemptExceptionMarker"),
    isExceptionMarker: (line) =>
      line.trimStart().startsWith(`<!-- ${str(config, "exceptions.marker")}`),
  };
  const exceptionSpec = {
    marker: str(config, "exceptions.marker"),
    requiredFields: strings(config, "exceptions.requiredFields"),
    minReasonChars: num(config, "exceptions.minReasonChars"),
    maxMultipleOfBudget: num(config, "exceptions.maxMultipleOfBudget"),
    failWhenUnused: bool(config, "exceptions.failWhenUnused"),
    allowedForChainBudget: bool(config, "exceptions.allowedForChainBudget"),
  };

  const errors = [];
  const warnings = [];
  const fail = (file, message) =>
    errors.push(file ? `${file}: ${message}` : message);
  const warn = (file, message) =>
    warnings.push(file ? `${file}: ${message}` : message);

  const files = collectFiles(
    options.root,
    strings(config, "include"),
    strings(config, "exclude"),
  );
  if (files.length === 0) {
    console.error(
      `No instruction files matched ${strings(config, "include").join(", ")} under ${options.root}.`,
    );
    process.exit(1);
  }

  const rows = [];
  const paragraphIndex = new Map();

  for (const relFile of files) {
    const text = readFileSync(join(options.root, relFile), "utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    const lines = splitLines(text);
    const isRoot = relFile === "CLAUDE.md";
    const tier = isRoot ? "root" : "child";
    const tierBudget = isRoot ? budgets.root : budgets.child;

    // Exception marker: only line 1 counts, and a marker anywhere else is a
    // marker that silently does nothing.
    let marker = null;
    if (lines[0]?.includes(exceptionSpec.marker)) {
      const parsed = parseMarker(lines[0], exceptionSpec);
      for (const message of parsed.errors) fail(relFile, message);
      if (parsed.errors.length === 0) marker = parsed;
    }
    const strayMarker = lines.findIndex(
      (line, index) =>
        index > 0 && line.includes(`<!-- ${exceptionSpec.marker}`),
    );
    if (strayMarker > 0) {
      fail(
        relFile,
        `exception marker on line ${strayMarker + 1}; it is only honoured on line 1.`,
      );
    }

    let budget = tierBudget;
    let allowance = false;
    if (marker) {
      const cap = tierBudget * exceptionSpec.maxMultipleOfBudget;
      if (marker.bytes > cap) {
        fail(
          relFile,
          `exception claims ${formatBytes(marker.bytes)} B but the ${tier} cap is ${formatBytes(cap)} B ` +
            `(${exceptionSpec.maxMultipleOfBudget}x the ${formatBytes(tierBudget)} B budget). Relocate content instead.`,
        );
      } else if (exceptionSpec.failWhenUnused && bytes <= tierBudget) {
        fail(
          relFile,
          `stale exception marker: the file is ${formatBytes(bytes)} B and fits the ${formatBytes(tierBudget)} B ` +
            `${tier} budget. Delete the marker.`,
        );
      } else {
        budget = marker.bytes;
        allowance = true;
      }
    }

    if (bytes > budget) {
      fail(
        relFile,
        `${formatBytes(bytes)} B exceeds the ${formatBytes(budget)} B ${allowance ? "exception allowance" : `${tier} budget`} ` +
          `by ${formatBytes(bytes - budget)} B.`,
      );
    } else if (percentOf(bytes, budget) >= budgets.warnPercent) {
      warn(
        relFile,
        `${formatBytes(bytes)} B is ${percentOf(bytes, budget).toFixed(0)}% of its ${formatBytes(budget)} B budget.`,
      );
    }

    for (const offender of overlongLines(lines, lineRules)) {
      fail(
        relFile,
        `line ${offender.line} is ${offender.length} chars, over the ${lineRules.maxLength}-char backstop. Run \`pnpm run format\`.`,
      );
    }

    rows.push({ file: relFile, bytes, budget, tier, exception: allowance });

    const dupRules = config.duplication;
    if (dupRules && dupRules.severity !== "off") {
      for (const block of paragraphs(lines)) {
        const normalized = normalizeParagraph(block);
        if (normalized.length < (dupRules.minChars ?? Infinity)) continue;
        const seen = paragraphIndex.get(normalized) ?? [];
        seen.push(relFile);
        paragraphIndex.set(normalized, seen);
      }
    }
  }

  // Path chains: root plus every ancestor instruction file down to the folder.
  const chains = new Map();
  for (const relFile of files) {
    const dirs = ancestorDirs(relFile);
    const chainFiles = files.filter((candidate) => {
      const candidateDir =
        dirname(candidate) === "." ? "." : dirname(candidate);
      return dirs.includes(candidateDir);
    });
    const key = chainFiles.join("\n");
    if (chains.has(key)) continue;
    const bytes = chainFiles.reduce(
      (sum, candidate) =>
        sum + (rows.find((row) => row.file === candidate)?.bytes ?? 0),
      0,
    );
    chains.set(key, { files: chainFiles, bytes, leaf: relFile });
  }

  for (const chain of chains.values()) {
    if (chain.bytes > budgets.chain) {
      const detail = chain.files
        .map(
          (file) =>
            `${file} (${formatBytes(rows.find((row) => row.file === file).bytes)} B)`,
        )
        .join(" + ");
      fail(
        null,
        `chain for ${chain.leaf} is ${formatBytes(chain.bytes)} B, over the ${formatBytes(budgets.chain)} B chain budget` +
          `${exceptionSpec.allowedForChainBudget ? "" : " (no exceptions apply to chains)"}: ${detail}`,
      );
    } else if (percentOf(chain.bytes, budgets.chain) >= budgets.warnPercent) {
      warn(
        null,
        `chain for ${chain.leaf} is ${formatBytes(chain.bytes)} B, ${percentOf(chain.bytes, budgets.chain).toFixed(0)}% of the ${formatBytes(budgets.chain)} B chain budget.`,
      );
    }
  }

  const dupRules = config.duplication;
  if (dupRules && dupRules.severity !== "off") {
    for (const [normalized, owners] of paragraphIndex) {
      const distinct = [...new Set(owners)];
      if (distinct.length < 2) continue;
      const message =
        `duplicated paragraph in ${distinct.join(", ")}: "${normalized.slice(0, 72)}…" ` +
        "— state it once in the nearest shared parent.";
      if (dupRules.severity === "error") fail(null, message);
      else warn(null, message);
    }
  }

  // The prose table in the policy doc must agree with this config.
  const mirror = config.docsMirror;
  let mirrorNote = null;
  if (mirror && mirror.path) {
    if (options.root !== repoRoot) {
      mirrorNote = `docs mirror check skipped (custom --root).`;
    } else {
      checkDocsMirror(join(repoRoot, mirror.path), mirror, config, fail);
    }
  }

  report({ rows, chains, errors, warnings, mirrorNote, budgets, options });
  process.exit(errors.length > 0 ? 1 : 0);
}

function checkDocsMirror(docPath, mirror, config, fail) {
  const label = mirror.path;
  if (!existsSync(docPath)) {
    fail(
      null,
      `${label} is missing but is the documented mirror of the budget config.`,
    );
    return;
  }
  const rows = new Map();
  for (const line of splitLines(readFileSync(docPath, "utf8"))) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length >= 2) rows.set(cells[0], cells[1]);
  }
  for (const [rowLabel, budgetKey] of Object.entries(mirror.rows ?? {})) {
    const expected = num(config, `budgets.${budgetKey}`);
    const cell = rows.get(rowLabel);
    if (cell === undefined) {
      fail(
        null,
        `${label} has no budget table row "${rowLabel}" to mirror ${budgetKey}.`,
      );
      continue;
    }
    const actual = Number(cell.replace(/[,\s]/g, "").replace(/B$/i, ""));
    if (actual !== expected) {
      fail(
        null,
        `${label} lists "${rowLabel}" as ${cell} but ${budgetKey} is ${formatBytes(expected)} B. Update the table.`,
      );
    }
  }
}

function report({
  rows,
  chains,
  errors,
  warnings,
  mirrorNote,
  budgets,
  options,
}) {
  const width = Math.max(...rows.map((row) => row.file.length));
  console.log(
    `Instruction documents under ${relative(process.cwd(), options.root) || "."} (budgets from ${relative(repoRoot, options.config)}):`,
  );
  for (const row of rows) {
    const pct = percentOf(row.bytes, row.budget).toFixed(0).padStart(3);
    console.log(
      `  ${row.file.padEnd(width)}  ${formatBytes(row.bytes).padStart(6)} B / ${formatBytes(row.budget).padStart(6)} B  ${pct}%` +
        (row.exception ? "  (exception)" : ""),
    );
  }

  const worst = [...chains.values()].sort((a, b) => b.bytes - a.bytes)[0];
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  console.log(
    `  ${rows.length} files, ${formatBytes(total)} B total; worst chain ${worst.leaf} at ${formatBytes(worst.bytes)} B of ${formatBytes(budgets.chain)} B.`,
  );
  if (mirrorNote) console.log(`  ${mirrorNote}`);

  // One stream for the whole report so CI logs stay in order; only the verdict
  // goes to stderr.
  for (const warning of warnings) console.log(`\nwarning: ${warning}`);
  for (const error of errors) console.log(`\nerror: ${error}`);

  if (errors.length > 0) {
    console.error(
      `\n${errors.length} instruction-document violation${errors.length === 1 ? "" : "s"}. See docs/instruction-docs.md.`,
    );
  } else if (warnings.length > 0) {
    console.log(`\nInstruction budgets OK (${warnings.length} warning(s)).`);
  } else {
    console.log("\nInstruction budgets OK.");
  }
}

main();
