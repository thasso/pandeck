/**
 * Standalone unit test for the app-owned session log. Run through the server
 * Vitest suite:
 *   pnpm --filter @assistant/server test src/session/log/sessionLog.test.ts
 *
 * Covers: seq ordering + non-gapless cursor, clientRequestId idempotency,
 * provider-binding entries + trailing-unbound detection, client vs server
 * projection (server-only fields stripped for clients), file persistence restore,
 * and torn/corrupt-line tolerance on load.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureCpuMs } from "../../test/cpuBudget.ts";

const tmp = mkdtempSync(join(tmpdir(), "session-log-test-"));
process.env.ASSISTANT_CWD = tmp;

const { SessionLog } = await import("./store.ts");
const { createMemoryLogPersistence, createFileLogPersistence } =
  await import("./persistence.ts");

function mem() {
  return new SessionLog("sess-1", createMemoryLogPersistence());
}

/* ----------------------------- seq + ordering ---------------------------- */
test("seq + ordering", () => {
  const log = mem();
  const u = log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "hi" }],
  });
  const a = log.append({
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "yo" }],
    model: "opus",
  });
  assert.equal(u.seq, 0, "first entry seq is 0");
  assert.equal(a.seq, 1, "second entry seq is 1");
  assert.equal(log.seqCursor, 2, "cursor advances past the last seq");
  assert.notEqual(u.id, a.id, "entries get distinct ids");
  assert.ok(u.createdAt, "createdAt assigned");
});

/* --------------------------- clientRequestId idempotency ------------------ */
test("clientRequestId idempotency", () => {
  const log = mem();
  const first = log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "go" }],
    clientRequestId: "req-1",
  } as never);
  const dup = log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "go again" }],
    clientRequestId: "req-1",
  } as never);
  assert.equal(
    dup.id,
    first.id,
    "duplicate clientRequestId returns the existing entry",
  );
  assert.equal(
    log.seqCursor,
    1,
    "no second entry appended for a duplicate request",
  );
  // A different request id DOES append.
  log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "next" }],
    clientRequestId: "req-2",
  } as never);
  assert.equal(log.seqCursor, 2, "a new clientRequestId appends");
});

/* ------------------------------- binding -------------------------------- */
test("binding", () => {
  const log = mem();
  const u = log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "q" }],
  });
  assert.ok(
    log.trailingUnboundUserEntry(),
    "an unbound trailing user entry is detected",
  );
  log.bindUserEntry(u.id, "native-123");
  assert.equal(
    log.trailingUnboundUserEntry(),
    undefined,
    "binding clears the unbound detection",
  );
  // After an assistant turn, there is no trailing unbound user entry.
  const log2 = mem();
  log2.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "q" }],
  });
  log2.append({
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "a" }],
  });
  assert.equal(
    log2.trailingUnboundUserEntry(),
    undefined,
    "a trailing assistant entry means the prompt ran",
  );
});

/* ---------- bindScannedEntries: reconcile ONE completed turn -------------- */
/**
 * The shapes under test, taken from a real pi `.jsonl`:
 *
 *   native   user → assistant(call a,b) → result a → result b →
 *            assistant(call c) → result c → assistant(final text)
 *   our log  user → assistant(a,b,c aggregated) → result a → result b → result c
 *
 * Same turn, different granularity: the provider writes one message per model
 * call, we write one entry per TURN. Nothing lines up positionally after the
 * first tool call, which is what the reconciliation has to survive.
 */
type Log = InstanceType<typeof SessionLog>;
type Scan = Parameters<Log["bindScannedEntries"]>[0][number];

function bindingsOf(log: Log) {
  return log
    .rawEntries()
    .filter((e) => e.type === "message.providerBound") as Array<{
    boundEntryId: string;
    providerMessageId: string;
    providerTurnEndId?: string;
  }>;
}
function userEntry(log: Log, text: string) {
  return log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text }],
  });
}
/** An aggregated turn: text, then its calls, then the answer it ended on. */
function assistantEntry(log: Log, calls: string[], answered = true) {
  return log.append({
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "working" },
      ...calls.map((toolCallId) => ({
        type: "toolCall" as const,
        toolCallId,
        name: "bash",
        input: {},
      })),
      ...(answered ? [{ type: "text" as const, text: "done" }] : []),
    ],
  });
}
function resultEntry(log: Log, call: string) {
  return log.append({
    type: "message",
    role: "toolResult",
    toolCallId: call,
    content: [{ type: "text", text: "ok" }],
  });
}
/**
 * The boundary the runtime hands over: where the turn started, plus the prompts
 * the provider ACCEPTED into it. This helper says "it took every prompt in the
 * turn", which is the ordinary case; the refused-steering test builds its own.
 */
