/**
 * The rollback drill (Task-1463 P6b, P6B-F3): a build with P6b reverted
 * registers the `jiraIssue` and `confluencePage` executors without
 * `routes`. Every gateway card must then fail closed through P6a's route
 * guard (`ROUTE_UNSUPPORTED`), approved by hand, covered by a grant at
 * idle, or after a switch to local mode; and a card left `executing` by
 * the restart must stay untouched. Nothing reads local credentials,
 * fetches, or reaches the gateway's apply. Its own file: it replaces the
 * real executors for the rest of the module registry.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ApprovalCard, ApprovalKind } from "@assistant/shared";
import { afterEach, beforeEach, test, vi } from "vitest";
import { approvalStore } from "../../db/approvalStore.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import {
  ROUTE_UNSUPPORTED,
  approvalForId,
  createApproval,
  grantApprovalForSession,
  recoverAutoApprovalsOnBoot,
  registerApprovalExecutor,
  resolveApproval,
  runAutoApprovals,
  setApprovalBroadcastForTests,
  setAutoApprovalDrainForTests,
} from "../../pendingApprovals.ts";
import {
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
} from "../../remoteTools.ts";
import { GATEWAY_CONTEXT } from "./remoteWriteRules.ts";

const SITE = "acme.atlassian.net";

/** What the reverted build's executors did: the local path, recorded. */
let local: string[];
let applied: string[];
let fetches: string[];
let uninstall: () => void = () => {};
let sessionId: string;

function revertedExecutor(kind: ApprovalKind): void {
  registerApprovalExecutor(kind, {
    execute() {
      local.push(kind);
      return Promise.resolve({ resultSummary: "applied locally" });
    },
  });
}

beforeEach(async () => {
  // The real modules load first, so the drill replaces their registrations.
  await import("../jira/jiraTools.ts");
  await import("../confluence/confluenceTools.ts");
  revertedExecutor("jiraIssue");
  revertedExecutor("confluencePage");
  local = [];
  applied = [];
  fetches = [];
  sessionId = `rollback-drill-${randomUUID()}`;
  sessionStore.upsert({
    id: sessionId,
    harness: "pi",
    agentType: "assistant",
    title: sessionId,
  });
  vi.stubGlobal("fetch", (input: unknown) => {
    fetches.push(String(input));
    return Promise.reject(new Error("no fetch in the drill"));
  });
  setApprovalBroadcastForTests(() => {});
  setAutoApprovalDrainForTests(async () => {});
  uninstall = installRemoteToolPort({
    callFile: () => Promise.reject(new Error("unused")),
    uploads: {
      open: () => Promise.reject(new Error("unused")),
      put: () => Promise.reject(new Error("unused")),
      release: () => {},
    },
    call: () => Promise.reject(new Error("unused")),
    prepare: () => Promise.reject(new Error("unused")),
    apply: (name) => {
      applied.push(name);
      return Promise.resolve({ outcome: "notSent" });
    },
  });
  applyListing(
    acceptRemoteTools([
      {
        name: "jira_mutate_issue",
        effect: "write",
        actionKey: "jira:write",
        twoPhase: true,
      },
    ]),
  );
});

afterEach(() => {
  uninstall();
  vi.unstubAllGlobals();
  setApprovalBroadcastForTests(null);
  setAutoApprovalDrainForTests(null);
  assert.deepEqual(local, [], "the local path ran");
  assert.deepEqual(applied, [], "the gateway's apply ran");
  assert.deepEqual(fetches, [], "something fetched");
});

function gatewayCards(): ApprovalCard[] {
  return [
    createApproval({
      sessionId,
      kind: "jiraIssue",
      title: "Comment on OPS-1",
      body: {
        kind: "jiraIssue",
        jiraHost: SITE,
        items: [
          {
            clientId: "item-1",
            issueKey: "OPS-1",
            operation: "comment",
            commentBody: "Hi",
            fieldChanges: [],
          },
        ],
      },
      context: { ...GATEWAY_CONTEXT },
    }),
    createApproval({
      sessionId,
      kind: "confluencePage",
      title: "Comment on Page",
      body: {
        kind: "confluencePage",
        confluenceHost: SITE,
        items: [
          { clientId: "item-1", operation: "comment", pageId: "1", body: "Hi" },
        ],
      },
      context: { ...GATEWAY_CONTEXT },
    }),
  ];
}

test("approved by hand, each gateway card fails ROUTE_UNSUPPORTED", async () => {
  for (const card of gatewayCards()) {
    const { card: decided, outcomePrompt } = await resolveApproval(
      card.id,
      "approved",
    );
    assert.equal(decided.status, "failed");
    assert.equal(decided.error, ROUTE_UNSUPPORTED);
    assert.ok(outcomePrompt.includes(`Error: ${ROUTE_UNSUPPORTED}`));
  }
});

test("covered by a session grant, the idle path fails them the same", async () => {
  grantApprovalForSession(sessionId, "jira:comment", false);
  grantApprovalForSession(sessionId, "confluence:comment", false);
  const cards = gatewayCards();
  for (const card of cards) assert.equal(card.autoApproved, true);
  await runAutoApprovals(sessionId);
  for (const card of cards)
    assert.equal(approvalForId(card.id)?.error, ROUTE_UNSUPPORTED);
});

test("boot recovery leaves an executing gateway card untouched and fails a covered pending one", async () => {
  grantApprovalForSession(sessionId, "jira:comment", false);
  grantApprovalForSession(sessionId, "confluence:comment", false);
  const [executing, pending] = gatewayCards();
  const stored = approvalStore.get(executing!.id)!;
  stored.card.status = "executing";
  approvalStore.update(stored);
  const runs: Promise<void>[] = [];
  recoverAutoApprovalsOnBoot((id) => {
    if (id === sessionId) runs.push(runAutoApprovals(id));
  });
  await Promise.all(runs);
  assert.equal(approvalForId(executing!.id)?.status, "executing");
  assert.equal(approvalForId(pending!.id)?.error, ROUTE_UNSUPPORTED);
});

test("after a switch to local mode, a gateway card still fails closed", async () => {
  const cards = gatewayCards();
  uninstall();
  for (const card of cards)
    assert.equal(
      (await resolveApproval(card.id, "approved")).card.error,
      ROUTE_UNSUPPORTED,
    );
});
