/**
 * Where store-backed cards (approvals, pull requests) sit in a transcript. A
 * card is its own row, not a log entry, so every projection that shows one —
 * the client reducer and the server snapshot — interleaves it here, and both
 * place it the same way.
 *
 * A card names the tool call that created it (`sourceToolCallId`) and renders
 * right after that call. One assistant entry holds a whole turn — every tool
 * call and the closing text — so "after the call" is usually INSIDE an entry:
 * the entry is split there, the card goes between the halves, and the rest of
 * the turn continues below it as a `fragment` row. Splitting on the live
 * message too keeps the card at its call while the turn streams, instead of
 * trailing the stream until the turn ends.
 *
 * A card without an anchor, or whose call is not in the list, falls back to its
 * creation time.
 */
import type { DisplayMessage } from "./protocol.ts";

interface PlacedCard {
  sourceToolCallId?: string;
  createdAt: number;
}

/** The card a card row carries, or undefined for any other row. */
function cardOf(message: DisplayMessage): PlacedCard | undefined {
  for (const block of message.blocks) {
    if (block.kind === "approval") return block.approval;
    if (block.kind === "pullRequest") return block.pullRequest;
  }
  return undefined;
}

function cardCreatedAt(message: DisplayMessage): number {
  return (
    cardOf(message)?.createdAt ??
    (message.createdAt ? Date.parse(message.createdAt) : 0)
  );
}

/** The timeline entry a row shows, which a split continuation is not. */
export function displayEntryId(message: DisplayMessage): string {
  return message.fragment?.entryId ?? message.id;
}

/** Where a row's first block sits in its entry's block list. */
export function displayBlockOffset(message: DisplayMessage): number {
  return message.fragment?.blockOffset ?? 0;
}

/**
 * Splits are cached on the message's identity: the projection hands back the
 * same object for an unchanged entry, and the halves must keep theirs too or
 * every memoized row below a card re-renders on each streamed frame.
 */
const splitCache = new WeakMap<
  DisplayMessage,
  Map<number, readonly [DisplayMessage, DisplayMessage]>
>();

/**
 * Split `message` after its tool block at `index`. The head keeps the row's
 * identity (its id answers jumps and fork anchors); the turn's END travels with
 * the continuation — usage, timing, stop reason, error, the streaming flag and
 * the fork-at action, all of which render at or describe the bottom of a turn.
 */
function splitAfter(
  message: DisplayMessage,
  index: number,
): readonly [DisplayMessage, DisplayMessage] {
  const cached = splitCache.get(message)?.get(index);
  if (cached) return cached;
  const {
    forkAtEntryId,
    streaming,
    error,
    errorInfo,
    stopReason,
    usage,
    model,
    startedAt,
    completedAt,
    ...rest
  } = message;
  const tool = message.blocks[index];
  const entryId = displayEntryId(message);
  const head: DisplayMessage = {
    ...rest,
    blocks: message.blocks.slice(0, index + 1),
  };
  const tail: DisplayMessage = {
    id: `${entryId}~${tool?.kind === "tool" ? tool.toolId : index}`,
    role: message.role,
    blocks: message.blocks.slice(index + 1),
    fragment: {
      entryId,
      blockOffset: displayBlockOffset(message) + index + 1,
    },
    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    ...(message.inheritedFrom ? { inheritedFrom: message.inheritedFrom } : {}),
    ...(forkAtEntryId ? { forkAtEntryId } : {}),
    ...(streaming ? { streaming } : {}),
    ...(error ? { error } : {}),
    ...(errorInfo ? { errorInfo } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(usage ? { usage } : {}),
    ...(model ? { model } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
  const split = [head, tail] as const;
  const byIndex = splitCache.get(message) ?? new Map();
  byIndex.set(index, split);
  splitCache.set(message, byIndex);
  return split;
}

/**
 * Where a card anchored at `toolCallId` goes, splitting the row holding that
 * call in place when the call is not its last block. Cards already placed at
 * the same call stay ahead of this one. Undefined when no row holds the call.
 */
function anchoredIndex(
  result: DisplayMessage[],
  toolCallId: string,
): number | undefined {
  for (let i = 0; i < result.length; i += 1) {
    const message = result[i]!;
    const blockIndex = message.blocks.findIndex(
      (block) => block.kind === "tool" && block.toolId === toolCallId,
    );
    if (blockIndex < 0) continue;
    if (blockIndex < message.blocks.length - 1)
      result.splice(i, 1, ...splitAfter(message, blockIndex));
    let at = i + 1;
    while (
      at < result.length &&
      cardOf(result[at]!)?.sourceToolCallId === toolCallId
    )
      at += 1;
    return at;
  }
  return undefined;
}

/**
 * Where an unanchored card goes by creation time: before the first row written
 * after it, else after the last dated row — trailing undated live rows stay
 * below it, and an undated card earlier in history cannot pull it ahead of its
 * timestamp. Undefined for a card older than a windowed list's first row: it
 * belongs to history not loaded yet.
 */
function datedIndex(
  result: readonly DisplayMessage[],
  createdAt: number,
  loadedFrom: number | null,
): number | undefined {
  if (loadedFrom !== null && createdAt < loadedFrom) return undefined;
  const after = result.findIndex((candidate) => {
    const candidateAt = candidate.createdAt
      ? Date.parse(candidate.createdAt)
      : Number.NaN;
    return Number.isFinite(candidateAt) && candidateAt > createdAt;
  });
  if (after >= 0) return after;
  let lastDated = -1;
  for (let index = 0; index < result.length; index += 1)
    if (result[index]!.createdAt) lastDated = index;
  return lastDated >= 0 ? lastDated + 1 : result.length;
}

/**
 * Interleave card rows into a projected message list, oldest card first.
 * `loadedFrom` is a windowed list's first persisted time (null when the list
 * starts at the session start).
 */
export function placeCardRows(
  messages: readonly DisplayMessage[],
  cards: readonly DisplayMessage[],
  loadedFrom: number | null = null,
): DisplayMessage[] {
  const result = [...messages];
  const ordered = [...cards].sort(
    (a, b) => cardCreatedAt(a) - cardCreatedAt(b),
  );
  for (const card of ordered) {
    const toolCallId = cardOf(card)?.sourceToolCallId;
    const at =
      (toolCallId ? anchoredIndex(result, toolCallId) : undefined) ??
      datedIndex(result, cardCreatedAt(card), loadedFrom);
    if (at !== undefined) result.splice(at, 0, card);
  }
  return result;
}
