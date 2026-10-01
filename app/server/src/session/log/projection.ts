/**
 * Project raw log entries into the two conversation views:
 *   - CLIENT: strips server-only fields (`providerMessageId`, `metadata`,
 *     `clientRequestId`) — the public {@link SessionEntry}.
 *   - SERVER: retains them for fork/resume anchoring and log-search.
 *
 * Bookkeeping entries (`message.providerBound`, `tool.audit`, `run.*`,
 * `command.*`) are NOT conversation entries and project to `null` here; query
 * them via the store's audit-specific helpers instead.
 */
import type {
  AgentContentBlock,
  SessionEntry,
} from "@assistant/shared/session";
import type {
  ClientTimelineEntry,
  HostCommandClientEntry,
} from "@assistant/shared/runtime";
import {
  isConversationEntry,
  isHostCommandResultEntry,
  type ConversationRawEntry,
  type AssistantRawEntry,
  type HostCommandResultEntry,
  type ProviderNoticeEntry,
  type SessionLogEntry,
  type ToolResultRawEntry,
} from "./rawEntry.ts";
import {
  lazyAssistantContent,
  lazyToolResultContent,
  resultKeepsFullToolInput,
  shouldKeepFullToolInput,
  toolInputExceedsInline,
  type ToolCallInfo,
} from "./timelinePayloadPolicy.ts";

// The client timeline types live in the shared package; re-export for the
// server's existing importers.
export type { ClientTimelineEntry, HostCommandClientEntry };

/** Server projection = the client entry plus retained server-only anchoring fields. */
export type ServerSessionEntry = SessionEntry & {
  providerMessageId?: string;
  /**
   * The native id this entry's TURN ends on (see
   * `MessageProviderBoundEntry.providerTurnEndId`). Present on every aggregated
   * assistant entry a turn reconciliation placed — equal to `providerMessageId`
   * whenever the turn ended on its own final message — and absent otherwise, so
   * its presence is what tells a reconciled binding from one that never resolved
   * a turn end.
   */
  providerTurnEndId?: string;
  metadata?: Record<string, unknown>;
  clientRequestId?: string;
};

/** The native ids one entry is bound to, as {@link effectiveBindings} resolves them. */
interface EntryBinding {
  providerMessageId: string;
  providerTurnEndId?: string;
}

/** Project a raw host-command result entry into its client timeline form. */
export function projectHostCommandForClient(
  entry: HostCommandResultEntry,
): HostCommandClientEntry {
  return {
    id: entry.id,
    seq: entry.seq,
    createdAt: entry.createdAt,
    ...(entry.inheritedFrom ? { inheritedFrom: entry.inheritedFrom } : {}),
    type: "command.result",
    name: entry.name,
    card: entry.card,
  };
}

export function projectProviderNoticeForClient(
  entry: ProviderNoticeEntry,
): SessionEntry {
  const info = entry.providerError;
  const details = [
    `Provider diagnostic: ${info.kind} — ${info.rawMessage}`,
    info.provider || info.model
      ? `Model: ${[info.provider, info.model].filter(Boolean).join("/")}`
      : undefined,
    entry.attempt !== undefined
      ? `Attempt: ${entry.attempt}/${entry.maxAttempts ?? "?"}`
      : undefined,
    entry.delayMs !== undefined ? `Retry delay: ${entry.delayMs}ms` : undefined,
    entry.phase ? `Phase: ${entry.phase}` : undefined,
    entry.requestBytes !== undefined
      ? `Request bytes: ${entry.requestBytes}`
      : undefined,
  ].filter((detail): detail is string => Boolean(detail));
  const message = `${entry.message}\n\n${details.join("\n")}`;
  return {
    id: entry.id,
    seq: entry.seq,
    createdAt: entry.createdAt,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: message }],
    ...(entry.severity === "error" ? { error: entry.message } : {}),
  };
}

/** Build the full server entry from a conversation raw entry (retains everything renderable + anchors). */
function projectForServer(
  entry: ConversationRawEntry,
  binding?: EntryBinding,
): ServerSessionEntry {
  const base = projectForClient(entry, binding);
  const server: ServerSessionEntry = { ...base };
  const anchor = binding?.providerMessageId ?? entry.providerMessageId;
  if (anchor !== undefined) server.providerMessageId = anchor;
  if (binding?.providerTurnEndId !== undefined)
    server.providerTurnEndId = binding.providerTurnEndId;
  if (entry.metadata !== undefined) server.metadata = entry.metadata;
  if (entry.role === "user" && entry.clientRequestId !== undefined)
    server.clientRequestId = entry.clientRequestId;
  return server;
}

