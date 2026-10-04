/**
 * Takeover of agent-spawned peer sessions ([Task-637](pa://task/637)):
 *   pnpm --filter @assistant/server test src/spawnOwnership.test.ts
 *
 * Driven at the ONE runtime seam both harnesses prompt through (pi and the
 * Claude SDK share `LiveRuntimeSession.appendUserEntry`), with a scripted
 * adapter so no provider is involved. Proves that NO prompt moves ownership —
 * a poke leaves the coordinator in charge — that the peer-chain reset the same
 * hook has always done still runs for every human prompt, and that the explicit
 * Take over / Hand back command is what moves it.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

process.env.ASSISTANT_CWD = mkdtempSync(join(tmpdir(), "spawn-ownership-"));

const { SessionRuntime } = await import("./session/runtime/runtime.ts");
const { setHumanPromptHook } = await import("./session/runtime/liveSession.ts");
const { SessionLogStore } = await import("./session/log/store.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { humanPromptHandler, setSpawnOwnership } =
  await import("./spawnOwnership.ts");

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
setHumanPromptHook(
  humanPromptHandler({
    closeChains: (sessionId) => chainResets.push(sessionId),
  }),
);

afterAll(() => {
  setHumanPromptHook(undefined);
  for (const id of created) sessionStore.remove(id);
});

test("no prompt takes a spawned child over, not even a visible human one", async () => {
  const target = child("visible");
  const peerTarget = child("peer");
  const hiddenTarget = child("hidden");
  const beforeResets = chainResets.length;

  for (const [id, text, options] of [
    [target, "a poke from the user", {}],
    [peerTarget, "from a peer", { origin: { kind: "agent", agentId: "p" } }],
    [hiddenTarget, "provenance", { hidden: true }],
  ] as const) {
    const run = runtime.prompt(id, text, options);
    adapters.get(id)!.finishRun();
    await run;
    // A poke leaves the coordinator in charge: taking over is an explicit act.
    assert.equal(
      ownershipOf(id),
      "coordinator",
      `${id} stays coordinator-owned`,
    );
  }
  assert.deepEqual(
    chainResets.slice(beforeResets),
    [target, hiddenTarget],
    "every HUMAN prompt, visible or hidden, still closes its peer chains",
  );
});

test("a human prompt to a session that was never spawned resets its chains", async () => {
  const plain = child("plain", { spawned: false });
  const run = runtime.prompt(plain, "ordinary session");
  adapters.get(plain)!.finishRun();
  await run;
  assert.equal(ownershipOf(plain), undefined);
  assert.equal(chainResets.at(-1), plain, "the chain reset is unconditional");
});

test("the explicit command takes a child over and hands it back", () => {
  const target = child("explicit");
  assert.equal(setSpawnOwnership(target, "taken-over"), "changed");
  assert.equal(ownershipOf(target), "taken-over");
  assert.equal(
    setSpawnOwnership(target, "taken-over"),
    "unchanged",
    "no change, so nothing to broadcast",
  );
  assert.equal(setSpawnOwnership(target, "coordinator"), "changed");
  assert.equal(ownershipOf(target), "coordinator");
  // A session with no spawn edge has no owner to set.
  const plain = child("explicit-plain", { spawned: false });
  assert.equal(setSpawnOwnership(plain, "taken-over"), "not-spawned");
});
