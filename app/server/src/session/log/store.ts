/**
 * The passive, append-only app-owned log. One {@link SessionLog} per session
 * owns its ordered raw entries, assigns `seq`/`id`/`createdAt`, dedupes
 * re-submitted prompts on `clientRequestId`, and projects the client/server
 * conversation views. {@link SessionLogStore} manages the per-session logs and
 * their persistence.
 *
 * This module knows NOTHING about adapters, the runtime, or the wire — it is the
 * storage layer the runtime appends to. Run state is never stored here.
 */
import { randomUUID } from "node:crypto";
import type { LazyBlockKind, SessionEntry } from "@assistant/shared/session";
import {
  TIMELINE_RANGE_LIMIT,
  timelineRangeStart,
} from "@assistant/shared/runtime";
import {
  turnStatsSeedForWindow,
  type TurnStatsSeed,
} from "@assistant/shared/turnStats";
import {
  isConversationEntry,
  type AssistantRawEntry,
  type ConversationRawEntry,
  type SessionLogEntry,
  type ToolResultRawEntry,
  type UserRawEntry,
} from "./rawEntry.ts";
import {
  countTimelineRows,
  projectLogForClient,
  projectLogForServer,
  projectLogTimelineForClient,
  projectTimelineDeltaForClient,
  rowEntryIdFor,
  type ClientTimelineEntry,
  type ClientTimelineProjectionOptions,
  type ServerSessionEntry,
} from "./projection.ts";
import {
  asSessionId,
  type ProviderBinding,
  type SessionId,
} from "./identity.ts";
import {
  createFileLogPersistence,
  createMemoryLogPersistence,
  type LastRunMarker,
  logPathFor,
  type LogPersistence,
} from "./persistence.ts";
import { sessionStore } from "../../db/sessionStore.ts";

/** Distributive Omit so a union member keeps its own shape after omission. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * What a caller passes to {@link SessionLog.append}: a full entry minus the
 * store-assigned envelope fields. `id`/`createdAt` may be supplied (e.g. to mirror
 * a native message id deterministically) or left for the store to assign.
 */
export type LogEntryDraft = DistributiveOmit<
  SessionLogEntry,
  "seq" | "sessionId" | "createdAt" | "id"
> & {
  id?: string;
  createdAt?: string;
};

/**
 * One row of a provider's own transcript, as a post-turn scan reports it. The
 * rows arrive in NATIVE order and are matched to our entries by turn structure
 * and tool call ids — never by position (see {@link SessionLog.bindScannedEntries}).
 */
export interface ScannedProviderEntry {
  role: SessionEntry["role"];
  providerMessageId: string;
  /** Tool result: the call it answers. */
  toolCallId?: string;
  /** Assistant message: the calls it declares. */
  toolCallIds?: string[];
  /** Assistant message: it declares a call whose id the scan could not read. */
  unidentifiedToolCalls?: true;
}

/**
 * Which entries a completed turn owns, as only the runtime can know it: where the
 * turn started in the log, and which prompts the PROVIDER actually accepted into
 * it (a steering message we appended and it refused is neither).
 */
export interface CompletedTurnBoundary {
  fromSeq: number;
  promptEntryIds: ReadonlySet<string>;
}

/** One entry's resolved anchors, as a completed-turn match produces them. */
interface ResolvedBinding {
  entryId: string;
  providerMessageId: string;
  /** Set on the aggregated assistant entry only; see `providerTurnEndId`. */
  providerTurnEndId?: string;
}

/** One answered "load earlier" slice of a windowed transcript. */
export interface TimelineRangeResult {
  entries: ClientTimelineEntry[];
  /** Absolute index of `entries[0]`; zero means the session start is reached. */
  timelineStart: number;
  totalEntryCount: number;
  turnStatsSeed?: TurnStatsSeed;
}

/**
 * How many rows at the END of the timeline a snapshot projects WITH bodies.
 *
 * Must stay comfortably above the window's own entry budget
 * (`SNAPSHOT_TIMELINE_WINDOW_ENTRIES`, 400): the two walks that may reach back
 * past the window start — the turn-boundary snap and the renderability floor —
 * read blocks, and a bodyless row would make the floor silently fail to find
 * the assistant entry that declares an orphan result. The snap is bounded by
 * the entry budget; the floor is bounded by one turn, and a turn longer than
 * the remaining 800 rows falls back to re-projecting (see
 * `RuntimeTransport.attach`), which is correct but pays the full cost.
 */
