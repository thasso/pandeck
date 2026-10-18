/**
 * Approval grants inherited down the spawn chain (`docs/approvals.md`,
 * Inherited grants).
 *
 * A spawned session's card is covered when every operation it performs is
 * held by the session or by an ancestor its spawn edges inherit from. The
 * lookup is live: no grant row is copied, so a revoke on the holder ends
 * coverage at the next check. Sessions and edges are REAL `sessionStore` rows;
 * only the broadcasts and the outcome drain are stubbed.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type {
  ApprovalBody,
  ApprovalCard,
  JiraIssueMutationOperation,
} from "@assistant/shared";
import { getDb } from "./db/index.ts";
import { APPROVAL_SQL, approvalStore } from "./db/approvalStore.ts";
import { SPAWN_GRANT_EDGE_SQL, sessionStore } from "./db/sessionStore.ts";
import {
  approvalForId,
  approvalGrantsPayload,
  type ApprovalGrantsPayload,
  createApproval,
  grantApprovalForSession,
  registerApprovalExecutor,
  resolveApproval,
  revokeApprovalGrant,
  runAutoApprovals,
  setApprovalBroadcastForTests,
  setAutoApprovalDrainForTests,
} from "./pendingApprovals.ts";

let executions: string[];
/** Runs inside `prepare`, so a test can act while a decision is mid-flight. */
let duringPrepare: (() => void) | null;
let grantBroadcasts: Array<{
  sessionId: string;
  payload: ApprovalGrantsPayload;
}>;

function session(name: string): string {
  const id = `inherit-${name}-${randomUUID()}`;
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant", title: id });
  return id;
}

/** A → B → C, each spawned by the one before with the default edge. */
function chain(): { a: string; b: string; c: string } {
  const a = session("a");
  const b = session("b");
  const c = session("c");
  sessionStore.linkSpawned(a, b);
  sessionStore.linkSpawned(b, c);
  return { a, b, c };
}

function jiraCard(
  sessionId: string,
  operations: JiraIssueMutationOperation[],
): ApprovalCard {
  return createApproval({
    sessionId,
    kind: "jiraIssue",
    title: "Jira",
    body: {
      kind: "jiraIssue",
      items: operations.map((operation, index) => ({
        clientId: `c${index}`,
        issueKey: "PA-1",
        operation,
        fieldChanges: [],
      })),
    },
  });
}

/** A card whose body only has to name its operation; it is never run. */
function cardFor(sessionId: string, body: Record<string, unknown>) {
  return createApproval({
    sessionId,
    kind: body.kind as ApprovalCard["kind"],
    title: String(body.kind),
    body: body as unknown as ApprovalBody,
  });
}

/** Grant a key the inspector cannot grant ahead of time, as its card would. */
function grantFromCard(sessionId: string, key: string): void {
  approvalStore.insertGrant(sessionId, {
    key,
    grantedAt: Date.now(),
    sourceApprovalId: `appr-${key}`,
  });
}

beforeEach(() => {
  executions = [];
  duringPrepare = null;
  grantBroadcasts = [];
  setApprovalBroadcastForTests(
    () => {},
    (sessionId, _grants, payload) =>
      grantBroadcasts.push({ sessionId, payload }),
  );
  setAutoApprovalDrainForTests(async () => {});
  registerApprovalExecutor("jiraIssue", {
    async prepare(card: ApprovalCard): Promise<ApprovalBody> {
      duringPrepare?.();
      return card.body;
    },
    async execute(card: ApprovalCard) {
      executions.push(card.id);
      return { resultSummary: "done" };
    },
  });
});

afterEach(() => {
  setApprovalBroadcastForTests(null);
  setAutoApprovalDrainForTests(null);
});

test("a grant covers the cards of every session spawned below its holder, and no other", async () => {
  const { a, b, c } = chain();
  const unrelated = session("unrelated");
  grantApprovalForSession(a, "jira:comment");

  const onB = jiraCard(b, ["comment"]);
  const onC = jiraCard(c, ["comment"]);
  const elsewhere = jiraCard(unrelated, ["comment"]);

  expect(onB.autoApproved).toBe(true);
  expect(onC.autoApproved).toBe(true);
  expect(onC.inheritedGrants).toEqual([
    { key: "jira:comment", fromSessionId: a },
  ]);
  expect(elsewhere.autoApproved).toBeUndefined();
  expect(elsewhere.inheritedGrants).toBeUndefined();

  await runAutoApprovals(c);
  expect(executions).toEqual([onC.id]);
  expect(approvalForId(onC.id)).toMatchObject({
    status: "executed",
    autoApproved: true,
    inheritedGrants: [{ key: "jira:comment", fromSessionId: a }],
  });
  expect(approvalForId(elsewhere.id)?.status).toBe("pending");
  // Nothing was copied: only the holder has a row.
  expect(approvalStore.grantsForSession(b)).toEqual([]);
  expect(approvalStore.grantsForSession(c)).toEqual([]);
});

