import { applyPatch } from "@assistant/shared";
import type {
  DisplayMessage,
  PeerPromptCard,
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
  });
}

function parseSessionPeerPromptPayload(
  output: string,
): { renderKind?: unknown; card?: unknown; [k: string]: unknown } | null {
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
        if (
          !payload ||
          payload.renderKind !== "sessionPeerPrompt" ||
          !payload.card ||
          typeof payload.card !== "object"
        )
          return block;
        const card = payload.card as PeerPromptCard;
        const merged = applyPeerPromptCardOverride(card, overrides);
        if (merged === card) return block;
        changed = true;
        return {
          ...block,
          output: JSON.stringify({ ...payload, card: merged }, null, 2),
        };
      }
      return block;
    });
    if (!changed) return message;
    changedAny = true;
    return { ...message, blocks };
  });
  return changedAny ? next : messages;
}