const CONTENT_TAIL_ROWS = 1_200;

export class SessionLog {
  readonly sessionId: SessionId;
  private readonly entries: SessionLogEntry[] = [];
  private nextSeq = 0;
  private binding: ProviderBinding | undefined;
  /** clientRequestId → the user entry id it produced, for idempotent re-submits. */
  private readonly requestIndex = new Map<string, string>();

  constructor(
    sessionId: string,
    private readonly persistence: LogPersistence,
  ) {
    this.sessionId = asSessionId(sessionId);
    // Rehydrate from disk (or memory) on construction.
    for (const entry of this.persistence.load()) this.adopt(entry);
  }

  /** Re-index a loaded/appended entry without re-persisting it. */
  private adopt(entry: SessionLogEntry): void {
    this.entries.push(entry);
    if (entry.seq >= this.nextSeq) this.nextSeq = entry.seq + 1;
    if (
      entry.type === "message" &&
      entry.role === "user" &&
      entry.clientRequestId
    ) {
      this.requestIndex.set(entry.clientRequestId, entry.id);
    }
  }

  /**
   * Append one entry, assigning `seq`/`id`/`createdAt`. Returns the persisted
   * entry. **Idempotent on `clientRequestId`** for user entries: a repeat returns
   * the existing entry and appends nothing (so a duplicate prompt submit is a
   * no-op). Entries are immutable once appended.
   */
  append(draft: LogEntryDraft): SessionLogEntry {
    if (draft.type === "message" && draft.role === "user") {
      const reqId = (draft as Partial<UserRawEntry>).clientRequestId;
      if (reqId) {
        const existingId = this.requestIndex.get(reqId);
        if (existingId) {
          const existing = this.entries.find((e) => e.id === existingId);
          if (existing) return existing;
        }
      }
    }
    const seq = this.nextSeq;
    const entry = {
      ...draft,
      sessionId: this.sessionId as string,
      seq,
      id: draft.id ?? `e${seq}-${randomUUID().slice(0, 8)}`,
      createdAt: draft.createdAt ?? new Date().toISOString(),
    } as SessionLogEntry;
    this.adopt(entry);
    this.persistence.append(entry);
    if (entry.type === "message") {
      const updatedAt = new Date(entry.createdAt).getTime();
      sessionStore.updateStats(entry.sessionId, {
        messageCount: this.clientEntries().length,
        updatedAt,
      });
      if (entry.role === "assistant")
        sessionStore.recordUsageTurn(entry.sessionId, entry.usage, {
          updatedAt,
        });
    }
    return entry;
  }

  /**
   * Bind a previously-appended (unbound) user entry to its native message id once
   * the provider accepts the prompt — appended as a separate immutable
   * `message.providerBound` bookkeeping entry (we never edit the user entry).
   */
  bindUserEntry(
    boundEntryId: string,
    providerMessageId: string,
  ): SessionLogEntry {
    return this.append({
      type: "message.providerBound",
      boundEntryId,
      providerMessageId,
    });
  }

  /** The set of entry ids already bound to a native id. */
  private boundEntryIds(): Set<string> {
    const bound = new Set<string>();
    for (const e of this.entries)
      if (e.type === "message.providerBound") bound.add(e.boundEntryId);
    return bound;
  }

