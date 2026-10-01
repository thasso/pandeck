/**
 * Takeover of agent-spawned peer sessions ([Task-637](pa://task/637)):
 *   pnpm --filter @assistant/server test src/spawnOwnership.test.ts
 *
 * Driven at the ONE runtime seam both harnesses prompt through (pi and the
 * Claude SDK share `LiveRuntimeSession.appendUserEntry`), with a scripted
 * adapter so no provider is involved. Proves that exactly an accepted, visible,
 * human-origin prompt moves ownership — and that the peer-chain reset the same
 * hook has always done still runs for every human prompt.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

process.env.ASSISTANT_CWD = mkdtempSync(join(tmpdir(), "spawn-ownership-"));

const { SessionRuntime } = await import("./session/runtime/runtime.ts");
const { setHumanPromptHook } = await import("./session/runtime/liveSession.ts");
const { SessionBusyError } = await import("./session/runtime/errors.ts");
const { SessionLogStore } = await import("./session/log/store.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { humanPromptHandler } = await import("./spawnOwnership.ts");

type AdapterEvent = import("./session/adapters/contract.ts").AdapterEvent;
type AgentRunResult = import("./session/adapters/contract.ts").AgentRunResult;
type PromptableAdapter =
  import("./session/adapters/contract.ts").PromptableAdapter;

/** A scripted adapter whose runs finish only when the test says so. */
class ScriptedAdapter implements PromptableAdapter {
  readonly provider = "scripted";
  readonly capabilities: import("./session/adapters/contract.ts").ForkCapability =
    { fork: "none", compact: false, steer: false, attachments: false };
  private listeners = new Set<(e: AdapterEvent) => void>();
  private resolveRun: ((r: AgentRunResult) => void) | undefined;

  subscribe(listener: (e: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getBinding() {
    return { provider: this.provider, nativeId: "native-1" };
  }
  prompt(): Promise<AgentRunResult> {
    return new Promise<AgentRunResult>((resolve) => {
      this.resolveRun = resolve;
    });
  }
  finishRun(): void {
    this.resolveRun?.({ stopReason: "end" });
    this.resolveRun = undefined;
  }
  abort(): void {}
  setModel(): void {}
  setReasoning(): void {}
  async listModels() {
    return [{ provider: this.provider, id: "m1" }];
  }
  dispose(): void {
    this.listeners.clear();
  }
}

const suffix = `${Date.now()}-${Math.random()}`;
const created: string[] = [];
const runtime = new SessionRuntime(new SessionLogStore(true));
const adapters = new Map<string, ScriptedAdapter>();

/** A live spawned child of `coordinator`, or (with `spawned: false`) a plain session. */
function child(name: string, opts: { spawned?: boolean } = {}): string {
  const id = `own-${name}-${suffix}`;
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant", title: id });
  created.push(id);
  if (opts.spawned !== false) sessionStore.linkSpawned(coordinator, id);
  const adapter = new ScriptedAdapter();
  adapters.set(id, adapter);
  runtime.createSession(id, adapter);
  return id;
}

function ownershipOf(id: string): string | undefined {
  return sessionStore.spawnedParentsByChildIds([id]).get(id)?.ownership;
}

const coordinator = `own-coordinator-${suffix}`;
sessionStore.upsert({
  id: coordinator,
  harness: "pi",
  agentType: "assistant",
  title: coordinator,
});
created.push(coordinator);

const chainResets: string[] = [];
let broadcasts = 0;
setHumanPromptHook(
  humanPromptHandler({
    closeChains: (sessionId) => chainResets.push(sessionId),
    broadcastSessions: () => {
      broadcasts += 1;
    },
  }),
);

afterAll(() => {
  setHumanPromptHook(undefined);
  for (const id of created) sessionStore.remove(id);
});

test("a visible human prompt takes a spawned child over exactly once", async () => {
  const target = child("visible");
  const adapter = adapters.get(target)!;
  const beforeResets = chainResets.length;
  const beforeBroadcasts = broadcasts;
  assert.equal(ownershipOf(target), "coordinator");

  const first = runtime.prompt(target, "take this over");
  adapter.finishRun();
  await first;
  assert.equal(ownershipOf(target), "taken-over");
  assert.equal(broadcasts, beforeBroadcasts + 1, "the transition broadcasts");
  assert.deepEqual(
    chainResets.slice(beforeResets),
    [target],
    "the human prompt still closes this session's peer chains",
  );

  const second = runtime.prompt(target, "and again");
  adapter.finishRun();
  await second;
  assert.equal(ownershipOf(target), "taken-over");
  assert.equal(
    broadcasts,
    beforeBroadcasts + 1,
    "a later prompt re-broadcasts nothing: ownership did not transition",
  );
  assert.deepEqual(
    chainResets.slice(beforeResets),
    [target, target],
    "every human prompt keeps resetting peer chains",
  );
});

test("peer, agent, system and hidden prompts never take a child over", async () => {
  const peerTarget = child("peer");
  const systemTarget = child("system");
  const hiddenTarget = child("hidden");
  const beforeResets = chainResets.length;
  const beforeBroadcasts = broadcasts;

  for (const [target, options] of [
    [peerTarget, { origin: { kind: "agent", agentId: "peer" } as const }],
    [systemTarget, { origin: { kind: "system" } as const }],
    [hiddenTarget, { hidden: true }],
  ] as const) {
    const run = runtime.prompt(target, "not from the user", options);
    adapters.get(target)!.finishRun();
    await run;
    assert.equal(
      ownershipOf(target),
      "coordinator",
      `${target} stays coordinator-owned`,
    );
  }

  assert.equal(broadcasts, beforeBroadcasts, "no ownership change, no churn");
  assert.deepEqual(
    chainResets.slice(beforeResets),
    [hiddenTarget],
    "a hidden HUMAN prompt still resets chains; agent/system prompts do not",
  );
});

test("a send that appends no user entry never takes a child over", async () => {
  const deduped = child("deduped");
  const busy = child("busy");
  const beforeBroadcasts = broadcasts;

  // A hidden prompt claims the request id; the visible retry is deduplicated
  // before any append, so the hook never sees it.
  const hidden = runtime.prompt(deduped, "provenance", {
    hidden: true,
    clientRequestId: "dup-1",
  });
  adapters.get(deduped)!.finishRun();
  await hidden;
  await runtime.prompt(deduped, "the user's retry", {
    clientRequestId: "dup-1",
  });
  assert.equal(ownershipOf(deduped), "coordinator");

  // A prompt refused by the busy gate is rejected ahead of the append.
  const running = runtime.prompt(busy, "peer work", {
    origin: { kind: "agent", agentId: "peer" },
  });
  await assert.rejects(
    () => runtime.prompt(busy, "the user's prompt"),
    SessionBusyError,
  );
  assert.equal(ownershipOf(busy), "coordinator");
  adapters.get(busy)!.finishRun();
  await running;

  assert.equal(broadcasts, beforeBroadcasts, "nothing transitioned");
});

test("a human prompt to a session that was never spawned changes nothing", async () => {
  const plain = child("plain", { spawned: false });
  const beforeBroadcasts = broadcasts;
  const run = runtime.prompt(plain, "ordinary session");
  adapters.get(plain)!.finishRun();
  await run;
  assert.equal(ownershipOf(plain), undefined);
  assert.equal(broadcasts, beforeBroadcasts);
  assert.equal(chainResets.at(-1), plain, "the chain reset is unconditional");
});
