import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KNOWLEDGE_WORKTREE_ID } from "@assistant/shared";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import {
  GitCommandError,
  clearRepoLockKeysForTests,
  git,
  gitBoundedStdout,
  gitOptional,
  gitOptionalExit,
  gitRawStdout,
  gitReadOnlyOptional,
  gitReadOnlyOptionalExit,
  gitWithInputOptional,
  repoLockKey,
  resolveRepoRoot,
  withRepoLock,
} from "../gitExec.ts";
import { readLocally } from "../checkoutFileAccess.ts";
import { inspectPath, realpathFile } from "../fileReads.ts";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { projectStore } from "../db/projectStore.ts";
import { mintDocumentTargetGrant } from "../documentGrantTargets.ts";
import { createGitFamily } from "../gitFamily.ts";
import { localGitRunner } from "../gitProcess.ts";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import { LibraryStore } from "../library/libraryStore.ts";
import { skillKind } from "../skills/skillLibrary.ts";
import { FILE_METHODS } from "../workerProtocol/fileMethods.ts";
import { resolveReadableWorktreeRow } from "../worktrees/knowledgeCheckout.ts";
import { addWorktreeComment } from "../worktrees/worktreeComments.ts";
import {
  getWorktreeChanges,
  getWorktreeFileContent,
  getWorktreeFileLog,
  getWorktreeFileRaw,
  getWorktreeLog,
  getWorktreeTree,
} from "../worktrees/worktreeDiff.ts";
import { mainWorktreeId } from "../worktrees/worktreeResolve.ts";
import { computeWorktreeStatus } from "../worktrees/worktreeStatus.ts";
import { spawnBrokerPidForTests } from "../spawnBroker.ts";
import { commitWorktree } from "../worktrees/worktreeWrite.ts";
import {
  inProcessWorkerEpochForTests,
  inProcessWorkerServedForTests,
  inProcessWorkerServedMethodForTests,
  writeAsInProcessWorkerForTests,
} from "./inProcessWorker.ts";

/** The same executors as the server runs them for its own repositories. */
const local = createGitFamily(localGitRunner, {
  inspect: (_cwd, path) => readLocally(() => inspectPath(path, true)),
  realpath: (_cwd, path) => readLocally(() => realpathFile(path)),
});

const scratch = mkdtempSync(join(tmpdir(), "in-process-worker-"));
const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function makeRepo(name: string): Promise<string> {
  const repo = join(scratch, name);
  mkdirSync(repo, { recursive: true });
  await local.git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "a.txt"), "alpha\n");
  await local.git(["add", "a.txt"], repo);
  await local.git(["commit", "-qm", "a"], repo, undefined, identity);
  return repo;
}

/** What `run` returns, and how many requests the in-process Worker served for it. */
async function served<T>(
  run: () => Promise<T>,
): Promise<{ result: T; requests: number }> {
  const before = inProcessWorkerServedForTests();
  const result = await run();
  return { result, requests: inProcessWorkerServedForTests() - before };
}