/** Build the client entry from a conversation raw entry (server-only fields removed). */
export function projectForClient(
  entry: ConversationRawEntry,
  binding?: EntryBinding,
): SessionEntry {
  const envelope = {
    id: entry.id,
    seq: entry.seq,
    createdAt: entry.createdAt,
    // The native anchor itself stays server-side; the client learns only WHETHER
    // this entry can be branched at, which is what decides if the transcript
    // offers the action (see `SessionEntry.forkable`). Both binding routes count
    // — see `effectiveBindings`.
    ...((binding?.providerMessageId ?? entry.providerMessageId)
      ? { forkable: true as const }
      : {}),
    // Unlike the anchor, fork PROVENANCE is public: the transcript marks where
    // an inherited prefix ends and links back to the session that wrote it.
    ...(entry.inheritedFrom ? { inheritedFrom: entry.inheritedFrom } : {}),
  };
  switch (entry.role) {
    case "user":
      return {
        ...envelope,
        type: "message",
        role: "user",
        origin: entry.origin,
        ...(entry.hidden ? { hidden: true } : {}),
        ...(entry.delivery ? { delivery: entry.delivery } : {}),
        ...(entry.peerPrompt ? { peerPrompt: entry.peerPrompt } : {}),
        content: entry.content,
      };
    case "assistant":
      return {
        ...envelope,
        type: "message",
        role: "assistant",
        ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
        content: entry.content,
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        ...(entry.stopReason !== undefined
          ? { stopReason: entry.stopReason }
          : {}),
        ...(entry.error !== undefined ? { error: entry.error } : {}),
        ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
        ...(entry.startedAt !== undefined
          ? { startedAt: entry.startedAt }
          : {}),
        ...(entry.completedAt !== undefined
          ? { completedAt: entry.completedAt }
          : {}),
      };
    case "toolResult":
      return {
        ...envelope,
        type: "message",
        role: "toolResult",
        toolCallId: entry.toolCallId,
        ...(entry.toolName !== undefined ? { toolName: entry.toolName } : {}),
        content: entry.content,
        ...(entry.isError !== undefined ? { isError: entry.isError } : {}),
        ...(entry.resultDiff !== undefined
          ? { resultDiff: entry.resultDiff }
          : {}),
      };
  }
}

/** Project a whole raw log into the ordered client conversation view. */
export function projectLogForClient(
  entries: readonly SessionLogEntry[],
): SessionEntry[] {
  const bound = effectiveBindings(entries);
  const out: SessionEntry[] = [];
  for (const e of entries)
    if (isConversationEntry(e)) out.push(projectForClient(e, bound.get(e.id)));
  return out;
}

/**
 * Project a whole raw log into the ordered client TIMELINE: conversation entries
 * AND host-command cards, interleaved by `seq`. This is what the transport renders
 * (so reconnect re-shows `/commit`/`/compact`); stats keep using the conversation-
 * only {@link projectLogForClient}.
 */
export interface ClientTimelineProjectionOptions {
  /** Replace large hidden/collapsed block bodies with previews + lazy refs. */
  lazyBodies?: boolean;
  /**
   * Project only these entry ids (still in timeline order, still against the
   * WHOLE log, so a lazy decision that depends on another entry — a result's
   * rich-card policy lifting its call's input summary — comes out the same).
   */
  only?: ReadonlySet<string>;
  /**
   * Carry CONTENT only from this row index on; every earlier row is projected
   * with an empty body.
   *
   * A snapshot sends the timeline's tail, and the rows before it exist for two
   * things only — being counted, and being summed into the window's turn-stats
   * seed — neither of which reads a block. Building their bodies anyway is what
   * made opening a long session slow: previewing every tool result and thinking
   * block in a 2,900-row session measured 144ms, against 6ms for the tail the
   * reader actually gets. Row IDENTITY and row COUNT are unchanged, so every
   * index the wire speaks in still means the same thing.
   *
   * Nothing content-bearing may be derived from a row below this line. The two
   * consumers that walk backwards past the window — the renderability floor and
   * the window's turn-boundary snap — stay inside the fully projected tail by
   * construction (`CONTENT_TAIL_ROWS`).
   */
  contentFromRow?: number;
}

/** Whether this raw entry becomes a client timeline ROW. */
function isTimelineRow(entry: SessionLogEntry): boolean {
  return (
    isConversationEntry(entry) ||
    isHostCommandResultEntry(entry) ||
    entry.type === "provider.notice"
  );
}

