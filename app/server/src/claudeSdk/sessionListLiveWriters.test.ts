import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type { ClaudeSdkMessage, ClaudeSdkSeam } from "./sdkSeam.ts";

const naming = vi.hoisted(() => ({
  pending: [] as Array<(title: string | null) => void>,
}));
vi.mock("../sessionNaming.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessionNaming.ts")>()),
  generateSessionTitle: () =>
    new Promise<string | null>((resolve) => naming.pending.push(resolve)),
}));
const tmp = mkdtempSync(join(tmpdir(), "claude-row-writers-"));
process.env.DATA_DIR = join(tmp, "data");
process.env.ASSISTANT_CWD = tmp;
const { assertSessionRowsReported: oracle } =
  await import("../test/sessionListPublicOracle.ts");
const { claudeSdkStore } = await import("./claudeSdkStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { claudeProfileSessionStore } = await import("./profileSessionStore.ts");
const profiles = await import("../credentialProfiles.ts");
const { createSession } = await import("../harnesses/create.ts");
const { sessionRuntime } = await import("../session/runtimeInstance.ts");
const { ensureRuntimeSessionWithRuntime } =
  await import("../session/runtimePrompt.ts");
const { installSessionActivityTracking } =
  await import("../sessionActivity.ts");
const { updateSettings, getSettings } = await import("../settings.ts");
const { HARNESS_IDLE_EVICT_MS } = await import("../harness.ts");
const sdk = await import("@anthropic-ai/claude-agent-sdk");
const stopTracking = installSessionActivityTracking();
const accountIds: string[] = [];
const nativeFiles: string[] = [];
let failure = false;

function account() {
  const id = profiles.createCredentialProfile({
    name: `Claude ${randomUUID()}`,
    provider: "claude",
  }).id;
  accountIds.push(id);
  return id;
}
function result(id: string): ClaudeSdkMessage {
  return {
    type: "result",
    subtype: failure ? "error_during_execution" : "success",
    session_id: id,
    uuid: randomUUID(),
    is_error: failure,
    result: "done",
    errors: failure ? ["row oracle provider failure"] : [],
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0.5,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.5,
        contextWindow: 200000,
      },
    },
    permission_denials: [],
    stop_reason: "end_turn",
  } as unknown as ClaudeSdkMessage;
}
function installSeam() {
  const seam: ClaudeSdkSeam = {
    query(params) {
      return {
        async *[Symbol.asyncIterator]() {
          const input =
            typeof params.prompt === "string"
              ? params.prompt
              : (await params.prompt[Symbol.asyncIterator]().next()).value
                  ?.message.content;
          const id = params.options?.resume ?? randomUUID();
          if (typeof input === "string" && input.startsWith("/compact")) {
            yield {
              type: "system",
              subtype: "compact_boundary",
              session_id: id,
              uuid: randomUUID(),
              compact_metadata: {
                trigger: "manual",
                pre_tokens: 1000,
                post_tokens: 100,
              },
            } as unknown as ClaudeSdkMessage;
            yield result(id);
            return;
          }
          const uuid = randomUUID();
          // This is the provider seam: write the native transcript the real CLI
          // would own, so fork/account transfer use the SDK's actual local store.
          const root = params.options?.env?.CLAUDE_CONFIG_DIR;
          assert.ok(
            root,
            "the fake provider must receive its isolated profile root",
          );
          const path = join(
            root,
            "projects",
            tmp.replace(/\//g, "-"),
            `${id}.jsonl`,
          );
          mkdirSync(dirname(path), { recursive: true });
          const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
          const userUuid = randomUUID();
          const lines = [
            {
              type: "user",
              uuid: userUuid,
              parentUuid: null,
              sessionId: id,
              cwd: tmp,
              timestamp: new Date().toISOString(),
              message: { role: "user", content: input },
            },
            {
              type: "assistant",
              uuid,
              parentUuid: userUuid,
              sessionId: id,
              cwd: tmp,
              timestamp: new Date().toISOString(),
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Claude oracle answer" }],
              },
            },
          ];
          writeFileSync(
            path,
            previous +
              lines.map((row) => JSON.stringify(row)).join("\n") +
              "\n",
          );
          nativeFiles.push(path);
          for (const event of [
            { type: "message_start", message: { id: uuid } },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Claude oracle answer" },
            },
            { type: "content_block_stop", index: 0 },
          ])
            yield {
              type: "stream_event",
              session_id: id,
              uuid: randomUUID(),
              event,
            } as unknown as ClaudeSdkMessage;
          yield {
            type: "assistant",
            session_id: id,
            uuid,
            message: {
              id: uuid,
              role: "assistant",
              model: params.options?.model ?? "claude-sonnet-5",
              content: [{ type: "text", text: "Claude oracle answer" }],
              stop_reason: "end_turn",
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          } as unknown as ClaudeSdkMessage;
          yield result(id);
        },
        close() {},
        async interrupt() {},
      };
    },
    forkSession: (id, options) =>
      sdk.forkSession(id, options as Parameters<typeof sdk.forkSession>[1]),
    deleteSession: (id, options) =>
      sdk.deleteSession(id, options as Parameters<typeof sdk.deleteSession>[1]),
  };
  claudeSdkStore.setSeam(async () => seam);
  return seam;
}
async function freshClaude(profile = account()) {
  return (await createSession({
    harness: "claude-sdk",
    agentType: "assistant",
    modelId: "sonnet",
    credentialProfileId: profile,
    cwd: tmp,
  })) as import("./ClaudeSdkSession.ts").ClaudeSdkSession;
}
async function flushNames() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
afterEach(async () => {
  for (const session of claudeSdkStore.list())
    claudeSdkStore.remove(session.id);
  await sessionRuntime.dispose();
  for (const id of accountIds.splice(0))
    profiles.setCredentialProfileEnabled(id, false);
  vi.useRealTimers();
  vi.restoreAllMocks();
  failure = false;
  naming.pending.splice(0).forEach((resolve) => resolve(null));
  updateSettings({
    sessionNaming: { ...getSettings().sessionNaming, enabled: false },
  });
});
afterAll(() => {
  stopTracking();
  rmSync(tmp, { recursive: true, force: true });
});
updateSettings({
  sessionNaming: { ...getSettings().sessionNaming, enabled: false },
});