function acceptedTurn(log: Log, fromSeq: number) {
  const promptEntryIds = new Set(
    log
      .rawEntries()
      .filter(
        (entry) =>
          entry.type === "message" &&
          entry.role === "user" &&
          entry.seq >= fromSeq,
      )
      .map((entry) => entry.id),
  );
  return { fromSeq, promptEntryIds };
}
/** pi's own rows for one two-cycle turn, in pi's order. */
function nativeToolTurn(prefix: string): Scan[] {
  return [
    { role: "user", providerMessageId: `${prefix}-u` },
    {
      role: "assistant",
      providerMessageId: `${prefix}-a1`,
      toolCallIds: ["t1", "t2"],
    },
    { role: "toolResult", providerMessageId: `${prefix}-r1`, toolCallId: "t1" },
    { role: "toolResult", providerMessageId: `${prefix}-r2`, toolCallId: "t2" },
    {
      role: "assistant",
      providerMessageId: `${prefix}-a2`,
      toolCallIds: ["t3"],
    },
    { role: "toolResult", providerMessageId: `${prefix}-r3`, toolCallId: "t3" },
    { role: "assistant", providerMessageId: `${prefix}-a3` },
  ];
}
/** Our own rows for that same turn. Answers the ids, in log order. */
function ourToolTurn(log: Log, prompt: string) {
  const user = userEntry(log, prompt);
  const assistant = assistantEntry(log, ["t1", "t2", "t3"]);
  const results = [
    resultEntry(log, "t1"),
    resultEntry(log, "t2"),
    resultEntry(log, "t3"),
  ];
  return { user, assistant, results };
}

test("bindScannedEntries: reconcile ONE completed turn", () => {
  const log = mem();
  const turnStart = log.seqCursor;
  const { user, assistant, results } = ourToolTurn(log, "first prompt");
  const native = nativeToolTurn("n");
  log.bindScannedEntries(native, acceptedTurn(log, turnStart));

  assert.deepEqual(
    bindingsOf(log).map((b) => [b.boundEntryId, b.providerMessageId]),
    [
      [user.id, "n-u"],
      // The aggregated turn mirrors the message its final answer was written as.
      [assistant.id, "n-a3"],
      // Tool results bind by the call they answer, not by their position: ours
      // trail the turn, the provider's are interleaved between its messages.
      [results[0]!.id, "n-r1"],
      [results[1]!.id, "n-r2"],
      [results[2]!.id, "n-r3"],
    ],
    "every entry of a multi-cycle turn is bound to the message it belongs to",
  );
  assert.equal(
    bindingsOf(log).find((b) => b.boundEntryId === assistant.id)
      ?.providerTurnEndId,
    "n-a3",
    "the aggregated entry always records where its turn ENDED, reconciled or not",
  );

  log.bindScannedEntries(native, acceptedTurn(log, turnStart));
  assert.equal(
    bindingsOf(log).length,
    5,
    "re-scanning the same turn binds nothing twice",
  );
});

/* ---------- an entry anchored mid-turn does not block the rest ------------ */
test("an entry anchored mid-turn does not block the rest", () => {
  // A harness may anchor the prompt when it accepts it (`promptAccepted`) and
  // scan afterwards. Idempotence is therefore PER ENTRY: the prompt keeps the
  // anchor it already has, and the rest of the turn still binds — refusing the
  // whole scan because one row was bound would silently anchor nothing.
  const log = mem();
  const turnStart = log.seqCursor;
  const user = userEntry(log, "q");
  const assistant = assistantEntry(log, []);
  log.bindUserEntry(user.id, "n-u-accepted");

  log.bindScannedEntries(
    [
      { role: "user", providerMessageId: "n-u" },
      { role: "assistant", providerMessageId: "n-a" },
    ],
    acceptedTurn(log, turnStart),
  );

  assert.deepEqual(
    bindingsOf(log).map((b) => [b.boundEntryId, b.providerMessageId]),
    [
      [user.id, "n-u-accepted"],
      [assistant.id, "n-a"],
    ],
    "the already-anchored prompt keeps its binding and the answer gets its own",
  );
});

/* ---------- the boundary: a scan never reaches earlier turns -------------- */
test("the boundary: a scan never reaches earlier turns", () => {
  // A scan reports the provider's WHOLE file, so without the turn boundary the
  // first run after any change here would backfill every historical turn of
  // every existing session — which is not what this feature may do.
  const log = mem();
  const oldUser = userEntry(log, "an old prompt");
  const oldAssistant = assistantEntry(log, []);
  const turnStart = log.seqCursor;
  const newUser = userEntry(log, "the new prompt");
  const newAssistant = assistantEntry(log, []);

  log.bindScannedEntries(
    [
      { role: "user", providerMessageId: "n-old-u" },
      { role: "assistant", providerMessageId: "n-old-a" },
      { role: "user", providerMessageId: "n-new-u" },
      { role: "assistant", providerMessageId: "n-new-a" },
    ],
    acceptedTurn(log, turnStart),
  );

  assert.deepEqual(
    bindingsOf(log).map((b) => [b.boundEntryId, b.providerMessageId]),
    [
      [newUser.id, "n-new-u"],
      [newAssistant.id, "n-new-a"],
    ],
    "only the turn that just completed is bound",
  );
  assert.ok(
    !bindingsOf(log).some(
      (b) =>
        b.boundEntryId === oldUser.id || b.boundEntryId === oldAssistant.id,
    ),
    "the history a session already had is left exactly as it was",
  );
});

