import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { sessionStore } from "./db/sessionStore.ts";
import { refinementSource } from "./promptRefinementSource.ts";

const ports = vi.hoisted(() => ({
  getLiveById: vi.fn(),
  buildContext: vi.fn(() => "Visible transcript"),
}));
vi.mock("./hub.ts", () => ({ hub: { getLiveById: ports.getLiveById } }));
vi.mock("./promptRefinement.ts", () => ({
  buildVisibleConversationContext: ports.buildContext,
}));
beforeEach(() => {
  ports.getLiveById.mockReset();
  ports.buildContext.mockClear();
});

function source(id: string, requiresEnterprise: boolean) {
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    requiresEnterprise,
  });
}

test("an unknown staged id does not turn an ordinary draft into enterprise work", () => {
  assert.deepEqual(
    refinementSource({ sessionId: "not-started", requiresEnterprise: false }),
    { context: "" },
  );
  assert.equal(ports.buildContext.mock.calls.length, 0);
});
test("staged enterprise intent constrains refinement before any row exists", () => {
  assert.deepEqual(
    refinementSource({
      sessionId: "enterprise-not-started",
      requiresEnterprise: true,
    }),
    { context: "", requiresEnterprise: true },
  );
});
test("canonical enterprise requirements survive caller false, context opt-out and source deletion", () => {
  source("refinement-enterprise", true);
  const expected = {
    context: "",
    sourceSessionId: "refinement-enterprise",
    requiresEnterprise: true,
  };
  assert.deepEqual(
    refinementSource({
      sessionId: "refinement-enterprise",
      requiresEnterprise: false,
      includeContext: false,
    }),
    expected,
  );
  assert.equal(ports.getLiveById.mock.calls.length, 0);
  sessionStore.markDeleted("refinement-enterprise");
  assert.deepEqual(
    refinementSource({
      sessionId: "refinement-enterprise",
      requiresEnterprise: false,
    }),
    expected,
  );
});
test("known ordinary source context keeps its provenance without a global requirement", () => {
  source("refinement-ordinary", false);
  ports.getLiveById.mockReturnValue({ snapshot: () => [] });
  assert.deepEqual(refinementSource({ sessionId: "refinement-ordinary" }), {
    context: "Visible transcript",
    sourceSessionId: "refinement-ordinary",
  });
  assert.equal(ports.buildContext.mock.calls.length, 1);
});
test("a retained live transcript without its row fails closed, not like a staged id", () => {
  ports.getLiveById.mockReturnValue({ snapshot: () => [] });
  assert.deepEqual(refinementSource({ sessionId: "retained-unknown" }), {
    context: "Visible transcript",
    sourceSessionId: "retained-unknown",
    requiresEnterprise: true,
  });
});