  /**
   * Bind the turn that just completed — the entries the runtime's
   * {@link CompletedTurnBoundary} names — to its native ids, reconciled against
   * the provider's own transcript.
   *
   * THREE scopes make this safe, and all of them are deliberate:
   *
   * 1. ONLY THE NEW TURN. `fromSeq` is the log cursor the runtime captured when
   *    this turn began, so entries recorded before it are never read as
   *    candidates and never bound. A scan reports the WHOLE native file, so
   *    without that boundary the first run after any change here would silently
   *    backfill every historical turn of every existing session.
   * 2. ONLY ACCEPTED PROMPTS. `promptEntryIds` are the user entries the PROVIDER
   *    took. A steering message is appended to our log before the provider
   *    answers, so a refused one leaves a prompt we hold and it never saw;
   *    counting it would pair this turn's prompts one row too far back — onto a
   *    PREVIOUS turn's native prompt.
   * 3. THE TAIL OF THE SCAN. The completed turn is the LAST turn of both
   *    transcripts, so it is matched from the END: our prompts pair with the
   *    provider's last prompts, and the rows after them must account for exactly
   *    this turn. Walking from the START would let any historical divergence
   *    shift every later pairing by one and mis-bind silently. As a hard floor,
   *    no row already bound to an EARLIER entry may be claimed: a match that
   *    reaches back into the session's history is wrong by construction.
   *
   * Within the turn the two transcripts still differ in GRANULARITY: a harness
   * writes one native assistant message per model call (`assistant(call) →
   * result → assistant(call) → result → assistant(final)`) against the ONE
   * aggregated assistant entry plus trailing tool results our log keeps. The
   * match is therefore justified by tool call ids and is ALL-OR-NOTHING — see
   * {@link matchCompletedTurn} for what a justified, complete turn requires.
   * An unbound turn simply offers no fork action; the next turn is matched
   * independently.
   *
   * The aggregated assistant entry is bound to the LAST native assistant message
   * of the turn and ALWAYS records the turn's terminal native id
   * (`providerTurnEndId`) — the id an inclusive provider cut must name to
   * reproduce the complete turn, and the marker that tells a reconciled binding
   * from a legacy one.
   *
   * Idempotent PER ENTRY: an entry that already carries an anchor keeps the one
   * it has and the rest of the turn is still bound. Re-scanning a bound turn
   * therefore appends nothing, and a harness that anchors a prompt mid-turn
   * (`promptAccepted`) and scans afterwards is not silently refused everything.
   */
  bindScannedEntries(
    scanned: readonly ScannedProviderEntry[],
    turn: CompletedTurnBoundary,
  ): void {
    const entries = this.entries.filter(
      (entry): entry is ConversationRawEntry =>
        isConversationEntry(entry) && entry.seq >= turn.fromSeq,
    );
    if (entries.length === 0) return;
    const bindings = matchCompletedTurn(
      entries,
      scanned,
      turn.promptEntryIds,
      this.nativeIdsBoundBefore(turn.fromSeq),
    );
    if (!bindings) return;
    const bound = this.boundEntryIds();
    for (const binding of bindings) {
      if (bound.has(binding.entryId)) continue;
      this.append({
        type: "message.providerBound",
        boundEntryId: binding.entryId,
        providerMessageId: binding.providerMessageId,
        ...(binding.providerTurnEndId
          ? { providerTurnEndId: binding.providerTurnEndId }
          : {}),
      });
    }
  }

  /**
   * Every native id already spoken for by an entry BEFORE this turn. A completed
   * turn's rows are new, so claiming one of these means the match walked into the
   * session's history — the failure mode a count-based pairing produces when our
   * log and the provider's disagree about how many prompts exist.
   */
  private nativeIdsBoundBefore(seq: number): Set<string> {
    const seqById = new Map<string, number>();
    for (const entry of this.entries) seqById.set(entry.id, entry.seq);
    const ids = new Set<string>();
    for (const entry of this.entries) {
      if (isConversationEntry(entry)) {
        if (entry.seq < seq && entry.providerMessageId)
          ids.add(entry.providerMessageId);
        continue;
      }
      if (entry.type !== "message.providerBound") continue;
      const boundSeq = seqById.get(entry.boundEntryId);
      if (boundSeq === undefined || boundSeq >= seq) continue;
      ids.add(entry.providerMessageId);
      if (entry.providerTurnEndId) ids.add(entry.providerTurnEndId);
    }
    return ids;
  }