test("every caller-facing checkout executor crosses the Worker and answers as a local run", async () => {
  const repo = await makeRepo("routing");
  const head = ["rev-parse", "HEAD"];
  // Each case sends one request, but a cold `repoLockKey`: its identity reads
  // (`inspect` of the checkout and its `.git`) and the common dir's
  // canonicalization cross as well.
  const cases: [
    string,
    () => Promise<unknown>,
    () => Promise<unknown>,
    number?,
  ][] = [
    ["git", () => git(head, repo), () => local.git(head, repo)],
    [
      "gitOptional",
      () => gitOptional(["rev-parse", "nope"], repo),
      () => local.gitOptional(["rev-parse", "nope"], repo),
    ],
    [
      "gitOptionalExit",
      () => gitOptionalExit(head, repo),
      () => local.gitOptionalExit(head, repo),
    ],
    [
      "gitReadOnlyOptional",
      () => gitReadOnlyOptional(["status", "--porcelain"], repo),
      () => local.gitReadOnlyOptional(["status", "--porcelain"], repo),
    ],
    [
      "gitReadOnlyOptionalExit",
      () => gitReadOnlyOptionalExit(["log", "--oneline"], repo),
      () => local.gitReadOnlyOptionalExit(["log", "--oneline"], repo),
    ],
    [
      "gitBoundedStdout",
      () => gitBoundedStdout(["show", "HEAD"], repo, 7),
      () => local.gitBoundedStdout(["show", "HEAD"], repo, 7),
    ],
    [
      "gitRawStdout",
      () => gitRawStdout(["show", "HEAD:a.txt"], repo),
      () => local.gitRawStdout(["show", "HEAD:a.txt"], repo),
    ],
    [
      "gitWithInputOptional",
      () => gitWithInputOptional(["hash-object", "--stdin"], repo, "x\n"),
      () => local.gitWithInputOptional(["hash-object", "--stdin"], repo, "x\n"),
    ],
    [
      "resolveRepoRoot",
      () => resolveRepoRoot(repo),
      () => local.resolveRepoRoot(repo),
    ],
    [
      "repoLockKey (cold)",
      () => {
        clearRepoLockKeysForTests();
        return repoLockKey(repo);
      },
      () => {
        clearRepoLockKeysForTests();
        return local.repoLockKey(repo);
      },
      4,
    ],
  ];
  for (const [name, checkout, here, requests = 1] of cases) {
    const crossed = await served(checkout);
    assert.equal(crossed.requests, requests, `${name} requests`);
    const stayed = await served(here);
    assert.equal(stayed.requests, 0, `${name} on the local family`);
    assert.deepEqual(crossed.result, stayed.result, name);
  }
});

/** The file requests the in-process Worker served for `run`, by method. */
async function filesServed<T>(
  run: () => Promise<T>,
): Promise<{ result: T; methods: Record<string, number> }> {
  const methods = Object.values(FILE_METHODS);
  const before = methods.map(inProcessWorkerServedMethodForTests);
  const result = await run();
  return {
    result,
    methods: Object.fromEntries(
      methods
        .map((method, at): [string, number] => [
          method,
          inProcessWorkerServedMethodForTests(method) - before[at]!,
        ])
        .filter(([, count]) => count > 0),
    ),
  };
}

