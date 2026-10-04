/**
 * Sessions must run in a worktree they still have: creation (Task 119) and
 * resume (Task 321).
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/developerWorktreeGuard.test.ts
 *
 * Without an `in_worktree` edge a session executes in the app CWD (the server's
 * home directory in production), so every client creation path must reject a
 * `developer` session that carries no usable worktree. The same hazard arrives
 * from the other side once a worktree is cleaned up under an existing session:
 * its edge still points somewhere, the path is gone, and every run-starting
 * path would silently execute in the app's own checkout — so those refuse too,
 * until the user acknowledges it. Mechanics-only: the private handlers are
 * invoked directly on a Connection with a fake WebSocket and the rejection is
 * asserted BEFORE any session acquire or turn would run.
 */
import assert from "node:assert/strict";
import { afterAll, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate CWD and DATA_DIR BEFORE importing the connection, and enable the
// claude-sdk harness so its first send reaches the guard.
const tmp = mkdtempSync(join(tmpdir(), "dev-worktree-guard-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);

const { Connection } = await import("./connection.ts");
const { createCredentialProfile } = await import("./credentialProfiles.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { promptRuntimeSessionWithRuntime } =
  await import("./session/runtimePrompt.ts");
const { insertWorktree, linkSessionToWorktree } =
  await import("./db/worktreeStore.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { WORKTREE_MISSING_BLOCKED_REASON } = await import("@assistant/shared");
const gitExec = await import("./gitExec.ts");
const claudeProfile = createCredentialProfile({
  name: "Developer guard",
  provider: "claude",
});

const REJECTION = /Developer sessions run in a worktree/;

interface SentMessage {
  type: string;
  message?: string;
}

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
  return {
    conn: conn as unknown as Record<
      string,
      (...args: unknown[]) => Promise<void>
    >,
    sent,
  };
}

function assertOnlyRejection(sent: SentMessage[], path: string) {
  assert.equal(
    sent.length,
    1,
    `${path}: exactly one message (the rejection) should be sent`,
  );
  assert.equal(
    sent[0]?.type,
    "error",
    `${path}: rejection is an error message`,
  );
  assert.match(
    sent[0]?.message ?? "",
    REJECTION,
    `${path}: rejection names the worktree requirement`,
  );
}

test("guardDeveloperWorktree only rejects a bare developer session", () => {
  const { conn, sent } = makeConnection();
  const guard = (
    conn as unknown as {
      guardDeveloperWorktree: (
        agentType: string,
        worktree: { id: string } | null,
      ) => boolean;
    }
  ).guardDeveloperWorktree.bind(conn);
  assert.equal(guard("assistant", null), true, "assistant needs no worktree");
  assert.equal(
    guard("workshop", null),
    true,
    "workshop is exempt (app CWD is its purpose)",
  );
  assert.equal(
    guard("developer", { id: "wt1" }),
    true,
    "developer with a worktree passes",
  );
  assert.equal(sent.length, 0, "passing calls send nothing");
  assert.equal(guard("developer", null), false, "bare developer is rejected");
  assertOnlyRejection(sent, "guard");
});

test("pi first send rejects a developer session without a worktree", async () => {
  const { conn, sent } = makeConnection();
  await conn.handleFirstSend!({
    harness: "pi",
    id: "p1",
    agentType: "developer",
    text: "hi",
  });
  assertOnlyRejection(sent, "pi first send");
});

test("claude-sdk send rejects a developer session without a worktree", async () => {
  const { conn, sent } = makeConnection();
  await conn.handleFirstSend!({
    harness: "claude-sdk",
    id: "c1",
    agentType: "developer",
    text: "hi",
    credentialProfileId: claudeProfile.id,
  });
  assertOnlyRejection(sent, "claude-sdk first send");
});

test("newSession rejects a developer session without a worktree", async () => {
  const { conn, sent } = makeConnection();
  await conn.onNewSession!("developer");
  assertOnlyRejection(sent, "onNewSession");
});

test("draft sessions never create a developer persona (no worktree channel)", async () => {
  const { conn, sent } = makeConnection();
  await conn.onCreateDraftSession!("developer", "draft body");
  assertOnlyRejection(sent, "onCreateDraftSession");
});

/* ------------------------- resume: a DEAD edge (321) ----------------------- */

/** Link `sessionId` to a worktree row whose folder does or does not exist. */
function linkWorktree(sessionId: string, folder: string, present: boolean) {
  const id = `wt-${sessionId}`;
  const path = join(tmp, folder);
  if (present) mkdirSync(path, { recursive: true });
  insertWorktree({
    id,
    projectId: "guard-proj",
    mainRepoRoot: join(tmp, "main"),
    path,
    branch: folder,
    baseBranch: "main",
    baseCommit: "0".repeat(40),
    status: "active",
    mergeStateJson: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    removedAt: null,
  });
  linkSessionToWorktree(sessionId, id);
  return id;
}

function assertWorktreeGoneRejection(sent: SentMessage[], path: string) {
  assert.equal(
    sent.length,
    1,
    `${path}: exactly one message (the rejection) should be sent`,
  );
  assert.equal(sent[0]?.type, "error", `${path}: rejection is an error`);
  assert.ok(
    sent[0]?.message?.startsWith(WORKTREE_MISSING_BLOCKED_REASON),
    `${path}: rejection carries the shared blocked reason`,
  );
}

test("guardMissingWorktree refuses only a session whose worktree is GONE", () => {
  const { conn, sent } = makeConnection();
  const guard = (
    conn as unknown as { guardMissingWorktree: (id: string) => boolean }
  ).guardMissingWorktree.bind(conn);

  // No edge at all: an ordinary app-CWD session, nothing to refuse.
  assert.equal(guard("no-edge-sess"), true, "a session with no edge passes");
  linkWorktree("live-sess", "live-wt", true);
  assert.equal(guard("live-sess"), true, "a session with its worktree passes");
  assert.equal(sent.length, 0, "passing calls send nothing");

  linkWorktree("gone-sess", "gone-wt", false);
  assert.equal(guard("gone-sess"), false, "a dead edge is refused");
  assertWorktreeGoneRejection(sent, "guardMissingWorktree");
});

test("a prompt to a session whose worktree is gone starts no turn", async () => {
  const { conn, sent } = makeConnection();
  const sessionId = "prompt-gone-sess";
  linkWorktree(sessionId, "prompt-gone-wt", false);
  // A real driver: `dispatch` only prompts PiLiveSession/ClaudeSdkSession
  // instances, and acquiring an SDK session spawns nothing on its own.
  (conn as unknown as { viewing: unknown }).viewing = claudeSdkStore.acquire(
    sessionId,
    { agentType: "developer", credentialProfileId: claudeProfile.id },
  );

  await conn.dispatch!({ type: "prompt", text: "keep going" });
  assertWorktreeGoneRejection(sent, "prompt");

  // /commit, /push and /compact act on the same cwd and refuse identically.
  sent.length = 0;
  await conn.onRunSlashCommand!("commit", "");
  assertWorktreeGoneRejection(sent, "runSlashCommand");
});

/**
 * Task 325: `/pr` chains `/commit` and `/push` through the same
 * `hostSlashCommandRunner` seam, so all three must be refused at slash dispatch
 * (`onRunSlashCommand`, BEFORE `commitWorkflowContext().cwd` reaches any git
 * call), not only on the plain-prompt path. `resolveRepoRoot` is the first git
 * call every one of the three workflows makes, so a spy that never fires is
 * direct evidence no git ran.
 */
test("/commit, /push and /pr each refuse at slash dispatch before any git runs", async () => {
  const resolveRepoRoot = vi.spyOn(gitExec, "resolveRepoRoot");
  try {
    for (const name of ["commit", "push", "pr"]) {
      const { conn, sent } = makeConnection();
      const sessionId = `slash-${name}-gone-sess`;
      linkWorktree(sessionId, `slash-${name}-gone-wt`, false);
      (conn as unknown as { viewing: unknown }).viewing =
        claudeSdkStore.acquire(sessionId, {
          agentType: "developer",
          credentialProfileId: claudeProfile.id,
        });

      await conn.onRunSlashCommand!(name, "");
      assertWorktreeGoneRejection(sent, `/${name}`);
    }
    assert.equal(
      resolveRepoRoot.mock.calls.length,
      0,
      "no workflow reached the repo root resolution, so no git ran",
    );
  } finally {
    resolveRepoRoot.mockRestore();
  }
});

/**
 * `/clear` is the exception the guard must NOT catch: it drops the session's own
 * model context, resolving no cwd, so the app-CWD fallback this guard exists to
 * prevent cannot happen — and refusing it would strand a session whose checkout
 * disappeared with no way to shed its context. `/compact` sits on the other side
 * of that line (it spawns a provider query in the session's cwd) and stays
 * refused, which is what makes this a scoped exemption rather than a hole.
 */
test("/clear reaches its runner for a missing-worktree session while /compact does not", async () => {
  const gone = (name: string) => {
    const { conn, sent } = makeConnection();
    const sessionId = `slash-exempt-${name}-sess`;
    linkWorktree(sessionId, `slash-exempt-${name}-wt`, false);
    const session = claudeSdkStore.acquire(sessionId, {
      agentType: "developer",
      credentialProfileId: claudeProfile.id,
    });
    (conn as unknown as { viewing: unknown }).viewing = session;
    // Session broadcasts reach VIEWERS, not the connection's socket, so watch
    // the session directly for evidence the runner actually ran.
    const envelopes: SentMessage[] = [];
    session.addViewer({
      send: (m: unknown) => envelopes.push(m as SentMessage),
    });
    return { conn, sent, envelopes };
  };

  const compact = gone("compact");
  await compact.conn.onRunSlashCommand!("compact", "");
  assertWorktreeGoneRejection(compact.sent, "/compact");
  assert.deepEqual(
    compact.envelopes,
    [],
    "/compact never opened a turn: the guard refused it first",
  );

  const clear = gone("clear");
  await clear.conn.onRunSlashCommand!("clear", "");
  assert.equal(
    clear.sent.filter((m) =>
      m.message?.startsWith(WORKTREE_MISSING_BLOCKED_REASON),
    ).length,
    0,
    "/clear is not refused by the missing-worktree guard",
  );
  // It reached the harness: a session with no provider context reports the
  // runner's own "nothing to clear" as ordinary tool output.
  const toolEnds = clear.envelopes.filter((m) => m.type === "toolEnd");
  assert.equal(toolEnds.length, 1, "the clear ran and finished its tool turn");
  assert.match(
    (toolEnds[0] as { output?: string }).output ?? "",
    /Nothing to clear/,
    "the runner, not the guard, produced the outcome",
  );
});

test("acknowledging the missing worktree unblocks that session only", async () => {
  const { conn, sent } = makeConnection();
  const guard = (
    conn as unknown as { guardMissingWorktree: (id: string) => boolean }
  ).guardMissingWorktree.bind(conn);
  linkWorktree("ack-sess", "ack-wt", false);
  const otherWorktreeId = linkWorktree("other-sess", "other-wt", false);

  assert.equal(guard("ack-sess"), false, "refused before acknowledgement");
  sent.length = 0;

  await conn.onAcknowledgeMissingWorktree!("ack-sess");
  assert.equal(guard("ack-sess"), true, "acknowledged: the session may run");
  assert.equal(
    guard("other-sess"),
    false,
    "another session's dead edge is untouched",
  );
  assert.ok(otherWorktreeId, "the second worktree row exists");
});

/* ---------------- the invariant at the shared run boundary ---------------- */

/**
 * `promptRuntimeSessionWithRuntime` is the ONE door every run goes through —
 * queued peer delivery, `session_send_prompt`, review handoffs, day scans, the
 * post-reload continuation, approval/question resumes and the merge agent all
 * arrive here without passing a Connection handler. The check must therefore
 * hold with no browser involved, and hold BEFORE the runtime session is created
 * or anything is appended.
 */
function fakeRuntime() {
  const calls: Array<{ kind: "create" | "prompt"; id: string }> = [];
  const runtime = {
    get: () => ({}),
    createSession: (id: string) => {
      calls.push({ kind: "create", id });
      return {};
    },
    prompt: async (id: string) => {
      calls.push({ kind: "prompt", id });
    },
    admitPrompt: () => () => {},
  };
  return { runtime, calls };
}

function fakeDriver(
  sessionId: string,
  agentType: "developer" | "workflow-coordinator" = "developer",
) {
  return {
    id: sessionId,
    key: sessionId,
    sessionId,
    harness: "pi",
    agentType,
    sessionFile: undefined,
    isRunning: false,
    canSteer: false,
    contextInfo: () => ({}),
    broadcastState: () => {},
    createRuntimeAdapter: () => ({}),
  };
}

async function promptThroughBoundary(
  sessionId: string,
  agentType: "developer" | "workflow-coordinator" = "developer",
) {
  const { runtime, calls } = fakeRuntime();
  const prompt = () =>
    (
      promptRuntimeSessionWithRuntime as unknown as (
        runtime: unknown,
        driver: unknown,
        text: string,
        options: unknown,
      ) => Promise<void>
    )(runtime, fakeDriver(sessionId, agentType), "background turn", {
      hidden: true,
    });
  return { prompt, calls };
}

test("the run boundary refuses a background prompt into a dead worktree", async () => {
  linkWorktree("bg-gone-sess", "bg-gone-wt", false);
  const { prompt, calls } = await promptThroughBoundary("bg-gone-sess");

  await assert.rejects(prompt, (err: Error) => {
    assert.ok(
      err.message.startsWith(WORKTREE_MISSING_BLOCKED_REASON),
      "the throw carries the shared blocked reason",
    );
    return true;
  });
  // Nothing was created and nothing was appended: a refused turn leaves no
  // trace of itself in the session.
  assert.deepEqual(calls, [], "no runtime session created, no prompt driven");
});

test("the run boundary passes a live worktree and a session with no edge", async () => {
  linkWorktree("bg-live-sess", "bg-live-wt", true);
  const live = await promptThroughBoundary("bg-live-sess");
  await live.prompt();
  assert.deepEqual(live.calls, [{ kind: "prompt", id: "bg-live-sess" }]);

  const bare = await promptThroughBoundary("bg-no-edge-sess");
  await bare.prompt();
  assert.deepEqual(bare.calls, [{ kind: "prompt", id: "bg-no-edge-sess" }]);
});

test("the run boundary permits a coordinator after its worktree retires", async () => {
  const sessionId = "bg-retired-coordinator";
  sessionStore.upsert({
    id: sessionId,
    harness: "pi",
    agentType: "workflow-coordinator",
  });
  linkWorktree(sessionId, "bg-retired-coordinator-wt", false);

  const result = await promptThroughBoundary(sessionId, "workflow-coordinator");
  await result.prompt();

  assert.deepEqual(result.calls, [{ kind: "prompt", id: sessionId }]);
});

test("acknowledging the dead worktree reopens the run boundary", async () => {
  const { conn } = makeConnection();
  linkWorktree("bg-ack-sess", "bg-ack-wt", false);
  await assert.rejects((await promptThroughBoundary("bg-ack-sess")).prompt);

  await conn.onAcknowledgeMissingWorktree!("bg-ack-sess");
  const after = await promptThroughBoundary("bg-ack-sess");
  await after.prompt();
  assert.deepEqual(after.calls, [{ kind: "prompt", id: "bg-ack-sess" }]);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