test("each operation may be held by a different ancestor", () => {
  const { a, b, c } = chain();
  grantApprovalForSession(a, "jira:comment");
  grantApprovalForSession(b, "jira:edit");

  const mixed = jiraCard(c, ["comment", "edit"]);
  expect(mixed.autoApproved).toBe(true);
  expect(mixed.inheritedGrants).toEqual([
    { key: "jira:comment", fromSessionId: a },
    { key: "jira:edit", fromSessionId: b },
  ]);

  revokeApprovalGrant(b, "jira:edit");
  expect(jiraCard(c, ["comment", "edit"]).autoApproved).toBeUndefined();
});

test("the nearest holder is recorded, and the run records the holder that still stands", async () => {
  const { a, b, c } = chain();
  grantApprovalForSession(a, "jira:comment");
  grantApprovalForSession(b, "jira:comment");

  const card = jiraCard(c, ["comment"]);
  expect(card.inheritedGrants).toEqual([
    { key: "jira:comment", fromSessionId: b },
  ]);

  revokeApprovalGrant(b, "jira:comment");
  await runAutoApprovals(c);
  expect(approvalForId(card.id)).toMatchObject({
    status: "executed",
    inheritedGrants: [{ key: "jira:comment", fromSessionId: a }],
  });

  // A grant of its own wins: the card names no ancestor for that key, while
  // the inspector still shows that an ancestor covers it too.
  grantApprovalForSession(c, "jira:comment");
  const own = jiraCard(c, ["comment"]);
  expect(own.autoApproved).toBe(true);
  expect(own.inheritedGrants).toBeUndefined();
  expect(approvalGrantsPayload(c).inherited).toEqual([
    expect.objectContaining({ key: "jira:comment", heldBy: a }),
  ]);
});

test("ownership never gates inheritance", () => {
  const a = session("a");
  const owned = session("owned");
  const bornTaken = session("born-taken");
  const takenLater = session("taken-later");
  sessionStore.linkSpawned(a, owned);
  sessionStore.linkSpawned(a, bornTaken, Date.now(), "taken-over");
  sessionStore.linkSpawned(a, takenLater);
  sessionStore.setSpawnedOwnership(takenLater, "taken-over");
  grantApprovalForSession(a, "jira:comment");

  for (const id of [owned, bornTaken, takenLater])
    expect(jiraCard(id, ["comment"]).autoApproved).toBe(true);
});

test("every grant key inherits, card-only ones included; keyless cards are never covered", () => {
  const { a, c } = chain();
  const tag = {
    kind: "gitTag",
    repoPath: "/repo",
    remote: "origin",
    branch: "main",
    pushUrlFingerprint: "fp",
    tag: "v1",
    targetSha: "abc",
  };
  grantFromCard(a, "githubBranchDelete");
  grantFromCard(a, "managedPullRequestMerge");
  grantFromCard(a, "gitTag:/repo:origin:main:fp:v1:abc");

  expect(cardFor(c, { kind: "githubBranchDelete" }).autoApproved).toBe(true);
  expect(cardFor(c, { kind: "managedPullRequestMerge" }).autoApproved).toBe(
    true,
  );
  expect(cardFor(c, tag).autoApproved).toBe(true);
  expect(cardFor(c, { ...tag, tag: "v2" }).autoApproved).toBeUndefined();
  expect(
    cardFor(c, { kind: "managedCommitOverride" }).autoApproved,
  ).toBeUndefined();
});

test("a revoke on the holder hands a waiting card back, as a local revoke does", async () => {
  const { a, c } = chain();
  grantApprovalForSession(a, "jira:comment");
  const card = jiraCard(c, ["comment"]);
  expect(card.inheritedGrants).toHaveLength(1);

  revokeApprovalGrant(a, "jira:comment");
  await runAutoApprovals(c);

  expect(executions).toEqual([]);
  const back = approvalForId(card.id)!;
  expect(back.status).toBe("pending");
  expect(back.autoApproved).toBeUndefined();
  expect(back.inheritedGrants).toBeUndefined();

  // Approved by a click later, it records no inherited authority.
  const { card: clicked } = await resolveApproval(card.id, "approved");
  expect(clicked.status).toBe("executed");
  expect(clicked.inheritedGrants).toBeUndefined();
});

test("a revoke on the holder while the card prepares still stops it", async () => {
  const { a, c } = chain();
  grantApprovalForSession(a, "jira:comment");
  const card = jiraCard(c, ["comment"]);
  duringPrepare = () => revokeApprovalGrant(a, "jira:comment");

  await runAutoApprovals(c);

  expect(executions).toEqual([]);
  expect(approvalForId(card.id)).toMatchObject({ status: "pending" });
  expect(approvalForId(card.id)?.autoApproved).toBeUndefined();
});

