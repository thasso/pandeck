import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { git } from "./gitExec.ts";
import {
  KnowledgeBaseError,
  KnowledgeBaseStore,
} from "./knowledgeBaseStore.ts";

let root: string;
let store: KnowledgeBaseStore;

const AGENT = { kind: "agent", id: "workshop", name: "Workshop" } as const;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-store-test-"));
  store = new KnowledgeBaseStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("initialization", () => {
  test("initializes a dedicated git repo with a committed gitignore", async () => {
    await store.ensureInitialized();
    assert.ok(existsSync(join(root, ".git")), ".git repo created");
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    assert.match(ignore, /\.kb\/generated\//);
    const history = await store.history();
    assert.equal(history.length, 1);
    assert.equal(history[0]?.subject, "Initialize knowledge base");
  });

  test("is idempotent across repeated calls", async () => {
    await store.ensureInitialized();
    await store.ensureInitialized();
    const history = await new KnowledgeBaseStore(root).history();
    assert.equal(history.length, 1, "no duplicate init commit on reopen");
  });

  test("commits an initial state even when .gitignore pre-exists untracked", async () => {
    // A pre-existing/untracked .gitignore (or a crash mid-init) must still yield
    // a repo with a HEAD commit, not an empty repo.
    await writeFile(join(root, ".gitignore"), "stale-content\n", "utf8");
    await store.ensureInitialized();
    const history = await store.history();
    assert.equal(history.length, 1);
    assert.equal(history[0]?.subject, "Initialize knowledge base");
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    assert.match(ignore, /\.kb\/generated\//);
    assert.doesNotMatch(
      ignore,
      /stale-content/,
      "stale gitignore normalized to KB content",
    );
  });

  test("serializes concurrent first-use init across separate store instances", async () => {
    // Distinct instances must not race on git init/config/the gitignore commit.
    const stores = Array.from(
      { length: 6 },
      () => new KnowledgeBaseStore(root),
    );
    await Promise.all(stores.map((s) => s.ensureInitialized()));
    const history = await new KnowledgeBaseStore(root).history();
    assert.equal(
      history.length,
      1,
      "exactly one init commit despite concurrent init",
    );
  });
});

describe("write + commit", () => {
  test("commits a source entry with structured trailers", async () => {
    const result = await store.commitChanges(
      [
        {
          op: "write",
          path: "customers/globex/index.md",
          content: "# Globex\n",
        },
      ],
      {
        actor: AGENT,
        reason: "Add Globex entry",
        sessionId: "sess-1",
        taskId: "258",
        entryIds: ["kb-globex"],
      },
    );
    assert.equal(result.changedPaths[0], "customers/globex/index.md");
    assert.equal(result.commit.length, 40);
    assert.equal(result.shortCommit.length, 12);

    assert.equal(
      await store.readEntryFile("customers/globex/index.md"),
      "# Globex\n",
    );

    const [head] = await store.history({ limit: 1 });
    assert.ok(head);
    assert.equal(head.subject, "Add Globex entry");
    assert.equal(head.trailers["KB-Actor"], "agent:workshop (Workshop)");
    assert.equal(head.trailers["KB-Session"], "sess-1");
    assert.equal(head.trailers["KB-Task"], "258");
    assert.equal(head.trailers["KB-Entry"], "kb-globex");
    assert.equal(head.trailers["KB-Paths"], "customers/globex/index.md");
    assert.equal(head.author, "Workshop");
    assert.equal(head.authorEmail, "workshop@kb.local");
  });

  test("applies multiple writes and a delete in one commit", async () => {
    await store.commitChanges(
      [{ op: "write", path: "a/index.md", content: "a" }],
      { actor: AGENT, reason: "seed" },
    );
    const result = await store.commitChanges(
      [
        { op: "write", path: "b/index.md", content: "b" },
        { op: "write", path: "b/assets/data.txt", content: "bytes" },
        { op: "delete", path: "a/index.md" },
      ],
      { actor: AGENT, reason: "add b, drop a" },
    );
    // changedPaths reflects the actual staged diff (git orders them).
    assert.deepEqual([...result.changedPaths].sort(), [
      "a/index.md",
      "b/assets/data.txt",
      "b/index.md",
    ]);
    assert.ok(!existsSync(join(root, "a/index.md")), "a deleted");
    assert.equal(await store.readEntryFile("b/assets/data.txt"), "bytes");
  });

  test("records only actually-changed paths, not no-op writes", async () => {
    await store.commitChanges(
      [
        { op: "write", path: "m/index.md", content: "same\n" },
        { op: "write", path: "m/other.md", content: "orig\n" },
      ],
      { actor: AGENT, reason: "seed" },
    );
    // Re-write m/index.md with identical content (no-op) alongside a real change.
    const result = await store.commitChanges(
      [
        { op: "write", path: "m/index.md", content: "same\n" },
        { op: "write", path: "m/other.md", content: "changed\n" },
      ],
      { actor: AGENT, reason: "touch other" },
    );
    assert.deepEqual(
      result.changedPaths,
      ["m/other.md"],
      "no-op path excluded from result",
    );
    const [head] = await store.history({ limit: 1 });
    assert.ok(head);
    assert.equal(
      head.trailers["KB-Paths"],
      "m/other.md",
      "no-op path excluded from trailer",
    );
  });

  test("lists the source tree with path classification, hiding implementation paths", async () => {
    await store.commitChanges(
      [
        { op: "write", path: "notes/x/index.md", content: "x" },
        { op: "write", path: "notes/x/assets/a.bin", content: "a" },
        {
          op: "write",
          path: ".kb/comments/kb-x.jsonl",
          content: '{"schema":1}\n',
        },
      ],
      { actor: AGENT, reason: "seed" },
    );
    await store.writeGeneratedFile("index/tree.json", "{}");
    const tree = await store.listTree();
    const byPath = new Map(tree.map((n) => [n.path, n]));
    assert.equal(byPath.get("notes/x/index.md")?.kind, "entry-index");
    assert.equal(byPath.get("notes/x/assets/a.bin")?.kind, "asset");
    assert.equal(byPath.get("notes")?.type, "dir");
    // Versioned comment logs are source-of-truth and stay visible.
    assert.equal(byPath.get(".kb/comments/kb-x.jsonl")?.kind, "comment");
    // Implementation paths must never appear as normal tree entries.
    for (const hidden of [
      ".git",
      ".gitignore",
      ".kb",
      ".kb/comments",
      ".kb/generated",
      ".kb/generated/index/tree.json",
    ]) {
      assert.ok(!byPath.has(hidden), `${hidden} hidden`);
    }
    assert.ok(
      !tree.some(
        (n) => n.path.startsWith(".git/") || n.path.startsWith(".kb/generated"),
      ),
      "no git/generated descendants",
    );
  });
});

describe("history and diff", () => {
  test("answers whole-KB and per-entry history questions", async () => {
    await store.commitChanges(
      [{ op: "write", path: "one/index.md", content: "1" }],
      { actor: AGENT, reason: "one" },
    );
    await store.commitChanges(
      [{ op: "write", path: "two/index.md", content: "2" }],
      { actor: AGENT, reason: "two" },
    );
    await store.commitChanges(
      [{ op: "write", path: "one/index.md", content: "1b" }],
      { actor: AGENT, reason: "one again" },
    );

    const all = await store.history();
    assert.equal(all.length, 4, "3 edits + init");

    const perEntry = await store.history({ path: "one" });
    assert.deepEqual(
      perEntry.map((h) => h.subject),
      ["one again", "one"],
    );
  });

  test("produces per-entry diffs between revisions", async () => {
    const first = await store.commitChanges(
      [{ op: "write", path: "d/index.md", content: "line one\n" }],
      { actor: AGENT, reason: "first" },
    );
    const second = await store.commitChanges(
      [{ op: "write", path: "d/index.md", content: "line two\n" }],
      { actor: AGENT, reason: "second" },
    );

    const diff = await store.diff({
      from: first.commit,
      to: second.commit,
      path: "d/index.md",
    });
    assert.match(diff, /-line one/);
    assert.match(diff, /\+line two/);

    const show = await store.showCommit(second.commit, "d/index.md");
    assert.match(show, /\+line two/);
  });

  test("rejects option-shaped revisions so diff/show cannot inject git flags", async () => {
    await store.commitChanges(
      [{ op: "write", path: "d/index.md", content: "x\n" }],
      { actor: AGENT, reason: "seed" },
    );
    const sink = join(root, "pwned.txt");

    // `--output=<file>` is a real git diff/show option: without validation it
    // would let a "read-only" API write files. It must be refused, not run.
    await assert.rejects(
      store.diff({ from: `--output=${sink}` }),
      /Invalid diff from revision/,
    );
    await assert.rejects(
      store.diff({ from: "HEAD", to: `--output=${sink}` }),
      /Invalid diff to revision/,
    );
    await assert.rejects(
      store.showCommit(`--output=${sink}`),
      /Invalid commit revision/,
    );
    await assert.rejects(
      store.readFileAtCommit(`--output=${sink}`, "d/index.md"),
      /Invalid commit revision/,
    );
    await assert.rejects(
      store.diff({ from: "" }),
      /A diff from revision is required/,
    );

    assert.ok(
      !existsSync(sink),
      "no file was written by an option-shaped revision",
    );
  });
});

describe("restore and revert primitives", () => {
  test("reads a file at an older commit and restores it forward", async () => {
    const v1 = await store.commitChanges(
      [{ op: "write", path: "r/index.md", content: "v1\n" }],
      { actor: AGENT, reason: "v1" },
    );
    await store.commitChanges(
      [{ op: "write", path: "r/index.md", content: "v2\n" }],
      { actor: AGENT, reason: "v2" },
    );

    assert.equal(await store.readFileAtCommit(v1.commit, "r/index.md"), "v1\n");

    const restored = await store.restorePaths(v1.commit, ["r/index.md"], {
      actor: AGENT,
      reason: "restore v1",
    });
    assert.equal(await store.readEntryFile("r/index.md"), "v1\n");
    const [head] = await store.history({ limit: 1 });
    assert.ok(head);
    assert.equal(head.commit, restored.commit);
    assert.equal(head.subject, "restore v1");
  });

  test("restoring a path absent at the target commit removes it", async () => {
    const v1 = await store.commitChanges(
      [{ op: "write", path: "base/index.md", content: "base" }],
      { actor: AGENT, reason: "v1" },
    );
    // Add a file that did not exist at v1.
    await store.commitChanges(
      [{ op: "write", path: "new/index.md", content: "new" }],
      { actor: AGENT, reason: "add new" },
    );
    assert.ok(existsSync(join(root, "new/index.md")));

    const restored = await store.restorePaths(v1.commit, ["new/index.md"], {
      actor: AGENT,
      reason: "restore to v1 (remove new)",
    });
    assert.ok(
      !existsSync(join(root, "new/index.md")),
      "path absent at target is removed on restore",
    );
    assert.deepEqual(restored.changedPaths, ["new/index.md"]);
    // Unrelated file is untouched.
    assert.equal(await store.readEntryFile("base/index.md"), "base");
  });

  test("restoring a folder absent at the target commit removes the whole folder", async () => {
    const v1 = await store.commitChanges(
      [{ op: "write", path: "keep/index.md", content: "k" }],
      { actor: AGENT, reason: "v1" },
    );
    await store.commitChanges(
      [
        { op: "write", path: "folder/index.md", content: "a" },
        { op: "write", path: "folder/assets/x.txt", content: "b" },
      ],
      { actor: AGENT, reason: "add folder" },
    );
    assert.ok(existsSync(join(root, "folder/index.md")));

    const restored = await store.restorePaths(v1.commit, ["folder"], {
      actor: AGENT,
      reason: "restore to v1 (remove folder)",
    });
    assert.ok(
      !existsSync(join(root, "folder")),
      "absent-at-target folder removed recursively",
    );
    assert.deepEqual([...restored.changedPaths].sort(), [
      "folder/assets/x.txt",
      "folder/index.md",
    ]);
    assert.equal(await store.readEntryFile("keep/index.md"), "k");
  });

  test("restoring an existing folder is an exact tree snapshot, dropping later children", async () => {
    const v1 = await store.commitChanges(
      [{ op: "write", path: "e/index.md", content: "v1\n" }],
      { actor: AGENT, reason: "v1" },
    );
    // v2 adds a child under the same folder and edits the original.
    await store.commitChanges(
      [
        { op: "write", path: "e/index.md", content: "v2\n" },
        { op: "write", path: "e/extra.md", content: "extra\n" },
      ],
      { actor: AGENT, reason: "v2" },
    );

    const restored = await store.restorePaths(v1.commit, ["e"], {
      actor: AGENT,
      reason: "restore e to v1",
    });
    // extra.md (added after target) is gone; index.md is back to v1 content.
    assert.ok(
      !existsSync(join(root, "e/extra.md")),
      "later child removed by exact-snapshot restore",
    );
    assert.equal(await store.readEntryFile("e/index.md"), "v1\n");
    assert.deepEqual([...restored.changedPaths].sort(), [
      "e/extra.md",
      "e/index.md",
    ]);
    const [head] = await store.history({ limit: 1 });
    assert.ok(head);
    assert.equal(head.commit, restored.commit);
  });

  test("reverts a commit as a new forward commit", async () => {
    await store.commitChanges(
      [{ op: "write", path: "keep/index.md", content: "keep" }],
      { actor: AGENT, reason: "keep" },
    );
    const bad = await store.commitChanges(
      [{ op: "write", path: "bad/index.md", content: "oops" }],
      { actor: AGENT, reason: "add bad" },
    );

    await store.revertCommit(bad.commit, {
      actor: AGENT,
      reason: "revert bad",
    });
    assert.ok(!existsSync(join(root, "bad/index.md")), "reverted file gone");
    assert.ok(existsSync(join(root, "keep/index.md")), "unrelated file kept");
  });
});

describe("generated artifacts stay separate from source of truth", () => {
  test("generated files are written but never committed", async () => {
    await store.commitChanges(
      [{ op: "write", path: "s/index.md", content: "s" }],
      { actor: AGENT, reason: "s" },
    );
    await store.writeGeneratedFile(
      "index/tree.json",
      JSON.stringify({ built: true }),
    );

    assert.equal(
      await store.readGeneratedFile("index/tree.json"),
      '{"built":true}',
    );
    assert.equal(await store.readGeneratedFile("missing.json"), null);

    // Working tree is clean: the gitignored generated file does not show up.
    const status = await git(["status", "--porcelain"], root);
    assert.equal(
      status.stdout.trim(),
      "",
      "generated artifacts do not dirty the repo",
    );

    const tree = await store.listTree();
    assert.ok(
      !tree.some((n) => n.path.includes(".kb/generated")),
      "generated dir excluded from tree",
    );

    await store.clearGenerated();
    assert.equal(await store.readGeneratedFile("index/tree.json"), null);
    // Source of truth survives clearing generated artifacts.
    assert.equal(await store.readEntryFile("s/index.md"), "s");
  });
});

describe("atomicity and error handling", () => {
  test("an invalid path in a batch prevents all writes", async () => {
    await assert.rejects(
      store.commitChanges(
        [
          { op: "write", path: "good/index.md", content: "good" },
          { op: "write", path: "../escape.md", content: "bad" },
        ],
        { actor: AGENT, reason: "should not apply" },
      ),
      /relative/,
    );
    assert.ok(
      !existsSync(join(root, "good/index.md")),
      "valid sibling not written on validation failure",
    );
    const history = await store.history();
    assert.equal(history.length, 1, "only the init commit exists");
  });

  test("rejects reserved and generated commit targets", async () => {
    await assert.rejects(
      store.commitChanges(
        [{ op: "write", path: ".git/config", content: "x" }],
        { actor: AGENT, reason: "no" },
      ),
      KnowledgeBaseError,
    );
    await assert.rejects(
      store.commitChanges(
        [{ op: "write", path: ".kb/generated/x.json", content: "x" }],
        { actor: AGENT, reason: "no" },
      ),
      /reserved\/generated/,
    );
  });

  test("rejects empty change sets and no-op commits", async () => {
    await assert.rejects(
      store.commitChanges([], { actor: AGENT, reason: "empty" }),
      /No changes/,
    );

    await store.commitChanges(
      [{ op: "write", path: "n/index.md", content: "same" }],
      { actor: AGENT, reason: "first" },
    );
    await assert.rejects(
      store.commitChanges(
        [{ op: "write", path: "n/index.md", content: "same" }],
        { actor: AGENT, reason: "noop" },
      ),
      /Nothing staged/,
    );
  });

  test("reading a missing entry fails cleanly", async () => {
    await store.ensureInitialized();
    await assert.rejects(store.readEntryFile("does/not/exist.md"), /not found/);
  });

  test("history/diff/show reject reserved and generated path scopes", async () => {
    await store.commitChanges(
      [{ op: "write", path: "e/index.md", content: "e" }],
      { actor: AGENT, reason: "seed" },
    );
    await assert.rejects(
      store.history({ path: ".gitignore" }),
      /reserved\/generated/,
    );
    await assert.rejects(
      store.diff({ from: "HEAD", path: ".kb/generated/x.json" }),
      /reserved\/generated/,
    );
    await assert.rejects(
      store.showCommit("HEAD", ".git/config"),
      /reserved\/generated/,
    );
    // A genuine entry scope is accepted.
    assert.equal((await store.history({ path: "e" })).length, 1);
  });

  test("a failed mixed batch leaves the working tree clean", async () => {
    await store.commitChanges(
      [{ op: "write", path: "clean/index.md", content: "v1" }],
      { actor: AGENT, reason: "seed" },
    );
    // Valid write + delete of a path that does not exist: whole batch must fail
    // atomically and leave no partial working-tree change behind.
    await assert.rejects(
      store.commitChanges(
        [
          {
            op: "write",
            path: "clean/added.md",
            content: "should not persist",
          },
          { op: "delete", path: "clean/missing.md" },
        ],
        { actor: AGENT, reason: "mixed failure" },
      ),
      /does not exist/,
    );
    assert.ok(!existsSync(join(root, "clean/added.md")), "write rolled back");
    const status = await git(["status", "--porcelain"], root);
    assert.equal(
      status.stdout.trim(),
      "",
      "working tree clean after failed batch",
    );
    assert.equal(
      (await store.history()).length,
      2,
      "no commit from failed batch",
    );
  });
});

describe("concurrent mutation locking", () => {
  test("serializes concurrent commits without corrupting the repo", async () => {
    await store.ensureInitialized();
    const writes = Array.from({ length: 8 }, (_, i) =>
      store.commitChanges(
        [
          {
            op: "write",
            path: `c/entry-${i}/index.md`,
            content: `entry ${i}\n`,
          },
        ],
        { actor: AGENT, reason: `add entry ${i}` },
      ),
    );
    const results = await Promise.all(writes);

    const hashes = new Set(results.map((r) => r.commit));
    assert.equal(
      hashes.size,
      8,
      "every concurrent commit produced a distinct commit",
    );

    const history = await store.history({ limit: 100 });
    assert.equal(
      history.length,
      9,
      "8 commits + init, none lost to an index race",
    );
    for (let i = 0; i < 8; i++) {
      assert.equal(
        await store.readEntryFile(`c/entry-${i}/index.md`),
        `entry ${i}\n`,
      );
    }
  });
});