/* ---------- the match is anchored at the END of both transcripts --------- */
test("the match is anchored at the END of both transcripts", () => {
  // A prompt the provider never received (refused before it ran) leaves our log
  // with one more prompt than the file has. Pairing from the START would shift
  // every later prompt by one and mis-bind silently; pairing from the END is
  // unaffected by whatever the history contains.
  const log = mem();
  userEntry(log, "a prompt that never reached pi");
  const turnStart = log.seqCursor;
  const user = userEntry(log, "the new prompt");
  const assistant = assistantEntry(log, []);

  log.bindScannedEntries(
    [
      { role: "user", providerMessageId: "n-u-real" },
      { role: "assistant", providerMessageId: "n-a-real" },
    ],
    acceptedTurn(log, turnStart),
  );

  assert.deepEqual(
    bindingsOf(log).map((b) => [b.boundEntryId, b.providerMessageId]),
    [
      [user.id, "n-u-real"],
      [assistant.id, "n-a-real"],
    ],
    "our newest prompt pairs with the provider's newest, not with an older one",
  );
});

/* ---------- a steered turn owns both of its prompts ---------------------- */
test("a steered turn owns both of its prompts", () => {
  // Steering injects a second prompt INTO the running turn, so pi's transcript
  // carries it between the turn's own messages. Both are this turn's.
  const log = mem();
  const turnStart = log.seqCursor;
  const first = userEntry(log, "start");
  const steer = userEntry(log, "actually, also do this");
  const assistant = assistantEntry(log, ["t1"]);
  const result = resultEntry(log, "t1");

  log.bindScannedEntries(
    [
      { role: "user", providerMessageId: "n-u1" },
      { role: "assistant", providerMessageId: "n-a1", toolCallIds: ["t1"] },
      { role: "toolResult", providerMessageId: "n-r1", toolCallId: "t1" },
      { role: "user", providerMessageId: "n-u2" },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    acceptedTurn(log, turnStart),
  );

  assert.deepEqual(
    bindingsOf(log).map((b) => [b.boundEntryId, b.providerMessageId]),
    [
      [first.id, "n-u1"],
      [steer.id, "n-u2"],
      [assistant.id, "n-a2"],
      [result.id, "n-r1"],
    ],
    "both prompts of a steered turn bind, in order, with the turn around them",
  );
});

/* ---------- a REFUSED steering prompt is not one of the turn's ----------- */
test("a REFUSED steering prompt is not one of the turn's", () => {
  // A steering message is appended before the provider answers, so a refused one
  // sits in our log and in no transcript. Counting it would pair this turn's
  // prompts one row too far back — its own prompt onto the PREVIOUS turn's
  // native prompt, which is a wrong fork point, not a missing one.
  const log = mem();
  const firstStart = log.seqCursor;
  const firstUser = userEntry(log, "an earlier prompt");
  const firstAssistant = assistantEntry(log, []);
  log.bindScannedEntries(
    [
      { role: "user", providerMessageId: "n-u1" },
      { role: "assistant", providerMessageId: "n-a1" },
    ],
    acceptedTurn(log, firstStart),
  );

  const turnStart = log.seqCursor;
  const user = userEntry(log, "the running prompt");
  const refusedSteer = userEntry(log, "a steer pi ignored");
  const assistant = assistantEntry(log, []);
  log.bindScannedEntries(
    [
      { role: "user", providerMessageId: "n-u1" },
      { role: "assistant", providerMessageId: "n-a1" },
      { role: "user", providerMessageId: "n-u2" },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    // The runtime reports only the prompt the provider took.
    { fromSeq: turnStart, promptEntryIds: new Set([user.id]) },
  );

  assert.deepEqual(
    bindingsOf(log).map((b) => [b.boundEntryId, b.providerMessageId]),
    [
      [firstUser.id, "n-u1"],
      [firstAssistant.id, "n-a1"],
      [user.id, "n-u2"],
      [assistant.id, "n-a2"],
    ],
    "the accepted prompt pairs with the provider's newest, the refused one with nothing",
  );
  assert.ok(
    !bindingsOf(log).some((b) => b.boundEntryId === refusedSteer.id),
    "and the refused steer is never anchored at all",
  );
});

/* ---------- a match may never reach into the session's history ----------- */
test("a match may never reach into the session's history", () => {
  // The floor under every pairing rule: if the tail we matched contains a row an
  // earlier entry is already bound to, we are reading the history, not this turn.
  const log = mem();
  const firstStart = log.seqCursor;
  userEntry(log, "an earlier prompt");
  assistantEntry(log, []);
  log.bindScannedEntries(
    [
      { role: "user", providerMessageId: "n-u1" },
      { role: "assistant", providerMessageId: "n-a1" },
    ],
    acceptedTurn(log, firstStart),
  );
  const boundBefore = bindingsOf(log).length;

  const turnStart = log.seqCursor;
  userEntry(log, "the new prompt");
  userEntry(
    log,
    "a steer the provider accepted but did not write as its own row",
  );
  assistantEntry(log, []);
  // Our turn claims two accepted prompts, but the provider's file holds only one
  // prompt row for this turn (it folded the steer into the running one). Every
  // other rule is satisfied by this tail — pairing simply reaches one row too far
  // back, onto the prompt the FIRST turn already owns.
  log.bindScannedEntries(
    [
      { role: "user", providerMessageId: "n-u1" },
      { role: "user", providerMessageId: "n-u2" },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    acceptedTurn(log, turnStart),
  );

  assert.equal(
    bindingsOf(log).length,
    boundBefore,
    "the turn is refused rather than pairing a prompt with a historical row",
  );
});

/* ---------- turn ending on a tool result (an abort) ---------------------- */
test("turn ending on a tool result (an abort)", () => {
  // An aborted turn stops after the tool ran and never writes a final answer, so
  // the LAST native row of the turn is that result. Only it names the whole turn.
  const log = mem();
  const turnStart = log.seqCursor;
  userEntry(log, "q");
  const assistant = log.append({
    type: "message",
    role: "assistant",
    stopReason: "aborted",
    content: [{ type: "toolCall", toolCallId: "t1", name: "bash", input: {} }],
  });
  resultEntry(log, "t1");

  log.bindScannedEntries(
    [
      { role: "user", providerMessageId: "n-u" },
      { role: "assistant", providerMessageId: "n-a", toolCallIds: ["t1"] },
      { role: "toolResult", providerMessageId: "n-r", toolCallId: "t1" },
    ],
    acceptedTurn(log, turnStart),
  );

  const bound = bindingsOf(log).find((b) => b.boundEntryId === assistant.id)!;
  assert.equal(
    bound.providerMessageId,
    "n-a",
    "the entry still mirrors its own native assistant message",
  );
  assert.equal(
    bound.providerTurnEndId,
    "n-r",
    "and carries the tool result the turn ended on, which a fork must cut at",
  );
});

/* ---------- a run the provider retried mid-turn --------------------------- */
test("a run the provider retried mid-turn", () => {
  // A connection that drops mid-turn leaves a mark on both sides: our log closes
  // the abandoned attempt as a CONTENT-EMPTY assistant entry, and the provider's
  // transcript keeps the call that attempt made — one it never answered and our
  // turn never declared. Neither is a turn, so the attempt that DID answer is
  // still placed; the alternative loses the anchors of the session's last turn,
  // which is exactly where a fork is wanted.
  const log = mem();
  const turnStart = log.seqCursor;
  const user = userEntry(log, "q");
  const abandoned = log.append({
    type: "message",
    role: "assistant",
    content: [],
  });
  const assistant = assistantEntry(log, ["t1"]);
  const result = resultEntry(log, "t1");

  log.bindScannedEntries(
    [
      { role: "user", providerMessageId: "n-u" },
      // The attempt that died, still in the provider's own history.
      { role: "assistant", providerMessageId: "n-dead", toolCallIds: ["t0"] },
      { role: "assistant", providerMessageId: "n-a1", toolCallIds: ["t1"] },
      { role: "toolResult", providerMessageId: "n-r1", toolCallId: "t1" },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    acceptedTurn(log, turnStart),
  );

  assert.deepEqual(
    bindingsOf(log).map((b) => [b.boundEntryId, b.providerMessageId]),
    [
      [user.id, "n-u"],
      [assistant.id, "n-a2"],
      [result.id, "n-r1"],
    ],
    "the retried turn binds, and the attempt that wrote nothing anchors nothing",
  );
  assert.equal(
    bindingsOf(log).some((b) => b.boundEntryId === abandoned.id),
    false,
    "the content-empty entry mirrors no native message, so it gets no anchor",
  );
});

/* ---------- a turn whose ONLY answer is empty is placed as before --------- */
test("a turn whose ONLY answer is empty is placed as before", () => {
  // Nothing was retried here: the run simply produced no content. The entry is
  // still the turn's answer and still mirrors what the provider wrote, so the
  // allowance above must not turn a turn we place today into a refused one.
  const log = mem();
  const turnStart = log.seqCursor;
  const user = userEntry(log, "q");
  const assistant = log.append({
    type: "message",
    role: "assistant",
    content: [],
  });

  log.bindScannedEntries(
    [
      { role: "user", providerMessageId: "n-u" },
      { role: "assistant", providerMessageId: "n-a" },
    ],
    acceptedTurn(log, turnStart),
  );

  assert.deepEqual(
    bindingsOf(log).map((b) => [b.boundEntryId, b.providerMessageId]),
    [
      [user.id, "n-u"],
      [assistant.id, "n-a"],
    ],
    "a lone content-empty answer keeps its anchor, and so does its prompt",
  );
});

/* ---------- an unplaceable turn binds NOTHING ---------------------------- */
/**
 * Every case here is a transcript that cannot be reconciled with certainty. The
 * rule is the same for all of them: leave the whole turn unbound (it then offers
 * no fork action) rather than anchor part of it to a message that may be the
 * wrong one — and never let it disturb the turns around it.
 */
test("an unplaceable turn binds NOTHING", () => {
  const unplaceable = (
    build: (log: Log) => void,
    scan: Scan[],
    reason: string,
  ) => {
    const log = mem();
    const turnStart = log.seqCursor;
    build(log);
    log.bindScannedEntries(scan, acceptedTurn(log, turnStart));
    assert.deepEqual(bindingsOf(log), [], reason);
  };

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, ["t1"]);
      resultEntry(log, "t1");
    },
    [
      { role: "user", providerMessageId: "n-u" },
      { role: "assistant", providerMessageId: "n-a1", toolCallIds: ["t1"] },
      // The result answers a call this turn never made.
      { role: "toolResult", providerMessageId: "n-r1", toolCallId: "other" },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    "a result answering a foreign call refuses the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, ["t1", "t2"]);
      // pi answered both calls; our log only ever received one of the results,
      // so the copy a fork makes would be a row short of the provider's turn.
      resultEntry(log, "t1");
    },
    [
      { role: "user", providerMessageId: "n-u" },
      {
        role: "assistant",
        providerMessageId: "n-a1",
        toolCallIds: ["t1", "t2"],
      },
      { role: "toolResult", providerMessageId: "n-r1", toolCallId: "t1" },
      { role: "toolResult", providerMessageId: "n-r2", toolCallId: "t2" },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    "a native result our log never received refuses the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, ["t1"]);
      resultEntry(log, "t1");
    },
    [
      { role: "user", providerMessageId: "n-u" },
      // A result AHEAD of the message that declared its call: this tail is not
      // one turn in provider order, whatever the ids say.
      { role: "toolResult", providerMessageId: "n-r1", toolCallId: "t1" },
      { role: "assistant", providerMessageId: "n-a1", toolCallIds: ["t1"] },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    "a result before its declaration refuses the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, []);
    },
    [
      { role: "user", providerMessageId: "n-u" },
      // Two messages that each END a turn: the tail spans more than the turn we
      // are placing, so its terminal id is not decidable.
      { role: "assistant", providerMessageId: "n-a1" },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    "a second terminal assistant message refuses the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      // The tool never came back, so we hold no result for it either.
      assistantEntry(log, ["t1"], false);
    },
    [
      { role: "user", providerMessageId: "n-u" },
      { role: "assistant", providerMessageId: "n-a1", toolCallIds: ["t1"] },
    ],
    "a call neither side ever answered refuses the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, ["t1"]);
      resultEntry(log, "t1");
    },
    [
      { role: "user", providerMessageId: "n-u" },
      { role: "assistant", providerMessageId: "n-a1", toolCallIds: ["t1"] },
      { role: "toolResult", providerMessageId: "n-r1", toolCallId: "t1" },
      // A second row claims the same call: which one our result mirrors is not
      // decidable, and a Map would have silently kept the last.
      { role: "toolResult", providerMessageId: "n-r2", toolCallId: "t1" },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    "a duplicated native result refuses the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, []);
    },
    [
      { role: "user", providerMessageId: "n-u" },
      // This message DID call a tool; the scan could not read the call's id.
      // Reported as a message that calls nothing it is indistinguishable from
      // the turn's final answer, and our answer would anchor to a message from
      // the MIDDLE of the turn — the exact cut that loses a tool result.
      {
        role: "assistant",
        providerMessageId: "n-a1",
        unidentifiedToolCalls: true,
      },
    ],
    "a message with an unreadable call id refuses the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, ["t1"]);
      resultEntry(log, "t1");
      resultEntry(log, "t1");
    },
    [
      { role: "user", providerMessageId: "n-u" },
      { role: "assistant", providerMessageId: "n-a1", toolCallIds: ["t1"] },
      { role: "toolResult", providerMessageId: "n-r1", toolCallId: "t1" },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    "two of OUR results for one call refuses the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, ["t1", "t1"]);
      resultEntry(log, "t1");
    },
    [
      { role: "user", providerMessageId: "n-u" },
      { role: "assistant", providerMessageId: "n-a1", toolCallIds: ["t1"] },
      { role: "toolResult", providerMessageId: "n-r1", toolCallId: "t1" },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    "an entry declaring one call twice refuses the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, ["t1"]);
      resultEntry(log, "t1");
    },
    [
      { role: "user", providerMessageId: "n-u" },
      { role: "assistant", providerMessageId: "n-a1", toolCallIds: ["t1"] },
      { role: "toolResult", providerMessageId: "n-r1", toolCallId: "t1" },
      // Our entry answered after its last call, so the provider's turn must end
      // on the message that answer was written as. A scan that raced the
      // provider's own write ends on the result instead — and binding here would
      // anchor the turn one message short of its answer.
    ],
    "a scan missing the turn's final answer refuses the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, []);
      // TWO answers with content under one prompt; which native message each
      // mirrors cannot be decided from ids. Only an attempt that wrote NOTHING
      // is passed over.
      assistantEntry(log, []);
    },
    [
      { role: "user", providerMessageId: "n-u" },
      { role: "assistant", providerMessageId: "n-a" },
    ],
    "two assistant entries with content under one boundary refuse the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, ["t1"]);
      resultEntry(log, "t1");
    },
    [
      { role: "user", providerMessageId: "n-u" },
      // A foreign call the provider ANSWERED: work our turn does not account
      // for, so the tail is a turn we cannot see — not an abandoned attempt.
      { role: "assistant", providerMessageId: "n-a1", toolCallIds: ["t0"] },
      { role: "toolResult", providerMessageId: "n-r0", toolCallId: "t0" },
      { role: "assistant", providerMessageId: "n-a2", toolCallIds: ["t1"] },
      { role: "toolResult", providerMessageId: "n-r1", toolCallId: "t1" },
      { role: "assistant", providerMessageId: "n-a3" },
    ],
    "a foreign call the provider answered refuses the turn",
  );

  unplaceable(
    (log) => {
      // An ordinary turn: our log watched no attempt fail, so nothing here
      // accounts for a native message we cannot read. The allowance an
      // abandoned attempt buys is spent per attempt, and this turn has none.
      userEntry(log, "q");
      assistantEntry(log, ["t1"]);
      resultEntry(log, "t1");
    },
    [
      { role: "user", providerMessageId: "n-u" },
      { role: "assistant", providerMessageId: "n-dead", toolCallIds: ["t0"] },
      { role: "assistant", providerMessageId: "n-a1", toolCallIds: ["t1"] },
      { role: "toolResult", providerMessageId: "n-r1", toolCallId: "t1" },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    "an unexplained hanging native call refuses the turn",
  );

  unplaceable(
    (log) => {
      // ONE attempt failed on our side; the provider left TWO dead branches.
      userEntry(log, "q");
      log.append({ type: "message", role: "assistant", content: [] });
      assistantEntry(log, ["t1"]);
      resultEntry(log, "t1");
    },
    [
      { role: "user", providerMessageId: "n-u" },
      { role: "assistant", providerMessageId: "n-dead1", toolCallIds: ["t0"] },
      { role: "assistant", providerMessageId: "n-dead2", toolCallIds: ["t9"] },
      { role: "assistant", providerMessageId: "n-a1", toolCallIds: ["t1"] },
      { role: "toolResult", providerMessageId: "n-r1", toolCallId: "t1" },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    "more dead branches than attempts we saw fail refuses the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, ["t1"]);
      resultEntry(log, "t1");
    },
    [
      { role: "user", providerMessageId: "n-u" },
      // Half ours, half not: a message that mixes our turn's call with one we
      // never made is not a dead branch, and placing our entry on it would bind
      // work our copy cannot show.
      {
        role: "assistant",
        providerMessageId: "n-a1",
        toolCallIds: ["t0", "t1"],
      },
      { role: "toolResult", providerMessageId: "n-r1", toolCallId: "t1" },
      { role: "assistant", providerMessageId: "n-a2" },
    ],
    "a message mixing our call with an unknown one refuses the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, []);
    },
    [
      { role: "user", providerMessageId: "n-u" },
      { role: "assistant", providerMessageId: "n-a" },
      // The provider recorded a LATER prompt, so its last prompt is not ours and
      // the tail after it holds no answer of ours to place.
      { role: "user", providerMessageId: "n-u2" },
    ],
    "a tail that starts after a later prompt refuses the turn",
  );

  unplaceable(
    (log) => {
      userEntry(log, "q");
      assistantEntry(log, []);
    },
    [{ role: "assistant", providerMessageId: "n-a" }],
    "a turn whose prompt the provider never recorded refuses the turn",
  );
});

