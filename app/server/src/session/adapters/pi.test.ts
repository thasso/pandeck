/**
 * Unit test for the pi entry scanner + pi adapter. Run through the server Vitest
 * suite:
 *   pnpm --filter @assistant/server test src/session/adapters/pi.test.ts
 *
 * Uses a fake pi driver (emits adapter-native events + writes a pi-shaped .jsonl)
 * so no real pi AgentSession/auth/model registry is needed. Covers the entry
 * scanner's native-id extraction, post-turn native-id binding, the run promise
 * resolving on turn end, and the adapter→runtime normalized projection.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiDriver } from "./pi.ts";
import type { AdapterEventListener } from "./nativeEvents.ts";

const tmp = mkdtempSync(join(tmpdir(), "pi-adapter-test-"));
process.env.ASSISTANT_CWD = tmp;

const { scanPiEntries, lastUserNativeId } = await import("./entryScanner.ts");
const { createPiAdapter } = await import("./pi.ts");
const { NativeAdapterEventSource } = await import("./nativeEvents.ts");
const { SessionRuntime } = await import("../runtime/runtime.ts");
const { SessionLogStore } = await import("../log/store.ts");

/* ------------------------------ entry scanner ---------------------------- */
test("entry scanner", () => {
  const path = join(tmp, "scan.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "session", id: "sess" }),
      JSON.stringify({ type: "model_change", id: "mc" }),
      JSON.stringify({
        type: "message",
        id: "u-1",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "a-1",
        message: {
          role: "assistant",
          // pi names a call `id` on the block; our model calls it `toolCallId`.
          content: [{ type: "toolCall", id: "tc-1", name: "read" }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "tr-1",
        message: { role: "toolResult", toolCallId: "tc-1", content: [] },
      }),
      JSON.stringify({
        type: "message",
        id: "a-2",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      }),
      "{ torn line", // tolerated
    ].join("\n") + "\n",
    "utf8",
  );
  const entries = scanPiEntries(path);
  assert.deepEqual(
    entries.map((e) => [e.role, e.id]),
    [
      ["user", "u-1"],
      ["assistant", "a-1"],
      ["toolResult", "tr-1"],
      ["assistant", "a-2"],
    ],
    "scans conversation entries with native ids, skips bookkeeping + torn lines",
  );
  assert.equal(
    entries[2]!.toolCallId,
    "tc-1",
    "tool result carries its toolCallId",
  );
  assert.deepEqual(
    entries.map((e) => e.toolCallIds),
    [undefined, ["tc-1"], undefined, undefined],
    "an assistant message carries the calls it declares — how a reconciler tells its turn from the next",
  );
  assert.equal(lastUserNativeId(path), "u-1", "last user native id resolved");
  assert.deepEqual(
    scanPiEntries(join(tmp, "missing.jsonl")),
    [],
    "missing file → empty",
  );
});

/* --------------------------- fake pi driver ------------------------------ */
/**
 * One realistic pi turn: the agent runs TWO tool cycles and then answers, so its
 * `.jsonl` holds three assistant messages with the results interleaved, while the
 * adapter reports the turn as one assistant stream carrying both calls.
 */
class FakePiDriver implements PiDriver {
  private events = new NativeAdapterEventSource();
  constructor(readonly sessionFile: string) {}
  subscribeAdapterEvents(listener: AdapterEventListener): () => void {
    return this.events.subscribe(listener);
  }
  prompt(text: string): "started" {
    // Pi persists the turn to its jsonl (with native ids) as it runs.
    writeFileSync(
      this.sessionFile,
      [
        JSON.stringify({ type: "session", id: "s" }),
        JSON.stringify({
          type: "message",
          id: "u-native",
          message: { role: "user", content: [{ type: "text", text }] },
        }),
        JSON.stringify({
          type: "message",
          id: "a-native-1",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "looking" },
              { type: "toolCall", id: "tc1", name: "read" },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "tr-native-1",
          message: {
            role: "toolResult",
            toolCallId: "tc1",
            content: [{ type: "text", text: "ok" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "a-native-2",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tc2", name: "bash" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "tr-native-2",
          message: {
            role: "toolResult",
            toolCallId: "tc2",
            content: [{ type: "text", text: "built" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "a-native-final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    this.events.messageStarted("turn-1");
    this.events.messageDelta("turn-1", "text", "looking");
    this.events.toolStarted("tc1", "read", {});
    this.events.toolCompleted({
      type: "toolEnd",
      sessionId: "p",
      id: "turn-1",
      toolId: "tc1",
      output: "ok",
      isError: false,
    });
    this.events.toolStarted("tc2", "bash", {});
    this.events.toolCompleted({
      type: "toolEnd",
      sessionId: "p",
      id: "turn-1",
      toolId: "tc2",
      output: "built",
      isError: false,
    });
    this.events.messageDelta("turn-1", "text", "done");
    this.events.messageCompleted("turn-1");
    return "started";
  }
  abort(): void {}
  setModel(): void {}
  setThinkingLevel(): void {}
}

/* ------------------------- adapter: events + binding --------------------- */
test("adapter: events + binding", async () => {
  const driver = new FakePiDriver(join(tmp, "run.jsonl"));
  const adapter = createPiAdapter("p", driver);
  const events: string[] = [];
  let bound:
    | {
        role: string;
        providerMessageId: string;
        toolCallId?: string;
        toolCallIds?: string[];
      }[]
    | undefined;
  adapter.subscribe((e) => {
    events.push(e.type);
    if (e.type === "entriesBound") bound = e.entries;
  });
  const result = await adapter.prompt("hello");
  assert.equal(result.stopReason, "end", "run resolves on turn end");
  assert.ok(
    events.includes("messageStarted") &&
      events.includes("messageDelta") &&
      events.includes("messageCompleted"),
    "assistant stream lifecycle mapped",
  );
  assert.ok(
    events.includes("toolStarted") && events.includes("toolCompleted"),
    "tool lifecycle mapped",
  );
  assert.deepEqual(
    bound?.map((b) => [b.role, b.providerMessageId]),
    [
      ["user", "u-native"],
      ["assistant", "a-native-1"],
      ["toolResult", "tr-native-1"],
      ["assistant", "a-native-2"],
      ["toolResult", "tr-native-2"],
      ["assistant", "a-native-final"],
    ],
    "the post-turn scan reports pi's OWN transcript, several messages per turn",
  );
  assert.equal(
    bound?.[2]!.toolCallId,
    "tc1",
    "tool result binding carries its toolCallId",
  );
  assert.deepEqual(
    bound?.map((b) => b.toolCallIds),
    [undefined, ["tc1"], undefined, ["tc2"], undefined, undefined],
    "and each assistant message carries the calls it declares, so the log can place it",
  );
  assert.equal(
    adapter.getBinding().nativeId,
    driver.sessionFile,
    "binding references the pi session file",
  );
});

/* ---------------- driver completion fallback: no runCompleted ------------ */
test("driver completion fallback: a turn that ends without runCompleted completes once and ignores late events", async () => {
  class RejectsWithoutEndDriver implements PiDriver {
    private events = new NativeAdapterEventSource();
    readonly sessionFile = undefined;
    subscribeAdapterEvents(listener: AdapterEventListener): () => void {
      return this.events.subscribe(listener);
    }
    prompt(): { outcome: "started"; completed: Promise<void> } {
      this.events.messageStarted("turn-missing-end");
      this.events.messageDelta("turn-missing-end", "text", "partial");
      this.events.toolStarted("tc-late", "Read", { file: "x" });
      return {
        outcome: "started",
        completed: Promise.reject(new Error("boom")),
      };
    }
    lateAssistantEnd(): void {
      this.events.toolCompleted({
        type: "toolEnd",
        sessionId: "p",
        id: "turn-missing-end",
        toolId: "tc-late",
        output: "late output",
        isError: false,
      });
      this.events.messageCompleted("turn-missing-end");
    }
    completionMetadata(): { model: string; usage: { inputTokens: number } } {
      return { model: "pi-model", usage: { inputTokens: 12 } };
    }
    abort(): void {}
    setModel(): void {}
    setThinkingLevel(): void {}
  }

  const driver = new RejectsWithoutEndDriver();
  const adapter = createPiAdapter("p-missing-end", driver);
  let assistantText = "";
  let messageCompletedCount = 0;
  let toolCompletedCount = 0;
  let completedModel: string | undefined;
  let completedInputTokens: number | undefined;
  let sawRunCompleted = false;
  adapter.subscribe((e) => {
    if (e.type === "messageCompleted") {
      messageCompletedCount++;
      assistantText = e.content.find((b) => b.type === "text")?.text ?? "";
      completedModel = e.model;
      completedInputTokens = e.usage?.inputTokens;
    }
    if (e.type === "toolCompleted") toolCompletedCount++;
    if (e.type === "runCompleted") sawRunCompleted = true;
  });
  const result = await adapter.prompt("hello");
  assert.equal(
    result.stopReason,
    "error",
    "driver rejection without runCompleted settles the prompt as an error",
  );
  assert.match(
    result.errorMessage ?? "",
    /boom/,
    "driver rejection is surfaced",
  );
  assert.equal(
    assistantText,
    "partial",
    "fallback completion flushes buffered assistant content",
  );
  assert.equal(
    completedModel,
    "pi-model",
    "fallback preserves best-effort model metadata",
  );
  assert.equal(
    completedInputTokens,
    12,
    "fallback preserves best-effort usage metadata",
  );
  assert.equal(
    sawRunCompleted,
    true,
    "fallback emits runCompleted so runtime observers go idle",
  );
  driver.lateAssistantEnd();
  assert.equal(
    messageCompletedCount,
    1,
    "late real completion after fallback is ignored, avoiding duplicate durable entries",
  );
  assert.equal(
    toolCompletedCount,
    0,
    "late buffered tool completions after fallback are suppressed",
  );
});

test("driver completion fallback: an empty successful completion without runCompleted is a quiet no-op", async () => {
  class CompletesWithoutEndDriver implements PiDriver {
    readonly sessionFile = undefined;
    subscribeAdapterEvents(): () => void {
      return () => {};
    }
    prompt(): { outcome: "started"; completed: Promise<void> } {
      return { outcome: "started", completed: Promise.resolve() };
    }
    abort(): void {}
    setModel(): void {}
    setThinkingLevel(): void {}
  }

  const adapter = createPiAdapter("p-noop", new CompletesWithoutEndDriver());
  const result = await adapter.prompt("hello");
  assert.equal(
    result.stopReason,
    "end",
    "empty successful driver completion without runCompleted is a quiet no-op",
  );
});

/* ------------------------- aborted pi turn is lossless ------------------- */
test("aborted pi turn is lossless", async () => {
  class AbortPiDriver implements PiDriver {
    private events = new NativeAdapterEventSource();
    constructor(readonly sessionFile: string) {}
    subscribeAdapterEvents(listener: AdapterEventListener): () => void {
      return this.events.subscribe(listener);
    }
    prompt(): "started" {
      writeFileSync(
        this.sessionFile,
        [
          JSON.stringify({ type: "session", id: "s" }),
          JSON.stringify({
            type: "message",
            id: "u-native",
            message: {
              role: "user",
              content: [{ type: "text", text: "abort me" }],
            },
          }),
          JSON.stringify({
            type: "message",
            id: "a-native",
            message: {
              role: "assistant",
              stopReason: "aborted",
              content: [
                { type: "text", text: "partial" },
                { type: "toolCall", id: "tc-abort" },
              ],
            },
          }),
          JSON.stringify({
            type: "message",
            id: "tr-native",
            message: {
              role: "toolResult",
              toolCallId: "tc-abort",
              content: [{ type: "text", text: "edited" }],
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );
      this.events.messageStarted("turn-abort");
      this.events.messageDelta("turn-abort", "text", "partial");
      this.events.toolStarted("tc-abort", "edit", {});
      this.events.toolCompleted({
        type: "toolEnd",
        sessionId: "p",
        id: "turn-abort",
        toolId: "tc-abort",
        output: "edited",
        isError: false,
      });
      this.events.messageCompleted("turn-abort", { aborted: true });
      return "started";
    }
    abort(): void {}
    setModel(): void {}
    setThinkingLevel(): void {}
  }

  const runtime = new SessionRuntime(new SessionLogStore(true));
  const driver = new AbortPiDriver(join(tmp, "abort-pi.jsonl"));
  runtime.createSession("p-abort", createPiAdapter("p-abort", driver));
  await runtime.prompt("p-abort", "abort me");
  const snap = runtime.get("p-abort")!.getSnapshot();
  assert.deepEqual(
    snap.entries.map((e) => e.role),
    ["user", "assistant", "toolResult"],
    "pi abort preserves partial assistant and completed tool result",
  );
  const assistant = snap.entries.find((e) => e.role === "assistant")!;
  assert.equal(
    assistant.stopReason,
    "aborted",
    "pi partial assistant entry is marked aborted",
  );
  // An aborted turn never reached its final answer, so pi's transcript ends it
  // on the tool result. A fork "at" this turn must cut there, or the child holds
  // a tool call with no output.
  const abortAnchors = runtime.forkAnchors("p-abort", assistant.id);
  assert.equal(
    abortAnchors.own,
    "a-native",
    "the entry still mirrors the assistant message that made the call",
  );
  assert.equal(
    abortAnchors.ownTurnEnd,
    "tr-native",
    "while the turn ends on the result, which is what the cut names",
  );
  await runtime.dispose();
});

/* -------------------------- steering prompt ------------------------------ */
test("steering prompt", async () => {
  class ManualPiDriver implements PiDriver {
    private events = new NativeAdapterEventSource();
    private running = false;
    constructor(readonly sessionFile: string) {}
    subscribeAdapterEvents(listener: AdapterEventListener): () => void {
      return this.events.subscribe(listener);
    }
    prompt(): "started" | "steered" {
      if (this.running) return "steered";
      this.running = true;
      this.events.messageStarted("turn-manual");
      this.events.messageDelta("turn-manual", "text", "waiting");
      return "started";
    }
    finish(): void {
      writeFileSync(
        this.sessionFile,
        [
          JSON.stringify({ type: "session", id: "s" }),
          JSON.stringify({
            type: "message",
            id: "u-native",
            message: {
              role: "user",
              content: [{ type: "text", text: "main" }],
            },
          }),
          JSON.stringify({
            type: "message",
            id: "a-native",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "waiting" }],
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );
      this.running = false;
      this.events.messageCompleted("turn-manual");
    }
    abort(): void {}
    setModel(): void {}
    setThinkingLevel(): void {}
  }

  const driver = new ManualPiDriver(join(tmp, "steer.jsonl"));
  const adapter = createPiAdapter("p-steer", driver);
  const main = adapter.prompt("main");
  const steer = await adapter.prompt("steer", { steer: true });
  assert.equal(steer.stopReason, "end", "steering resolves on acceptance");
  driver.finish();
  assert.equal(
    (await main).stopReason,
    "end",
    "steering does not clobber the active run promise",
  );
});

/* ------------------------ steer-only prompt mapping ---------------------- */
test("steer-only prompt mapping", async () => {
  // `steerOnly` moves the steer/start decision into the driver, so the adapter's
  // whole job is reporting WHICH happened. Mapping a driver that declined to
  // steer onto a successful steer is exactly how a lost race used to spend a
  // turn nobody asked for.
  class SteerOnlyDriver implements PiDriver {
    private events = new NativeAdapterEventSource();
    readonly calls: { steerOnly?: boolean }[] = [];
    readonly sessionFile = undefined;
    constructor(private readonly response: "steered" | "ignored") {}
    subscribeAdapterEvents(listener: AdapterEventListener): () => void {
      return this.events.subscribe(listener);
    }
    prompt(
      _t: string,
      _a?: unknown[],
      options?: { steerOnly?: boolean },
    ): "started" | "steered" | "ignored" {
      this.calls.push({ ...(options?.steerOnly ? { steerOnly: true } : {}) });
      return this.response;
    }
    abort(): void {}
    setModel(): void {}
    setThinkingLevel(): void {}
  }

  const taken = new SteerOnlyDriver("steered");
  const takenResult = await createPiAdapter("p-steer-only", taken).prompt("x", {
    steer: true,
    steerOnly: true,
  });
  assert.deepEqual(taken.calls, [{ steerOnly: true }], "the flag reaches pi");
  assert.equal(takenResult.steered, true, "a real steer reports steered");

  const refused = new SteerOnlyDriver("ignored");
  const refusedResult = await createPiAdapter("p-steer-none", refused).prompt(
    "x",
    { steer: true, steerOnly: true },
  );
  assert.equal(
    refusedResult.steered,
    false,
    "a driver that declined reports steered:false rather than rejecting",
  );
  assert.equal(refusedResult.stopReason, "end");

  // Without `steerOnly`, "ignored" keeps its existing meaning: a refusal.
  await assert.rejects(
    createPiAdapter("p-steer-legacy", new SteerOnlyDriver("ignored")).prompt(
      "x",
      { steer: true },
    ),
  );

  // The driver answers "steered" the moment it hands the text to pi, before
  // pi's own promise settles — and pi refuses to steer an idle harness. A
  // rejection there must not be reported as a delivered steer, or the fact is
  // discarded exactly the way `steerOnly` exists to prevent.
  class RejectingSteerDriver implements PiDriver {
    private events = new NativeAdapterEventSource();
    readonly sessionFile = undefined;
    subscribeAdapterEvents(listener: AdapterEventListener): () => void {
      return this.events.subscribe(listener);
    }
    prompt(): { outcome: "steered"; completed: Promise<void> } {
      return {
        outcome: "steered",
        completed: Promise.reject(new Error("Cannot steer while idle")),
      };
    }
    abort(): void {}
    setModel(): void {}
    setThinkingLevel(): void {}
  }

  const rejected = await createPiAdapter(
    "p-steer-reject",
    new RejectingSteerDriver(),
  ).prompt("x", { steer: true, steerOnly: true });
  assert.equal(
    rejected.steered,
    false,
    "a steer pi rejected asynchronously is not a delivery",
  );

  // The same acceptance rule governs an ORDINARY steer, because model-only
  // context (a deferred background fact) rides those too: resolving on the
  // synchronous outcome would let the facade commit a fact pi then dropped.
  await assert.rejects(
    createPiAdapter("p-steer-reject-plain", new RejectingSteerDriver()).prompt(
      "x",
      { steer: true },
    ),
    "an ordinary steer pi rejected must not resolve as sent",
  );
});

/* ------------------------- adapter → runtime projection ------------------ */
test("adapter → runtime projection", async () => {
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const driver = new FakePiDriver(join(tmp, "run2.jsonl"));
  runtime.createSession("p2", createPiAdapter("p2", driver));
  await runtime.prompt("p2", "hello", { clientRequestId: "r1" });
  const snap = runtime.get("p2")!.getSnapshot();
  assert.equal(snap.runState, "idle", "idle after the turn");
  assert.deepEqual(
    snap.entries.map((e) => e.role),
    ["user", "assistant", "toolResult", "toolResult"],
    "normalized projection: the whole turn is one assistant entry + its results",
  );
  assert.deepEqual(
    snap.entries.map((e) => e.forkable === true),
    [true, true, true, true],
    "and every entry of it is anchored, which is what offers the fork actions",
  );

  // The anchors a fork is cut at, end to end: prompt, aggregated turn, turn end.
  const [user, assistant, , lastResult] = snap.entries;
  assert.equal(
    runtime.forkAnchors("p2", user!.id).own,
    "u-native",
    "the prompt anchors on its own native message — pi's 'fork before' cut",
  );
  const turn = runtime.forkAnchors("p2", assistant!.id);
  assert.equal(
    turn.own,
    "a-native-final",
    "the aggregated entry mirrors the message its final answer was written as",
  );
  assert.equal(
    turn.ownTurnEnd,
    "a-native-final",
    "which is also where the turn ends, so an inclusive cut keeps both tool results",
  );
  assert.equal(
    runtime.forkCutEntryId("p2", assistant!.id),
    lastResult!.id,
    "and OUR copy runs through the last result of that same turn",
  );
  await runtime.dispose();
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
