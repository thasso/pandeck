/**
 * Up-front grant requests (`docs/approvals.md`, Requesting grants up front).
 *
 * The tool drops what the session already holds with at least the requested
 * scope and puts the rest on ONE keyless card; only the user's click grants
 * the keys or raises the peer turn cap. Sessions, edges, grants and caps are
 * REAL store rows; only the broadcasts, the outcome drain and the session
 * list broadcast are stubbed, and the cap setter is wrapped in a spy.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type {
  ApprovalBody,
  ApprovalCard,
  ApprovalGrantsRequestBody,
  ApprovalResolutionEdits,
} from "@assistant/shared";

vi.mock("../../hub.ts", () => ({ hub: {} }));
vi.mock("../../peerSpawnRuntimes.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../peerSpawnRuntimes.ts")>();
  return {
    ...actual,
    setSessionPeerTurnCap: vi.fn(actual.setSessionPeerTurnCap),
  };
});

const { sessionStore } = await import("../../db/sessionStore.ts");
const { approvalStore } = await import("../../db/approvalStore.ts");
const { directPeerTurnCapOf, setSessionPeerTurnCap } =
  await import("../../peerSpawnRuntimes.ts");
const {
  approvalForId,
  approvalGrantsForSession,
  approvalsForSession,
  createApproval,
  effectiveGrantScope,
  grantApprovalForSession,
  hasPendingApproval,
  resolveApproval,
  runAutoApprovals,
  setApprovalBroadcastForTests,
  setAutoApprovalDrainForTests,
} = await import("../../pendingApprovals.ts");
const { approvalGrantsRequestTool } =
  await import("./approvalGrantsRequestTool.ts");
await import("../../hub.ts");

const setter = vi.mocked(setSessionPeerTurnCap);

function session(name = "s"): string {
  const id = `grants-request-${name}-${randomUUID()}`;
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant", title: id });
  return id;
}

function grant(sessionId: string, key: string, inheritable: boolean): void {
  approvalStore.insertGrant(sessionId, {
    key,
    grantedAt: Date.now(),
    sourceApprovalId: `appr-${key}`,
    inheritable,
  });
}

async function request(
  sessionId: string,
  params: Record<string, unknown>,
): Promise<{ text: string; terminate: boolean }> {
  const result = await approvalGrantsRequestTool.execute(
    { reason: "Long delivery run", ...params },
    {
      toolCallId: `call-${randomUUID()}`,
      session: { sessionId, harness: "pi", agentType: "assistant" },
    },
  );
  return {
    text: (result.content[0] as { text: string }).text,
    terminate: result.terminate === true,
  };
}

function pending(sessionId: string): ApprovalCard[] {
  return approvalsForSession(sessionId).filter(
    (card) => card.status === "pending",
  );
}

function onlyCard(sessionId: string): ApprovalCard {
  const cards = approvalsForSession(sessionId);
  expect(cards).toHaveLength(1);
  return cards[0]!;
}

const bodyOf = (card: ApprovalCard) => card.body as ApprovalGrantsRequestBody;

/** Grants and cap, the state no step before the click may change. */
function state(sessionId: string) {
  return {
    grants: approvalGrantsForSession(sessionId),
    cap: directPeerTurnCapOf(sessionId),
  };
}

function mergeCard(sessionId: string): ApprovalCard {
  return createApproval({
    sessionId,
    kind: "managedPullRequestMerge",
    title: "Merge",
    body: { kind: "managedPullRequestMerge" } as unknown as ApprovalBody,
  });
}

beforeEach(() => {
  setter.mockClear();
  setApprovalBroadcastForTests(
    () => {},
    () => {},
  );
  setAutoApprovalDrainForTests(async () => {});
});

afterEach(() => {
  setApprovalBroadcastForTests(null);
  setAutoApprovalDrainForTests(null);
});

