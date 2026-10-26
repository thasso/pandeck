import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { commitWithMessageFile } from "./commitMessageFile.ts";

// Passthrough `node:fs` with one hook: the message file's write fails, after
// its directory was created.
const writeHook = vi.hoisted(() => ({ fail: undefined as Error | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const failure = writeHook.fail;
      writeHook.fail = undefined;
      if (failure) throw failure;
      return actual.writeFileSync(...args);
    },
  };
});

const MESSAGE = "  Subject line\n\n# kept\nBody  \n\n";
const savedTmpdir = process.env.TMPDIR;
let scratch: string;
let tmp: string;

beforeEach(() => {
  scratch = mkdtempSync(join(realpathSync(tmpdir()), "commit-message-file-"));
  tmp = join(scratch, "tmp");
  mkdirSync(tmp);
  process.env.TMPDIR = tmp;
});

afterEach(() => {
  writeHook.fail = undefined;
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  rmSync(scratch, { recursive: true, force: true });
});

/** A `runGit` recording its argv and the message file as the call saw it. */
function recording(outcome: () => Promise<unknown> = async () => undefined) {
  const calls: Array<{ args: string[]; file: string; content: string }> = [];
  const runGit = async (args: string[]) => {
    const file = args.at(-1)!;
    calls.push({ args, file, content: readFileSync(file, "utf8") });
    return outcome();
  };
  return { calls, runGit };
}

/** The one message file a call used: `<TMPDIR>/assistant-commit-*`. */
function messageFileOf(file: string): string {
  const [dir, ...rest] = file.slice(tmp.length + 1).split("/");
  assert.equal(file.slice(0, tmp.length + 1), `${tmp}/`);
  assert.match(dir!, /^assistant-commit-.{6}$/);
  assert.deepEqual(rest, ["COMMIT_MESSAGE"]);
  return dir!;
}

test.each([
  ["verbatim", ["commit", "--cleanup=verbatim", "-F"]],
  ["git-default", ["commit", "-F"]],
] as const)(
  "%s: one git call with exactly its argv, the file present, then removed",
  async (cleanup, argv) => {
    const { calls, runGit } = recording();
    await commitWithMessageFile(MESSAGE, cleanup, runGit);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.deepEqual(call!.args, [...argv, call!.file]);
    messageFileOf(call!.file);
    assert.equal(call!.content, `${MESSAGE.trim()}\n`);
    assert.deepEqual(readdirSync(tmp), []);
  },
);

test("a git rejection is the call's rejection, and the file is removed", async () => {
  const sentinel = new Error("sentinel");
  const { calls, runGit } = recording(async () => {
    throw sentinel;
  });
  await assert.rejects(
    commitWithMessageFile(MESSAGE, "git-default", runGit),
    (error) => error === sentinel,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(readdirSync(tmp), []);
});

test("a creation failure (a TMPDIR that is not a directory) runs no git", async () => {
  const notADirectory = join(scratch, "file");
  writeFileSync(notADirectory, "");
  process.env.TMPDIR = notADirectory;
  const { calls, runGit } = recording();
  await assert.rejects(
    commitWithMessageFile(MESSAGE, "verbatim", runGit),
    (error: NodeJS.ErrnoException) => error.code === "ENOTDIR",
  );
  assert.equal(calls.length, 0);
  assert.ok(statSync(notADirectory).isFile());
});

test("a write failure after creation runs no git and leaves the directory", async () => {
  const failure = Object.assign(new Error("ENOSPC: injected"), {
    code: "ENOSPC",
  });
  writeHook.fail = failure;
  const { calls, runGit } = recording();
  await assert.rejects(
    commitWithMessageFile(MESSAGE, "verbatim", runGit),
    (error) => error === failure,
  );
  assert.equal(calls.length, 0);
  // As base: the write runs before the cleanup's `try`, so nothing removes
  // the directory; the fixture's teardown does.
  const left = readdirSync(tmp);
  assert.equal(left.length, 1);
  assert.match(left[0]!, /^assistant-commit-/);
  assert.deepEqual(readdirSync(join(tmp, left[0]!)), []);
});