/** How many rows a raw log projects to, without projecting any of them. */
export function countTimelineRows(entries: readonly SessionLogEntry[]): number {
  let rows = 0;
  for (const entry of entries) if (isTimelineRow(entry)) rows += 1;
  return rows;
}

/** An entry projected for COUNTING and SUMMING only — see `contentFromRow`. */
function projectWithoutContent(
  entry: ConversationRawEntry,
  binding?: EntryBinding,
): SessionEntry {
  return projectForClient(
    { ...entry, content: [] } as ConversationRawEntry,
    binding,
  );
}

export function projectLogTimelineForClient(
  entries: readonly SessionLogEntry[],
  opts: ClientTimelineProjectionOptions = {},
): ClientTimelineEntry[] {
  const out: ClientTimelineEntry[] = [];
  const bound = effectiveBindings(entries);
  const contentFrom = opts.contentFromRow ?? 0;
  const lazyIndex = opts.lazyBodies
    ? buildLazyProjectionIndex(entries)
    : undefined;
  let row = 0;
  for (const e of entries) {
    // Counted before the `only` filter: a row's index is its place in the WHOLE
    // timeline, which is what `contentFromRow` and every wire index mean.
    const index = isTimelineRow(e) ? row++ : -1;
    if (opts.only && !opts.only.has(e.id)) continue;
    const bodyless = index >= 0 && index < contentFrom;
    if (isConversationEntry(e))
      out.push(
        bodyless
          ? projectWithoutContent(e, bound.get(e.id))
          : lazyIndex
            ? projectForClientLazy(e, lazyIndex, bound.get(e.id))
            : projectForClient(e, bound.get(e.id)),
      );
    else if (isHostCommandResultEntry(e))
      out.push(projectHostCommandForClient(e));
    else if (e.type === "provider.notice")
      out.push(projectProviderNoticeForClient(e));
  }
  return out;
}

/**
 * The client projection of ONE appended entry, plus whatever its arrival
 * changes about entries the client already holds — the live counterpart of a
 * reconnect snapshot, projected by the same lazy policy so a turn watched live
 * leaves the browser with the rows a reload would send.
 *
 * Today one arrival touches a second row: a tool result whose card READS the
 * call's input (`resultKeepsFullToolInput` — the Task card, which lines the
 * operations up with what changed) lifts the input summary off its declaring
 * call. The declaring entry is re-sent only when the client's copy was
 * actually summarized (the input exceeded the inline bound); a small input was
 * whole from the start. Empty when `entryId` is not a client-visible entry.
 */
export function projectTimelineDeltaForClient(
  entries: readonly SessionLogEntry[],
  entryId: string,
): ClientTimelineEntry[] {
  const appended = entries.find((e) => e.id === entryId);
  if (!appended) return [];
  const ids = new Set([entryId]);
  if (isConversationEntry(appended) && appended.role === "toolResult") {
    const declarerId = rowEntryIdFor(entries, entryId);
    const declarer =
      declarerId === entryId
        ? undefined
        : entries.find((e) => e.id === declarerId);
    const call =
      declarer && isConversationEntry(declarer) && declarer.role === "assistant"
        ? declarer.content.find(
            (
              block,
            ): block is Extract<AgentContentBlock, { type: "toolCall" }> =>
              block.type === "toolCall" &&
              block.toolCallId === appended.toolCallId,
          )
        : undefined;
    // The client's copy was summarized only if the input exceeded the inline
    // bound AND was not already whole for the running card (a question).
    if (
      call &&
      toolInputExceedsInline(call.input) &&
      !shouldKeepFullToolInput(call.name, call.input) &&
      resultKeepsFullToolInput(
        appended as ToolResultRawEntry,
        {
          entryId: declarerId,
          blockIndex: 0,
          name: call.name,
          input: call.input,
        },
        textOf(appended.content),
      )
    )
      ids.add(declarerId);
  }
  return projectLogTimelineForClient(entries, { lazyBodies: true, only: ids });
}

/**
 * The transcript ROW an entry renders in, as an entry id. Every entry is its
 * own row except a tool result, which folds into the assistant entry that
 * declared its call — the LAST such declaration before the result, which is the
 * ownership rule `entriesToDisplayMessages` applies. An anchor has to name the
 * row and not the entry, because a row is what the browser can scroll to.
 *
 * A result whose declaring call is not in this log (an impossible log, or one
 * cut by a fork) stays its own anchor: nothing else is closer to it.
 */
