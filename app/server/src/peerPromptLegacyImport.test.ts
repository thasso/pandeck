import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { getDb } from "./db/index.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { importLegacyAgentRelays } from "./peerPromptLegacyImport.ts";

const LEGACY_PATH = join(DATA_DIR, "agent-relays.json");

function resetMigration(): void {
  getDb()
    .prepare("DELETE FROM peer_prompt_migrations WHERE key = ?")
    .run("legacy-agent-relays-import");
}

function cleanupBackups(): void {
  for (const name of readdirSync(DATA_DIR)) {
    if (name.startsWith("agent-relays.json."))
      rmSync(join(DATA_DIR, name), { force: true });
  }
  rmSync(LEGACY_PATH, { force: true });
}

beforeEach(() => {
  getDb(); // ensure DATA_DIR + schema exist before writing the legacy file
  mkdirSync(DATA_DIR, { recursive: true });
});

afterEach(() => {
  resetMigration();
  cleanupBackups();
});

describe("importLegacyAgentRelays", () => {
  it("imports valid legacy relays once and is idempotent", () => {
    const store = {
      version: 1,
      messages: [
        {
          id: "relay_1",
          correlationId: "thr-1",
          createdAt: 1000,
          status: "delivered",
          deliveredAt: 1500,
          exchangeIndex: 1,
          responseRequested: true,
          sender: { sessionId: "A", title: "Alice" },
          recipient: { sessionId: "B" },
          message: "please review",
          taskId: "42",
        },
        {
          id: "relay_2",
          correlationId: "thr-1",
          createdAt: 2000,
          status: "pending",
          exchangeIndex: 2,
          responseRequested: false,
          sender: { sessionId: "B" },
          recipient: { sessionId: "A" },
          message: "done",
        },
      ],
    };
    writeFileSync(LEGACY_PATH, JSON.stringify(store), "utf8");

    const first = importLegacyAgentRelays();
    assert.equal(first.imported, 2);
    const one = peerPromptStore.getById("relay_1");
    assert.equal(one?.status, "admitted");
    assert.equal(one?.taskId, "42");
    assert.equal(one?.senderLabel, "Alice");
    assert.equal(peerPromptStore.getById("relay_2")?.status, "queued");
    // The chain has both participants.
    assert.deepEqual(peerPromptStore.participantsOf("legacy_thr-1").sort(), [
      "A",
      "B",
    ]);
    // Legacy file retained as a backup, not left in place.
    assert.equal(existsSync(LEGACY_PATH), false);

    // Idempotent: a second run (even if the file reappears) imports nothing new.
    writeFileSync(LEGACY_PATH, JSON.stringify(store), "utf8");
    const second = importLegacyAgentRelays();
    assert.equal(second.skipped, true);
    assert.equal(second.imported, 0);
  });

  it("quarantines corrupt JSON without resetting the store", () => {
    // A pre-existing valid row must survive the corrupt import.
    const chainId = peerPromptStore.createChain("survivor-chain");
    const survivor = peerPromptStore.enqueue({
      conversationId: "survivor",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: "X",
      recipientSessionId: "Y",
      prompt: "keep me",
      responseRequested: false,
    });

    writeFileSync(LEGACY_PATH, "{ not valid json ", "utf8");
    const result = importLegacyAgentRelays();
    assert.equal(result.imported, 0);
    assert.ok(result.quarantined);
    assert.equal(existsSync(result.quarantined!), true);
    assert.equal(existsSync(LEGACY_PATH), false);
    // The store was not reset.
    assert.equal(peerPromptStore.getById(survivor.id)?.prompt, "keep me");
  });
});