test("every checkout surface reads a checkout's files through the Worker", async () => {
  const repo = realpathSync(await makeRepo("surfaces"));
  writeFileSync(join(repo, "new.txt"), "x\ny\n");
  const row = {
    id: "surfaces",
    projectId: "surfaces",
    path: repo,
    mainRepoRoot: repo,
    branch: "main",
    baseBranch: "main",
    baseCommit: "",
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  } satisfies WorktreeRow;
  const now = new Date().toISOString();
  projectStore.put({
    id: "surfaces",
    name: "Surfaces",
    key: "SURFACES",
    description: "",
    status: "active",
    localPaths: [{ path: repo, kind: "repo", match: "prefix" }],
    worktreeRoot: join(scratch, "surfaces-worktrees"),
    createdAt: now,
    updatedAt: now,
  });
  const read = { open: 1, read: 1, close: 1 };
  const contained = { realpath: 2 };
  const size = (name: string) => lstatSync(join(repo, name)).size;
  const cases: [string, () => Promise<unknown>, unknown, object][] = [
    [
      "status",
      async () => (await computeWorktreeStatus(row, { force: true })).dirty,
      true,
      // The untracked file's lines are counted, and the repo key asked cold.
      { exists: 1, ...contained, ...read, inspect: 2, realpath: 3 },
    ],
    [
      "changes with an untracked file",
      async () =>
        (await getWorktreeChanges(row, { kind: "workingTree" })).files.map(
          (file) => [file.path, file.additions],
        ),
      [["new.txt", 2]],
      { ...contained, ...read },
    ],
    [
      "file",
      async () => (await getWorktreeFileContent(row, "a.txt")).content,
      "alpha\n",
      { ...contained, ...read },
    ],
    [
      "raw",
      async () => (await getWorktreeFileRaw(row, "a.txt")).content.toString(),
      "alpha\n",
      { ...contained, ...read },
    ],
    [
      "tree",
      () => getWorktreeTree(row, ""),
      [
        { name: "a.txt", path: "a.txt", kind: "file", size: size("a.txt") },
        {
          name: "new.txt",
          path: "new.txt",
          kind: "file",
          size: size("new.txt"),
        },
      ],
      { inspect: 2 },
    ],
    [
      "tree with ignored files",
      async () => (await getWorktreeTree(row, "", true)).map((e) => e.name),
      ["a.txt", "new.txt"],
      { realpath: 1, readdir: 1, inspect: 2 },
    ],
    [
      "a comment's working source",
      async () =>
        (
          await addWorktreeComment({
            worktreeId: mainWorktreeId("surfaces"),
            body: "routed",
            author: { kind: "user" },
            anchor: { path: "a.txt", side: "new", line: 1 },
          })
        ).anchor?.selectors.quote.exact,
      "alpha",
      // The add asks the repo key, remembered by now: identity reads only.
      { ...contained, ...read, inspect: 2 },
    ],
    [
      "a worktreeFile grant",
      async () =>
        typeof (
          await mintDocumentTargetGrant(
            {
              target: {
                kind: "worktreeFile",
                worktreeId: row.id,
                path: "a.txt",
                view: "file",
              },
              scope: "file",
              delivery: "attachment",
            },
            {
              dataDir: join(scratch, "data"),
              resolveWorktree: async () => row,
            },
          )
        ).grantId,
      "string",
      // Containment's two, then the grant layer's own served reads (W2).
      { realpath: 5, stat: 1 },
    ],
    [
      "repoLockKey",
      () => {
        clearRepoLockKeysForTests();
        return repoLockKey(repo);
      },
      realpathSync(join(repo, ".git")),
      { inspect: 2, realpath: 1 },
    ],
  ];
  for (const [name, run, expected, methods] of cases) {
    const { result, methods: served } = await filesServed(run);
    assert.deepEqual(result, expected, name);
    assert.deepEqual(
      served,
      Object.fromEntries(
        Object.entries(methods).map(([method, count]) => [
          `files.${method}`,
          count,
        ]),
      ),
      name,
    );
  }
});

test("the Knowledge Base and the libraries never reach the Worker", async () => {
  const before = inProcessWorkerServedForTests();
  const row = await resolveReadableWorktreeRow(KNOWLEDGE_WORKTREE_ID);
  assert.ok(row, "the KB checkout row");
  writeFileSync(join(row.path, "note.md"), "# Note\n");
  const store = new KnowledgeBaseStore();
  await store.commitChanges(
    [{ op: "write", path: "first.md", content: "first\n" }],
    { actor: { kind: "user", name: "T" }, reason: "Add first" },
  );
  assert.ok((await store.history()).length >= 2);

  const status = await computeWorktreeStatus(row, { force: true });
  assert.ok(status);
  const tree = await getWorktreeTree(row, "");
  assert.ok(tree.some((entry) => entry.path === "first.md"));
  const changes = await getWorktreeChanges(row, { kind: "workingTree" });
  assert.ok(changes.files.some((file) => file.path === "note.md"));
  const content = await getWorktreeFileContent(row, "first.md");
  assert.ok(content);
  const raw = await getWorktreeFileRaw(row, "first.md", "HEAD");
  assert.equal(raw.content.toString("utf8"), "first\n");
  const working = await getWorktreeFileRaw(row, "note.md");
  assert.equal(working.content.toString("utf8"), "# Note\n");
  const listing = await getWorktreeTree(row, "", true);
  assert.ok(listing.some((entry) => entry.path === "note.md"));
  const grant = await mintDocumentTargetGrant({
    target: {
      kind: "worktreeFile",
      worktreeId: KNOWLEDGE_WORKTREE_ID,
      path: "first.md",
      view: "file",
    },
    scope: "file",
    delivery: "attachment",
  });
  assert.ok(grant.grantId);
  assert.ok((await getWorktreeLog(row, 10)).entries.length >= 2);
  assert.ok((await getWorktreeFileLog(row, "first.md", 10)).entries.length);
  const committed = await commitWorktree(row, { message: "Add note" });
  assert.ok(committed);

  const library = new LibraryStore(skillKind, join(scratch, "skills"));
  await library.ensureInitialized();
  await library.status();
  await library.history();
  await library.gitBlobIdOf(new TextEncoder().encode("x\n"));

  assert.equal(inProcessWorkerServedForTests() - before, 0);
});