/* ---------- an unplaceable turn leaves its neighbours alone -------------- */
test("an unplaceable turn leaves its neighbours alone", () => {
  // The turn before it keeps the anchors it earned, and the turn after it is
  // matched independently — divergence is never contagious.
  const log = mem();
  const firstStart = log.seqCursor;
  const first = ourToolTurn(log, "first prompt");
  log.bindScannedEntries(nativeToolTurn("n1"), acceptedTurn(log, firstStart));

  const brokenStart = log.seqCursor;
  const broken = userEntry(log, "second prompt");
  const brokenAssistant = assistantEntry(log, ["t9"]);
  log.bindScannedEntries(
    [
      ...nativeToolTurn("n1"),
      { role: "user", providerMessageId: "n2-u" },
      { role: "assistant", providerMessageId: "n2-a", toolCallIds: ["t9"] },
    ],
    acceptedTurn(log, brokenStart),
  );

  const thirdStart = log.seqCursor;
  const third = userEntry(log, "third prompt");
  const thirdAssistant = assistantEntry(log, []);
  log.bindScannedEntries(
    [
      ...nativeToolTurn("n1"),
      { role: "user", providerMessageId: "n2-u" },
      { role: "assistant", providerMessageId: "n2-a", toolCallIds: ["t9"] },
      { role: "user", providerMessageId: "n3-u" },
      { role: "assistant", providerMessageId: "n3-a" },
    ],
    acceptedTurn(log, thirdStart),
  );

  const bound = new Map(
    bindingsOf(log).map((b) => [b.boundEntryId, b.providerMessageId]),
  );
  assert.equal(
    bound.get(first.user.id),
    "n1-u",
    "the earlier turn is untouched",
  );
  assert.equal(bound.get(first.assistant.id), "n1-a3", "including its anchor");
  assert.equal(
    bound.has(broken.id) || bound.has(brokenAssistant.id),
    false,
    "the turn that could not be placed is wholly unbound",
  );
  assert.equal(bound.get(third.id), "n3-u", "and the NEXT turn still binds");
  assert.equal(
    bound.get(thirdAssistant.id),
    "n3-a",
    "against its own tail of the same file",
  );
});

