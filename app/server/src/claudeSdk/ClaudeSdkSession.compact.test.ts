/**
 * Tests {@link ClaudeSdkSession}'s manual-compaction surface (`compactContext`,
 * the harness step behind `/compact`) and the compaction card it renders.
 *
 * Run through Vitest: `pnpm --filter @assistant/server test src/claudeSdk/ClaudeSdkSession.compact.test.ts`
 *
 * The fake seam reproduces what the real CLI emits (verified live against
 * claude-code 2.1.207): a `system`/`compact_boundary` message with pre/post token
 * counts and preserved-message uuids, then REPLAYS of the preserved history as
 * ordinary user/assistant messages, then `result`. The replays must not land in
 * the transcript, and a run WITHOUT a boundary ("Not enough messages to compact.")
 * must report `skipped` rather than a bogus compaction card.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import { entriesToDisplayMessages } from "@assistant/shared/display";
import { ClaudeSdkSession } from "./ClaudeSdkSession.ts";
import type { ClaudeSdkMessage, ClaudeSdkSeam } from "./sdkSeam.ts";

const PROVIDER_SESSION = "11111111-2222-3333-4444-555555555555";

function boundaryMessage(): ClaudeSdkMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    session_id: PROVIDER_SESSION,
    uuid: "boundary-uuid",
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 41_000,
      post_tokens: 6_400,
      duration_ms: 3_502,
      preserved_messages: {
        anchor_uuid: "anchor-uuid",
        uuids: ["kept-1", "kept-2"],
      },
    },
  } as unknown as ClaudeSdkMessage;
}

function replayMessages(): ClaudeSdkMessage[] {
  return [
    {
      type: "user",
      session_id: PROVIDER_SESSION,
      uuid: "kept-1",
      message: { role: "user", content: "keep me" },
    },
    {
      type: "assistant",
      session_id: PROVIDER_SESSION,
      uuid: "kept-2",
      message: {
        id: "msg_kept",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "replayed history" }],
      },
    },
  ] as unknown as ClaudeSdkMessage[];
}

function resultMessage(result: string): ClaudeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: PROVIDER_SESSION,
    uuid: "result-uuid",
    is_error: false,
    result,
    num_turns: 0,
    total_cost_usd: 0.01,
    modelUsage: {},
  } as unknown as ClaudeSdkMessage;
}

/** A seam that replays a fixed message list, plus a PostCompact hook driver. */
function seamFor(
  messages: ClaudeSdkMessage[],
  summary?: string,
): ClaudeSdkSeam {
  return {
    query(params) {
      const hooks = (
        params.options as
          | {
              hooks?: Record<
                string,
                Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>
              >;
            }
          | undefined
      )?.hooks;
      return {
        async *[Symbol.asyncIterator]() {
          if (summary !== undefined) {
            for (const matcher of hooks?.PostCompact ?? []) {
              for (const hook of matcher.hooks)
                await hook({
                  hook_event_name: "PostCompact",
                  compact_summary: summary,
                });
            }
          }
          for (const message of messages) yield message;
        },
      };
    },
  };
}

/** A session that already has provider history, so compaction is applicable. */
function sessionWith(seam: ClaudeSdkSeam): ClaudeSdkSession {
  return new ClaudeSdkSession("compaction-test", {
    seam: () => Promise.resolve(seam),
    title: "Compaction test",
    providerSessionId: PROVIDER_SESSION,
    modelId: "sonnet",
    thinkingLevel: "medium",
    agentType: "workshop",
  });
}

