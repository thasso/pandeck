import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import {
  GitCommandError,
  git,
  gitBoundedStdout,
  gitRawStdout,
  gitWithInputOptional,
} from "../gitExec.ts";
import { createGitFamily } from "../gitFamily.ts";
import { localGitRunner } from "../gitProcess.ts";
import { WRONG_WORKER, encodeRun } from "../workerProtocol/checkoutMethods.ts";
import { WorkerRequestError } from "../workerProtocol/connection.ts";
import {
  ensureInProcessWorker,
  inProcessWorkerServedForTests,
} from "../workers/inProcessWorker.ts";
import { getWorktreeFileRaw } from "../worktrees/worktreeDiff.ts";

/** The same executors over a runner that never leaves this process. */
const local = createGitFamily(localGitRunner);
const MiB = 1024 * 1024;
const MAX_RAW_BYTES = 20 * MiB;

let repo: string;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "worker-checkout-git-"));
  await local.git(["init", "-q", "-b", "main"], repo);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Store `content` as a blob and answer its oid. */
async function blob(content: Buffer): Promise<string> {
  const path = join(repo, "blob.bin");
  writeFileSync(path, content);
  return (await local.git(["hash-object", "-w", path], repo)).stdout.trim();
}

/** Bytes that are neither text nor valid UTF-8. */
function binary(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 151 + 7) & 0xff;
  return bytes;
}

/**
 * The spawn broker's JSON line carries these sizes too, at seconds per call
 * on the local path and the Worker path alike (base64 and control-character
 * escapes; measured 20 MiB raw 4.9 s vs 4.7 s, 32 MiB stdin 12.4 s vs 12.1 s).
 * That cost is not under test, so these children start in-process: the
 * Worker protocol still carries every byte.
 */
describe("payloads of every supported size", () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.ASSISTANT_SPAWN_BROKER;
    process.env.ASSISTANT_SPAWN_BROKER = "0";
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.ASSISTANT_SPAWN_BROKER;
    else process.env.ASSISTANT_SPAWN_BROKER = saved;
  });

  test("a 20 MiB raw file crosses intact; a larger one answers as before", async () => {
    const row = { path: repo } as WorktreeRow;
    const commit = async (name: string, content: Buffer) => {
      writeFileSync(join(repo, name), content);
      await local.git(["add", name], repo);
      await local.git(
        ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", name],
        repo,
      );
    };
    const exact = binary(MAX_RAW_BYTES);
    await commit("exact.bin", exact);
    const served = await getWorktreeFileRaw(row, "exact.bin", "HEAD");
    assert.ok(served.content.equals(exact));

    // One byte over the limit fits the read and is refused as too large; two
    // bytes over overflow the read itself.
    await commit("over.bin", binary(MAX_RAW_BYTES + 1));
    await assert.rejects(getWorktreeFileRaw(row, "over.bin", "HEAD"), {
      message: "File is too large to serve raw.",
    });
    await commit("overflow.bin", binary(MAX_RAW_BYTES + 2));
    await assert.rejects(getWorktreeFileRaw(row, "overflow.bin", "HEAD"), {
      message: "File not found at that revision.",
    });
  });

  test("32 MiB of stdin reaches git whole", async () => {
    const input = binary(32 * MiB);
    const expected = createHash("sha1")
      .update(`blob ${input.length}\0`)
      .update(input)
      .digest("hex");
    const result = await gitWithInputOptional(
      ["hash-object", "--stdin"],
      repo,
      input,
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), expected);
  });

  test("12 MiB of control characters and invalid UTF-8 come back as a local run's", async () => {
    const controls = Buffer.alloc(12 * MiB);
    for (let i = 0; i < controls.length; i++) controls[i] = i % 3 === 0 ? 1 : 0;
    const text = await blob(controls);
    const crossed = await git(["cat-file", "blob", text], repo);
    const here = await local.git(["cat-file", "blob", text], repo);
    assert.equal(crossed.stdout.length, controls.length);
    assert.ok(crossed.stdout === here.stdout, "same text, unit for unit");
    assert.deepEqual({ ...crossed, stdout: "" }, { ...here, stdout: "" });

    const bytes = binary(3 * MiB + 17);
    const raw = await blob(bytes);
    const crossedRaw = await gitRawStdout(["cat-file", "blob", raw], repo);
    const hereRaw = await local.gitRawStdout(["cat-file", "blob", raw], repo);
    assert.ok(crossedRaw.content.equals(bytes));
    assert.deepEqual(crossedRaw, hereRaw);
  });

  test("an output over maxBuffer fails as a local run does", async () => {
    const oid = await blob(binary(2 * MiB));
    const crossed = await gitRawStdout(["cat-file", "blob", oid], repo, MiB);
    const here = await local.gitRawStdout(["cat-file", "blob", oid], repo, MiB);
    assert.notEqual(here.code, 0);
    assert.deepEqual(crossed, here);

    const big = await blob(Buffer.alloc(12 * MiB + 1, 0x61));
    const failures = await Promise.all(
      [git, local.git].map((run) =>
        run(["cat-file", "blob", big], repo).then(
          () => assert.fail("over the exec buffer"),
          (error: unknown) => error,
        ),
      ),
    );
    for (const error of failures) assert.ok(error instanceof GitCommandError);
    const [crossedError, hereError] = failures as GitCommandError[];
    assert.equal(crossedError!.message, hereError!.message);
    assert.equal(crossedError!.failureKind, hereError!.failureKind);
    assert.equal(crossedError!.result.code, hereError!.result.code);
    assert.equal(crossedError!.result.stderr, hereError!.result.stderr);
    assert.ok(crossedError!.result.stdout === hereError!.result.stdout);
  });
});

test("a location naming another Worker is refused before anything runs", async () => {
  const marker = join(repo, "ran");
  const { method, payload } = encodeRun({
    location: { workerId: "elsewhere", path: repo },
    args: ["-c", `alias.mark=!touch '${marker}'`, "mark"],
    mode: "mutating",
    maxBuffer: MiB,
  });
  const before = inProcessWorkerServedForTests();
  await assert.rejects(
    ensureInProcessWorker().request(method, payload),
    (error: unknown) => {
      assert.ok(error instanceof WorkerRequestError);
      assert.equal(error.code, WRONG_WORKER);
      assert.match(error.message, /"elsewhere", not "local"/);
      return true;
    },
  );
  assert.equal(inProcessWorkerServedForTests() - before, 1, "it was decoded");
  assert.equal(existsSync(marker), false, "and git never ran");
});

test("a bounded read cut inside a surrogate pair keeps the exact code units", async () => {
  const oid = await blob(Buffer.from("😀abc", "utf8"));
  const args = ["cat-file", "blob", oid];

  const one = await gitBoundedStdout(args, repo, 1);
  assert.equal(one.patch.length, 1);
  assert.equal(one.patch.charCodeAt(0), 0xd83d);
  assert.equal(one.totalChars, "😀abc".length);
  assert.equal(one.totalChars, 5);
  assert.equal(one.truncated, true);
  assert.deepEqual(one, await local.gitBoundedStdout(args, repo, 1));

  const three = await gitBoundedStdout(args, repo, 3);
  assert.equal(three.patch, "😀a");
  assert.deepEqual(
    [...three.patch].map((c) => c.codePointAt(0)),
    [0x1f600, 0x61],
  );
  assert.equal(three.truncated, true);
  assert.deepEqual(three, await local.gitBoundedStdout(args, repo, 3));
});