/* ---------------------- projection: client strips server fields ----------- */
test("projection: client strips server fields", () => {
  const log = mem();
  log.append({
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    providerMessageId: "native-abc",
    metadata: { raw: { foo: 1 } },
  } as never);
  const client = log.clientEntries();
  const server = log.serverEntries();
  assert.equal(client.length, 1);
  assert.equal(
    (client[0] as unknown as Record<string, unknown>).providerMessageId,
    undefined,
    "client entry has no providerMessageId",
  );
  assert.equal(
    (client[0] as unknown as Record<string, unknown>).metadata,
    undefined,
    "client entry has no raw metadata",
  );
  assert.equal(
    server[0]?.providerMessageId,
    "native-abc",
    "server entry retains providerMessageId",
  );
  // Bookkeeping entries never appear in either conversation view.
  log.bindUserEntry("whatever", "native-xyz");
  assert.equal(
    log.clientEntries().length,
    1,
    "binding entry is not a conversation entry",
  );
  assert.equal(
    log.serverEntries().length,
    1,
    "binding entry absent from server view too",
  );
});

/* ----------------------- tool result is its own entry --------------------- */
test("tool result is its own entry", () => {
  const log = mem();
  log.append({
    type: "message",
    role: "assistant",
    content: [
      {
        type: "toolCall",
        toolCallId: "t1",
        name: "bash",
        input: { cmd: "ls" },
      },
    ],
  });
  const tr = log.append({
    type: "message",
    role: "toolResult",
    toolCallId: "t1",
    toolName: "bash",
    content: [{ type: "text", text: "file.txt" }],
  });
  assert.equal(tr.seq, 1, "tool result is a separate seq-ordered entry");
  const client = log.clientEntries();
  assert.equal(
    client.length,
    2,
    "assistant + toolResult are two client entries",
  );
  assert.equal(client[1]?.role, "toolResult");
});

