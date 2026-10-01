#!/usr/bin/env node
/**
 * The gate a release passes before it is published. It used to live inside
 * `tag-release.yml`; publication now happens through the approval-gated
 * `forgejo_create_release` tool, so the checks the workflow ran on its checkout
 * run here instead — same three questions, one command:
 *
 *   1. does every version declaration in the tree say this version?
 *   2. does CHANGELOG.md hold exactly one non-empty section for it?
 *   3. is the target commit on origin/main's first-parent history, where branch
 *      protection and CI gate it?
 *
 * Prints the target SHA and the notes to hand to the release tool. Read-only:
 * it never tags, pushes, or fetches.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDeclaredVersion,
  assertOnFirstParentHistory,
  extractChangelogSection,
  readDeclaredVersions,
} from "./release-utils.mjs";

const args = process.argv.slice(2);

/** `--name <value>`, absent as undefined; an empty value is a usage error. */
function flag(name) {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return undefined;
  return args[at + 1] ?? "";
}

// `--root` exists so the gate can be exercised against a fixture tree, as
// `check-instruction-docs.mjs` is; a release run never passes it.
const repoRoot =
  flag("root") || dirname(dirname(fileURLToPath(import.meta.url)));

function git(...args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

/** A git question whose "no" is an exit code rather than an error. */
function gitOk(...args) {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
}

const version = args[0];
const ref = flag("ref") ?? "HEAD";
if (!version || version.startsWith("-") || !ref) {
  console.error(
    "Usage: node scripts/release-check.mjs <version> [--ref <ref>] [--root <dir>]",
  );
  process.exit(2);
}

try {
  assertDeclaredVersion(repoRoot, version);
  const notes = extractChangelogSection(
    readFileSync(`${repoRoot}/CHANGELOG.md`, "utf8"),
    version,
  );

  const target = git("rev-parse", `${ref}^{commit}`);
  // The local view of the protected branch: this checks what has been fetched,
  // so a stale origin/main rejects a target rather than accepting a wrong one.
  const branch = gitOk(
    "rev-parse",
    "--verify",
    "--quiet",
    "origin/main^{commit}",
  )
    ? "origin/main"
    : "main";
  assertOnFirstParentHistory(
    target,
    git("rev-list", "--first-parent", branch).split("\n"),
  );

  console.log(
    `Version:  ${version} (${readDeclaredVersions(repoRoot).length} declarations agree)`,
  );
  console.log(`Tag:      v${version}`);
  console.log(`Target:   ${target}`);
  console.log(`          ${git("log", "-1", "--format=%s", target)}`);
  console.log(`On:       ${branch} (first-parent history)`);
  console.log(`\nRelease notes (CHANGELOG.md section ${version}):\n`);
  process.stdout.write(notes);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
