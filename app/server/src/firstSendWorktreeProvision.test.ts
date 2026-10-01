/**
 * "+ New worktree" on the new-session surface (Task 240): the first send
 * provisions the checkout BEFORE the session is created, because a session's
 * cwd is fixed at construction in both harnesses.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/firstSendWorktreeProvision.test.ts
 *
 * Mechanics-only, like `developerWorktreeGuard.test.ts`: the private handler is
 * invoked on a Connection with a fake WebSocket against a real temp git repo.
 * The naming agent has no credentials here, so `generateWorktreeSuffix` takes
 * its documented timestamp fallback — which is exactly what proves naming can
 * never block creation.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterAll, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorktreeProvisionDisplay } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "first-send-provision-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);

// Record the turn instead of driving a real one, so the end-to-end test can
// assert WHEN the prompt runs relative to provisioning.
const promptCalls: string[] = [];
vi.mock("./session/runtimePrompt.ts", () => ({
  subscribeHarnessOpened: () => () => {},
  promptRuntimeSession: async (_driver: unknown, text: string) => {
    promptCalls.push(text);
  },
}));

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

const repoPath = join(tmp, "mainrepo");
mkdirSync(repoPath, { recursive: true });
sh(repoPath, "init", "-b", "main");
writeFileSync(join(repoPath, "readme.md"), "hello\n");
sh(repoPath, "add", "-A");
sh(repoPath, "commit", "-m", "init");

const { Connection } = await import("./connection.ts");
const { projectStore } = await import("./db/projectStore.ts");
const { createCredentialProfile } = await import("./credentialProfiles.ts");
const claudeProfile = createCredentialProfile({
  name: "Provisioning Claude",
  provider: "claude",
});
// Spawned rows only (the synthetic main checkout is never a row), read straight
// from the store so the assertions do not depend on a git fan-out.
const { listWorktrees, taskIdsForWorktree } =
  await import("./db/worktreeStore.ts");
const { createTask } = await import("./tasks.ts");

projectStore.put({
  id: "prov-proj",
  name: "Provisioning Project",
  key: "PP",
  description: "",
  status: "active",
  localPaths: [{ path: repoPath, kind: "repo", match: "prefix" }],
  worktreeRoot: join(tmp, "wt-root"),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

interface SentMessage {
  type: string;
  clientRequestId?: string;
  provision?: WorktreeProvisionDisplay;
  message?: string;
}

type ProvisionResult =
  | {
      worktree: { id: string; path: string; projectId: string };
      provision: WorktreeProvisionDisplay;
    }
  | null
  | undefined;

function makeConnection() {
  const sent: SentMessage[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s) as SentMessage),
  };
  const conn = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs);
  const provision = (
    conn as unknown as {
      provisionFirstSendWorktree: (msg: {
        createWorktreeInProjectId?: string;
        text: string;
        attachTaskId?: string;
        clientRequestId?: string;
      }) => Promise<ProvisionResult>;
    }
  ).provisionFirstSendWorktree.bind(conn);
  return { provision, sent };
}

/** Only the provisioning progress reports, in order. */
function phases(sent: SentMessage[]): string[] {
  return sent
    .filter((msg) => msg.type === "worktreeProvision")
    .map((msg) => msg.provision?.state ?? "");
}

test("no + New worktree staged is a no-op that reports nothing", async () => {
  const { provision, sent } = makeConnection();
  assert.equal(await provision({ text: "hi" }), null);
  assert.deepEqual(sent, [], "nothing staged sends no progress");
});

test("provisions the checkout before the session and reports each phase", async () => {
  const { provision, sent } = makeConnection();
  const result = await provision({
    createWorktreeInProjectId: "prov-proj",
    text: "Add a retry button to the provisioning card",
    clientRequestId: "creq-1",
  });
  assert.ok(result, "provisioning succeeds against a real repo");
  assert.equal(result.worktree.projectId, "prov-proj");
  assert.ok(
    existsSync(result.worktree.path),
    "the checkout exists on disk before the session is created",
  );
  assert.equal(result.provision.state, "created");
  assert.equal(
    result.provision.baseBranch,
    "main",
    "forked from the main checkout's current branch",
  );
  assert.deepEqual(
    phases(sent),
    ["naming", "creating", "created"],
    "the browser can render the card through every phase",
  );
  assert.ok(
    sent.every((msg) => msg.clientRequestId === "creq-1"),
    "every report echoes the send it belongs to, so the card is keyed to it",
  );
  const records = listWorktrees();
  assert.equal(records.length, 1, "exactly one worktree was created");
  assert.equal(records[0]?.branch, result.provision.branch);
});

test("a staged Task is linked and named into the branch", async () => {
  const { provision } = makeConnection();
  const result = await provision({
    createWorktreeInProjectId: "prov-proj",
    text: "Work on it",
    attachTaskId: "240",
    clientRequestId: "creq-2",
  });
  assert.ok(result);
  assert.match(
    result.provision.branch ?? "",
    /^t240-/,
    "the Task id leads the branch name",
  );
  assert.equal(result.provision.taskId, "240");
  assert.deepEqual(
    taskIdsForWorktree(result.worktree.id),
    ["240"],
    "the task —in_worktree→ worktree edge makes the Task's checkout exact",
  );
});