/* --------------------------- file persistence restore --------------------- */
test("file persistence restore", () => {
  const path = join(tmp, "restore.jsonl");
  const log = new SessionLog(
    "sess-restore",
    createFileLogPersistence("sess-restore", path),
  );
  log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "one" }],
    clientRequestId: "rr-1",
  } as never);
  log.append({
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "two" }],
  });

  // Reopen from the same file → entries + cursor + request index restored.
  const reopened = new SessionLog(
    "sess-restore",
    createFileLogPersistence("sess-restore", path),
  );
  assert.equal(
    reopened.clientEntries().length,
    2,
    "entries restored from disk",
  );
  assert.equal(reopened.seqCursor, 2, "seq cursor restored");
  const dup = reopened.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "one again" }],
    clientRequestId: "rr-1",
  } as never);
  assert.equal(
    dup.seq,
    0,
    "clientRequestId index survives a restore (dedupes to the original)",
  );
  assert.equal(
    reopened.clientEntries().length,
    2,
    "no new entry from a restored-dup request",
  );
});

/* --------------------------- corrupt / torn line -------------------------- */
test("corrupt / torn line", () => {
  const path = join(tmp, "corrupt.jsonl");
  const log = new SessionLog(
    "sess-corrupt",
    createFileLogPersistence("sess-corrupt", path),
  );
  log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "ok" }],
  });
  // Simulate a corrupt line + a torn final line (no trailing newline).
  appendFileSync(path, "{ this is not json }\n", "utf8");
  appendFileSync(
    path,
    '{"type":"message","role":"assistant","seq":99,"id":"x","createdAt":"now","content":[',
    "utf8",
  );
  const reopened = new SessionLog(
    "sess-corrupt",
    createFileLogPersistence("sess-corrupt", path),
  );
  assert.equal(
    reopened.clientEntries().length,
    1,
    "corrupt + torn lines are skipped; the one good entry survives",
  );
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/* ---------------- run markers: the only trace of a killed turn ------------ */
/**
 * Both harnesses flush a turn's assistant entry and tool results together when
 * it completes, so a turn the process died inside leaves NO conversation record.
 * The run bracket is the evidence, and it is read from the tail — boot asks it of
 * every session, and rehydrating every transcript is not a boot step.
 */