/** A stand-in `git`, first on PATH through the call's own env override. */
function standIn(name: string, body: string) {
  const dir = join(scratch, name);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "log");
  const pid = join(dir, "pid");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\necho $$ > '${pid}'\nlog='${log}'\n${body}\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  return {
    dir,
    env: { PATH: `${bin}:${process.env.PATH}` },
    log: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
    pid: () => Number(readFileSync(pid, "utf8")),
  };
}

/** Logs `term`, keeps writing for about half a second, then `done` and exits. */
const TERM_HANDLING = `
on_term() {
  echo term >> "$log"
  i=0
  while [ $i -lt 10 ]; do echo "w$i" >> "$log"; sleep 0.05; i=$((i + 1)); done
  echo done >> "$log"
  exit 0
}
trap on_term TERM
echo started >> "$log"
while :; do sleep 0.05; done`;

/** Ignores SIGTERM and writes until it is killed. */
const TERM_IGNORING = `
trap '' TERM
echo started >> "$log"
while :; do echo tick >> "$log"; sleep 0.05; done`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A frame whose header length is zero: a protocol error on arrival. */
const INVALID_FRAME = new Uint8Array(8);

describe.each(["broker", "in-process"] as const)(
  "teardown with the %s spawn mode",
  (mode) => {
    let saved: string | undefined;
    beforeAll(() => {
      saved = process.env.ASSISTANT_SPAWN_BROKER;
      if (mode === "in-process") process.env.ASSISTANT_SPAWN_BROKER = "0";
      else delete process.env.ASSISTANT_SPAWN_BROKER;
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.ASSISTANT_SPAWN_BROKER;
      else process.env.ASSISTANT_SPAWN_BROKER = saved;
    });
    afterEach(async () => {
      // Every case leaves a working connection behind.
      await git(["--version"], scratch);
    });

    /**
     * Run the stand-in as a checkout `git` under the repo lock, queue a second
     * locked operation, end the run with `end`, and record what each saw.
     */
    async function lockedRun(
      name: string,
      body: string,
      end: (stop: AbortController) => void,
    ) {
      const repo = await makeRepo(`${mode}-${name}`);
      const fake = standIn(`${mode}-${name}-standin`, body);
      const key = await repoLockKey(repo);
      const stop = new AbortController();
      let atRejection: { log: string; alive: boolean } | undefined;
      // Recorded inside the locked section, the moment the call rejects:
      // strictly before the lock passes to the next holder.
      const first = withRepoLock(key, async () => {
        try {
          await git(["standin"], repo, stop.signal, fake.env);
        } catch (error) {
          atRejection = { log: fake.log(), alive: alive(fake.pid()) };
          return error;
        }
        assert.fail("the stand-in run must not succeed");
      });
      let secondSaw: { log: string; rejected: boolean } | undefined;
      const second = withRepoLock(key, async () => {
        secondSaw = { log: fake.log(), rejected: atRejection !== undefined };
      });
      await until("the stand-in to start", () =>
        fake.log().includes("started"),
      );
      const started = Date.now();
      end(stop);
      const error = await first;
      const elapsed = Date.now() - started;
      await second;
      await sleep(300);
      return {
        error,
        atRejection: atRejection!,
        secondSaw: secondSaw!,
        fake,
        elapsed,
      };
    }

    test("a protocol error rejects a running call only after its child exited", async () => {
      const epoch = inProcessWorkerEpochForTests();
      assert.ok(epoch);
      const run = await lockedRun("term", TERM_HANDLING, () =>
        writeAsInProcessWorkerForTests(INVALID_FRAME),
      );
      assert.ok(run.error instanceof GitCommandError, String(run.error));
      assert.equal(run.error.failureKind, "execution");
      assert.match(run.error.message, /^git standin failed: .*protocol error/);
      assert.match(run.atRejection.log, /term[\s\S]*done\n$/);
      assert.equal(run.atRejection.alive, false);
      assert.equal(run.fake.log(), run.atRejection.log, "nothing wrote after");
      assert.ok(run.secondSaw.rejected, "the second operation started after");
      assert.match(run.secondSaw.log, /done\n$/);

      const after = await git(["--version"], scratch);
      assert.match(after.stdout, /^git version/);
      assert.equal(inProcessWorkerEpochForTests(), epoch + 1);
    });

    test("a child that ignores SIGTERM is killed, and the call rejects after", async () => {
      const run = await lockedRun("ignore", TERM_IGNORING, () =>
        writeAsInProcessWorkerForTests(INVALID_FRAME),
      );
      assert.ok(run.error instanceof GitCommandError, String(run.error));
      assert.equal(run.error.failureKind, "execution");
      assert.equal(run.atRejection.alive, false, "killed before rejection");
      assert.ok(run.elapsed >= 1_500, `escalated after ${run.elapsed} ms`);
      assert.equal(run.fake.log(), run.atRejection.log, "nothing wrote after");
      assert.ok(run.secondSaw.rejected);
      assert.equal(run.secondSaw.log, run.atRejection.log);
    });

    test("a caller's cancel settles only after the child exited", async () => {
      const epoch = inProcessWorkerEpochForTests();
      const run = await lockedRun("cancel", TERM_HANDLING, (stop) =>
        stop.abort(),
      );
      assert.ok(run.error instanceof GitCommandError, String(run.error));
      assert.equal(run.error.failureKind, "execution");
      assert.equal(
        run.error.message,
        "git standin failed: The operation was aborted",
      );
      assert.match(run.atRejection.log, /term[\s\S]*done\n$/);
      assert.equal(run.atRejection.alive, false);
      assert.ok(run.secondSaw.rejected);
      assert.equal(inProcessWorkerEpochForTests(), epoch, "same connection");
    });
  },
);

