/**
 * Task 97: memory tool surface (`memory_search` / `memory_manage`) + persona
 * guidance. Isolated temp DB.
 *   pnpm --filter @assistant/server test src/tools/memoryTools.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";
import type { ToolCallContext } from "../../mcp/tool.ts";

const tmp = mkdtempSync(join(tmpdir(), "memory-tools-test-"));
process.env.ASSISTANT_CWD = tmp;

const { memoryTools } = await import("./memoryTools.ts");
const { AGENT_TYPES } = await import("../../agentTypes.ts");
const { memoryBehaviorGuidance } = await import("../../memoryPrompt.ts");
const { getDb, closeDb } = await import("../../db/index.ts");
const { memoryStore } = await import("../../db/memoryStore.ts");

const search = memoryTools.find((t) => t.name === "memory_search")!;
const manage = memoryTools.find((t) => t.name === "memory_manage")!;

let callSeq = 0;
function ctx(
  toolCallId?: string,
  agentType:
    "assistant" | "personal-assistant" | "developer" = "personal-assistant",
): ToolCallContext {
  return {
    toolCallId: toolCallId ?? `call-${(callSeq += 1)}`,
    session: { sessionId: "sess-t", harness: "pi", agentType },
  };
}
async function run(
  tool: typeof manage,
  params: unknown,
  toolCallId?: string,
): Promise<Record<string, unknown>> {
  const res = await tool.execute(params as never, ctx(toolCallId));
  return JSON.parse(
    res.content[0]!.type === "text" ? res.content[0]!.text : "{}",
  ) as Record<string, unknown>;
}

beforeEach(() => getDb().exec("DELETE FROM memory_cards"));
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("both memory tools are exposed to every persona", () => {
  for (const type of [
    "assistant",
    "personal-assistant",
    "developer",
    "workshop",
  ] as const) {
    const names = AGENT_TYPES[type].tools().map((t) => t.name);
    assert.ok(names.includes("memory_search"), `${type} has memory_search`);
    assert.ok(names.includes("memory_manage"), `${type} has memory_manage`);
  }
});

test("create → search round-trip; injected id/revision drives manage", async () => {
  const created = await run(manage, {
    operations: [
      {
        op: "create",
        text: "Prefers concise answers",
        kind: "preference",
        reason: "user said",
      },
    ],
  });
  const card = (
    created.results as Array<{
      ok: boolean;
      card: { id: string; revision: number };
    }>
  )[0]!;
  assert.ok(card.ok);
  const id = card.card.id;
  const rev = card.card.revision;

  const found = await run(search, { query: "concise answers" });
  const hits = found.results as Array<{ id: string; revision: number }>;
  assert.ok(
    hits.some((h) => h.id === id && h.revision === rev),
    "search returns the created card id + revision",
  );

  // Reinforce and pin via the returned id/revision.
  const pinned = await run(manage, {
    operations: [{ op: "pin", id, expectedRevision: rev }],
  });
  assert.ok((pinned.results as Array<{ ok: boolean }>)[0]!.ok);
});

test("stale expectedRevision fails without mutation and returns the current card", async () => {
  const created = await run(manage, {
    operations: [
      { op: "create", text: "Deploys frozen on Fridays", kind: "constraint" },
    ],
  });
  const { id, revision } = (
    created.results as Array<{ card: { id: string; revision: number } }>
  )[0]!.card;
  await run(manage, {
    operations: [
      {
        op: "edit",
        id,
        expectedRevision: revision,
        text: "Deploys blocked on Fridays",
      },
    ],
  });
  // Now revision is stale.
  const stale = await run(manage, {
    operations: [
      { op: "edit", id, expectedRevision: revision, text: "should not apply" },
    ],
  });
  const res = (
    stale.results as Array<{
      ok: boolean;
      error: string;
      current: { revision: number; text: string };
    }>
  )[0]!;
  assert.equal(res.ok, false);
  assert.equal(res.error, "stale-revision");
  assert.equal(
    res.current.text,
    "Deploys blocked on Fridays",
    "returns the current card, unmutated",
  );
});

test("correction supersedes and creates a replacement in one operation", async () => {
  const created = await run(manage, {
    operations: [{ op: "create", text: "Lives in Berlin", kind: "fact" }],
  });
  const { id, revision } = (
    created.results as Array<{ card: { id: string; revision: number } }>
  )[0]!.card;
  const corrected = await run(manage, {
    operations: [
      {
        op: "correct",
        id,
        expectedRevision: revision,
        text: "Lives in Munich",
        kind: "fact",
      },
    ],
  });
  const res = (
    corrected.results as Array<{
      ok: boolean;
      superseded: string;
      card: { id: string; text: string };
    }>
  )[0]!;
  assert.ok(res.ok);
  assert.equal(res.superseded, id);
  assert.notEqual(res.card.id, id);
  assert.equal(res.card.text, "Lives in Munich");
});

test("retried create does not duplicate; converges on one card", async () => {
  await run(manage, {
    operations: [
      { op: "create", text: "Uses vim keybindings", kind: "preference" },
    ],
  });
  await run(manage, {
    operations: [
      { op: "create", text: "uses   vim keybindings", kind: "preference" },
    ],
  });
  const found = await run(search, { query: "vim keybindings", scope: "all" });
  assert.equal(
    (found.results as unknown[]).length,
    1,
    "duplicate content converges on one card",
  );
});

test("retried existing-card tool ops are idempotent no-ops (same tool call id)", async () => {
  const created = await run(manage, {
    operations: [{ op: "create", text: "Lives in Berlin", kind: "fact" }],
  });
  const { id, revision } = (
    created.results as Array<{ card: { id: string; revision: number } }>
  )[0]!.card;

  // A retried CORRECT with the same tool-call id returns the prior replacement,
  // not a stale error, and does not supersede twice.
  const correctParams = {
    operations: [
      {
        op: "correct",
        id,
        expectedRevision: revision,
        text: "Lives in Munich",
        kind: "fact",
      },
    ],
  };
  const first = await run(manage, correctParams, "call-correct");
  const firstCard = (
    first.results as Array<{ ok: boolean; card: { id: string } }>
  )[0]!;
  assert.ok(firstCard.ok);
  const retry = await run(manage, correctParams, "call-correct");
  const retryCard = (
    retry.results as Array<{ ok: boolean; card: { id: string } }>
  )[0]!;
  assert.ok(retryCard.ok, "retry is a no-op success, not a stale error");
  assert.equal(
    retryCard.card.id,
    firstCard.card.id,
    "same replacement, no second supersede",
  );
  // Exactly one active card (the replacement) — the retry created nothing.
  assert.equal(memoryStore.count({ states: ["active"] }), 1);

  // A retried PIN with the same tool-call id is also an idempotent no-op success.
  const repl = memoryStore.activeCards()[0]!;
  const pinParams = {
    operations: [{ op: "pin", id: repl.id, expectedRevision: repl.revision }],
  };
  assert.ok(
    (
      (await run(manage, pinParams, "call-pin")).results as Array<{
        ok: boolean;
      }>
    )[0]!.ok,
  );
  const pinRetry = (await run(manage, pinParams, "call-pin")).results as Array<{
    ok: boolean;
  }>;
  assert.ok(pinRetry[0]!.ok, "retried pin is an idempotent success, not stale");
});

/**
 * Task 285 review: `text`/`kind` reach the schema on every operation, but only
 * create/correct/edit read them — an op that does not is a SUCCESS that changed
 * nothing about the text. Nothing rejects it, so the applicability note in the
 * schema is the only warning a caller gets; this test is why it must stay.
 */