  /** The trailing user entry with no provider binding, if any (resume's accepted-but-not-bound case). */
  trailingUnboundUserEntry(): SessionEntry | undefined {
    const bound = new Set<string>();
    for (const e of this.entries)
      if (e.type === "message.providerBound") bound.add(e.boundEntryId);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (!isConversationEntry(e)) continue;
      if (e.role !== "user") return undefined; // a later assistant/tool entry means the prompt ran
      if (!bound.has(e.id)) return projectLogForClient([e])[0];
      return undefined;
    }
    return undefined;
  }

  /** All raw entries in `seq` order (module-internal callers only). */
  rawEntries(): readonly SessionLogEntry[] {
    return this.entries;
  }

  /** The public client conversation view. */
  clientEntries(): SessionEntry[] {
    return projectLogForClient(this.entries);
  }

  /** The full client timeline: conversation entries + host-command cards, by `seq`. */
  clientTimeline(
    opts: ClientTimelineProjectionOptions = {},
  ): ClientTimelineEntry[] {
    return projectLogTimelineForClient(this.entries, opts);
  }

  /**
   * The client timeline for a SNAPSHOT: identical in length, order and row
   * identity to {@link clientTimeline}, but carrying bodies only where the
   * answer can use them — the tail the reader is about to render, plus any
   * range the browser claims to hold (which the server has to fingerprint
   * before it will answer with a delta).
   *
   * This is the shape of the load-time win: a 2,900-row session's snapshot
   * builds ~600 bodies instead of 2,900, and everything the wire counts in —
   * `timelineStart`, `totalEntryCount`, the turn-stats seed — is unchanged,
   * because none of them reads a block.
   *
   * `bodiesFrom` is the LOWEST row that must carry one: the start of a cached
   * range the answer has to fingerprint, or `0` for the whole timeline (which
   * the transport falls back to when the window it built renders nothing). The
   * tail is bodied regardless.
   */
  clientTimelineForSnapshot(bodiesFrom?: number): {
    timeline: ClientTimelineEntry[];
    contentFromRow: number;
  } {
    const rows = countTimelineRows(this.entries);
    const contentFromRow = Math.max(
      0,
      Math.min(
        rows - CONTENT_TAIL_ROWS,
        bodiesFrom !== undefined && bodiesFrom >= 0 ? bodiesFrom : rows,
      ),
    );
    return {
      timeline: projectLogTimelineForClient(this.entries, {
        lazyBodies: true,
        contentFromRow,
      }),
      contentFromRow,
    };
  }

  /** The lazily-projected rows one appended entry touches (see `projectTimelineDeltaForClient`). */
  clientTimelineDelta(entryId: string): ClientTimelineEntry[] {
    return projectTimelineDeltaForClient(this.entries, entryId);
  }

  /**
   * Locate a jump target: the first entry `match` accepts, answered as the
   * transcript ROW it renders in and that row's index in the client timeline.
   *
   * `match` runs over the RAW entries because that is the authoritative copy —
   * the client projection may have replaced a large tool payload with a preview,
   * so a card the caller identifies by a key inside that payload is only
   * reliably found here. The index, in contrast, counts into the client timeline,
   * which is what `timelineStart` and a windowed "load earlier" speak in.
   */
  locateAnchor(
    match: (entry: SessionLogEntry) => boolean,
  ): { entryId: string; index: number; totalEntryCount: number } | undefined {
    const hit = this.entries.find(match);
    if (!hit) return undefined;
    const entryId = rowEntryIdFor(this.entries, hit.id);
    const timeline = this.clientTimeline();
    const index = timeline.findIndex((entry) => entry.id === entryId);
    // Bookkeeping entries (provider bindings, tool audit) never reach the client
    // timeline: they have no row to scroll to, so they are not an anchor.
    if (index < 0) return undefined;
    return { entryId, index, totalEntryCount: timeline.length };
  }

  /**
   * The entries immediately BEFORE `beforeSeq`, for a windowed transcript's
   * "load earlier". Bounded by `limit` and by bytes, starting at a turn boundary
   * when one fits, and answered with the turn stats for everything preceding the
   * new start so the client can re-seed without changing the rows it already
   * rendered — including the `partialTurn` flag when the slice itself starts
   * inside a turn too long to bound any other way.
   *
   * `undefined` means the anchor is not in this timeline (a stale/foreign
   * request), which the caller drops rather than answering with a wrong slice.
   */
  clientTimelineRange(
    beforeSeq: number,
    limit: number = TIMELINE_RANGE_LIMIT,
  ): TimelineRangeResult | undefined {
    const timeline = this.clientTimeline({ lazyBodies: true });
    const end = timeline.findIndex((entry) => entry.seq === beforeSeq);
    if (end < 0) return undefined;
    const start = timelineRangeStart(timeline, end, limit);
    const seed = turnStatsSeedForWindow(timeline, start);
    return {
      entries: timeline.slice(start, end),
      timelineStart: start,
      totalEntryCount: timeline.length,
      ...(seed ? { turnStatsSeed: seed } : {}),
    };
  }

  /** Return a full block body for a lazily-projected snapshot block. */
  loadTimelineBlock(
    entryId: string,
    blockIndex: number,
    kind: LazyBlockKind,
  ): unknown {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry || !isConversationEntry(entry)) return undefined;
    const block = entry.content[blockIndex];
    if (!block) return undefined;
    if (
      kind === "thinking" &&
      entry.role === "assistant" &&
      block.type === "thinking"
    )
      return block.text;
    if (
      kind === "toolInput" &&
      entry.role === "assistant" &&
      block.type === "toolCall"
    )
      return block.input;
    if (
      kind === "toolOutput" &&
      entry.role === "toolResult" &&
      block.type === "text"
    )
      return block.text;
    return undefined;
  }

  /** The server conversation view (retains native ids for fork/resume/search). */
  serverEntries(): ServerSessionEntry[] {
    return projectLogForServer(this.entries);
  }

  getBinding(): ProviderBinding | undefined {
    return this.binding;
  }

  setBinding(binding: ProviderBinding): void {
    this.binding = binding;
  }

  /** Highest assigned seq + 1 (the next seq this log would use). */
  get seqCursor(): number {
    return this.nextSeq;
  }

  /** The newest run marker in this log's durable form; see {@link LogPersistence.lastRunMarker}. */
  lastRunMarker(): LastRunMarker | undefined {
    return this.persistence.lastRunMarker();
  }

  /**
   * Copy this log's prefix THROUGH `entryId` into `target` — the durable half of
   * a fork. Entries keep their `id` and `seq`, per the {@link SessionEntry}
   * identity contract: identity is per session, so a child carrying its parent's
   * prefix ids is expected.
   *
   * The copy drops every id that names something OUTSIDE the child, because
   * each would be a dangling foreign key there:
   *   - native anchors, both the inline `providerMessageId` and the
   *     `message.providerBound` rows. A provider fork rewrites the transcript it
   *     copies (the Claude SDK remaps every message uuid; pi's branch is its own
   *     session), so a parent's native ids name nothing in the child's — keeping
   *     them would hand a later fork an id its provider cannot resolve. The
   *     child re-anchors through its own turns, and until then its inherited
   *     prefix offers no fork point.
   *   - `clientRequestId`, the submitting client's idempotency token. `adopt`
   *     re-indexes it, so an inherited one would make the child treat a resubmit
   *     of that token as an already-handled prompt and append NOTHING — an
   *     edit-and-retry, which reuses the optimistic submit, is exactly that case.
   *
   * Every copied entry is stamped `inheritedFrom`, which is the one id that
   * points OUT of the child on purpose: ids survive the copy, so it addresses
   * the same entry in the session that wrote it, and it is what tells the
   * transcript where the inherited prefix ends. An already-stamped entry keeps
   * its stamp — a fork of a fork inherited it from the ORIGINAL session, and
   * re-pointing it at the intermediate one would walk the user back one hop
   * short of where the message was written.
   *
   * Copies raw rather than replaying `append`: a replay would re-derive ids and
   * re-run the per-entry stats/usage mirrors, double-counting the parent's turns
   * onto the child's metadata row.
   *
   * Returns false when `entryId` is not in this log, so a caller can refuse the
   * fork rather than silently copy everything.
   */
  copyPrefixTo(target: SessionLog, entryId: string): boolean {
    const cut = this.entries.findIndex((entry) => entry.id === entryId);
    if (cut < 0) return false;
    for (const entry of this.entries.slice(0, cut + 1)) {
      if (entry.type === "message.providerBound") continue;
      // Run markers are this session's OWN lifecycle, not conversation history.
      // A fork cuts at a conversation entry, which is inside the turn and so
      // BEFORE that turn's closing marker — copying them would hand the child a
      // permanently unmatched opener and boot would read the fork as a session
      // that crashed mid-turn. A fresh fork has run nothing; it owns no bracket.
      if (
        entry.type === "run.started" ||
        entry.type === "run.ended" ||
        entry.type === "run.aborted"
      )
        continue;
      const {
        providerMessageId: _anchor,
        clientRequestId: _token,
        ...rest
      } = entry as SessionLogEntry & {
        providerMessageId?: string;
        clientRequestId?: string;
      };
      target.adoptCopy({
        ...rest,
        sessionId: target.sessionId as string,
        inheritedFrom: entry.inheritedFrom ?? {
          sessionId: this.sessionId as string,
          entryId: entry.id,
        },
      } as SessionLogEntry);
    }
    return true;
  }

  /** Adopt + persist an entry copied verbatim from another log (see {@link copyPrefixTo}). */
  private adoptCopy(entry: SessionLogEntry): void {
    this.adopt(entry);
    this.persistence.append(entry);
  }

  get logPath(): string {
    return this.persistence.path;
  }
}

