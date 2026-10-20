import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  directPeerChildStore,
  type DirectPeerChild,
} from "./directPeerChildStore.ts";
import { closeDb, getDb } from "./index.ts";
import { sessionStore } from "./sessionStore.ts";

let seq = 0;

function child(
  spawnerSessionId: string,
  patch: Partial<DirectPeerChild> = {},
): DirectPeerChild {
  return {
    childSessionId: `dpc-child-${seq++}`,
    spawnerSessionId,
    costClass: "counted",
    source: { kind: "profile", profileId: "pr_terra" },
    provider: "openai-codex",
    modelId: "gpt-5.6-terra",
    thinkingLevel: "medium",
    credentialProfileId: "codex-acct",
    createdAt: Date.now() + seq,
    ...patch,
  };
}

describe("directPeerChildStore", () => {
  it("keeps every child, its cost and its runtime source across a restart", () => {
    const spawner = `dpc-spawner-${seq++}`;
    const profile = child(spawner);
    const agent = child(spawner, {
      costClass: "low",
      source: { kind: "agent", agentName: "test-reviewer" },
    });
    directPeerChildStore.record(profile);
    directPeerChildStore.record(agent);
    // A repeat changes nothing.
    directPeerChildStore.record({ ...profile, costClass: "low" });
    closeDb();
    getDb();
    assert.deepEqual(directPeerChildStore.childrenOf(spawner), [
      profile,
      agent,
    ]);
    assert.deepEqual(directPeerChildStore.get(agent.childSessionId), agent);
    assert.equal(
      directPeerChildStore.spawnerOf(profile.childSessionId),
      spawner,
    );
    assert.equal(directPeerChildStore.spawnerOf("nobody"), undefined);
  });

  it("counts no deleted child", () => {
    const spawner = `dpc-spawner-${seq++}`;
    const gone = child(spawner);
    sessionStore.upsert({
      id: gone.childSessionId,
      harness: "pi",
      agentType: "developer",
    });
    directPeerChildStore.record(gone);
    assert.equal(directPeerChildStore.childrenOf(spawner).length, 1);
    sessionStore.markDeleted(gone.childSessionId);
    assert.deepEqual(directPeerChildStore.childrenOf(spawner), []);
  });
});
