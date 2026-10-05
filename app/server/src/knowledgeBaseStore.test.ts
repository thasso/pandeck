import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { git } from "./gitExec.ts";
import {
  KnowledgeBaseError,
  KnowledgeBaseStore,
} from "./knowledgeBaseStore.ts";

/**
 * The KB folder is the user's: a tool write touches only its own paths,
 * refuses paths with the user's uncommitted edits, and leaves everything else
 * in the working tree, the index and the repo config exactly as it found it.
 */

let root: string;
let store: KnowledgeBaseStore;

const AGENT = { kind: "agent", id: "workshop", name: "Workshop" } as const;
const meta = (reason: string) => ({ actor: AGENT, reason });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-store-test-"));
  store = new KnowledgeBaseStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function status(): Promise<string> {
  return (await git(["status", "--porcelain"], root)).stdout;
}

describe("initialization", () => {
  test("makes the folder a repository with one empty first commit", async () => {
    await store.ensureInitialized();
    assert.ok(existsSync(join(root, ".git")));
    assert.equal(existsSync(join(root, ".gitignore")), false);
    const history = await store.history();
    assert.equal(history.length, 1);
    assert.equal(history[0]?.subject, "Initialize knowledge base");
    // Identity is per commit; the repo's own config is left alone.
    const name = await git(["config", "--local", "--get", "user.name"], root)
      .then((r) => r.stdout.trim())
      .catch(() => "");
    assert.equal(name, "");
  });

  test("adopts an existing repository without committing anything", async () => {
    await git(["init", "-b", "main"], root);
    await writeFile(join(root, "notes.md"), "# Notes\n");
    await git(["add", "notes.md"], root);
    await git(
      ["-c", "user.name=U", "-c", "user.email=u@x", "commit", "-m", "Mine"],
      root,
    );
    await store.ensureInitialized();
    const history = await store.history();
    assert.deepEqual(
      history.map((row) => row.subject),
      ["Mine"],
    );
  });

  test("serializes concurrent first-use init across store instances", async () => {
    const stores = Array.from(
      { length: 6 },
      () => new KnowledgeBaseStore(root),
    );
    await Promise.all(stores.map((s) => s.ensureInitialized()));
    assert.equal((await new KnowledgeBaseStore(root).history()).length, 1);
  });
});

describe("writes", () => {
  test("commits exactly its own paths with the KB trailers", async () => {
    const result = await store.commitChanges(
      [
        { op: "write", path: "a/one.md", content: "one\n" },
        { op: "write", path: "b.bin", content: new Uint8Array([0, 1, 2]) },
      ],
      { ...meta("Add two"), sessionId: "s1", taskId: "7" },
    );
    assert.deepEqual(result.changedPaths.sort(), ["a/one.md", "b.bin"]);
    const [head] = await store.history({ limit: 1 });
    assert.equal(head?.subject, "Add two");
    assert.equal(head?.author, "Workshop");
    assert.equal(head?.trailers["KB-Session"], "s1");
    assert.equal(head?.trailers["KB-Task"], "7");
    assert.equal(head?.trailers["KB-Paths"], "a/one.md, b.bin");
    assert.equal(await status(), "");
  });

  test("leaves the user's other uncommitted and staged work alone", async () => {
    await store.commitChanges(
      [{ op: "write", path: "theirs.md", content: "v1\n" }],
      meta("seed"),
    );
    await writeFile(join(root, "theirs.md"), "v2 (mine)\n");
    await writeFile(join(root, "draft.md"), "draft\n");
    await git(["add", "draft.md"], root);

    await store.commitChanges(
      [{ op: "write", path: "agent.md", content: "agent\n" }],
      meta("agent note"),
    );

    const shown = await git(["show", "--name-only", "--format=", "HEAD"], root);
    assert.equal(shown.stdout.trim(), "agent.md");
    assert.equal(
      await readFile(join(root, "theirs.md"), "utf8"),
      "v2 (mine)\n",
    );
    assert.match(await status(), /^ M theirs\.md$/m);
    assert.match(await status(), /^A {2}draft\.md$/m);
  });

  test("refuses a path with uncommitted edits and changes nothing", async () => {
    await store.commitChanges(
      [{ op: "write", path: "plan.md", content: "v1\n" }],
      meta("seed"),
    );
    await writeFile(join(root, "plan.md"), "user edit\n");
    await writeFile(join(root, "new.md"), "untracked\n");
    for (const path of ["plan.md", "new.md"]) {
      await assert.rejects(
        store.commitChanges(
          [{ op: "write", path, content: "agent\n" }],
          meta("overwrite"),
        ),
        (err: Error) =>
          err instanceof KnowledgeBaseError &&
          /Uncommitted changes/.test(err.message),
      );
    }
    assert.equal(await readFile(join(root, "plan.md"), "utf8"), "user edit\n");
    assert.equal(await readFile(join(root, "new.md"), "utf8"), "untracked\n");
    assert.equal((await store.history()).length, 2);
  });

  test("validates every path before writing any", async () => {
    for (const path of [
      "../escape.md",
      "/abs.md",
      ".git/config",
      "x/.hidden.md",
    ])
      await assert.rejects(
        store.commitChanges(
          [
            { op: "write", path: "ok.md", content: "ok\n" },
            { op: "write", path, content: "bad\n" },
          ],
          meta("bad"),
        ),
        KnowledgeBaseError,
      );
    assert.equal(existsSync(join(root, "ok.md")), false);
  });

  test("rolls its own paths back when the commit fails", async () => {
    await store.commitChanges(
      [{ op: "write", path: "same.md", content: "same\n" }],
      meta("seed"),
    );
    await assert.rejects(
      store.commitChanges(
        [{ op: "write", path: "same.md", content: "same\n" }],
        meta("no-op"),
      ),
      /Nothing to commit/,
    );
    assert.equal(await status(), "");
  });

  test("deletes a file and refuses a missing one", async () => {
    await store.commitChanges(
      [{ op: "write", path: "gone.md", content: "x\n" }],
      meta("seed"),
    );
    await store.commitChanges([{ op: "delete", path: "gone.md" }], meta("rm"));
    assert.equal(existsSync(join(root, "gone.md")), false);
    await assert.rejects(
      store.commitChanges([{ op: "delete", path: "gone.md" }], meta("rm")),
      /not found/,
    );
  });

  test("serializes concurrent writes without losing a commit", async () => {
    await store.ensureInitialized();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.commitChanges(
          [{ op: "write", path: `c/${i}.md`, content: `${i}\n` }],
          meta(`add ${i}`),
        ),
      ),
    );
    assert.equal(new Set(results.map((r) => r.commit)).size, 8);
    assert.equal((await store.history({ limit: 100 })).length, 9);
  });
});