/** Our side of a completed turn, in the only shape a turn can have. */
interface OurTurn {
  /** The prompt(s) that drove it — several only when the turn was steered. */
  users: ConversationRawEntry[];
  assistant: AssistantRawEntry;
  results: ToolResultRawEntry[];
  /**
   * How many attempts this turn ABANDONED before the one that answered — the
   * content-empty assistant entries skipped below. It is the evidence, from our
   * side, for the only native rows a match may pass over, so the two sides stay
   * coupled: one skipped row per attempt we actually saw fail, never more.
   */
  abandonedAttempts: number;
}

/**
 * Split the just-completed turn's entries into their roles, or `undefined` if
 * they are not the shape a turn has: prompts, then ONE aggregated assistant
 * entry, then the results it flushed on completion. Two assistant entries with
 * content under one boundary are ambiguous — which native message each mirrors
 * cannot be decided from ids — so the turn is refused rather than half-placed.
 *
 * An attempt the provider ABANDONED and retried (a connection dropped mid-turn)
 * closes as a CONTENT-EMPTY assistant entry. It is skipped — it wrote nothing,
 * so there is no second turn to decide between — but only while the attempt that
 * ANSWERED is here too: a turn whose one assistant entry is empty still mirrors
 * whatever the provider wrote, and is placed as it always was. Each skip is
 * COUNTED (`abandonedAttempts`): it is what buys the match the right to pass
 * over the row that attempt left in the provider's transcript.
 *
 * A user entry the provider never accepted (`promptEntryIds` does not hold it)
 * is not one of this turn's prompts: it exists in our log alone, so it is left
 * out of the pairing entirely and never anchored.
 */
