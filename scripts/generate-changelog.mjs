#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  format as formatWithPrettier,
  resolveConfig as resolvePrettierConfig,
} from "prettier";
import { assertSemVer, findChangelogSection } from "./release-utils.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const INTRO = `# Changelog

All notable changes to Pandeck are recorded here. Releases use
Semantic Versioning and tags add a leading \`v\` to the declared version.
`;

function git(args, root = repoRoot) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function repositoryWebUrl(remote) {
  const value = remote.trim().replace(/\.git$/, "");
  if (/^https?:\/\//.test(value)) return value;

  const ssh = /^ssh:\/\/[^@]+@([^/:]+)(?::\d+)?\/(.+)$/.exec(value);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;

  const scp = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(value);
  if (scp) return `https://${scp[1]}/${scp[2]}`;

  throw new Error(
    `Cannot turn remote "${remote}" into a web URL; pass --repo-url explicitly.`,
  );
}

export function collectChanges(commits, repoUrl) {
  const tasks = new Map();
  const other = [];

  for (const { hash, subject } of commits) {
    // A squash merge on GitHub: the pull request's title, then its number.
    const pull = /^(.+) \(#(\d+)\)$/.exec(subject);
    if (pull) {
      const [, title, number] = pull;
      const task = /^Task-(\d+):\s*(.+)$/.exec(title);
      const link = `[PR #${number}](${repoUrl}/pull/${number})`;
      if (task) {
        const key = task[1];
        const entry = tasks.get(key) ?? {
          task: `Task-${key}`,
          title: task[2],
          pulls: [],
        };
        entry.pulls.push(link);
        tasks.set(key, entry);
      } else {
        other.push(`- ${title} (${link})`);
      }
      continue;
    }

    other.push(
      `- ${subject} ([${hash.slice(0, 8)}](${repoUrl}/commit/${hash}))`,
    );
  }

  return { tasks: [...tasks.values()], other };
}

export function renderSection(version, date, changes) {
  const lines = [`## [${version}] - ${date}`];
  if (changes.tasks.length > 0) {
    lines.push("", "### Tasks", "");
    for (const task of changes.tasks) {
      lines.push(
        `- **${task.task}: ${task.title}** (${task.pulls.join(", ")})`,
      );
    }
  }
  if (changes.other.length > 0) {
    lines.push("", "### Other changes", "", ...changes.other);
  }
  if (changes.tasks.length === 0 && changes.other.length === 0) {
    lines.push("", "- No changes since the previous tag.");
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = {
    version: argv.shift(),
    base: null,
    date: new Date().toISOString().slice(0, 10),
    repoUrl: null,
  };
  while (argv.length > 0) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value) throw new Error(`${flag} needs a value.`);
    if (flag === "--base") options.base = value;
    else if (flag === "--date") options.date = value;
    else if (flag === "--repo-url") options.repoUrl = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.version) {
    console.error(
      "Usage: node scripts/generate-changelog.mjs <version> [--base <tag>] [--date YYYY-MM-DD] [--repo-url <url>]",
    );
    process.exit(2);
  }
  assertSemVer(options.version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error(`Invalid date "${options.date}"; expected YYYY-MM-DD.`);
  }

  const changelogPath = `${repoRoot}/CHANGELOG.md`;
  const existing = existsSync(changelogPath)
    ? readFileSync(changelogPath, "utf8")
    : INTRO;
  if (findChangelogSection(existing, options.version) !== null) {
    throw new Error(
      `CHANGELOG.md already has a section for ${options.version}.`,
    );
  }

  let base = options.base;
  if (!base) {
    try {
      base = git([
        "describe",
        "--tags",
        "--abbrev=0",
        "--first-parent",
        "HEAD",
      ]);
    } catch {
      base = null;
    }
  }
  if (base) git(["rev-parse", "--verify", `${base}^{commit}`]);

  const format = "%H%x1f%s";
  const log = git([
    "log",
    "--first-parent",
    `--format=${format}`,
    ...(base ? [`${base}..HEAD`] : ["HEAD"]),
  ]);
  const commits = log
    ? log.split("\n").map((line) => {
        const [hash, subject] = line.split("\x1f");
        return { hash, subject };
      })
    : [];
  const repoUrl = (
    options.repoUrl ?? repositoryWebUrl(git(["remote", "get-url", "origin"]))
  ).replace(/\/$/, "");
  const section = renderSection(
    options.version,
    options.date,
    collectChanges(commits, repoUrl),
  );

  const firstRelease = existing.search(/^## \[/m);
  const output =
    firstRelease === -1
      ? `${existing.trimEnd()}\n\n${section}`
      : `${existing.slice(0, firstRelease).trimEnd()}\n\n${section}\n${existing
          .slice(firstRelease)
          .trimStart()}`;
  let formatted;
  try {
    const prettierConfig = await resolvePrettierConfig(changelogPath);
    formatted = await formatWithPrettier(
      output.endsWith("\n") ? output : `${output}\n`,
      { ...prettierConfig, filepath: changelogPath },
    );
  } catch (error) {
    throw new Error(
      `Could not format generated CHANGELOG.md; no file was changed. ${error.message}`,
      { cause: error },
    );
  }
  writeFileSync(changelogPath, formatted);
  console.log(
    `Added and formatted ${options.version} in CHANGELOG.md from ${base ?? "the first commit"}..HEAD.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