test("reinforce ignores a text it was handed, and says ok", async () => {
  const created = await run(manage, {
    operations: [{ op: "create", text: "Original wording", kind: "fact" }],
  });
  const { id, revision } = (
    created.results as Array<{ card: { id: string; revision: number } }>
  )[0]!.card;

  const reinforced = await run(manage, {
    operations: [
      { op: "reinforce", id, expectedRevision: revision, text: "New wording" },
    ],
  });
  const result = (
    reinforced.results as Array<{ ok: boolean; card: { text: string } }>
  )[0]!;
  assert.ok(result.ok, "the ignored text does not fail the operation");
  assert.equal(
    result.card.text,
    "Original wording",
    "reinforce leaves the text alone: correct/edit are the ops that rewrite it",
  );
});

test("persona guidance differs: coding read-only, personal-assistant temporal rule", () => {
  const pa = memoryBehaviorGuidance("personal-assistant");
  const dev = memoryBehaviorGuidance("developer");
  const asst = memoryBehaviorGuidance("assistant");
  assert.match(pa, /Time is first-class/i);
  assert.doesNotMatch(asst, /Time is first-class/i);
  assert.match(dev, /READ-ONLY|automatic capture is disabled/i);
  assert.doesNotMatch(pa, /READ-ONLY/i);
  assert.match(asst, /\[id@revision\]/, "teaches injected id references");
});