/** A process's `/proc` state letter and process group; `gone` once reaped. */
function procStat(pid: number): { state: string; pgrp?: number } {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "latin1");
  } catch {
    return { state: "gone" };
  }
  const [state, , pgrp] = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { state: state ?? "?", pgrp: Number(pgrp) };
}

/** Gone, a zombie or dead: the process has exited and runs nothing more. */
const hasExited = (state: string) => ["gone", "Z", "X"].includes(state);

describe.skipIf(process.platform !== "linux")(
  "a spawn broker that dies under a running checkout call",
  () => {
    let saved: string | undefined;
    beforeAll(() => {
      saved = process.env.ASSISTANT_SPAWN_BROKER;
      delete process.env.ASSISTANT_SPAWN_BROKER;
    });
    afterAll(() => {
      if (saved !== undefined) process.env.ASSISTANT_SPAWN_BROKER = saved;
    });

    /**
     * Run a SIGTERM-ignoring stand-in under the repo lock with a second
     * holder queued, then SIGKILL the broker (after ending the connection,
     * with `endConnection`). Records the stand-in's state when the call
     * rejects and when the second holder starts.
     */
    async function brokerDeath(name: string, endConnection: boolean) {
      const repo = await makeRepo(name);
      const fake = standIn(`${name}-standin`, TERM_IGNORING);
      const key = await repoLockKey(repo);
      let atRejection: { state: string; log: string } | undefined;
      const first = withRepoLock(key, async () => {
        try {
          await git(["standin"], repo, undefined, fake.env);
        } catch (error) {
          atRejection = { state: procStat(fake.pid()).state, log: fake.log() };
          return error;
        }
        assert.fail("the stand-in run must not succeed");
      });
      let secondState: string | undefined;
      const second = withRepoLock(key, async () => {
        secondState = procStat(fake.pid()).state;
      });
      try {
        await until("the stand-in to start", () =>
          fake.log().includes("started"),
        );
        const broker = await spawnBrokerPidForTests();
        assert.ok(broker, "the broker runs");
        assert.equal(
          procStat(fake.pid()).pgrp,
          broker,
          "the stand-in is in the broker's process group",
        );
        if (endConnection) writeAsInProcessWorkerForTests(INVALID_FRAME);
        process.kill(broker, "SIGKILL");
        const error = await first;
        await second;
        await sleep(300);
        return {
          error,
          atRejection: atRejection!,
          secondState: secondState!,
          fake,
        };
      } finally {
        try {
          process.kill(fake.pid(), "SIGKILL");
        } catch {
          // Already gone — the expected case.
        }
      }
    }

    test("with the connection ending too, the call rejects only after its child exited", async () => {
      const early: string[] = [];
      for (let trial = 0; trial < 10; trial++) {
        await git(["--version"], scratch);
        const epoch = inProcessWorkerEpochForTests();
        assert.ok(epoch);
        const run = await brokerDeath(`broker-death-end-${trial}`, true);
        assert.ok(run.error instanceof GitCommandError, String(run.error));
        assert.equal(run.error.failureKind, "execution");
        assert.match(
          run.error.message,
          /^git standin failed: .*protocol error/,
        );
        if (!hasExited(run.atRejection.state) || !hasExited(run.secondState))
          early.push(`${trial}: ${run.atRejection.state}/${run.secondState}`);
        assert.equal(
          run.fake.log(),
          run.atRejection.log,
          "nothing wrote after",
        );
        const after = await git(["--version"], scratch);
        assert.match(after.stdout, /^git version/);
        assert.equal(inProcessWorkerEpochForTests(), epoch + 1);
      }
      assert.deepEqual(early, [], "a running stand-in when the lock passed on");
    });

    test("with the connection kept, the call rejects only after its child exited", async () => {
      const early: string[] = [];
      for (let trial = 0; trial < 10; trial++) {
        await git(["--version"], scratch);
        const epoch = inProcessWorkerEpochForTests();
        const run = await brokerDeath(`broker-death-kept-${trial}`, false);
        assert.ok(run.error instanceof GitCommandError, String(run.error));
        assert.equal(run.error.failureKind, "execution");
        assert.match(run.error.message, /exited before answering/);
        if (!hasExited(run.atRejection.state) || !hasExited(run.secondState))
          early.push(`${trial}: ${run.atRejection.state}/${run.secondState}`);
        assert.equal(
          run.fake.log(),
          run.atRejection.log,
          "nothing wrote after",
        );
        assert.equal(inProcessWorkerEpochForTests(), epoch, "same connection");
      }
      assert.deepEqual(early, [], "a running stand-in when the lock passed on");
    });
  },
);

