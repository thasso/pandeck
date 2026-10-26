import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, test, vi } from "vitest";
import {
  checkoutPathExists,
  inspectCheckoutPath,
  readCheckoutFile,
  readCheckoutLink,
  throwInCheckoutReadForTests,
} from "./checkoutFileAccess.ts";
import type { CommitAgentResult } from "./commitAgent.ts";
import {
  runCommitWorkflow,
  setCommitMessageGeneratorForTests,
  untrackedFingerprintForTests,
  type CommitWorkflowResult,
} from "./commitWorkflow.ts";
import { errorText } from "./errors.ts";
import { fileReadsCountsForTests, holdFileForTests } from "./fileReads.ts";
import { updateSettings } from "./settings.ts";
import {
  MALFORMED_ANSWERS,
  answerForPathForTests,
  answeredFailure,
  answering,
  recordServedForTests,
} from "./test/workerAnswers.ts";
import { WorkerMethodError } from "./workerProtocol/connection.ts";
import { FILE_METHODS } from "./workerProtocol/fileMethods.ts";
import { isWorkerFailure } from "./workers/fileClient.ts";
import {
  inProcessWorkerFileHandlesForTests,
  inProcessWorkerServedForTests,
  writeAsInProcessWorkerForTests,
} from "./workers/inProcessWorker.ts";

/**
 * The commit workflow's checkout reads (`docs/workers.md`, "Checkout files"):
 * every checkout reads through the in-process Worker over the real codec, one
 * inside the Knowledge Base root too, since placement is typed and the
 * workflow never holds the KB row. Every expected value is base's, computed
 * below by verbatim copies of base's code over sync `fs`.
 */

// Passthrough git seam with one hook: right before the workflow takes the
// repository lock.
const gitHooks = vi.hoisted(() => ({
  beforeLock: undefined as (() => void) | undefined,
}));
vi.mock("./gitExec.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gitExec.ts")>();
  return {
    ...actual,
    withRepoLock: async <T>(key: string, fn: () => Promise<T>) => {
      const hook = gitHooks.beforeLock;
      gitHooks.beforeLock = undefined;
      hook?.();
      return actual.withRepoLock(key, fn);
    },
  };
});

const INVALID_FRAME = new Uint8Array(8);
const MARKER_REASON = "A merge or rebase appears to be in progress.";

let scratch: string;
let kb: string;
let next = 0;

beforeAll(() => {
  // Canonical from the start, so git's and the Worker's spellings agree.
  scratch = mkdtempSync(join(realpathSync(tmpdir()), "workflow-reads-"));
  kb = join(scratch, "kb");
  mkdirSync(kb);
  updateSettings({
    knowledgeBase: { enabled: true, path: kb, effectivePath: "ignored" },
  });
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1)
    await new Promise<void>((done) => setImmediate(done));
}

