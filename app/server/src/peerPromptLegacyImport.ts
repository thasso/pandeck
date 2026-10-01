/**
 * One-time import of the legacy `agent-relays.json` file into the transactional
 * peer-prompt store (Task 87). Idempotent: completion is recorded durably so a
 * restart never re-imports. Corrupt/truncated JSON is quarantined with an
 * actionable warning and never resets the SQLite store.
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import {
  peerPromptStore,
  type PeerPromptStatus,
  type ImportedRecord,
} from "./db/peerPromptStore.ts";

const LEGACY_PATH = join(DATA_DIR, "agent-relays.json");
const MIGRATION_KEY = "legacy-agent-relays-import";

interface LegacyRelay {
  id?: unknown;
  taskId?: unknown;
  correlationId?: unknown;
  createdAt?: unknown;
  deliveredAt?: unknown;
  status?: unknown;
  exchangeIndex?: unknown;
  responseRequested?: unknown;
  sender?: { sessionId?: unknown; title?: unknown };
  recipient?: { sessionId?: unknown; title?: unknown };
  message?: unknown;
}

function mapStatus(legacy: unknown): {
  status: PeerPromptStatus;
  admitted: boolean;
} {
  switch (legacy) {
    case "delivered":
      return { status: "admitted", admitted: true };
    case "pending":
      return { status: "queued", admitted: false };
    default:
      return { status: "failed", admitted: false }; // paused/rejected/unknown
  }
}

function toImported(relay: LegacyRelay): ImportedRecord | null {
  const id = typeof relay.id === "string" ? relay.id : null;
  const senderSessionId =
    typeof relay.sender?.sessionId === "string" ? relay.sender.sessionId : null;
  const recipientSessionId =
    typeof relay.recipient?.sessionId === "string"
      ? relay.recipient.sessionId
      : null;
  const prompt = typeof relay.message === "string" ? relay.message : null;
  if (!id || !senderSessionId || !recipientSessionId || !prompt) return null;
  const conversationId =
    typeof relay.correlationId === "string" && relay.correlationId
      ? relay.correlationId
      : `legacy_${id}`;
  const createdAt =
    typeof relay.createdAt === "number" ? relay.createdAt : Date.now();
  const hop = typeof relay.exchangeIndex === "number" ? relay.exchangeIndex : 1;
  const { status, admitted } = mapStatus(relay.status);
  return {
    id,
    conversationId,
    chainId: `legacy_${conversationId}`,
    hop,
    senderSessionId,
    recipientSessionId,
    ...(typeof relay.taskId === "string" ? { taskId: relay.taskId } : {}),
    prompt,
    responseRequested: relay.responseRequested !== false,
    status,
    ...(typeof relay.sender?.title === "string"
      ? { senderLabel: relay.sender.title }
      : {}),
    createdAt,
    ...(admitted && typeof relay.deliveredAt === "number"
      ? { acceptedAt: relay.deliveredAt }
      : {}),
  };
}

/**
 * Run the legacy import if it has not run before. Safe to call at every boot.
 * Returns a summary for logging/tests.
 */
export function importLegacyAgentRelays(): {
  skipped: boolean;
  imported: number;
  quarantined?: string;
} {
  if (peerPromptStore.migrationDone(MIGRATION_KEY))
    return { skipped: true, imported: 0 };
  if (!existsSync(LEGACY_PATH)) {
    peerPromptStore.markMigrationDone(MIGRATION_KEY);
    return { skipped: false, imported: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(LEGACY_PATH, "utf8"));
  } catch {
    return {
      skipped: false,
      imported: 0,
      quarantined: quarantine("could not be parsed as JSON"),
    };
  }
  const messages = (parsed as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) {
    return {
      skipped: false,
      imported: 0,
      quarantined: quarantine("did not contain a messages array"),
    };
  }

  let imported = 0;
  const byConversation = new Map<string, ImportedRecord[]>();
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const rec = toImported(raw as LegacyRelay);
    if (!rec) continue;
    const list = byConversation.get(rec.conversationId) ?? [];
    list.push(rec);
    byConversation.set(rec.conversationId, list);
  }

  for (const [, records] of byConversation) {
    records.sort((a, b) => a.hop - b.hop || a.createdAt - b.createdAt);
    let maxHop = 0;
    for (const rec of records) {
      peerPromptStore.createChain(rec.chainId, rec.createdAt);
      peerPromptStore.addParticipant(
        rec.chainId,
        rec.senderSessionId,
        rec.createdAt,
      );
      peerPromptStore.addParticipant(
        rec.chainId,
        rec.recipientSessionId,
        rec.createdAt,
      );
      if (peerPromptStore.insertImported(rec)) imported++;
      maxHop = Math.max(maxHop, rec.hop);
    }
    // Restore the chain counter so post-import sends continue past imported hops.
    if (maxHop > 0)
      peerPromptStore.bumpChainNextHopTo(records[0]!.chainId, maxHop + 1);
  }

  // Retain the legacy file as a timestamped backup; all new writes use SQLite.
  const backup = `${LEGACY_PATH}.imported-${Date.now()}.bak`;
  try {
    renameSync(LEGACY_PATH, backup);
  } catch {
    /* best-effort backup */
  }
  peerPromptStore.markMigrationDone(MIGRATION_KEY);
  return { skipped: false, imported };
}

function quarantine(reason: string): string {
  const target = `${LEGACY_PATH}.corrupt-${Date.now()}.json`;
  try {
    renameSync(LEGACY_PATH, target);
  } catch {
    // If we cannot move it, leave it in place; still record migration to avoid a loop.
  }
  console.warn(
    `[peer-prompts] legacy agent-relays.json ${reason}; quarantined to ${target}. No relays were imported.`,
  );
  peerPromptStore.markMigrationDone(MIGRATION_KEY);
  return target;
}