function splitOurTurn(
  entries: readonly ConversationRawEntry[],
  promptEntryIds: ReadonlySet<string>,
): OurTurn | undefined {
  const users: ConversationRawEntry[] = [];
  const results: ToolResultRawEntry[] = [];
  const answered = entries.some(
    (entry) => entry.role === "assistant" && entry.content.length > 0,
  );
  let abandonedAttempts = 0;
  let assistant: AssistantRawEntry | undefined;
  for (const entry of entries) {
    if (entry.role === "user") {
      if (!promptEntryIds.has(entry.id)) continue; // the provider never took it
      if (assistant) return undefined; // a prompt after the answer is another turn
      users.push(entry);
    } else if (entry.role === "assistant") {
      // An abandoned attempt, next to the one that answered: it wrote nothing.
      if (answered && entry.content.length === 0) {
        abandonedAttempts++;
        continue;
      }
      if (assistant) return undefined; // ambiguous: two turns under one boundary
      assistant = entry;
    } else {
      if (!assistant) return undefined; // a result with nothing that declared it
      results.push(entry);
    }
  }
  return assistant
    ? { users, assistant, results, abandonedAttempts }
    : undefined;
}

/**
 * Match ONE completed turn against the TAIL of the provider's transcript, and
 * answer the anchors for every entry of it — or `undefined`, meaning the turn
 * cannot be placed with certainty and none of it may be bound.
 *
 * The turn is the last of both transcripts, so the match is anchored at the end:
 * our accepted prompts pair with the provider's LAST prompts, and every native
 * row from the first of them to the end of the scan must be accounted for by
 * this turn. A turn with NO accepted prompt is not matched at all — without one
 * there is nothing to anchor the tail to, and the rows would be read against
 * whatever the previous prompt left behind.
 *
 * What justifies a row is the set of tool calls our aggregated entry declares:
 * a native assistant may declare only those and only once, and a native result
 * may answer only a call a CLAIMED message already declared — a result ahead of
 * its declaration is not this turn in order. The turn must then be COMPLETE and
 * one-to-one on both sides: every declared call claimed natively, every claimed
 * call answered exactly once, exactly as many results as our log holds and each
 * of ours among them, and our own final answer (text after the last call)
 * matched by a native message that ENDS the turn — after which no further row
 * may appear, since a second terminal message means the tail spans more than
 * this turn.
 *
 * The only row that may be passed over is an attempt the provider abandoned: a
 * message whose calls our turn declares none of and whose calls the provider
 * itself never answered — a dead branch of its own transcript, left behind when
 * a run failed mid-turn and was retried. Skipping it costs nothing a fork could
 * want: the row precedes the anchors in the SAME linear history, so a cut at
 * them reproduces it either way.
 *
 * That allowance is NOT free-standing — it is spent against `abandonedAttempts`,
 * the attempts our own log watched fail. Both transcripts must therefore show
 * the same retry: an unexplained native message, with nothing on our side that
 * accounts for it, is provider work we cannot see and still refuses the turn.
 */