test("an opted-out edge passes nothing down, while the opted-out session's own grants still do", () => {
  const a = session("a");
  const b = session("b");
  const c = session("c");
  sessionStore.linkSpawned(a, b, Date.now(), "coordinator", {
    inheritGrants: false,
  });
  sessionStore.linkSpawned(b, c);
  grantApprovalForSession(a, "jira:comment");
  grantApprovalForSession(b, "jira:edit");

  expect(jiraCard(b, ["comment"]).autoApproved).toBeUndefined();
  expect(jiraCard(c, ["comment"]).autoApproved).toBeUndefined();
  expect(jiraCard(c, ["edit"]).inheritedGrants).toEqual([
    { key: "jira:edit", fromSessionId: b },
  ]);
  expect(approvalGrantsPayload(b)).toMatchObject({
    inherited: [],
    inheritance: { parentSessionId: a, inherits: false },
  });
  expect(approvalGrantsPayload(c)).toMatchObject({
    inherited: [expect.objectContaining({ key: "jira:edit", heldBy: b })],
    inheritance: { parentSessionId: b, inherits: true },
  });
});

test("a deleted ancestor's authority ends there; an archived one's does not", () => {
  const { a, b, c } = chain();
  grantApprovalForSession(a, "jira:comment");
  grantApprovalForSession(b, "jira:edit");

  sessionStore.setArchived(a, true);
  expect(jiraCard(c, ["comment"]).autoApproved).toBe(true);

  sessionStore.setArchived(a, false);
  sessionStore.markDeleted(a);
  expect(jiraCard(c, ["comment"]).autoApproved).toBeUndefined();
  expect(jiraCard(c, ["edit"]).autoApproved).toBe(true);

  // The walk stops at a deleted parent: nothing above it reaches below it.
  const top = session("top");
  const mid = session("mid");
  const leaf = session("leaf");
  sessionStore.linkSpawned(top, mid);
  sessionStore.linkSpawned(mid, leaf);
  grantApprovalForSession(top, "jira:comment");
  sessionStore.markDeleted(mid);
  expect(jiraCard(leaf, ["comment"]).autoApproved).toBeUndefined();
});

test("a grant change re-sends the lists of the holder and of every session below it", () => {
  const { a, b, c } = chain();
  grantApprovalForSession(a, "jira:comment");
  expect(grantBroadcasts.map((entry) => entry.sessionId)).toEqual([a, b, c]);
  const toC = grantBroadcasts.find((entry) => entry.sessionId === c)!;
  expect(toC.payload).toMatchObject({
    grants: [],
    inherited: [{ key: "jira:comment", heldBy: a }],
    inheritance: { parentSessionId: b, inherits: true },
  });
  expect(
    grantBroadcasts.find((entry) => entry.sessionId === a)!.payload,
  ).toMatchObject({ grants: [{ key: "jira:comment" }], inherited: [] });
  expect(
    grantBroadcasts.find((entry) => entry.sessionId === a)!.payload.inheritance,
  ).toBeUndefined();

  grantBroadcasts = [];
  revokeApprovalGrant(a, "jira:comment");
  expect(grantBroadcasts.map((entry) => entry.sessionId)).toEqual([a, b, c]);
  expect(
    grantBroadcasts.find((entry) => entry.sessionId === c)!.payload.inherited,
  ).toEqual([]);
});

/** Every SQL string prepared on the connection while `run` executes. */
function statementsDuring(run: () => void): string[] {
  const db = getDb();
  const prepare = db.prepare.bind(db);
  const seen: string[] = [];
  db.prepare = ((sql: string) => {
    seen.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  try {
    run();
  } finally {
    db.prepare = prepare;
  }
  return seen;
}

test("a grant-change fan-out reads each session's grants and each edge once", () => {
  // A → B → C → D, plus a second branch A → E → F: every descendant shares
  // the edges above it, which a per-descendant walk would read again.
  const { a, b, c } = chain();
  const d = session("d");
  const e = session("e");
  const f = session("f");
  sessionStore.linkSpawned(c, d);
  sessionStore.linkSpawned(a, e);
  sessionStore.linkSpawned(e, f);
  const tree = [a, b, c, d, e, f];

  const seen = statementsDuring(() =>
    grantApprovalForSession(a, "jira:comment"),
  );

  expect(grantBroadcasts.map((entry) => entry.sessionId).sort()).toEqual(
    [...tree].sort(),
  );
  const count = (sql: string) => seen.filter((s) => s === sql).length;
  // One grant read and at most one edge read per session in the tree.
  expect(count(APPROVAL_SQL.grantsForSession)).toBe(tree.length);
  expect(count(SPAWN_GRANT_EDGE_SQL)).toBeLessThanOrEqual(tree.length);
});