export function rowEntryIdFor(
  entries: readonly SessionLogEntry[],
  entryId: string,
): string {
  const declarer = new Map<string, string>();
  for (const e of entries) {
    if (!isConversationEntry(e)) continue;
    if (e.role === "assistant") {
      for (const block of e.content)
        if (block.type === "toolCall") declarer.set(block.toolCallId, e.id);
      continue;
    }
    if (e.id !== entryId) continue;
    if (e.role === "toolResult") return declarer.get(e.toolCallId) ?? entryId;
    return entryId;
  }
  return entryId;
}

interface LazyProjectionIndex {
  toolCalls: Map<string, ToolCallInfo>;
  fullToolCallIds: Set<string>;
}

function buildLazyProjectionIndex(
  entries: readonly SessionLogEntry[],
): LazyProjectionIndex {
  const toolCalls = new Map<string, ToolCallInfo>();
  for (const e of entries) {
    if (!isConversationEntry(e) || e.role !== "assistant") continue;
    e.content.forEach((block, blockIndex) => {
      if (block.type === "toolCall")
        toolCalls.set(block.toolCallId, {
          entryId: e.id,
          blockIndex,
          name: block.name,
          input: block.input,
        });
    });
  }
  // A call's input stays whole only when the card its result renders reads
  // that input; a card that renders from the payload alone leaves a large
  // input summarized like any other (`resultKeepsFullToolInput`).
  const fullToolCallIds = new Set<string>();
  const completedToolCallIds = new Set<string>();
  for (const e of entries) {
    if (!isConversationEntry(e) || e.role !== "toolResult") continue;
    completedToolCallIds.add(e.toolCallId);
    const call = toolCalls.get(e.toolCallId);
    if (resultKeepsFullToolInput(e, call, textOf(e.content)))
      fullToolCallIds.add(e.toolCallId);
  }
  // A validated ask_questions call is rendered while it is running, so its
  // input remains available in a mid-turn snapshot. Once a result exists, the
  // result policy above decides whether the completed row earned that input.
  for (const [toolCallId, call] of toolCalls)
    if (
      !completedToolCallIds.has(toolCallId) &&
      shouldKeepFullToolInput(call.name, call.input)
    )
      fullToolCallIds.add(toolCallId);
  return { toolCalls, fullToolCallIds };
}

function projectForClientLazy(
  entry: ConversationRawEntry,
  index: LazyProjectionIndex,
  binding?: EntryBinding,
): SessionEntry {
  if (entry.role === "assistant")
    return projectForClient(
      {
        ...entry,
        content: lazyAssistantContent(
          entry as AssistantRawEntry,
          index.fullToolCallIds,
        ),
      },
      binding,
    );
  if (entry.role === "toolResult")
    return projectForClient(
      {
        ...entry,
        content: lazyToolResultContent(
          entry as ToolResultRawEntry,
          index.toolCalls.get(entry.toolCallId),
        ),
      },
      binding,
    );
  return projectForClient(entry, binding);
}

function textOf(content: readonly AgentContentBlock[]): string {
  return content
    .filter(
      (c): c is Extract<AgentContentBlock, { type: "text" }> =>
        c.type === "text",
    )
    .map((c) => c.text)
    .join("\n");
}

/**
 * The native id each entry is EFFECTIVELY bound to.
 *
 * An anchor reaches an entry two ways: inline on the row (a harness that knows
 * the id as the turn completes) or as a later immutable `message.providerBound`
 * row (a harness that recovers ids from a post-turn scan — pi binds every entry
 * this way, and it is the ONLY way its entries are ever anchored). Any view that
 * cares about anchors must fold both, or a whole harness silently looks
 * unanchored and cannot be forked.
 *
 * The bookkeeping row wins: it is the later, post-persistence correction.
 */
function effectiveBindings(
  entries: readonly SessionLogEntry[],
): Map<string, EntryBinding> {
  const bound = new Map<string, EntryBinding>();
  for (const e of entries)
    if (e.type === "message.providerBound")
      bound.set(e.boundEntryId, {
        providerMessageId: e.providerMessageId,
        ...(e.providerTurnEndId
          ? { providerTurnEndId: e.providerTurnEndId }
          : {}),
      });
  return bound;
}

/** Project a whole raw log into the ordered server conversation view. */
export function projectLogForServer(
  entries: readonly SessionLogEntry[],
): ServerSessionEntry[] {
  const bound = effectiveBindings(entries);
  const out: ServerSessionEntry[] = [];
  for (const e of entries)
    if (isConversationEntry(e)) out.push(projectForServer(e, bound.get(e.id)));
  return out;
}