afterEach(async () => {
  gitHooks.beforeLock = undefined;
  setCommitMessageGeneratorForTests(null);
  await settle();
  assert.equal(inProcessWorkerFileHandlesForTests(), 0, "handles held");
  assert.equal(
    fileReadsCountsForTests().liveDescriptors,
    0,
    "descriptors open",
  );
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** A checkout on branch `feature` with one committed file; on a Worker by default. */
function repo(parent = scratch): string {
  const cwd = join(parent, `repo-${(next += 1)}`);
  mkdirSync(cwd);
  sh(cwd, "init", "-q", "-b", "main");
  sh(cwd, "config", "user.name", "Test User");
  sh(cwd, "config", "user.email", "test@example.com");
  writeFileSync(join(cwd, "file.txt"), "base\n");
  sh(cwd, "add", "-A");
  sh(cwd, "commit", "-qm", "base");
  sh(cwd, "switch", "-q", "-c", "feature");
  return cwd;
}

/** A linked worktree of a fresh checkout; its git dir is under `.git/worktrees/`. */
function linked(): string {
  const main = repo();
  const path = `${main}-linked`;
  sh(main, "worktree", "add", "-q", "-b", "linked", path);
  return path;
}

const generated: CommitAgentResult = {
  status: "commit",
  subject: "Update checked content",
  body: ["Keep the generated message workflow."],
  blockers: [],
  warnings: [],
};

/** A dry run, answering its result and the prompt the commit agent saw. */
async function dryRun(
  cwd: string,
): Promise<{ result: CommitWorkflowResult; prompt: string | undefined }> {
  let prompt: string | undefined;
  setCommitMessageGeneratorForTests(async (text) => {
    prompt = text;
    return generated;
  });
  const result = await runCommitWorkflow({ source: "tool", cwd, dryRun: true });
  return { result, prompt };
}

/** The approved-change commit of a dry run's proposal; `beforeLock` runs first. */
async function approved(
  cwd: string,
  beforeLock?: () => void,
): Promise<CommitWorkflowResult> {
  const proposal = (await dryRun(cwd)).result;
  assert.equal(proposal.status, "dry-run");
  gitHooks.beforeLock = beforeLock;
  return runCommitWorkflow({
    source: "tool",
    cwd,
    force: true,
    forceRefusesSecrets: true,
    approvedChange: {
      fingerprint: proposal.changeFingerprint!,
      message: proposal.commitMessage!,
    },
  });
}

const absoluteGitDir = (cwd: string) =>
  sh(cwd, "rev-parse", "--absolute-git-dir").trim();

function untracked(cwd: string): string[] {
  return sh(cwd, "ls-files", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean);
}

function assertNothingCommitted(cwd: string): void {
  assert.equal(sh(cwd, "diff", "--cached", "--name-only"), "");
  assert.equal(sh(cwd, "log", "--oneline").trim().split("\n").length, 1);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

/**
 * Like `answerForPathForTests`, for the `nth` request of `method` naming
 * `path`; the ones before it are served as usual.
 */
function answerNthForPath(
  method: string,
  path: string,
  nth: number,
  substitute: Parameters<typeof answerForPathForTests>[2],
): () => void {
  let disarm = () => {};
  const at = (left: number): (() => void) =>
    answerForPathForTests(
      method,
      path,
      left === 1
        ? substitute
        : (payload, signal, real) => {
            disarm = at(left - 1);
            return real(payload, signal);
          },
    );
  disarm = at(nth);
  return () => disarm();
}

// --- Base, verbatim (main 0fc22f5, commitWorkflow.ts), over sync `fs` -----

const MAX_UNTRACKED_FILE_CHARS = 12_000;
const MAX_UNTRACKED_TOTAL_CHARS = 60_000;

interface UntrackedSummary {
  path: string;
  included: boolean;
  reason?: string;
  content?: string;
}

function isProbablyText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function readUntrackedSummaries(
  repoRoot: string,
  files: string[],
): UntrackedSummary[] {
  const summaries: UntrackedSummary[] = [];
  let remaining = MAX_UNTRACKED_TOTAL_CHARS;
  for (const path of files.slice(0, 80)) {
    const absolute = join(repoRoot, path);
    try {
      if (lstatSync(absolute).isSymbolicLink()) {
        summaries.push({
          path,
          included: true,
          content: readlinkSync(absolute),
        });
        continue;
      }
      const buffer = readFileSync(absolute);
      if (buffer.length === 0) {
        summaries.push({ path, included: true, content: "" });
        continue;
      }
      if (buffer.length > 256_000) {
        summaries.push({
          path,
          included: false,
          reason: `large file (${buffer.length} bytes)`,
        });
        continue;
      }
      if (!isProbablyText(buffer.subarray(0, Math.min(buffer.length, 8192)))) {
        summaries.push({
          path,
          included: false,
          reason: `binary or non-UTF-8 file (${buffer.length} bytes)`,
        });
        continue;
      }
      const max = Math.min(MAX_UNTRACKED_FILE_CHARS, Math.max(0, remaining));
      const content = buffer.toString("utf8");
      const truncated = content.length > max;
      const shown = truncated
        ? `${content.slice(0, max)}\n[TRUNCATED ${content.length - max} characters]`
        : content;
      remaining -= shown.length;
      summaries.push({ path, included: true, content: shown });
    } catch (err) {
      summaries.push({
        path,
        included: false,
        reason: `could not read: ${errorText(err)}`,
      });
    }
  }
  if (files.length > 80) {
    summaries.push({
      path: `... ${files.length - 80} more untracked files`,
      included: false,
      reason: "not listed",
    });
  }
  return summaries;
}

function renderUntrackedSummaries(summaries: UntrackedSummary[]): string {
  if (summaries.length === 0) return "";
  return summaries
    .map((item) => {
      if (!item.included)
        return `Untracked file: ${item.path}\n[content omitted: ${item.reason ?? "not included"}]`;
      return [
        `Untracked file: ${item.path}`,
        "```",
        item.content ?? "",
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

/** Base's per-path values and digest; `hash-object` run the same way. */
function baseFingerprint(
  repoRoot: string,
  files: string[],
): { values: Map<string, string>; digest: string } {
  const values = new Map<string, string>();
  const regularFiles: Array<{ path: string; executable: boolean }> = [];
  for (const path of files) {
    try {
      const stat = lstatSync(join(repoRoot, path));
      if (stat.isSymbolicLink()) {
        values.set(path, `symlink:${readlinkSync(join(repoRoot, path))}`);
      } else if (stat.isFile()) {
        regularFiles.push({ path, executable: Boolean(stat.mode & 0o111) });
      } else {
        values.set(path, `special:${stat.mode}`);
      }
    } catch {
      values.set(path, "unreadable");
    }
  }
  for (let offset = 0; offset < regularFiles.length; offset += 100) {
    const batch = regularFiles.slice(offset, offset + 100);
    const hashes = sh(
      repoRoot,
      "hash-object",
      "--",
      ...batch.map((file) => file.path),
    )
      .trimEnd()
      .split("\n");
    for (let index = 0; index < batch.length; index += 1) {
      const file = batch[index]!;
      values.set(
        file.path,
        `file:${file.executable ? "x" : "-"}:${hashes[index]!}`,
      );
    }
  }
  const fingerprint = createHash("sha256");
  for (const path of files)
    fingerprint
      .update(path)
      .update("\0")
      .update(values.get(path) ?? "unreadable")
      .update("\0");
  return { values, digest: fingerprint.digest("hex") };
}

// ---------------------------------------------------------------------------

/** Every AC2 fixture kind, untracked in `cwd`. */
function untrackedFixtures(cwd: string): void {
  const at = (name: string) => join(cwd, name);
  writeFileSync(at("mode-0644.txt"), "plain\n");
  chmodSync(at("mode-0644.txt"), 0o644);
  writeFileSync(at("mode-0755.sh"), "#!/bin/sh\necho run\n");
  chmodSync(at("mode-0755.sh"), 0o755);
  writeFileSync(at("empty.txt"), "");
  writeFileSync(at("nul.bin"), Buffer.from([0x61, 0x00, 0x62]));
  writeFileSync(at("latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  writeFileSync(at("size-256000.txt"), "x".repeat(256_000));
  writeFileSync(at("size-256001.txt"), "x".repeat(256_001));
  writeFileSync(at("long.txt"), "y".repeat(MAX_UNTRACKED_FILE_CHARS + 500));
  symlinkSync("mode-0644.txt", at("link"));
  symlinkSync("missing-target", at("dangling"));
  symlinkSync(Buffer.from([0x62, 0x61, 0x64, 0xff]), at("bad-utf8-link"));
  // An untracked nested repository: `ls-files` lists it as `nested/`.
  mkdirSync(at("nested"));
  sh(at("nested"), "init", "-q", "-b", "main");
  writeFileSync(at("nested/inner.txt"), "inner\n");
}

describe("AC1 the commit's reads reach the Worker", () => {
  test("a dry run serves each untracked path and the first marker", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "note.txt"), "note\n");
    symlinkSync("note.txt", join(cwd, "link"));
    const note = join(cwd, "note.txt");
    const link = join(cwd, "link");
    const gitDir = absoluteGitDir(cwd);
    const recorder = recordServedForTests([
      FILE_METHODS.inspect,
      FILE_METHODS.readlink,
      FILE_METHODS.open,
      FILE_METHODS.read,
      FILE_METHODS.close,
      FILE_METHODS.exists,
    ]);
    let result: CommitWorkflowResult;
    try {
      ({ result } = await dryRun(cwd));
    } finally {
      recorder.stop();
    }
    assert.equal(result.status, "dry-run");
    // The fingerprint, then the summaries; in `ls-files` order.
    assert.deepEqual(
      recorder
        .pathsOf(FILE_METHODS.inspect)
        .filter((path) => path === note || path === link),
      [link, note, link, note],
    );
    assert.deepEqual(recorder.pathsOf(FILE_METHODS.readlink), [link, link]);
    assert.deepEqual(recorder.pathsOf(FILE_METHODS.open), [note]);
    assert.deepEqual(recorder.pathsOf(FILE_METHODS.read), [note]);
    assert.deepEqual(recorder.pathsOf(FILE_METHODS.close), [note]);
    assert.deepEqual(recorder.pathsOf(FILE_METHODS.exists), [
      join(gitDir, "MERGE_HEAD"),
      join(gitDir, "rebase-merge"),
      join(gitDir, "rebase-apply"),
    ]);
  });

  test("a project inside the Knowledge Base root reads on the Worker", async () => {
    const cwd = repo(kb);
    writeFileSync(join(cwd, "note.txt"), "note\n");
    symlinkSync("note.txt", join(cwd, "link"));
    const served = inProcessWorkerServedForTests();
    const { result, prompt } = await dryRun(cwd);
    assert.equal(result.status, "dry-run");
    assert.ok(inProcessWorkerServedForTests() > served);
    assert.ok(prompt?.includes("Untracked file: link\n```\nnote.txt\n```"));
  });
});

describe("AC2 untracked summaries and fingerprint as base", () => {
  test("every fixture kind", async () => {
    const cwd = repo();
    untrackedFixtures(cwd);
    const files = untracked(cwd);
    assert.ok(files.includes("nested/"), files.join(","));
    const expected = renderUntrackedSummaries(
      readUntrackedSummaries(cwd, files),
    );
    assert.ok(
      expected.includes(
        "Untracked file: nested/\n[content omitted: could not read: EISDIR: illegal operation on a directory, read]",
      ),
    );
    const { result, prompt } = await dryRun(cwd);
    assert.equal(result.status, "dry-run");
    assert.ok(prompt?.includes(expected), "the prompt's untracked section");

    const base = baseFingerprint(cwd, files);
    const fingerprint = await untrackedFingerprintForTests(cwd, files);
    assert.deepEqual(fingerprint.values, base.values);
    assert.equal(fingerprint.digest, base.digest);
    assert.match(base.values.get("mode-0755.sh")!, /^file:x:/);
    assert.match(base.values.get("mode-0644.txt")!, /^file:-:/);
    assert.match(base.values.get("nested/")!, /^special:\d+$/);
  });

  test("81 files: the summaries' cap", async () => {
    const cwd = repo();
    for (let index = 0; index < 81; index += 1)
      writeFileSync(
        join(cwd, `untracked-${String(index).padStart(3, "0")}.txt`),
        `${"z".repeat(1000)}${index}\n`,
      );
    const files = untracked(cwd);
    const expected = renderUntrackedSummaries(
      readUntrackedSummaries(cwd, files),
    );
    assert.ok(expected.endsWith("[content omitted: not listed]"));
    const { prompt } = await dryRun(cwd);
    assert.ok(prompt?.includes(expected));
    const base = baseFingerprint(cwd, files);
    assert.equal(
      (await untrackedFingerprintForTests(cwd, files)).digest,
      base.digest,
    );
  });
});

const MARKERS = [
  ["MERGE_HEAD", 1],
  ["rebase-merge", 2],
  ["rebase-apply", 3],
] as const;

function placeMarker(gitDir: string, marker: string, cwd: string): () => void {
  const path = join(gitDir, marker);
  if (marker === "MERGE_HEAD")
    writeFileSync(path, `${sh(cwd, "rev-parse", "HEAD").trim()}\n`);
  else mkdirSync(path);
  return () => rmSync(path, { recursive: true, force: true });
}

describe("AC3 an operation in progress blocks as base", () => {
  const CHECKOUTS = [
    ["a main checkout", () => repo()],
    ["a linked worktree", linked],
  ] as const;

  test.each(
    CHECKOUTS.flatMap(([kind, make]) =>
      MARKERS.map(([marker, probes]) => ({ kind, make, marker, probes })),
    ),
  )("$marker in $kind", async ({ make, marker, probes }) => {
    const cwd = make();
    writeFileSync(join(cwd, "file.txt"), "changed\n");
    const gitDir = absoluteGitDir(cwd);
    const order = MARKERS.map(([name]) => join(gitDir, name));

    const remove = placeMarker(gitDir, marker, cwd);
    const recorder = recordServedForTests([FILE_METHODS.exists]);
    let blocked: CommitWorkflowResult;
    try {
      ({ result: blocked } = await dryRun(cwd));
    } finally {
      recorder.stop();
      remove();
    }
    assert.ok(
      blocked.blockers.some(({ reason }) => reason === MARKER_REASON),
      JSON.stringify(blocked.blockers),
    );
    // The first marker found ends the probe.
    assert.deepEqual(
      recorder.pathsOf(FILE_METHODS.exists),
      order.slice(0, probes),
    );

    const clean = (await dryRun(cwd)).result;
    assert.ok(!clean.blockers.some(({ reason }) => reason === MARKER_REASON));

    let removeLocked = () => {};
    const lockedRecorder = recordServedForTests([FILE_METHODS.exists]);
    let refused: CommitWorkflowResult;
    try {
      refused = await approved(cwd, () => {
        removeLocked = placeMarker(gitDir, marker, cwd);
      });
    } finally {
      lockedRecorder.stop();
      removeLocked();
    }
    assert.equal(refused.status, "blocked");
    assert.deepEqual(refused.blockers, [
      { kind: "unsafe", reason: MARKER_REASON },
    ]);
    // The proposal's three and the fresh review's three, both before the
    // marker; then the approved change's probe under the lock.
    assert.deepEqual(lockedRecorder.pathsOf(FILE_METHODS.exists), [
      ...order,
      ...order,
      ...order.slice(0, probes),
    ]);
    assertNothingCommitted(cwd);
  });
});

/** One commit read, by the Worker request it makes and that request's turn. */
interface CommitSite {
  name: string;
  method: string;
  /** The path the request names, in the checkout at `cwd`. */
  path: (cwd: string) => string;
  /** Which request naming that path. */
  nth: number;
  phase: Parameters<typeof holdFileForTests>[1];
  /** The same read, made directly: its error is the expected one. */
  direct: (cwd: string, path: string) => Promise<unknown>;
  /** Through the approved change's probe, under the lock. */
  locked?: boolean;
}

const COMMIT_SITES: CommitSite[] = [
  {
    name: "R1 fingerprint inspect",
    method: FILE_METHODS.inspect,
    path: (cwd) => join(cwd, "note.txt"),
    nth: 1,
    phase: "inspect",
    direct: (cwd, path) =>
      inspectCheckoutPath(cwd, path, { follow: false, mode: true }),
  },
  {
    name: "R2 fingerprint readlink",
    method: FILE_METHODS.readlink,
    path: (cwd) => join(cwd, "link"),
    nth: 1,
    phase: "readlink",
    direct: readCheckoutLink,
  },
  {
    name: "R3 summary inspect",
    method: FILE_METHODS.inspect,
    path: (cwd) => join(cwd, "note.txt"),
    nth: 2,
    phase: "inspect",
    direct: (cwd, path) => inspectCheckoutPath(cwd, path, { follow: false }),
  },
  {
    name: "R4 summary readlink",
    method: FILE_METHODS.readlink,
    path: (cwd) => join(cwd, "link"),
    nth: 2,
    phase: "readlink",
    direct: readCheckoutLink,
  },
  {
    name: "R5 summary read",
    method: FILE_METHODS.open,
    path: (cwd) => join(cwd, "note.txt"),
    nth: 1,
    phase: "before-open",
    direct: (cwd, path) => readCheckoutFile(cwd, path),
  },
  {
    name: "R6 findings marker",
    method: FILE_METHODS.exists,
    path: (cwd) => join(absoluteGitDir(cwd), "MERGE_HEAD"),
    nth: 1,
    phase: "exists",
    direct: checkoutPathExists,
  },
  {
    name: "R6 approved-change marker",
    method: FILE_METHODS.exists,
    path: (cwd) => join(absoluteGitDir(cwd), "MERGE_HEAD"),
    nth: 1,
    phase: "exists",
    direct: checkoutPathExists,
    locked: true,
  },
];

/** A checkout with a tracked change, an untracked file and an untracked link. */
function commitFixture(): string {
  const cwd = repo();
  writeFileSync(join(cwd, "file.txt"), "changed\n");
  writeFileSync(join(cwd, "note.txt"), "note\n");
  symlinkSync("note.txt", join(cwd, "link"));
  return cwd;
}

/** Runs the workflow through `site`, with `arm` armed right before it. */
async function throughSite(
  site: CommitSite,
  cwd: string,
  arm: () => () => void,
): Promise<CommitWorkflowResult> {
  let disarm = () => {};
  try {
    if (site.locked)
      return await approved(cwd, () => {
        disarm = arm();
      });
    disarm = arm();
    return (await dryRun(cwd)).result;
  } finally {
    disarm();
  }
}

function assertFailedWith(
  result: CommitWorkflowResult,
  error: unknown,
  cwd: string,
): void {
  assert.ok(isWorkerFailure(error), String(error));
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.error, errorText(error));
  assert.doesNotMatch(result.error!, /unreadable|could not read/);
  assertNothingCommitted(cwd);
}

describe("AC5 a Worker failure fails the commit, never a filesystem answer", () => {
  test.each(COMMIT_SITES)("$name: a malformed answer", async (site) => {
    const cwd = commitFixture();
    const path = site.path(cwd);
    const malformed = () =>
      answerNthForPath(
        site.method,
        path,
        site.nth,
        answering(MALFORMED_ANSWERS[site.method]!),
      );
    const disarm = answerForPathForTests(
      site.method,
      path,
      answering(MALFORMED_ANSWERS[site.method]!),
    );
    const expected = await rejection(site.direct(cwd, path)).finally(disarm);
    assertFailedWith(await throughSite(site, cwd, malformed), expected, cwd);
  });

  const REFUSED = COMMIT_SITES.find(({ name }) => name.startsWith("R6 f"))!;

  test("R6: a coded refusal", async () => {
    const cwd = commitFixture();
    const path = REFUSED.path(cwd);
    const refuse = () =>
      answerForPathForTests(REFUSED.method, path, async () => {
        throw new WorkerMethodError("wrong_worker", "Not here.");
      });
    const disarm = refuse();
    const expected = await rejection(REFUSED.direct(cwd, path)).finally(disarm);
    assertFailedWith(await throughSite(REFUSED, cwd, refuse), expected, cwd);
  });

  test("R6: a held call, a connection end, then release", async () => {
    const cwd = commitFixture();
    const held = holdFileForTests(REFUSED.path(cwd), REFUSED.phase);
    const pending = dryRun(cwd);
    await held.reached;
    writeAsInProcessWorkerForTests(INVALID_FRAME);
    held.release();
    const { result } = await pending;
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /The Worker connection ended/);
    assertNothingCommitted(cwd);
  });
});

describe("AC6 only an established filesystem failure maps", () => {
  const omitted = (path: string, message: string) =>
    `Untracked file: ${path}\n[content omitted: could not read: ${message}]`;

  test.each([
    [FILE_METHODS.inspect, "note.txt", "ENOENT"],
    [FILE_METHODS.inspect, "note.txt", null],
    [FILE_METHODS.readlink, "link", "ENOENT"],
    [FILE_METHODS.readlink, "link", null],
  ] as const)(
    "Worker: %s of %s answered code %s",
    async (method, name, code) => {
      const cwd = commitFixture();
      const path = join(cwd, name);
      const message = `${code ?? "uncoded"}: answered for ${name}`;
      const failure = answering(answeredFailure(code, message));

      const disarm = answerForPathForTests(method, path, failure);
      const fingerprint = await untrackedFingerprintForTests(
        cwd,
        untracked(cwd),
      ).finally(disarm);
      assert.equal(fingerprint.values.get(name), "unreadable");

      // The fingerprint's request is the first; the summary's the second.
      const second = answerNthForPath(method, path, 2, failure);
      const { result, prompt } = await dryRun(cwd).finally(second);
      assert.equal(result.status, "dry-run");
      assert.ok(prompt?.includes(omitted(name, message)), prompt);
    },
  );

  test("the reader's own error fails the commit", async () => {
    const cwd = commitFixture();
    throwInCheckoutReadForTests(new TypeError("sentinel"), { at: "read" });
    const { result } = await dryRun(cwd);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "sentinel");
    assertNothingCommitted(cwd);
  });
});