function matchCompletedTurn(
  entries: readonly ConversationRawEntry[],
  scanned: readonly ScannedProviderEntry[],
  promptEntryIds: ReadonlySet<string>,
  spentNativeIds: ReadonlySet<string>,
): ResolvedBinding[] | undefined {
  const ours = splitOurTurn(entries, promptEntryIds);
  if (!ours) return undefined;
  const declared = declaredCallIds(ours.assistant);
  if (!declared) return undefined; // duplicate call ids: nothing is decidable

  // Pair prompts from the END. No accepted prompt, or fewer native prompts than
  // ours, means there is nothing this turn can be anchored to.
  const nativeUsers: number[] = [];
  scanned.forEach((row, index) => {
    if (row.role === "user") nativeUsers.push(index);
  });
  if (ours.users.length > nativeUsers.length) return undefined;
  // The last N native prompts, so every prompt row from here on is one of them
  // (a steered turn owns the ones the provider wrote between its own messages).
  const pairedUsers = nativeUsers.slice(nativeUsers.length - ours.users.length);
  // Our FIRST prompt is where this turn starts in the provider's transcript. A
  // turn with no accepted prompt has no such point: the rows after the
  // provider's last prompt answer a prompt we do not hold, and binding our entry
  // to them would let a fork cut a turn our copy cannot show.
  const start = pairedUsers[0];
  if (start === undefined) return undefined;

  // The calls the provider ANSWERED in this tail. A call it left hanging that
  // our turn does not declare either is the signature of an abandoned attempt —
  // and the walk below may pass over one row per attempt we watched fail.
  let abandonedAllowance = ours.abandonedAttempts;
  const answeredNatively = new Set<string>();
  for (let i = start; i < scanned.length; i++) {
    const row = scanned[i]!;
    if (row.role === "toolResult" && row.toolCallId)
      answeredNatively.add(row.toolCallId);
  }

  // Claim every native row of the turn. Anything else unjustifiable refuses the
  // turn: the rows run to the end of the scan, so nothing may be skipped over.
  const claimedCalls = new Set<string>();
  const claimedResults = new Map<string, string>();
  let assistantId: string | undefined;
  let turnEndId: string | undefined;
  let turnEnded = false;
  for (let i = start; i < scanned.length; i++) {
    const row = scanned[i]!;
    // A row an earlier entry is already bound to belongs to the history, so the
    // tail we are reading is not this turn's.
    if (spentNativeIds.has(row.providerMessageId)) return undefined;
    if (turnEnded) return undefined; // the turn's answer was already written
    if (row.role === "user") continue; // paired above: this turn's own prompt
    if (row.role === "toolResult") {
      const call = row.toolCallId;
      if (!call || !claimedCalls.has(call) || claimedResults.has(call))
        return undefined;
      claimedResults.set(call, row.providerMessageId);
      turnEndId = row.providerMessageId;
      continue;
    }
    if (row.unidentifiedToolCalls) return undefined;
    const calls = row.toolCallIds ?? [];
    // An abandoned attempt: every call it made is one we never saw and the
    // provider never answered. It ends nothing and anchors nothing — a row that
    // called NOTHING is the turn's final answer and can never be read this way.
    // Only as many such rows as our log holds failed attempts may be passed
    // over; one more is provider work nothing on our side explains.
    if (
      calls.length > 0 &&
      calls.every((call) => !declared.has(call) && !answeredNatively.has(call))
    ) {
      if (abandonedAllowance === 0) return undefined;
      abandonedAllowance--;
      continue;
    }
    for (const call of calls) {
      if (!declared.has(call) || claimedCalls.has(call)) return undefined;
      claimedCalls.add(call);
    }
    assistantId = row.providerMessageId;
    turnEndId = row.providerMessageId;
    if (calls.length === 0) turnEnded = true; // the turn's final answer
  }
  if (!assistantId || !turnEndId) return undefined;

  // Both sides must describe the SAME complete turn, one row for one row.
  if (claimedCalls.size !== declared.size) return undefined;
  for (const call of claimedCalls)
    if (!claimedResults.has(call)) return undefined;
  if (ours.results.length !== claimedResults.size) return undefined;
  const seen = new Set<string>();
  for (const result of ours.results) {
    if (seen.has(result.toolCallId)) return undefined; // two results, one call
    if (!claimedResults.has(result.toolCallId)) return undefined;
    seen.add(result.toolCallId);
  }
  // Our entry answered after its last call, so the provider's turn must end on
  // the message that answer was written as. If it does not, the transcript we
  // read is not the whole turn (a scan that raced the provider's own write).
  if (answeredAfterLastCall(ours.assistant) && !turnEnded) return undefined;

  return [
    ...ours.users.map((user, index) => ({
      entryId: user.id,
      providerMessageId: scanned[pairedUsers[index]!]!.providerMessageId,
    })),
    {
      entryId: ours.assistant.id,
      providerMessageId: assistantId,
      providerTurnEndId: turnEndId,
    },
    ...ours.results.map((result) => ({
      entryId: result.id,
      providerMessageId: claimedResults.get(result.toolCallId)!,
    })),
  ];
}

