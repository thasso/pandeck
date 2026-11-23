/**
 * The approval route guard (Task-1463 P6a, P6B-F3; `docs/approvals.md`): a
 * card whose persisted `context.via` its executor does not declare fails
 * `ROUTE_UNSUPPORTED` before any executor code, approved by hand or under a
 * grant at idle. A card without a route runs as ever, and a rejection needs
 * no executor. Sessions are real `sessionStore` rows; only the broadcasts and
 * the outcome drain are stubbed.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApprovalCard } from "@assistant/shared";
import { sessionStore } from "./db/sessionStore.ts";
import {
  ROUTE_UNSUPPORTED,
  approvalForId,
  createApproval,
  grantApprovalForSession,
  registerApprovalExecutor,
  resolveApproval,
  runAutoApprovals,
  setApprovalBroadcastForTests,
  setAutoApprovalDrainForTests,
} from "./pendingApprovals.ts";

/** Every executor hook the runner called, in order. */
let hooks: string[];

function register(routes?: readonly string[]): void {
  registerApprovalExecutor("jiraIssue", {
    ...(routes ? { routes } : {}),
    prepare(card: ApprovalCard) {
      hooks.push("prepare");
      return Promise.resolve(card.body);
    },
    execute() {
      hooks.push("execute");
      return Promise.resolve({ resultSummary: "done" });
    },
    release() {
      hooks.push("release");
    },
  });
}

function session(): string {
  const id = `route-guard-${randomUUID()}`;
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant", title: id });
  return id;
}

function card(sessionId: string, context?: Record<string, unknown>) {
  return createApproval({
    sessionId,
    kind: "jiraIssue",
    title: "Jira",
    body: {
      kind: "jiraIssue",
      items: [
        {
          clientId: "c0",
          issueKey: "PA-1",
          operation: "comment",
          fieldChanges: [],
        },
      ],
    },
    ...(context ? { context } : {}),
  });
}

beforeEach(() => {
  hooks = [];
  setApprovalBroadcastForTests(() => {});
  setAutoApprovalDrainForTests(async () => {});
  register();
});

afterEach(() => {
  setApprovalBroadcastForTests(null);
  setAutoApprovalDrainForTests(null);
});

test("a routed card approved by hand fails ROUTE_UNSUPPORTED and runs no executor hook", async () => {
  for (const via of ["gateway", 1, null]) {
    const routed = card(session(), { via });
    const { card: resolved, outcomePrompt } = await resolveApproval(
      routed.id,
      "approved",
    );
    expect(resolved).toMatchObject({
      status: "failed",
      decision: "approved",
      error: ROUTE_UNSUPPORTED,
    });
    expect(approvalForId(routed.id)?.status).toBe("failed");
    expect(outcomePrompt).toContain(`Error: ${ROUTE_UNSUPPORTED}`);
  }
  expect(hooks).toEqual([]);
});

test("a routed card approved under a grant at idle fails the same, with no hook", async () => {
  const sessionId = session();
  grantApprovalForSession(sessionId, "jira:comment", false);
  const routed = card(sessionId, { via: "gateway" });
  expect(routed.autoApproved).toBe(true);
  await runAutoApprovals(sessionId);
  expect(approvalForId(routed.id)).toMatchObject({
    status: "failed",
    autoApproved: true,
    error: ROUTE_UNSUPPORTED,
  });
  expect(hooks).toEqual([]);
});

test("a card without a route runs as ever; a declared route runs too", async () => {
  const plain = card(session(), { cwd: "/tmp" });
  expect((await resolveApproval(plain.id, "approved")).card.status).toBe(
    "executed",
  );
  expect(hooks).toEqual(["prepare", "execute", "release"]);

  hooks = [];
  register(["gateway"]);
  const routed = card(session(), { via: "gateway" });
  expect((await resolveApproval(routed.id, "approved")).card.status).toBe(
    "executed",
  );
  expect(hooks).toEqual(["prepare", "execute", "release"]);
  const other = card(session(), { via: "elsewhere" });
  expect((await resolveApproval(other.id, "approved")).card.error).toBe(
    ROUTE_UNSUPPORTED,
  );
  expect(hooks).toEqual(["prepare", "execute", "release"]);
});

test("a routed card's rejection needs no executor", async () => {
  const routed = card(session(), { via: "gateway" });
  expect((await resolveApproval(routed.id, "rejected")).card).toMatchObject({
    status: "rejected",
    decision: "rejected",
  });
  expect(hooks).toEqual([]);
});