test("Claude acquisition, configure, prompt, native fork and failed fork compensation report real transitions", async () => {
  const seam = installSeam();
  const parent = await oracle("ClaudeStore.acquire", () => freshClaude(), {
    equal: "acquisition has no messages and is intentionally absent",
  });
  assert.equal(claudeSdkStore.get(parent.id), parent);
  await oracle(
    "Claude.configure",
    () => parent.configure("claude-opus-4-6", "high"),
    {
      equal:
        "configuration is local on an empty, intentionally unlisted conversation",
    },
  );
  assert.equal(parent.modelSelection().model?.id, "opus");
  ensureRuntimeSessionWithRuntime(sessionRuntime, parent);
  await oracle(
    "Claude prompt acceptance/stream/result",
    () => sessionRuntime.prompt(parent.id, "first Claude turn"),
    { changed: [parent.id] },
  );
  assert.ok(
    sessionRuntime
      .get(parent.id)!
      .clientTimeline()
      .some((e) => e.type === "message" && e.role === "assistant"),
  );
  const anchor = sessionRuntime
    .get(parent.id)!
    .clientTimeline()
    .findLast((e) => e.type === "message" && e.role === "assistant")!;
  const child = await oracle(
    "ClaudeStore.forkSession",
    () =>
      claudeSdkStore.forkSession(parent.id, {
        anchor: sessionRuntime.forkAnchors(parent.id, anchor.id).own!,
        keepThroughEntryId: anchor.id,
        forkOrigin: { harness: "claude-sdk", parentSessionId: parent.id },
      }),
    { changed: (value) => [value.id] },
  );
  assert.equal(child.listItem(0).forkOrigin?.parentSessionId, parent.id);
  assert.equal(child.listItem(0).messageCount, 2);
  const original = claudeSdkStore.persist.bind(claudeSdkStore);
  const deleted = vi.spyOn(seam, "deleteSession");
  vi.spyOn(claudeSdkStore, "persist").mockImplementation(() => {
    throw new Error("persist failed after native fork");
  });
  const members = claudeSdkStore.list().map((s) => s.id);
  await oracle(
    "ClaudeStore.forkSession compensation",
    async () => {
      await assert.rejects(
        () =>
          claudeSdkStore.forkSession(parent.id, {
            anchor: sessionRuntime.forkAnchors(parent.id, anchor.id).own!,
            keepThroughEntryId: anchor.id,
            forkOrigin: { harness: "claude-sdk", parentSessionId: parent.id },
          }),
        /persist failed/,
      );
    },
    {
      equal:
        "failed registration removes the half-live child and its real native transcript",
    },
  );
  assert.equal(deleted.mock.calls.length, 1);
  assert.deepEqual(
    claudeSdkStore.list().map((s) => s.id),
    members,
  );
  assert.equal(
    existsSync(
      join(
        claudeProfileSessionStore(parent.credentialProfileId).root,
        "projects",
        tmp.replace(/\//g, "-"),
        `${deleted.mock.calls[0]![0]}.jsonl`,
      ),
    ),
    false,
  );
  claudeSdkStore.persist = original;
});

test("Claude account transfer, model/reasoning selection and failed prompt use public row reports", async () => {
  installSeam();
  const from = account();
  const to = account();
  const live = await freshClaude(from);
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  await oracle(
    "Claude.setModel unlocked",
    () => live.setModel("claude-opus-4-6"),
    {
      equal: "selection changes on a deliberately unlisted empty conversation",
    },
  );
  assert.equal(live.modelSelection().model?.id, "opus");
  await oracle(
    "Claude.setThinkingLevel unlocked",
    () => live.setThinkingLevel("high"),
    {
      equal: "reasoning selection changes before the first conversation entry",
    },
  );
  assert.equal(live.toRecord().thinkingLevel, "high");
  await sessionRuntime.prompt(live.id, "history to transfer");
  const sourceFile = nativeFiles.at(-1)!;
  await oracle("Claude.switchAccount", () => live.switchAccount(to, () => {}), {
    changed: [live.id],
  });
  assert.equal(live.credentialProfileId, to);
  assert.equal(sessionStore.get(live.id)?.credentialProfileId, to);
  assert.equal(existsSync(sourceFile), false);
  failure = true;
  await oracle(
    "Claude failed prompt terminal",
    async () => {
      await assert.rejects(async () => {
        await sessionRuntime.prompt(live.id, "fail the resumed provider turn");
      }, /row oracle provider failure/);
    },
    { changed: [live.id] },
  );
  assert.equal(live.isRunning, false);
  assert.equal(sessionRuntime.isRunning(live.id), false);
});

test("Claude synthetic progress, plain/card finishes and idle eviction preserve public reporting", async () => {
  installSeam();
  const live = await freshClaude();
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  await sessionRuntime.prompt(live.id, "synthetic base");
  const tool = await oracle(
    "Claude.beginSyntheticTool",
    () => live.beginSyntheticTool("oracle-tool", {}),
    { changed: [live.id] },
  );
  await oracle(
    "Claude.updateSyntheticTool",
    () => live.updateSyntheticTool("real progress"),
    { equal: "tool progress changes the live turn body, not the list row" },
  );
  assert.match(JSON.stringify(live.snapshot()), /real progress/);
  await oracle(
    "Claude.finishSyntheticTool",
    () => live.finishSyntheticTool(tool.toolId, "completed"),
    { changed: [live.id] },
  );
  assert.equal(live.isRunning, false);
  assert.match(JSON.stringify(live.timelineEntries()), /completed/);
  live.beginSyntheticTool("clear-context", {});
  await oracle(
    "Claude.finishSyntheticCard",
    () =>
      live.finishSyntheticCard({
        kind: "contextClear",
        contextClear: { tokensBefore: 100 },
      }),
    { changed: [live.id] },
  );
  assert.ok(live.timelineEntries().some((e) => e.type === "command.result"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  live.armIdleIfUnviewed();
  await oracle(
    "ClaudeStore.evictIdle",
    () => vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS),
    { changed: [live.id] },
  );
  assert.equal(claudeSdkStore.get(live.id), undefined);
  assert.ok(sessionStore.get(live.id));
});

test("Claude automatic/fork title completion reports each real pending/title boundary", async () => {
  installSeam();
  updateSettings({
    sessionNaming: { ...getSettings().sessionNaming, enabled: true },
  });
  const live = await freshClaude();
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  await oracle(
    "Claude.beginAutoName",
    () => sessionRuntime.prompt(live.id, "name this conversation"),
    { changed: [live.id] },
  );
  assert.equal(naming.pending.length, 1);
  assert.equal(live.listItem(0).titleGenerationPending, true);
  await oracle(
    "Claude.autoName completion",
    async () => {
      naming.pending.shift()!("Automatic Claude title");
      await flushNames();
    },
    { changed: [live.id] },
  );
  assert.equal(live.listItem(0).title, "Automatic Claude title");
  const anchor = sessionRuntime
    .get(live.id)!
    .clientTimeline()
    .findLast((e) => e.type === "message" && e.role === "assistant")!;
  const child = await claudeSdkStore.forkSession(live.id, {
    anchor: sessionRuntime.forkAnchors(live.id, anchor.id).own!,
    keepThroughEntryId: anchor.id,
    forkOrigin: { harness: "claude-sdk", parentSessionId: live.id },
  });
  ensureRuntimeSessionWithRuntime(sessionRuntime, child);
  await oracle(
    "Claude fork naming start",
    () => sessionRuntime.prompt(child.id, "new branch purpose"),
    { changed: [child.id] },
  );
  await oracle(
    "Claude fork naming completion",
    async () => {
      naming.pending.shift()!("Claude child title");
      await flushNames();
    },
    { changed: [child.id] },
  );
  assert.equal(child.listItem(0).title, "Claude child title");
  assert.equal(child.listItem(0).forkAutoRenamePending, undefined);
});

test("Claude compaction usage and context clearing report actual native/canonical semantics", async () => {
  installSeam();
  const live = await freshClaude();
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  await sessionRuntime.prompt(live.id, "context base");
  const cost = live.toRecord().usage!.cost;
  const compacted = await oracle(
    "Claude.compactContext result usage",
    () => live.compactContext(),
    {
      equal:
        "native summary context and billed usage are not session-list fields",
    },
  );
  assert.equal(compacted.kind, "compacted");
  assert.ok(live.toRecord().usage!.cost > cost);
  const messages = live.listItem(0).messageCount;
  const cleared = await oracle(
    "Claude.clearContext",
    () => live.clearContext(),
    {
      equal:
        "forgetting the resume id preserves the owned transcript and cumulative billed usage",
    },
  );
  assert.equal(cleared.kind, "cleared");
  assert.equal(live.toRecord().providerSessionId, undefined);
  assert.equal(live.listItem(0).messageCount, messages);
  const applied = await oracle(
    "Claude.applyCompactionWindow",
    () => live.applyCompactionWindow(150000),
    {
      equal:
        "Claude only answers when a configured cap would apply; it changes no list field",
    },
  );
  assert.equal(applied.pendingReason, "next-turn");
});