/** The calls an aggregated entry declares, or `undefined` if it declares one twice. */
function declaredCallIds(entry: AssistantRawEntry): Set<string> | undefined {
  const ids = new Set<string>();
  for (const block of entry.content) {
    if (block.type !== "toolCall") continue;
    if (ids.has(block.toolCallId)) return undefined;
    ids.add(block.toolCallId);
  }
  return ids;
}

/**
 * Whether the turn produced its own answer after the last tool call it made —
 * the content a provider writes as one final, call-free message. False for a turn
 * that stopped at a tool (an abort), which therefore ends on a tool result.
 */
function answeredAfterLastCall(entry: AssistantRawEntry): boolean {
  let answered = true; // a turn that called nothing is answer all the way down
  for (const block of entry.content) {
    if (block.type === "toolCall") answered = false;
    else if (
      (block.type === "text" || block.type === "thinking") &&
      block.text.trim().length > 0
    )
      answered = true;
  }
  return answered;
}

/**
 * Process-global registry of per-session logs. `create`/`open` are idempotent for
 * a given id (return the resident log). Persistence defaults to the per-id JSONL
 * file; pass `memory: true` for tests that should not touch disk.
 */
export class SessionLogStore {
  private readonly logs = new Map<string, SessionLog>();
  /**
   * A memory store's stand-in for the files: kept per id across `evict`, so an
   * evicted log reopens with its entries exactly as a file-backed one does.
   */
  private readonly memoryFiles = new Map<string, LogPersistence>();

  constructor(private readonly memory = false) {}

  private persistenceFor(sessionId: string): LogPersistence {
    if (!this.memory) return createFileLogPersistence(sessionId);
    let persistence = this.memoryFiles.get(sessionId);
    if (!persistence) {
      persistence = createMemoryLogPersistence();
      this.memoryFiles.set(sessionId, persistence);
    }
    return persistence;
  }

  /** Get the resident log for `id`, creating (and rehydrating from disk) on first use. */
  open(sessionId: string): SessionLog {
    let log = this.logs.get(sessionId);
    if (!log) {
      log = new SessionLog(sessionId, this.persistenceFor(sessionId));
      this.logs.set(sessionId, log);
    }
    return log;
  }

  /** Whether a log is resident in memory OR exists on disk for `id`. */
  has(sessionId: string): boolean {
    if (this.logs.has(sessionId)) return true;
    return this.memory
      ? (this.memoryFiles.get(sessionId)?.exists() ?? false)
      : createFileLogPersistence(sessionId).exists();
  }

  /** Drop a session's resident log from memory (does not delete its file). */
  evict(sessionId: string): void {
    this.logs.delete(sessionId);
  }

  /**
   * When this session's log ends on an OPEN run bracket — a turn the process died
   * inside — or `undefined` when its last turn closed, when it has no markers at
   * all (a log written before they existed), or when the log cannot be read.
   *
   * An interrupted turn is not a partial record: both harnesses flush a turn's
   * assistant entry and tool results together at completion, so what a killed
   * turn leaves is NO record. The bracket is the only evidence, and this reads it
   * without rehydrating the log — boot asks it of every session.
   */
  interruptedRunAt(sessionId: string): number | undefined {
    const resident = this.logs.get(sessionId);
    const marker = resident
      ? resident.lastRunMarker()
      : this.persistenceFor(sessionId).lastRunMarker();
    return marker?.type === "run.started" ? marker.at : undefined;
  }

  /** The on-disk path a session's log uses (for diagnostics / deletion). */
  pathFor(sessionId: string): string {
    return logPathFor(sessionId);
  }

  /** Resident session ids (for diagnostics). */
  residentIds(): string[] {
    return [...this.logs.keys()];
  }
}
