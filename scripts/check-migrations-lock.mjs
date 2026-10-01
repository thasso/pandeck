#!/usr/bin/env node
/**
 * Append-only migration guard, ACROSS COMMITS.
 *
 * `migrationsLock.test.ts` compares the lock with the files next to it — both
 * sides of one commit. That cannot see a migration being RENUMBERED, and
 * renumbering is the failure this script exists for:
 *
 *   two branches both add `0042_*.sql`. One merges. The other is rebased, hits
 *   the collision, and its migration is renamed to `0043_*.sql`. The lock is
 *   regenerated during conflict resolution, so lock and files agree perfectly
 *   and every in-commit check passes — while any database that already applied
 *   the original `0042` now disagrees with the shipped build about what version
 *   42 IS. That database crash-loops on the next deploy, and no test failed.
 *
 * The invariant only exists in history: a migration, once locked, keeps its
 * name AND its hash forever. So compare against the merge base rather than the
 * working tree. Entries may be added; nothing may be renamed, rehashed, or
 * removed.
 *
 *   node scripts/check-migrations-lock.mjs [--base <ref>] [--root <dir>]
 *
 * Exit 0 when clean, 1 on a violation, 2 on usage/environment error. When the
 * base ref cannot be resolved (a shallow clone, or the very first commit) the
 * check reports that and passes — CI checks out full history for this reason.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

/** `--name <value>`, absent as undefined. */
function flag(name) {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return undefined;
  return args[at + 1] ?? "";
}

const repoRoot =
  flag("root") || dirname(dirname(fileURLToPath(import.meta.url)));
const LOCK_PATH = "app/server/src/db/migrations.lock.json";

function git(...gitArgs) {
  return execFileSync("git", gitArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A git question whose "no" is an exit code rather than an error. */
function gitOr(fallback, ...gitArgs) {
  try {
    return git(...gitArgs);
  } catch {
    return fallback;
  }
}

function parseLock(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(`Cannot parse ${label}: ${String(err)}`);
    process.exit(2);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`${label} is not a JSON object of { filename: sha256 }.`);
    process.exit(2);
  }
  return parsed;
}

/** Version integer from a migration file name, or NaN. */
function versionOf(name) {
  return Number(name.split("_", 1)[0]);
}

// The ref this branch grew from: `--base` or `PA_BASE_REF` in CI (the PR's
// target, which is not always main); locally the upstream main is the useful
// default.
const baseRef =
  flag("base") ||
  process.env.PA_BASE_REF?.trim() ||
  gitOr("", "rev-parse", "--verify", "--quiet", "origin/main") ||
  gitOr("", "rev-parse", "--verify", "--quiet", "main");

if (!baseRef) {
  console.log(
    "check-migrations-lock: no base ref to compare against; skipping.",
  );
  process.exit(0);
}

const mergeBase = gitOr("", "merge-base", "HEAD", baseRef) || baseRef;
const baseLockText = gitOr("", "show", `${mergeBase}:${LOCK_PATH}`);

if (!baseLockText) {
  console.log(
    `check-migrations-lock: ${LOCK_PATH} does not exist at ${mergeBase}; nothing to compare.`,
  );
  process.exit(0);
}

const base = parseLock(baseLockText, `${LOCK_PATH} at ${mergeBase}`);
const current = parseLock(
  readFileSync(join(repoRoot, LOCK_PATH), "utf8"),
  LOCK_PATH,
);

const problems = [];

// Every entry the base branch had locked must survive, byte for byte.
for (const [name, hash] of Object.entries(base)) {
  if (!(name in current)) {
    // Renumbering shows up here first: the old name is gone. Name the file that
    // replaced it, so the message describes what actually happened.
    const version = versionOf(name);
    const replacement = Object.keys(current).find(
      (candidate) => versionOf(candidate) === version && !(candidate in base),
    );
    const sameContent = Object.entries(current).find(
      ([candidate, candidateHash]) =>
        candidateHash === hash && !(candidate in base),
    );
    problems.push(
      replacement
        ? `${name} was replaced by ${replacement} — version ${version} was RENUMBERED or reused. Databases that applied ${name} record version ${version} with its checksum and will crash-loop on this build. Give the migration that has never been applied the next FREE version instead.`
        : sameContent
          ? `${name} was renamed to ${sameContent[0]} — a locked migration keeps its name forever. Databases that applied it recorded the old version number.`
          : `${name} was removed from the lock. Migrations are append-only.`,
    );
    continue;
  }
  if (current[name] !== hash)
    problems.push(
      `${name} changed content after it was locked (${hash.slice(0, 12)} → ${current[name].slice(0, 12)}). Revert the edit and add a NEW forward migration.`,
    );
}

// Two files claiming one version never both apply: runMigrations keys on the
// integer, so the second is silently skipped on a database that ran the first.
const byVersion = new Map();
for (const name of Object.keys(current)) {
  const version = versionOf(name);
  if (!Number.isInteger(version)) continue;
  const seen = byVersion.get(version);
  if (seen)
    problems.push(
      `${seen} and ${name} both claim version ${version}. A version number identifies a migration; only one file may hold it.`,
    );
  else byVersion.set(version, name);
}

if (problems.length > 0) {
  console.error(
    `Migration lock is not append-only relative to ${mergeBase}:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\n\nMigrations are identified by their version number in every database that ` +
      `applied them; that number cannot be reassigned later. See docs/migrations.md.`,
  );
  process.exit(1);
}

console.log(
  `check-migrations-lock: ${Object.keys(current).length} migration(s) locked, append-only against ${mergeBase}.`,
);