test("run markers: the last marker is read from the tail", () => {
  const log = mem();
  assert.equal(
    log.lastRunMarker(),
    undefined,
    "a log with no markers reports nothing rather than guessing",
  );
  log.append({ type: "run.started", runId: "r1" });
  assert.equal(log.lastRunMarker()?.type, "run.started");
  assert.equal(log.lastRunMarker()?.runId, "r1");
  log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "go" }],
  });
  assert.equal(
    log.lastRunMarker()?.type,
    "run.started",
    "the prompt that drove the turn does not close its bracket",
  );
  log.append({ type: "run.ended", runId: "r1" });
  assert.equal(log.lastRunMarker()?.type, "run.ended");
  log.append({ type: "run.started", runId: "r2" });
  log.append({ type: "run.aborted", runId: "r2" });
  assert.equal(
    log.lastRunMarker()?.type,
    "run.aborted",
    "the NEWEST marker answers; an earlier closed run never masks it",
  );
});

test("run markers: the file reader agrees with memory across the tail read and a reopen", () => {
  // The file reader has to agree with the in-memory one, including across the
  // bounded tail read and a reopen.
  const path = join(tmp, "run-marker.jsonl");
  const log = new SessionLog(
    "sess-run-marker",
    createFileLogPersistence("sess-run-marker", path),
  );
  log.append({ type: "run.started", runId: "file-run" });
  // A turn's worth of bulk between the marker and EOF, as a real interrupted
  // turn cannot have (its entries never flush) but a completed one does.
  for (let i = 0; i < 40; i += 1)
    log.append({
      type: "message",
      role: "toolResult",
      toolCallId: `t${i}`,
      content: [{ type: "text", text: "x".repeat(200) }],
    });
  assert.equal(log.lastRunMarker()?.runId, "file-run");
  const reopened = new SessionLog(
    "sess-run-marker",
    createFileLogPersistence("sess-run-marker", path),
  );
  assert.equal(
    reopened.lastRunMarker()?.type,
    "run.started",
    "reopening reads the same verdict off disk",
  );
  rmSync(path, { force: true });
});