describe("moves", () => {
  test("moves a folder in one commit, and refuses dirty or taken paths", async () => {
    await store.commitChanges(
      [
        { op: "write", path: "old/a.md", content: "a\n" },
        { op: "write", path: "old/b.md", content: "b\n" },
        { op: "write", path: "taken.md", content: "t\n" },
      ],
      meta("seed"),
    );
    await assert.rejects(store.move("old", "taken.md", meta("mv")), /exists/);
    await assert.rejects(store.move("old", "old/inner", meta("mv")), /inside/);
    await writeFile(join(root, "old/a.md"), "edited\n");
    await assert.rejects(
      store.move("old", "new", meta("mv")),
      /Uncommitted changes/,
    );
    await git(["checkout", "--", "old/a.md"], root);

    const result = await store.move("old", "archive/new", meta("Archive"));
    assert.deepEqual(result.changedPaths.sort(), [
      "archive/new/a.md",
      "archive/new/b.md",
      "old/a.md",
      "old/b.md",
    ]);
    assert.equal(await readFile(join(root, "archive/new/b.md"), "utf8"), "b\n");
    assert.equal(await status(), "");
  });
});

describe("reads", () => {
  test("lists the working tree, uncommitted files included, hidden paths not", async () => {
    await store.commitChanges(
      [{ op: "write", path: "docs/a.md", content: "a\n" }],
      meta("seed"),
    );
    await mkdir(join(root, ".obsidian"));
    await writeFile(join(root, ".obsidian/app.json"), "{}");
    await writeFile(join(root, "docs/draft.md"), "draft\n");
    assert.deepEqual(
      (await store.listTree()).map((node) => `${node.type}:${node.path}`),
      ["dir:docs", "file:docs/a.md", "file:docs/draft.md"],
    );
    assert.deepEqual(
      (await store.listTree("docs")).map((node) => node.path),
      ["docs/a.md", "docs/draft.md"],
    );
  });

  test("bounds byte reads and follows a file's history across a rename", async () => {
    await store.commitChanges(
      [{ op: "write", path: "a.md", content: "0123456789" }],
      meta("Write a"),
    );
    const bytes = await store.readBytes("a.md", 4);
    assert.equal(bytes.content.toString(), "0123");
    assert.equal(bytes.truncated, true);
    await store.move("a.md", "b.md", meta("Rename a"));
    assert.deepEqual(
      (await store.history({ path: "b.md" })).map((row) => row.subject),
      ["Rename a", "Write a"],
    );
    const [head] = await store.history({ limit: 1 });
    const patch = await store.showCommit(head!.commit, { maxChars: 10_000 });
    assert.match(patch.patch, /rename to b\.md/);
    await assert.rejects(store.showCommit("--output=/tmp/x", { maxChars: 10 }));
  });
});
