/**
 * Tests {@link ClaudeSdkSession}'s context-clear surface (`clearContext`, the
 * harness step behind `/clear`) and the boundary card it renders.
 *
 * Run through Vitest: `pnpm --filter @assistant/server test src/claudeSdk/ClaudeSdkSession.clear.test.ts`
 *
 * The CLI reaches this session's context through the resume id, so the whole
 * clear is: forget that id, and make sure the next query asks for no `resume`.
 * What must NOT change is our transcript — the app log owns it, and a cleared
 * session keeps every message the user can still read.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import { entriesToDisplayMessages } from "@assistant/shared/display";
import { runClearForHost } from "../hostSlashCommands.ts";
import { ClaudeSdkSession } from "./ClaudeSdkSession.ts";
import type { ClaudeSdkMessage, ClaudeSdkSeam } from "./sdkSeam.ts";

const PROVIDER_SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Records the options of every query so the resume id can be asserted. */
function recordingSeam(seen: Array<Record<string, unknown>>): ClaudeSdkSeam {
  return {
    query(params) {
      seen.push((params.options ?? {}) as Record<string, unknown>);
      return {
        async *[Symbol.asyncIterator]() {
          const messages: ClaudeSdkMessage[] = [];
          for (const message of messages) yield message;
        },
      };
    },
  };
}

function sessionWithHistory(seam: ClaudeSdkSeam): ClaudeSdkSession {
  return new ClaudeSdkSession("clear-test", {
    seam: () => Promise.resolve(seam),
    title: "Clear test",
    providerSessionId: PROVIDER_SESSION,
    modelId: "sonnet",
    thinkingLevel: "medium",
    agentType: "workshop",
    usage: {
      input: 40_000,
      output: 2_000,
      cacheRead: 9_000,
      cacheWrite: 0,
      cost: 0.4,
      contextTokens: 51_000,
    },
  });
}

async function testClearedCard(): Promise<void> {
  const queries: Array<Record<string, unknown>> = [];
  const session = sessionWithHistory(recordingSeam(queries));
  const envelopes: ServerMessage[] = [];
  session.addViewer({ send: (m) => envelopes.push(m) });

  const { assistantId } = session.beginSyntheticTool("/clear", {
    command: "/clear",
  });
  const outcome = await session.clearContext();
  assert.equal(outcome.kind, "cleared", "a session with history clears");
  if (outcome.kind !== "cleared") return;
  assert.equal(
    outcome.tokensBefore,
    51_000,
    "the dropped context size is reported",
  );

  session.finishSyntheticCard({
    kind: "contextClear",
    contextClear:
      outcome.tokensBefore !== undefined
        ? { tokensBefore: outcome.tokensBefore }
        : {},
  });

  const types = envelopes.map((e) => e.type);
  assert.ok(
    types.includes("contextClearResult"),
    `contextClearResult present: ${types.join(",")}`,
  );
  assert.ok(types.includes("assistantEnd"), "assistantEnd present");
  for (const e of envelopes) {
    if (e.type === "contextClearResult" || e.type === "assistantEnd")
      assert.equal(
        (e as { id: string }).id,
        assistantId,
        `${e.type} shares the synthetic turn id`,
      );
  }

  const snapshot = session.snapshot();
  assert.equal(snapshot.length, 1, "the clear turn is the only turn");
  assert.equal(
    snapshot[0]!.blocks[0]!.kind,
    "contextClear",
    "block is the boundary card",
  );
  assert.equal(
    session.contextInfo().context?.tokens,
    null,
    "context reading drops to unknown, not a stale 51k",
  );

  const record = session.toRecord();
  assert.equal(
    record.providerSessionId,
    undefined,
    "the persisted record forgets the resume id, so a restart cannot resume it",
  );
  const cards = entriesToDisplayMessages(record.entries)
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "contextClear");
  assert.equal(cards.length, 1, "the card is durable, not transient");

  // Every read hands out a COPY, like the other card kinds: a caller that edits
  // what it got must not be editing the session's own committed entry.
  const handedOut = session
    .timelineEntries()
    .find((e) => e.type === "command.result");
  assert.ok(handedOut && handedOut.card.kind === "contextClear");
  (handedOut.card.contextClear as { tokensBefore?: number }).tokensBefore = 7;
  const reread = session
    .timelineEntries()
    .find((e) => e.type === "command.result");
  assert.ok(reread && reread.card.kind === "contextClear");
  assert.equal(
    reread.card.contextClear.tokensBefore,
    51_000,
    "the session's own card is untouched by a caller's edit",
  );

  // The point of the whole exercise: the next turn opens a FRESH provider
  // session instead of resuming the cleared one.
  const adapter = session.createRuntimeAdapter();
  await adapter.prompt("after the clear").catch(() => {});
  assert.ok(queries.length > 0, "a query was opened for the next prompt");
  assert.equal(
    queries[0]!.resume,
    undefined,
    "the post-clear query carries no resume id",
  );
}

/**
 * The runner against the REAL host, end to end. `beginSyntheticTool` marks the
 * session running for the duration of the turn it opens, so a runner that reads
 * that flag after opening one refuses every time — which no fake-host test with
 * a stubbed begin can see.
 */
async function testRunnerAgainstRealSession(): Promise<void> {
  const session = sessionWithHistory(recordingSeam([]));
  const envelopes: ServerMessage[] = [];
  session.addViewer({ send: (m) => envelopes.push(m) });

  await runClearForHost(session);

  const clears = envelopes.filter((e) => e.type === "contextClearResult");
  assert.equal(clears.length, 1, "the runner rendered the boundary card");
  assert.equal(
    session.toRecord().providerSessionId,
    undefined,
    "the context was really cleared, not refused",
  );
  const toolEnds = envelopes.filter(
    (e) => e.type === "toolEnd" && e.isError === true,
  );
  assert.deepEqual(toolEnds, [], "no error turn: nothing refused the clear");
  assert.equal(session.isRunning, false, "the synthetic turn was closed");
}

/** A busy session refuses in the harness, before a turn is opened. */
async function testRunnerRefusesWhileStreaming(): Promise<void> {
  const session = sessionWithHistory(recordingSeam([]));
  session.beginSyntheticTool("/other", { command: "/other" });
  await assert.rejects(
    runClearForHost(session),
    /while Claude is streaming/i,
    "the harness's own refusal reaches the dispatcher",
  );
  assert.equal(
    session.toRecord().providerSessionId,
    PROVIDER_SESSION,
    "the refused clear left the context alone",
  );
}

async function testNoProviderHistory(): Promise<void> {
  const session = new ClaudeSdkSession("clear-fresh", {
    seam: () => Promise.resolve(recordingSeam([])),
  });
  const outcome = await session.clearContext();
  assert.equal(
    outcome.kind,
    "skipped",
    "a session with no Claude context has nothing to clear",
  );
}

test(
  "Claude /clear drops the resume id, reports what it dropped, and renders one durable card",
  testClearedCard,
);
test(
  "Claude /clear without provider context is skipped",
  testNoProviderHistory,
);
test(
  "the /clear runner clears a real Claude session instead of refusing its own turn",
  testRunnerAgainstRealSession,
);
test(
  "the /clear runner refuses a streaming Claude session",
  testRunnerRefusesWhileStreaming,
);