test("run markers: the tail walk finds a marker buried past one chunk", () => {
  // Nothing bounds how much follows an opener — the prompt that drove the turn
  // is appended after it and has no size limit — so the walk must not give up
  // after one read. This buries the marker well past a single chunk.
  const path = join(tmp, "run-marker-far.jsonl");
  const log = new SessionLog(
    "sess-run-far",
    createFileLogPersistence("sess-run-far", path),
  );
  log.append({ type: "run.started", runId: "buried" });
  // 9 MiB in ONE entry: past any byte cap a scan might have been given, and past
  // the point where carrying the line across chunk boundaries could stay linear
  // if it were kept rather than dropped.
  log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "z".repeat(9 * 1024 * 1024) }],
  });
  const { value: marker, cpuMs } = measureCpuMs(() => log.lastRunMarker());
  assert.equal(
    marker?.runId,
    "buried",
    "an opener buried by one enormous prompt is still found — a cap here would" +
      " answer 'not interrupted' for exactly the session this exists to expose",
  );
  // CPU time, so a loaded runner cannot fail this (../../test/cpuBudget.ts).
  // Carrying the over-long line instead of dropping it turns the walk
  // quadratic over 9 MiB, which costs seconds rather than the ~8ms it takes.
  assert.ok(
    cpuMs < 500,
    "and the walk stays linear: an over-long line is dropped, never carried",
  );
  const reopened = new SessionLog(
    "sess-run-far",
    createFileLogPersistence("sess-run-far", path),
  );
  assert.equal(
    reopened.lastRunMarker()?.type,
    "run.started",
    "including across a chunk boundary, which splits a line in two",
  );
  rmSync(path, { force: true });
});

test("run markers: a fork copies no run bracket", () => {
  // A fork cuts at a conversation entry — INSIDE the turn, before that turn's
  // closing marker. Copying the bracket would leave the child holding an opener
  // it never wrote, and boot would read the fresh fork as a crashed session.
  const parent = mem();
  parent.append({ type: "run.started", runId: "parent-run" });
  parent.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "do it" }],
  });
  const assistant = parent.append({
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
  });
  parent.append({ type: "run.ended", runId: "parent-run" });

  const child = new SessionLog("sess-fork", createMemoryLogPersistence());
  assert.equal(parent.copyPrefixTo(child, assistant.id), true);
  assert.equal(
    child.lastRunMarker(),
    undefined,
    "a fresh fork has run nothing, so it owns no bracket",
  );
  assert.equal(
    child.clientEntries().length,
    2,
    "and the conversation it forked from is copied intact",
  );
});