test("a linked Jira issue replaces the internal Task branch prefix", async () => {
  const task = createTask({
    title: "Fix playback startup",
    projectId: "prov-proj",
    jiraIssueKeys: ["NEB-1234"],
    source: { createdBy: "user" },
  });
  const { provision } = makeConnection();
  const result = await provision({
    createWorktreeInProjectId: "prov-proj",
    text: "Work on it",
    attachTaskId: task.id,
    clientRequestId: "creq-jira",
  });
  assert.ok(result);
  assert.match(result.provision.branch ?? "", /^neb-1234-/);
  assert.deepEqual(taskIdsForWorktree(result.worktree.id), [task.id]);
});

test("a blocked provision creates nothing and reports the blocker", async () => {
  const before = listWorktrees().length;
  const { provision, sent } = makeConnection();
  const result = await provision({
    createWorktreeInProjectId: "no-such-project",
    text: "hi",
    clientRequestId: "creq-3",
  });
  assert.equal(result, undefined, "the caller creates no session and no turn");
  // A blocker known up front fails fast, without flashing a naming phase.
  assert.deepEqual(phases(sent), ["failed"]);
  const failure = sent.at(-1)?.provision;
  assert.match(
    failure?.error ?? "",
    /Unknown project/,
    "the card carries the real blocker, not a scripted one",
  );
  assert.equal(listWorktrees().length, before, "nothing was created");
});

test("a failure without a clientRequestId still reports, rather than ending in silence", async () => {
  // The browser always sends one, so the card normally carries the blocker.
  // Without one there is no card to carry it, and every other early return in
  // the send handlers says something.
  const { provision, sent } = makeConnection();
  assert.equal(
    await provision({
      createWorktreeInProjectId: "no-such-project",
      text: "hi",
    }),
    undefined,
  );
  assert.deepEqual(phases(sent), [], "no card without a send to key it to");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, "error");
  assert.match(sent[0]?.message ?? "", /Unknown project/);
});

test("the first send provisions, records the genesis card, then runs the turn", async () => {
  const sent: SentMessage[] = [];
  const order: string[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s) as SentMessage),
  };
  const conn = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs) as unknown as {
    handleClaudeSdkSend: (msg: Record<string, unknown>) => Promise<void>;
    ensureClaudeSdkView: unknown;
  };
  // A real SDK session would start a query; this double only has to observe the
  // synthetic-turn surface the genesis card is recorded through.
  let viewedCwd: string | undefined;
  conn.ensureClaudeSdkView = (
    _ticket: number,
    _id: string,
    _modelId: string | undefined,
    _thinking: string | undefined,
    _agentType: string | undefined,
    cwd?: string,
  ) => {
    viewedCwd = cwd;
    return {
      sessionId: "prov-session",
      broadcastState() {},
      contextInfo: () => ({}),
      beginSyntheticTool: () => {
        order.push("card:begin");
        return { assistantId: "a1", toolId: "t1" };
      },
      finishSyntheticWorktreeProvision: (
        provision: WorktreeProvisionDisplay,
      ) => {
        order.push(`card:${provision.state}`);
      },
    };
  };

  await conn.handleClaudeSdkSend({
    id: "prov-session",
    agentType: "developer",
    text: "Start on the card",
    credentialProfileId: claudeProfile.id,
    createWorktreeInProjectId: "prov-proj",
    clientRequestId: "creq-4",
  });

  assert.deepEqual(promptCalls, ["Start on the card"], "the turn ran once");
  assert.deepEqual(
    order,
    ["card:begin", "card:created"],
    "the genesis card is recorded before the turn",
  );
  assert.ok(
    viewedCwd?.startsWith(join(tmp, "wt-root")),
    `the session is created in the new checkout (got ${viewedCwd})`,
  );
  const created = sent.filter(
    (msg) =>
      msg.type === "worktreeProvision" && msg.provision?.state === "created",
  );
  assert.equal(created.length, 1, "the browser was told provisioning finished");
});

test("a blocked first send creates no session and runs no turn", async () => {
  promptCalls.length = 0;
  const before = listWorktrees().length;
  const sent: SentMessage[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s) as SentMessage),
  };
  const conn = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs) as unknown as {
    handleClaudeSdkSend: (msg: Record<string, unknown>) => Promise<void>;
    ensureClaudeSdkView: unknown;
  };
  conn.ensureClaudeSdkView = () => {
    throw new Error("no session may be created for a failed provision");
  };

  await conn.handleClaudeSdkSend({
    id: "blocked-session",
    agentType: "developer",
    text: "Start on the card",
    credentialProfileId: claudeProfile.id,
    createWorktreeInProjectId: "no-such-project",
    clientRequestId: "creq-5",
  });

  assert.deepEqual(promptCalls, [], "the safe failure is automatic");
  assert.equal(listWorktrees().length, before, "nothing was created");
  assert.equal(phases(sent).at(-1), "failed");
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