test("refuses tag keys, keyless kinds, unknown and repeated keys, and an empty request, creating nothing", async () => {
  const id = session();
  for (const key of [
    "gitTag:/repo:origin:main:fp:v1:abc",
    "settingsInput",
    "managedCommitOverride",
    "approvalGrantsRequest",
    "nope",
  ])
    await expect(request(id, { grants: [{ key }] })).rejects.toThrow(
      /cannot be requested/,
    );
  await expect(
    request(id, { grants: [{ key: "jira:edit" }, { key: "jira:edit" }] }),
  ).rejects.toThrow(/twice/);
  await expect(request(id, {})).rejects.toThrow(/at least one/);
  await expect(
    request(id, { grants: [{ key: "jira:edit" }], reason: "  " }),
  ).rejects.toThrow(/reason/);
  await expect(request(id, { peerTurnCap: 17 })).rejects.toThrow(/1 to 16/);
  expect(approvalsForSession(id)).toEqual([]);
});

test("one keyless card lists what is missing, card-only keys marked, and ends the turn", async () => {
  const id = session();
  const result = await request(id, {
    grants: [
      { key: "jira:edit" },
      { key: "managedPullRequestMerge", alsoSpawnedSessions: true },
    ],
    peerTurnCap: 8,
  });

  expect(result.terminate).toBe(true);
  expect(result.text).toMatch(/end your turn/);
  const card = onlyCard(id);
  expect(card).toMatchObject({
    kind: "approvalGrantsRequest",
    status: "pending",
  });
  expect(card.autoApproved).toBeUndefined();
  expect(bodyOf(card)).toEqual({
    kind: "approvalGrantsRequest",
    reason: "Long delivery run",
    items: [
      expect.objectContaining({
        key: "jira:edit",
        cardOnly: false,
        inheritable: false,
        covers: expect.any(String),
      }),
      expect.objectContaining({
        key: "managedPullRequestMerge",
        cardOnly: true,
        inheritable: true,
        label: expect.stringMatching(/merge/i),
      }),
    ],
    peerTurnCap: { current: 4, requested: 8 },
  });
});

test("no card for what the session already holds with at least the requested scope", async () => {
  const parent = session("parent");
  const id = session("child");
  sessionStore.linkSpawned(parent, id);
  grant(id, "jira:edit", false);
  grant(id, "jira:comment", false);
  grant(parent, "jira:comment", true);
  grant(parent, "tempo:create", true);
  setSessionPeerTurnCap(id, 6);
  setter.mockClear();

  // Own session-only covers session-only; an ancestor's inheritable grant
  // counts as inheritable even where an own session-only one is nearer.
  const held = await request(id, {
    grants: [
      { key: "jira:edit" },
      { key: "jira:comment", alsoSpawnedSessions: true },
      { key: "tempo:create", alsoSpawnedSessions: true },
    ],
    peerTurnCap: 6,
  });
  expect(held.terminate).toBe(false);
  expect(held.text).toMatch(/Already granted/);
  expect(approvalsForSession(id)).toEqual([]);
  expect(effectiveGrantScope(id, "jira:comment")).toBe("inheritable");

  // Own session-only with an inheritable request is a widening: kept.
  await request(id, {
    grants: [
      { key: "jira:edit", alsoSpawnedSessions: true },
      { key: "jira:comment", alsoSpawnedSessions: true },
    ],
    peerTurnCap: 5,
  });
  const card = onlyCard(id);
  expect(bodyOf(card).items).toEqual([
    expect.objectContaining({
      key: "jira:edit",
      inheritable: true,
      heldForSessionOnly: true,
    }),
  ]);
  expect(bodyOf(card).peerTurnCap).toBeUndefined();
  expect(setter).not.toHaveBeenCalled();
});

test("asking again after approval creates no card", async () => {
  const id = session();
  await request(id, {
    grants: [{ key: "managedPullRequestMerge" }],
    peerTurnCap: 8,
  });
  await resolveApproval(onlyCard(id).id, "approved");
  const again = await request(id, {
    grants: [{ key: "managedPullRequestMerge" }],
    peerTurnCap: 8,
  });
  expect(again.terminate).toBe(false);
  expect(approvalsForSession(id)).toHaveLength(1);
});

test("a newer request supersedes the earlier pending one", async () => {
  const id = session();
  await request(id, { grants: [{ key: "jira:edit" }] });
  const first = onlyCard(id);
  await request(id, { grants: [{ key: "jira:create" }] });
  expect(approvalForId(first.id)?.status).toBe("superseded");
  expect(pending(id)).toHaveLength(1);
});

