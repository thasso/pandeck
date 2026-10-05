import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { getWorktreeFileDiff, getWorktreeFileLog } from "./worktreeDiff.ts";

const repo = mkdtempSync(join(tmpdir(), "worktree-file-log-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function sh(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd: repo, encoding: "utf8" },
  ).trim();
}

function commit(message: string): string {
  sh("add", "-A");
  sh("commit", "-m", message);
  return sh("rev-parse", "HEAD");
}

sh("init", "-b", "main");
writeFileSync(join(repo, "notes.md"), "one\n");
const root = commit("add notes");
writeFileSync(join(repo, "other.txt"), "unrelated\n");
commit("unrelated change");
writeFileSync(join(repo, "notes.md"), "one\ntwo\n");
const edit = commit("extend notes");
sh("mv", "notes.md", "plan.md");
const rename = commit("rename to plan");

const row = { id: "wt-file-log", path: repo } as WorktreeRow;

describe("getWorktreeFileLog", () => {
  test("lists the commits that touched the file, across a rename", async () => {
    const log = await getWorktreeFileLog(row, "plan.md", 50);
    assert.equal(log.truncated, false);
    assert.deepEqual(
      log.entries.map((entry) => [entry.subject, entry.path]),
      [
        ["rename to plan", "plan.md"],
        ["extend notes", "notes.md"],
        ["add notes", "notes.md"],
      ],
    );
    assert.equal(log.entries[0]?.oid, rename);
    assert.equal(log.entries[1]?.parentOid, sh("rev-parse", `${edit}^`));
  });

  test("shows a root commit against the empty tree", async () => {
    const log = await getWorktreeFileLog(row, "plan.md", 50);
    const first = log.entries.at(-1)!;
    assert.equal(first.oid, root);
    assert.equal(first.parentOid, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    const diff = await getWorktreeFileDiff(row, first.path, {
      kind: "range",
      from: first.parentOid,
      to: first.oid,
    });
    assert.match(diff.diff, /\+one/);
  });

  test("opens each commit's own change through the range diff", async () => {
    const log = await getWorktreeFileLog(row, "plan.md", 50);
    const extend = log.entries[1]!;
    const diff = await getWorktreeFileDiff(row, extend.path, {
      kind: "range",
      from: extend.parentOid,
      to: extend.oid,
    });
    assert.match(diff.diff, /\+two/);
  });

  test("caps the list and says there is more", async () => {
    const log = await getWorktreeFileLog(row, "plan.md", 2);
    assert.equal(log.entries.length, 2);
    assert.equal(log.truncated, true);
  });

  test("refuses a path outside the checkout", async () => {
    await assert.rejects(
      getWorktreeFileLog(row, "../escape.md", 10),
      /Invalid file path/,
    );
  });
});