test("a script that ran checkout and local git, and read a served file, exits on its own", async () => {
  const src = dirname(dirname(fileURLToPath(import.meta.url)));
  const repo = await makeRepo("natural-exit");
  const head = join(repo, ".git", "HEAD");
  const script = `
    import { git } from ${JSON.stringify(pathToFileURL(join(src, "gitExec.ts")).href)};
    import { gitOptional } from ${JSON.stringify(pathToFileURL(join(src, "serverRepoGit.ts")).href)};
    import { openServedFile, statServedFile } from ${JSON.stringify(pathToFileURL(join(src, "servedFileAccess.ts")).href)};
    const checkout = await git(["rev-parse", "HEAD"], ${JSON.stringify(repo)});
    const local = await gitOptional(["rev-parse", "HEAD"], ${JSON.stringify(repo)});
    if (checkout.stdout !== local.stdout) throw new Error("different answers");
    const { size } = await statServedFile(${JSON.stringify(head)});
    const file = await openServedFile(${JSON.stringify(head)}, { stat: false });
    const chunks = [];
    for await (const chunk of file.createReadStream({ start: 0, end: size - 1 }))
      chunks.push(chunk);
    await file.close();
    if (!Buffer.concat(chunks).toString().startsWith("ref: "))
      throw new Error("not the file's bytes");
  `;
  const started = Date.now();
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: dirname(src), stdio: ["ignore", "inherit", "inherit"] },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("error", reject);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.equal(code, 0, "exited by itself, successfully");
  assert.ok(Date.now() - started < 15_000);
});