test("nothing is granted and the cap stays until the user approves", async () => {
  const id = session();
  grant(id, "jira:comment", false);
  const before = state(id);
  expect(before.cap).toBe(4);
  await request(id, {
    grants: [
      { key: "jira:edit" },
      { key: "managedPullRequestMerge", alsoSpawnedSessions: true },
    ],
    peerTurnCap: 8,
  });
  const card = onlyCard(id);
  expect(state(id)).toEqual(before);

  // Even with every requested key granted inheritable above and on the
  // session, the request card itself is never covered.
  await runAutoApprovals(id);
  expect(approvalForId(card.id)).toMatchObject({ status: "pending" });
  expect(approvalForId(card.id)?.autoApproved).toBeUndefined();
  expect(state(id)).toEqual(before);

  for (const edits of [
    {
      kind: "approvalGrantsRequest",
      keys: [{ key: "jira:create", inheritable: false }],
    },
    { kind: "approvalGrantsRequest", keys: [], peerTurnCap: 99 },
    { kind: "approvalGrantsRequest", keys: [] },
  ] as ApprovalResolutionEdits[])
    await expect(resolveApproval(card.id, "approved", edits)).rejects.toThrow();
  expect(approvalForId(card.id)).toMatchObject({ status: "pending" });
  expect(state(id)).toEqual(before);

  // Approve with the cap unticked: grants applied, the setter never runs.
  await resolveApproval(card.id, "approved", {
    kind: "approvalGrantsRequest",
    keys: [{ key: "jira:edit", inheritable: false }],
  });
  expect(setter).not.toHaveBeenCalled();
  expect(directPeerTurnCapOf(id)).toBe(4);

  const afterApprove = state(id);
  await request(id, { grants: [{ key: "jira:create" }], peerTurnCap: 8 });
  const second = pending(id)[0]!;
  const rejected = await resolveApproval(second.id, "rejected");
  expect(rejected.outcomePrompt).toMatch(/REJECTED/);
  expect(state(id)).toEqual(afterApprove);
  expect(setter).not.toHaveBeenCalled();
});

test("a request card stays pending even when every key is already granted everywhere", async () => {
  const parent = session("parent");
  const id = session("child");
  sessionStore.linkSpawned(parent, id);
  for (const holder of [id, parent]) {
    grant(holder, "approvalGrantsRequest", true);
    grant(holder, "jira:create", true);
  }
  await request(id, { grants: [{ key: "jira:edit" }], peerTurnCap: 8 });
  const card = onlyCard(id);
  expect(card.autoApproved).toBeUndefined();
  expect(hasPendingApproval(id)).toBe(true);
  await runAutoApprovals(id);
  expect(approvalForId(card.id)).toMatchObject({ status: "pending" });
  expect(directPeerTurnCapOf(id)).toBe(4);
});

test("approval grants each ticked key with its chosen scope, raises the cap and tells the agent", async () => {
  const id = session();
  await request(id, {
    grants: [
      { key: "jira:edit" },
      { key: "managedPullRequestMerge", alsoSpawnedSessions: true },
      { key: "github:create" },
    ],
    peerTurnCap: 8,
  });
  const card = onlyCard(id);
  const { card: done, outcomePrompt } = await resolveApproval(
    card.id,
    "approved",
    {
      kind: "approvalGrantsRequest",
      keys: [
        { key: "jira:edit", inheritable: true },
        { key: "managedPullRequestMerge", inheritable: false },
      ],
      peerTurnCap: 6,
    },
  );

  expect(done.status).toBe("executed");
  expect(approvalGrantsForSession(id)).toEqual([
    expect.objectContaining({
      key: "jira:edit",
      inheritable: true,
      sourceApprovalId: card.id,
    }),
    expect.objectContaining({
      key: "managedPullRequestMerge",
      inheritable: false,
      sourceApprovalId: card.id,
    }),
  ]);
  expect(directPeerTurnCapOf(id)).toBe(6);
  expect(bodyOf(done).result).toEqual({
    granted: [
      { key: "jira:edit", inheritable: true },
      { key: "managedPullRequestMerge", inheritable: false },
    ],
    declined: ["github:create"],
    peerTurnCap: { outcome: "raised", from: 4, to: 6 },
  });
  expect(outcomePrompt).toMatch(/jira:edit \(also sessions it starts\)/);
  expect(outcomePrompt).toMatch(
    /managedPullRequestMerge \(this session only\)/,
  );
  expect(outcomePrompt).toMatch(/Not granted: github:create/);
  expect(outcomePrompt).toMatch(/raised from 4 to 6/);
});

