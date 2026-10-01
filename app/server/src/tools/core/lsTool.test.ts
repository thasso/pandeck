/**
 * Task 319: the ported `ls` tool's observable contract — the sort, the `/`
 * suffix, the two bounds and their notices, path resolution (relative, absolute,
 * `~`, and the app-`CWD` fallback, all of which the port added over pi), and the
 * paths that throw.
 *
 *   pnpm --filter @assistant/server test src/tools/core/lsTool.test.ts
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { ToolCallContext, ToolResult } from "../../mcp/tool.ts";

const root = mkdtempSync(join(tmpdir(), "ls-tool-"));

// The app `CWD` is frozen when `config.ts` is imported, so it has to be pointed
// at the fixture root BEFORE `lsTool.ts` pulls it in — that is what the
// no-session-cwd fallback test below exercises.
process.env.DATA_DIR = join(root, "data");
process.env.ASSISTANT_CWD = join(root, "app-cwd");
mkdirSync(process.env.ASSISTANT_CWD, { recursive: true });
writeFileSync(join(process.env.ASSISTANT_CWD, "from-app-cwd.txt"), "x");

const { lsTool } = await import("./lsTool.ts");

afterAll(() => rmSync(root, { recursive: true, force: true }));

function ctxIn(cwd?: string, signal?: AbortSignal): ToolCallContext {
  return {
    toolCallId: "ls-tool-test",
    session: {
      sessionId: "ls-tool-test-session",
      harness: "pi",
      agentType: "developer",
      ...(cwd === undefined ? {} : { cwd }),
    },
    ...(signal !== undefined ? { signal } : {}),
  };
}

const run = (
  params: { path?: string; limit?: number },
  cwd?: string,
  signal?: AbortSignal,
): Promise<ToolResult> => lsTool.execute(params, ctxIn(cwd, signal));

const textOf = (result: ToolResult): string => {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  return block.type === "text" ? block.text : "";
};

/** A directory with the given files (and `dirs/` as directories). */
function fixture(name: string, files: string[], dirs: string[] = []): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(join(dir, file), "x");
  for (const sub of dirs) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

test("entries sort case-insensitively, directories get '/', dotfiles are listed", async () => {
  const dir = fixture("sorted", ["beta.ts", ".hidden", "Alpha.ts"], ["zsub"]);
  const result = await run({}, dir);
  assert.deepEqual(textOf(result).split("\n"), [
    ".hidden",
    "Alpha.ts",
    "beta.ts",
    "zsub/",
  ]);
  // No bound was hit, so there is nothing to report beyond the path.
  assert.deepEqual(result.details, { path: dir });
});

test("path is resolved against the session cwd and accepts an absolute path", async () => {
  const dir = fixture(join("nested", "child"), ["only.txt"]);
  assert.equal(
    textOf(await run({ path: "child" }, join(root, "nested"))),
    "only.txt",
  );
  assert.equal(textOf(await run({ path: dir }, root)), "only.txt");
});

test("`~` and `~/sub` expand against the home directory", async () => {
  const home = fixture("fake-home", ["in-home.txt"], ["sub"]);
  writeFileSync(join(home, "sub", "in-sub.txt"), "x");
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(homedir(), home, "HOME override must reach os.homedir()");
    assert.deepEqual(textOf(await run({ path: "~" }, root)).split("\n"), [
      "in-home.txt",
      "sub/",
    ]);
    assert.equal(textOf(await run({ path: "~/sub" }, root)), "in-sub.txt");
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
});

test("a session without a cwd falls back to the app CWD", async () => {
  // The Claude and pi wirings both populate `ctx.session.cwd`; this is the
  // documented fallback, and the only way to reach it is to omit the field.
  assert.equal(textOf(await run({})), "from-app-cwd.txt");
});

test("the entry limit truncates and reports how to raise it", async () => {
  const dir = fixture(
    "limited",
    Array.from({ length: 5 }, (_, i) => `f${i}.txt`),
  );
  const result = await run({ limit: 2 }, dir);
  assert.equal(
    textOf(result),
    "f0.txt\nf1.txt\n\n[2 entries limit reached. Use limit=4 for more]",
  );
  assert.deepEqual(result.details, { path: dir, entryLimitReached: 2 });
});

/** 300 names of ~200 bytes: ~60KB, past the byte bound, under the entry cap. */
function longNames(): string[] {
  return Array.from(
    { length: 300 },
    (_, i) => `${String(i).padStart(3, "0")}-${"n".repeat(200)}.txt`,
  );
}

test("the 50KB bound drops whole trailing lines and reports the byte limit", async () => {
  const names = longNames();
  const dir = fixture("bytes", names);
  const result = await run({}, dir);
  const text = textOf(result);
  assert.match(text, /\n\n\[50KB limit reached\]$/);
  const listed = text.split("\n\n[")[0]!.split("\n");
  assert.ok(
    listed.length > 0 && listed.length < names.length,
    `expected a partial listing, got ${listed.length} of ${names.length}`,
  );
  // Only whole lines survive, in order, from the head.
  assert.deepEqual(listed, names.slice(0, listed.length));
  const truncation = (result.details as { truncation: { outputBytes: number } })
    .truncation;
  assert.ok(truncation.outputBytes <= 50 * 1024);
});

test("both notices appear together when both bounds are hit", async () => {
  const dir = fixture("both", longNames());
  const result = await run({ limit: 299 }, dir);
  assert.match(
    textOf(result),
    /\n\n\[299 entries limit reached\. Use limit=598 for more\. 50KB limit reached\]$/,
  );
});

test("an entry that cannot be stat'd is skipped, not reported", async () => {
  const dir = fixture("broken-link", ["real.txt"]);
  symlinkSync(join(dir, "does-not-exist"), join(dir, "dangling"));
  assert.equal(textOf(await run({}, dir)), "real.txt");
});

test("an empty directory says so, and still reports the resolved path", async () => {
  const dir = fixture("empty", []);
  const result = await run({}, dir);
  assert.equal(textOf(result), "(empty directory)");
  assert.deepEqual(result.details, { path: dir });
});

test("a missing path, a file, and an aborted call all throw", async () => {
  const dir = fixture("throws", ["file.txt"]);
  await assert.rejects(() => run({ path: "nope" }, dir), /Path not found/);
  await assert.rejects(() => run({ path: "file.txt" }, dir), /Not a directory/);
  await assert.rejects(
    () => run({}, dir, AbortSignal.abort()),
    /Operation aborted/,
  );
});

test.skipIf(process.getuid?.() === 0)(
  "an unreadable directory throws rather than reporting an empty listing",
  async () => {
    const dir = fixture("unreadable", ["hidden.txt"]);
    chmodSync(dir, 0o000);
    try {
      await assert.rejects(() => run({}, dir), /Cannot read directory/);
    } finally {
      // Restore before afterAll, or the cleanup cannot remove the tree.
      chmodSync(dir, 0o700);
    }
  },
);
