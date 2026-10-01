/**
 * Both card stores FAILED their legacy import (their files cannot be read), so
 * their records exist only in files the server cannot open. What must still
 * hold: the server stays up across watcher ticks, boot's other recoveries run,
 * a client still gets `ready` and its session list, showing a session works,
 * and every read-only answer that would otherwise say "nothing pending" comes
 * with a notice saying the store is unavailable. Decisions and card mutations
 * refuse. `node:fs` is wrapped so the files are unreadable.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      if (/(pull-request-cards|pending-approvals)\.json$/.test(String(args[0])))
        throw Object.assign(new Error("EACCES: injected"), { code: "EACCES" });
      return fs.openSync(...args);
    }) as typeof fs.openSync,
  };
});

const { DATA_DIR } = await import("./config.ts");
const { closeDb } = await import("./db/index.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { LegacyStoreUnavailableError } =
  await import("./legacyJsonStoreImport.ts");
const cards = await import("./pullRequestCards.ts");
const approvals = await import("./pendingApprovals.ts");
const watcher = await import("./pullRequestWatcher.ts");
const { bootStep } = await import("./bootStep.ts");
const { Connection } = await import("./connection.ts");
const { hub } = await import("./hub.ts");

const SESSION = "unavailable-stores-session";

beforeAll(() => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, "pull-request-cards.json"), '{"cards":[]}');
  writeFileSync(join(DATA_DIR, "pending-approvals.json"), '{"approvals":[]}');
  sessionStore.upsert({
    id: SESSION,
    scope: "user",
    harness: "pi",
    agentType: "developer",
    title: "Still listed",
    messageCount: 2,
  });
  assert.equal(cards.importLegacyPullRequestCards().kind, "failed");
  assert.equal(approvals.importLegacyApprovals().kind, "failed");
  cards.setPullRequestCardBroadcastForTests(() => {});
  approvals.setApprovalBroadcastForTests(
    () => {},
    () => {},
  );
});
afterAll(() => closeDb());

function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

const notices = (sent: ServerMessage[]) =>
  sent.filter(
    (m): m is Extract<ServerMessage, { type: "notice" }> =>
      m.type === "notice" && m.severity === "error",
  );

test("the watcher's sweep survives an unavailable card store, tick after tick", async () => {
  await watcher.sweepPullRequestWatcherForTests();
  await watcher.sweepPullRequestWatcherForTests();
});

test("read-only projections answer empty rather than throwing", async () => {
  assert.deepEqual([...approvals.pendingApprovalSessionIds()], []);
  assert.equal(approvals.hasPendingApproval(SESSION), false);
  assert.deepEqual(approvals.approvalsForSession(SESSION), []);
  assert.deepEqual(cards.cardsForSession(SESSION), []);
  assert.equal(cards.pullRequestSummariesBySession().size, 0);
  assert.deepEqual([...cards.choosingTaskSessionIds()], []);
  const listed = await hub.listSessions();
  assert.ok(listed.some((session) => session.id === SESSION));
  // …and each store says why, so empty is never read as "none pending".
  assert.match(approvals.approvalStoreUnavailable() ?? "", /EACCES/);
  assert.match(cards.pullRequestCardStoreUnavailable() ?? "", /EACCES/);
});

test("a client still gets ready and its session list, then ONE notice naming every unavailable store", async () => {
  const sent: ServerMessage[] = [];
  await new Connection(fakeSocket(sent)).init();
  const ready = sent.find(
    (m): m is Extract<ServerMessage, { type: "ready" }> => m.type === "ready",
  );
  assert.ok(ready, "ready was sent");
  assert.ok(ready.sessions.some((session) => session.id === SESSION));
  // One: the client keeps a single global error, so a second would erase the
  // first.
  const said = notices(sent).map((n) => n.message);
  assert.equal(said.length, 1, said.join("\n"));
  assert.match(
    said[0]!,
    /^The approval store and the pull-request card store are unavailable/,
  );
  assert.match(said[0]!, /restarted/);
  // Marked as a condition of the server process, so a client retires it on the
  // next `ready` instead of keeping it after a healthy restart.
  assert.equal(notices(sent)[0]!.serverCondition, true);
});

test("showing a session works, sends no empty grant list, and says approvals are unavailable there", async () => {
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  await connection.init();
  sent.length = 0;
  await connection.handle({ type: "loadSession", id: SESSION });
  assert.ok(
    sent.some((m) => m.type === "snapshot"),
    `the session was shown: ${sent.map((m) => m.type).join(", ")}`,
  );
  assert.equal(
    sent.some((m) => m.type === "approvalGrants"),
    false,
    "an empty grant list would replace the client's",
  );
  // One targeted notice for both stores: the client keeps one failure per
  // session, so two would leave only the last store's outage on screen.
  const targeted = notices(sent).filter((n) => n.target?.id === SESSION);
  assert.equal(targeted.length, 1);
  assert.equal(targeted[0]!.serverCondition, true);
  assert.match(
    targeted[0]!.message,
    /approval store and the pull-request card store/,
  );
});

test("a deep-linked view on connect gets its targeted notice AFTER ready, the frame the client retires such notes on", async () => {
  const sent: ServerMessage[] = [];
  await new Connection(fakeSocket(sent), { sessionId: SESSION }).init();
  const at = (pick: (m: ServerMessage) => boolean) => sent.findIndex(pick);
  const snapshot = at((m) => m.type === "snapshot");
  const ready = at((m) => m.type === "ready");
  const global = at((m) => m.type === "notice" && !m.target);
  const targeted = at((m) => m.type === "notice" && m.target?.id === SESSION);
  assert.ok(snapshot >= 0, "the deep link was shown");
  assert.ok(ready > snapshot);
  assert.ok(global > ready);
  assert.ok(
    targeted > ready,
    `targeted notice at ${targeted}, ready at ${ready}: ${sent.map((m) => m.type).join(", ")}`,
  );
  assert.equal(
    sent.filter((m) => m.type === "notice" && m.target?.id === SESSION).length,
    1,
  );
});

test("boot's recoveries run on past a store that throws", () => {
  const ran: string[] = [];
  bootStep("auto-approval recovery", approvals.recoverAutoApprovalsOnBoot);
  bootStep("agent-handoff recovery", () => ran.push("handoffs"));
  assert.deepEqual(ran, ["handoffs"]);
  assert.throws(
    () => approvals.recoverAutoApprovalsOnBoot(),
    LegacyStoreUnavailableError,
  );
});

test("decisions, grants, new cards and card mutations refuse", async () => {
  assert.throws(
    () =>
      approvals.createApproval({
        sessionId: SESSION,
        kind: "commit",
        title: "t",
        body: { kind: "commit", message: "m", files: [] },
      }),
    LegacyStoreUnavailableError,
  );
  await assert.rejects(
    approvals.resolveApproval("appr_x", "approved"),
    LegacyStoreUnavailableError,
  );
  assert.throws(
    () => approvals.revokeApprovalGrant(SESSION, "k"),
    LegacyStoreUnavailableError,
  );
  assert.throws(
    () => approvals.approvalForId("appr_x"),
    LegacyStoreUnavailableError,
  );
  assert.throws(
    () =>
      cards.createPullRequestCard(
        {
          sessionId: SESSION,
          status: "creating",
          title: "t",
          headBranch: "f",
          baseBranch: "main",
        },
        {
          repoRoot: "/tmp/r",
          sessionKind: "developer",
          sessionId: SESSION,
          headBranch: "f",
          baseBranch: "main",
          draft: false,
        },
      ),
    LegacyStoreUnavailableError,
  );
  assert.throws(
    () => cards.patchPullRequestCard("pr_x", { status: "open" }),
    LegacyStoreUnavailableError,
  );
  assert.throws(
    () => cards.openPullRequestCards(),
    LegacyStoreUnavailableError,
  );
});