test("a request-granted merge covers later merge cards, and reaches a child only when passed down", async () => {
  const parent = session("parent");
  const child = session("child");
  sessionStore.linkSpawned(parent, child);
  await request(parent, { grants: [{ key: "managedPullRequestMerge" }] });
  await resolveApproval(onlyCard(parent).id, "approved");

  expect(mergeCard(parent).autoApproved).toBe(true);
  expect(mergeCard(child).autoApproved).toBeUndefined();

  await request(parent, {
    grants: [{ key: "managedPullRequestMerge", alsoSpawnedSessions: true }],
  });
  const widening = pending(parent).find(
    (card) => card.kind === "approvalGrantsRequest",
  )!;
  await resolveApproval(widening.id, "approved");
  expect(mergeCard(child).autoApproved).toBe(true);
});

test("the cap is only ever raised: a cap raised meanwhile is left alone", async () => {
  const id = session();
  await request(id, { peerTurnCap: 8 });
  const card = onlyCard(id);
  setSessionPeerTurnCap(id, 10);
  setter.mockClear();
  const { card: done, outcomePrompt } = await resolveApproval(
    card.id,
    "approved",
  );
  expect(setter).not.toHaveBeenCalled();
  expect(directPeerTurnCapOf(id)).toBe(10);
  expect(bodyOf(done).result?.peerTurnCap).toEqual({
    outcome: "unchanged",
    current: 10,
  });
  expect(outcomePrompt).toMatch(/unchanged \(10\)/);
});

test("a cap failure keeps the grants and the failed card and handoff say what was granted", async () => {
  const id = session();
  await request(id, {
    grants: [{ key: "jira:edit" }, { key: "jira:create" }],
    peerTurnCap: 8,
  });
  const card = onlyCard(id);
  setter.mockImplementationOnce(() => {
    throw new Error("Session does not exist or was deleted.");
  });
  const { card: failed, outcomePrompt } = await resolveApproval(
    card.id,
    "approved",
    {
      kind: "approvalGrantsRequest",
      keys: [{ key: "jira:edit", inheritable: true }],
      peerTurnCap: 8,
    },
  );

  expect(failed.status).toBe("failed");
  expect(approvalGrantsForSession(id)).toEqual([
    expect.objectContaining({ key: "jira:edit", inheritable: true }),
  ]);
  expect(directPeerTurnCapOf(id)).toBe(4);
  expect(bodyOf(failed).result).toEqual({
    granted: [{ key: "jira:edit", inheritable: true }],
    declined: ["jira:create"],
    peerTurnCap: {
      outcome: "failed",
      error: "Session does not exist or was deleted.",
    },
  });
  for (const text of [failed.error ?? "", outcomePrompt]) {
    expect(text).toMatch(/Granted: jira:edit \(also sessions it starts\)/);
    expect(text).toMatch(/Not granted: jira:create/);
    expect(text).toMatch(/Peer turn cap not raised: Session does not exist/);
  }
  expect(approvalForId(failed.id)?.status).toBe("failed");
});

test("the inspector still refuses card-only keys", () => {
  const id = session();
  grantApprovalForSession(id, "managedPullRequestMerge");
  expect(approvalGrantsForSession(id)).toEqual([]);
});

test("a grant request selection is checked for shape before it reaches the card", async () => {
  const { validateClientMessage } =
    await import("../../validateClientMessage.ts");
  const ok = (edits: unknown) =>
    validateClientMessage({
      type: "resolveApproval",
      approvalId: "appr_1",
      decision: "approved",
      edits,
    }).ok;
  const kind = "approvalGrantsRequest";
  expect(ok({ kind, keys: [{ key: "jira:edit", inheritable: true }] })).toBe(
    true,
  );
  expect(ok({ kind, keys: [], peerTurnCap: 8 })).toBe(true);
  expect(ok({ kind })).toBe(false);
  expect(ok({ kind, keys: [{ key: "jira:edit" }] })).toBe(false);
  expect(ok({ kind, keys: [{ key: 1, inheritable: false }] })).toBe(false);
  expect(ok({ kind, keys: [], peerTurnCap: "8" })).toBe(false);
});
