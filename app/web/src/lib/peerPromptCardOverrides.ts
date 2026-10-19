import { applyPatch } from "@assistant/shared";
import type {
  DisplayMessage,
  PeerPromptCard,
  PeerPromptInterruption,
  PeerPromptState,
  PeerPromptThreadsProjection,
} from "@assistant/shared";

/** A live, store-backed lifecycle patch for one peer-prompt card, keyed by its opaque `messageKey`. */
interface PeerPromptCardOverride {
  state: PeerPromptState;
  /**
   * Explicitly `undefined` CLEARS the reason, so the type has to admit it: an
   * override carries the LATEST lifecycle state, and a card that failed and
   * then succeeded must lose its stale failure reason rather than keep it
   * because the newer override merely omitted the key.
   */
  failureReason?: string | undefined;
  /** Cleared the same way: an answered request no longer shows its Stop. */
  interruption?: PeerPromptInterruption | undefined;
  /** Why its recipient settled it; cleared the same way. */
  settledReason?: string | undefined;
}

export type PeerPromptCardOverrides = Record<string, PeerPromptCardOverride>;

/**
 * Merge a live override onto a frozen (creation-time) card, so a later durable
 * transition (delivered → acknowledged → completed/awaiting_response → replied,
 * or a retry/interrupt/expiry) updates the SAME rendered card in place instead
 * of leaving it stuck at its initial snapshot.
 */
/**
 * Seed the override map from the authoritative bounded history projection
 * (`SessionState.peerPrompts`), whose message ids are the SAME opaque key as a
 * card's `messageKey` (both derived server-side from the same underlying peer
 * prompt id). Without this, reopening/navigating to a session after live
 * broadcasts already happened would re-render every card at its frozen
 * creation-time snapshot until a NEW broadcast arrives.
 */
export function seedPeerPromptCardOverridesFromHistory(
  projection: PeerPromptThreadsProjection | undefined,
): PeerPromptCardOverrides {
  if (!projection) return {};
  const overrides: PeerPromptCardOverrides = {};
  for (const thread of projection.threads) {
    for (const message of thread.messages) {
      overrides[message.id] = {
        state: message.state,
        failureReason: message.failureReason,
        interruption: message.interruption,
        settledReason: message.settledReason,
      };
    }
  }
  return overrides;
}

export function applyPeerPromptCardOverride(
  card: PeerPromptCard,
  overrides: PeerPromptCardOverrides,
): PeerPromptCard {
  const override = overrides[card.messageKey];
  if (!override) return card;
  // `applyPatch`, not a spread: an override with no reason CLEARS the card's
  // stale one, and a plain spread would leave the key present-and-undefined.
  return applyPatch(card, {
    state: override.state,
    failureReason: override.failureReason,
    interruption: override.interruption,
    settledReason: override.settledReason,
  });
}

function parseSessionPeerPromptPayload(
  output: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** One card of a tool payload, merged; anything that is not a card stays as it is. */
function mergeCard(card: unknown, overrides: PeerPromptCardOverrides): unknown {
  if (!card || typeof card !== "object") return card;
  return applyPeerPromptCardOverride(card as PeerPromptCard, overrides);
}

/**
 * The `session_send_prompt` payload with every card merged: each message row
 * of a `version: 2` payload, or the one card of a `version: 1` payload. The
 * same object when nothing changed.
 */
function patchToolPayload(
  payload: Record<string, unknown>,
  overrides: PeerPromptCardOverrides,
): Record<string, unknown> {
  if (Array.isArray(payload.rows)) {
    let changed = false;
    const rows = payload.rows.map((row: unknown) => {
      if (!row || typeof row !== "object" || !("card" in row)) return row;
      const card = (row as { card: unknown }).card;
      const merged = mergeCard(card, overrides);
      if (merged === card) return row;
      changed = true;
      return { ...row, card: merged };
    });
    return changed ? { ...payload, rows } : payload;
  }
  const merged = mergeCard(payload.card, overrides);
  return merged === payload.card ? payload : { ...payload, card: merged };
}

/**
 * Apply live overrides across a whole `DisplayMessage[]` list: the recipient's
 * `peerPrompt` transcript block, and the sender's `sessionPeerPrompt` tool-card
 * JSON output, are both patched in place so a durable lifecycle transition
 * updates the SAME rendered card without a new/duplicate row. Pure and
 * no-op when there are no overrides or matching blocks (safe to call on any
 * message list; degrades gracefully on malformed tool output).
 */
export function applyPeerPromptCardOverridesToMessages(
  messages: DisplayMessage[],
  overrides: PeerPromptCardOverrides,
): DisplayMessage[] {
  if (Object.keys(overrides).length === 0) return messages;
  let changedAny = false;
  const next = messages.map((message) => {
    let changed = false;
    const blocks = message.blocks.map((block) => {
      if (block.kind === "peerPrompt") {
        const merged = applyPeerPromptCardOverride(block.peerPrompt, overrides);
        if (merged === block.peerPrompt) return block;
        changed = true;
        return { ...block, peerPrompt: merged };
      }
      if (block.kind === "tool" && block.done && !block.isError) {
        const payload = parseSessionPeerPromptPayload(block.output);
        if (!payload || payload.renderKind !== "sessionPeerPrompt")
          return block;
        const patched = patchToolPayload(payload, overrides);
        if (patched === payload) return block;
        changed = true;
        return { ...block, output: JSON.stringify(patched, null, 2) };
      }
      return block;
    });
    if (!changed) return message;
    changedAny = true;
    return { ...message, blocks };
  });
  return changedAny ? next : messages;
}