async function testCompactedCard(): Promise<void> {
  const session = sessionWith(
    seamFor(
      [boundaryMessage(), ...replayMessages(), resultMessage("")],
      "## Summary\n\nWhat happened earlier.",
    ),
  );
  const envelopes: ServerMessage[] = [];
  session.addViewer({ send: (m) => envelopes.push(m) });

  const { assistantId, toolId } = session.beginSyntheticTool("/compact", {
    command: "/compact",
    rawArgs: "",
  });
  const outcome = await session.compactContext();
  assert.equal(outcome.kind, "compacted", "boundary present → compacted");
  if (outcome.kind !== "compacted") return;
  assert.equal(outcome.tokensBefore, 41_000, "pre_tokens carried");
  assert.equal(outcome.tokensAfter, 6_400, "post_tokens carried");
  assert.equal(
    outcome.firstKeptEntryId,
    "kept-1",
    "first preserved message id carried",
  );
  assert.match(
    outcome.summary,
    /What happened earlier/,
    "summary comes from the PostCompact hook",
  );

  session.finishSyntheticCompaction({
    summary: outcome.summary,
    tokensBefore: outcome.tokensBefore,
    tokensAfter: outcome.tokensAfter,
    firstKeptEntryId: outcome.firstKeptEntryId,
  });

  const types = envelopes.map((e) => e.type);
  assert.ok(
    types.includes("compactionResult"),
    `compactionResult present: ${types.join(",")}`,
  );
  assert.ok(types.includes("assistantEnd"), "assistantEnd present");
  for (const e of envelopes) {
    if (e.type === "compactionResult" || e.type === "assistantEnd") {
      assert.equal(
        (e as { id: string }).id,
        assistantId,
        `${e.type} shares the synthetic turn id`,
      );
    }
  }

  // The replayed preserved history must NOT have been appended as new turns: the
  // only assistant turn is the compaction card itself.
  const snapshot = session.snapshot();
  assert.equal(
    snapshot.length,
    1,
    `exactly one turn in the transcript, got ${snapshot.length}`,
  );
  assert.equal(
    snapshot[0]!.blocks.length,
    1,
    "compaction turn has a single block",
  );
  assert.equal(
    snapshot[0]!.blocks[0]!.kind,
    "compaction",
    "block is a compaction card",
  );
  assert.equal(session.isRunning, false, "not running after the card");

  const record = session.toRecord();
  const cards = entriesToDisplayMessages(record.entries)
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "compaction");
  assert.equal(
    cards.length,
    1,
    `record persists 1 compaction block, got ${cards.length}`,
  );
  // Context size follows the compaction immediately (post_tokens), and the
  // summarization run's cost is billed to the session.
  assert.equal(
    session.contextInfo().context?.tokens,
    6_400,
    "context reading updated from post_tokens",
  );
  assert.ok(
    (record.usage?.cost ?? 0) > 0,
    "summarization run's cost accumulated",
  );
  assert.ok(toolId.startsWith("slash-"), "toolId looks synthetic");
}

async function testSkipped(): Promise<void> {
  // No boundary: the CLI answered instead of compacting.
  const session = sessionWith(
    seamFor([resultMessage("Not enough messages to compact.")]),
  );
  session.beginSyntheticTool("/compact", { command: "/compact", rawArgs: "" });
  const outcome = await session.compactContext();
  assert.equal(
    outcome.kind,
    "skipped",
    "no boundary → skipped, not a fake card",
  );
  if (outcome.kind !== "skipped") return;
  assert.equal(
    outcome.reason,
    "Not enough messages to compact.",
    "the CLI's own answer is reported",
  );
}

async function testNoProviderHistory(): Promise<void> {
  const session = new ClaudeSdkSession("compaction-fresh", {
    seam: () => Promise.resolve(seamFor([])),
  });
  const outcome = await session.compactContext();
  assert.equal(
    outcome.kind,
    "skipped",
    "a session with no Claude history has nothing to compact",
  );
}

test(
  "Claude manual compaction reports the boundary and renders one durable card",
  testCompactedCard,
);
test("Claude compaction that the CLI declines reports skipped", testSkipped);
test(
  "Claude compaction without provider history is skipped",
  testNoProviderHistory,
);

async function testCompactionBillsItsOwnEpoch(): Promise<void> {
  // An ordinary turn, then a standalone compaction. Compaction opens its OWN
  // query(), so its result is that run's running total and must rebase onto what
  // the session already billed. Reusing the turn's epoch base charged the
  // difference between two unrelated epochs instead — here that would REPLACE
  // $0.05 with $0.01 and lose the turn, despite the code claiming to count
  // compaction usage.
  let call = 0;
  const seam: ClaudeSdkSeam = {
    query(params) {
      call += 1;
      if (call === 1)
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              ...(resultMessage("") as unknown as Record<string, unknown>),
              total_cost_usd: 0.05,
              modelUsage: {
                "claude-sonnet-4-6": { costUSD: 0.05, inputTokens: 10 },
              },
            } as unknown as ClaudeSdkMessage;
          },
        };
      return seamFor([
        boundaryMessage(),
        ...replayMessages(),
        resultMessage(""),
      ]).query(params);
    },
  };
  const session = sessionWith(seam);

  await session.createRuntimeAdapter().prompt("an ordinary turn");
  assert.ok(
    Math.abs((session.toRecord().usage?.cost ?? 0) - 0.05) < 1e-9,
    `the ordinary turn billed its run (${session.toRecord().usage?.cost})`,
  );

  session.beginSyntheticTool("/compact", { command: "/compact", rawArgs: "" });
  const outcome = await session.compactContext();
  assert.equal(outcome.kind, "compacted", "the fixture compacts");
  assert.ok(
    Math.abs((session.toRecord().usage?.cost ?? 0) - 0.06) < 1e-9,
    `compaction adds its own epoch to the session (${session.toRecord().usage?.cost})`,
  );
}

test(
  "a standalone Claude compaction bills its own query epoch",
  testCompactionBillsItsOwnEpoch,
);
