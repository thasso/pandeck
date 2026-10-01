/**
 * Projects the normalized session model (durable {@link SessionEntry}s + in-flight
 * {@link StreamingEntry}s) into the `DisplayMessage[]` the chat renderer consumes.
 * Shared by the server transport (reconnect snapshot) and the client reducer (the
 * keyed runtime snapshot → render model), so both ends agree on the projection.
 *
 * Granularity reconciliation: the normalized model keeps tool results as their own
 * entries; the legacy `DisplayMessage` nests a tool's output INSIDE the assistant
 * message's tool block. So a `toolResult` entry is folded back into the matching
 * `toolCall` block of the preceding assistant message (by `toolCallId`). The
 * in-flight streams render as one trailing streaming assistant message; a tool
 * stream marked `done` (live `toolEnd` arrived before the durable result) renders
 * with its spinner already stopped.
 */
import type { DisplayBlock, DisplayMessage, Harness } from "./protocol.ts";
import type { AgentContentBlock, StreamingEntry } from "./session/index.ts";
import type { ClientTimelineEntry, HostCommandCard } from "./runtimeEvents.ts";

type ToolStream = Extract<StreamingEntry, { kind: "tool" }>;
type ToolResultEntry = Extract<
  Extract<ClientTimelineEntry, { type: "message" }>,
  { role: "toolResult" }
>;
type AssistantEntry = Extract<
  Extract<ClientTimelineEntry, { type: "message" }>,
  { role: "assistant" }
>;

/**
 * Per-entry projection cache, so a re-projection only rebuilds what moved.
 *
 * The client re-projects the WHOLE timeline on every runtime event (up to once
 * per animation frame while a turn streams), and a long session runs to
 * thousands of entries. Without this, every message and every block is
 * reallocated per frame, so no `DisplayMessage` keeps its identity and every
 * memoized row in the transcript re-renders — including the Markdown pipeline.
 *
 * Reuse is keyed on IDENTITY of an entry plus of everything folded into it (its
 * tool results and any live tool stream merged into its blocks). The client's
 * reducer replaces only the entries it touches, so the tail changes and the rest
 * is reused. Passing no cache keeps the plain, allocate-everything behaviour —
 * which is what the server's one-shot reconnect projection wants.
 */
export interface DisplayProjectionCache {
  messages: Map<
    string,
    { deps: readonly unknown[]; message: DisplayMessage; generation: number }
  >;
  generation: number;
}

export function createDisplayProjectionCache(): DisplayProjectionCache {
  return { messages: new Map(), generation: 0 };
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface DisplayProjectionOptions {
  /**
   * The harness backing this transcript, which decides when a prompt may offer
   * "fork before": the Claude SDK needs an anchor strictly EARLIER, pi the
   * prompt's OWN one (see the rule below). A projection that does not know which
   * offers an action the server then refuses. Absent keeps the SDK rule, which
   * is what the anchor-blind callers (turn stats, message counts) want.
   */
  harness?: Harness;
}

/** Build the client-facing message list from durable timeline entries + in-flight streams. */
export function entriesToDisplayMessages(
  entries: readonly ClientTimelineEntry[],
  streaming: readonly StreamingEntry[] = [],
  cache?: DisplayProjectionCache,
  options: DisplayProjectionOptions = {},
): DisplayMessage[] {
  const messageStream = streaming.find((s) => s.kind === "message");
  const toolStreams = streaming.filter(
    (s): s is ToolStream => s.kind === "tool",
  );

  // ---------------------------------------------------------------------------
  // Pass 1 — resolve what folds into what, without building anything.
  //
  // This replays the ownership rule the single-pass version got implicitly from
  // its `toolBlocks` map: a tool call id belongs to the LAST assistant entry
  // that declared it BEFORE the result arrives. Resolving it up front is what
  // makes each message a pure function of its own inputs, and therefore
  // cacheable; the walk order is preserved exactly so the projection is
  // unchanged.
  // ---------------------------------------------------------------------------
  const declarer = new Map<string, AssistantEntry>();
  const resultsByOwner = new Map<string, ToolResultEntry[]>();
  for (const entry of entries) {
    if (entry.type === "command.result") continue;
    if (entry.role === "assistant") {
      for (const c of entry.content)
        if (c.type === "toolCall") declarer.set(c.toolCallId, entry);
    } else if (entry.role === "toolResult") {
      const owner = declarer.get(entry.toolCallId);
      if (!owner) continue;
      const list = resultsByOwner.get(owner.id);
      if (list) list.push(entry);
      else resultsByOwner.set(owner.id, [entry]);
    }
  }

  // A live tool stream updates the durable block it belongs to, UNLESS the live
  // message carries its own block for that call — then it merges there instead.
  const liveOwnToolIds = new Set<string>();
  if (messageStream?.kind === "message") {
    for (const c of messageStream.content)
      if (c.type === "toolCall") liveOwnToolIds.add(c.toolCallId);
  }
  const streamsByOwner = new Map<string, ToolStream[]>();
  for (const ts of toolStreams) {
    if (liveOwnToolIds.has(ts.toolCallId)) continue;
    const owner = declarer.get(ts.toolCallId);
    if (!owner) continue;
    const list = streamsByOwner.get(owner.id);
    if (list) list.push(ts);
    else streamsByOwner.set(owner.id, [ts]);
  }

  // ---------------------------------------------------------------------------
  // Pass 2 — project each entry, reusing an identical previous result.
  // ---------------------------------------------------------------------------
  const generation = cache ? ++cache.generation : 0;
  const out: DisplayMessage[] = [];
  // Where a "fork before this prompt" may be offered, which is a HARNESS rule.
  // Each harness cuts somewhere different, and the affordance must not outrun
  // what the server will actually accept:
  //   - The Claude SDK slices inclusively, so it cuts at the turn PRECEDING the
  //     prompt: it needs an anchor strictly EARLIER in the session, and a
  //     prompt's own anchor buys it nothing — the very first prompt of a session
  //     has nothing before it and is refused. A window that opens
  //     mid-conversation may not see the earlier anchor; hiding the action until
  //     "load earlier" brings it in is the safe direction.
  //   - pi branches FROM the selected entry and walks to its parent itself, so
  //     ONLY the prompt's own anchor permits it — which is exactly how it forks
  //     before the first prompt of a session, and why an earlier anchor must not
  //     stand in for a prompt whose own native id was never recovered.
  const forkBeforeNeedsOwnAnchor = options.harness === "pi";
  let anchorSeen = false;

  const project = (
    id: string,
    deps: readonly unknown[],
    build: () => DisplayMessage,
  ): DisplayMessage => {
    if (!cache) return build();
    const hit = cache.messages.get(id);
    if (hit && sameDeps(hit.deps, deps)) {
      hit.generation = generation;
      return hit.message;
    }
    const message = build();
    cache.messages.set(id, { deps, message, generation });
    return message;
  };

  for (const entry of entries) {
    if (entry.type === "command.result") {
      // A host-command card (/commit, /compact) — render as a standalone
      // assistant message keyed by the timeline entry id. Synthetic turn ids can
      // repeat after a server reload, but durable timeline entry ids are unique
      // within the session; transient live cards also use unique synthetic entry
      // ids and are replaced by the durable card when it arrives.
      //
      // `hostCommandBlock` can return `undefined` for a card KIND this build no
      // longer recognizes (a persisted record predating a union shrinking, e.g.
      // the superseded stage-1 `pullRequest` terminal card) — that legacy
      // message is dropped rather than rendered as a block-less crash.
      const block = hostCommandBlock(entry.card);
      if (!block) continue;
      out.push(
        project(entry.id, [entry], () => ({
          id: entry.id,
          role: "assistant",
          blocks: [block],
          createdAt: entry.createdAt,
          ...(entry.inheritedFrom
            ? { inheritedFrom: entry.inheritedFrom }
            : {}),
        })),
      );
    } else if (entry.role === "user") {
      const forkable = forkBeforeNeedsOwnAnchor
        ? entry.forkable === true
        : anchorSeen;
      if (entry.forkable) anchorSeen = true;
      if (entry.hidden) continue;
      out.push(
        project(entry.id, [entry, forkable], () => {
          // A delivered peer prompt renders as a sanitized card, never the raw
          // delivery envelope content (no ids/reply syntax in the transcript).
          const blocks = entry.peerPrompt
            ? [{ kind: "peerPrompt" as const, peerPrompt: entry.peerPrompt }]
            : userBlocks(entry.content);
          return {
            id: entry.id,
            role: "user",
            blocks,
            promptOrigin: entry.origin,
            ...(entry.delivery ? { promptDelivery: entry.delivery } : {}),
            createdAt: entry.createdAt,
            // Fork anchors travel as OUR entry id, never a native one: the
            // server resolves it to the harness's own anchor at fork time.
            ...(forkable ? { forkBeforeEntryId: entry.id } : {}),
            ...(entry.inheritedFrom
              ? { inheritedFrom: entry.inheritedFrom }
              : {}),
          };
        }),
      );
    } else if (entry.role === "assistant") {
      if (entry.forkable) anchorSeen = true;
      const results = resultsByOwner.get(entry.id);
      const streams = streamsByOwner.get(entry.id);
      const deps: unknown[] = [entry];
      if (results) deps.push(...results);
      if (streams) deps.push(...streams);
      out.push(
        project(entry.id, deps, () =>
          projectAssistantEntry(entry, results, streams),
        ),
      );
    }
    // toolResult entries render only through their owning assistant message.
  }

  if (cache) {
    for (const [id, held] of cache.messages)
      if (held.generation !== generation) cache.messages.delete(id);
  }

  // ---------------------------------------------------------------------------
  // In-flight overlay: the trailing streaming message. Never cached — it is the
  // one thing that genuinely changes on every frame.
  //
  // Its content carries text/thinking AND `toolCall` blocks in their true
  // arrival order, so a tool call that precedes later text renders ABOVE it
  // (matching the durable entry) instead of being pushed to the end. A tool with
  // no block here and no durable owner is appended as a fallback.
  // ---------------------------------------------------------------------------
  if (messageStream || toolStreams.length > 0) {
    const blocks =
      messageStream?.kind === "message"
        ? assistantBlocks(messageStream.content)
        : [];
    const byCallId = new Map(toolStreams.map((ts) => [ts.toolCallId, ts]));
    for (const b of blocks) {
      if (b.kind !== "tool") continue;
      const ts = byCallId.get(b.toolId);
      if (ts) applyToolStream(b, ts);
    }
    for (const ts of toolStreams) {
      // Merged into this live message's own block above, or into the durable
      // block of the entry that declared it.
      if (liveOwnToolIds.has(ts.toolCallId) || declarer.has(ts.toolCallId))
        continue;
      blocks.push({
        kind: "tool",
        toolId: ts.toolCallId,
        name: ts.name,
        args: ts.input,
        ...(ts.inputLive ? { argsLive: ts.inputLive } : {}),
        ...(ts.inputSummary ? { argsSummary: ts.inputSummary } : {}),
        output: ts.output ?? "",
        ...(ts.outputLive ? { outputLive: ts.outputLive } : {}),
        isError: ts.isError ?? false,
        done: ts.done ?? false,
      });
    }
    if (messageStream || blocks.length > 0)
      out.push({ id: "live", role: "assistant", blocks, streaming: true });
  }

  return out;
}

/**
 * `entriesToDisplayMessages(entries).length` without projecting anything. Each
 * entry decides on its own whether it becomes a message (tool results only
 * fold), so the count is additive over any split of a timeline: a caller that
 * only appends can count the new tail and add it to what it already had.
 */
export function displayMessageCount(
  entries: readonly ClientTimelineEntry[],
): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.type === "command.result") {
      if (hostCommandBlock(entry.card)) count++;
    } else if (entry.role === "assistant") count++;
    else if (entry.role === "user" && !entry.hidden) count++;
  }
  return count;
}

/**
 * One assistant entry plus everything folded into it. Pure: the same inputs
 * always give the same output, which is what lets the cache hand back the
 * previous object instead of an equal one.
 */
function projectAssistantEntry(
  entry: AssistantEntry,
  results: readonly ToolResultEntry[] | undefined,
  streams: readonly ToolStream[] | undefined,
): DisplayMessage {
  const blocks = assistantBlocks(entry.content);
  const message: DisplayMessage = {
    id: entry.id,
    role: "assistant",
    blocks,
    ...(entry.origin ? { promptOrigin: entry.origin } : {}),
    createdAt: entry.createdAt,
    // See the user projection: our entry id is the wire anchor for forking, and
    // only a turn bound to a native message can be branched at.
    ...(entry.forkable ? { forkAtEntryId: entry.id } : {}),
    ...(entry.inheritedFrom ? { inheritedFrom: entry.inheritedFrom } : {}),
    ...(entry.stopReason ? { stopReason: entry.stopReason } : {}),
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.usage ? { usage: entry.usage } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
    ...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
  };
  const byToolId = new Map<string, Extract<DisplayBlock, { kind: "tool" }>>();
  for (const b of blocks) if (b.kind === "tool") byToolId.set(b.toolId, b);

  for (const result of results ?? []) {
    const block = byToolId.get(result.toolCallId);
    if (!block) continue;
    block.output = textOf(result.content);
    const lazy = lazyTextRef(result.content);
    if (lazy) block.outputLazy = lazy;
    block.isError = result.isError ?? false;
    if (result.resultDiff !== undefined) block.resultDiff = result.resultDiff;
    block.done = true;
    message.streaming = false;
  }

  // Live status wins over the durable result: during the assistantEnd →
  // toolResult handoff a durable entry can coexist with a still-open stream, and
  // that stream is the current truth for the spinner.
  for (const ts of streams ?? []) {
    const block = byToolId.get(ts.toolCallId);
    if (!block) continue;
    applyToolStream(block, ts);
    message.streaming = true;
  }

  return message;
}

/**
 * Fold a live tool stream into the block that declared its call. Output and
 * status are the stream's. So is the INPUT when the stream carries it whole
 * while the block only has a summary: the transport keeps a completed
 * input-reading card's exact arguments on the tool stream (the declaring
 * message stream was summarized when the call opened), and a viewer that
 * hydrated the input through a subscription holds it on the stream too. Either
 * way the block's summary and live ref are stale, so the whole input replaces
 * them — the same handoff the live `toolEnded` event makes, now on reconnect.
 */
function applyToolStream(
  block: Extract<DisplayBlock, { kind: "tool" }>,
  stream: Extract<StreamingEntry, { kind: "tool" }>,
): void {
  block.output = stream.output ?? "";
  if (stream.outputLive) block.outputLive = stream.outputLive;
  else delete block.outputLive;
  if (block.argsLive && !stream.inputLive) {
    block.args = stream.input;
    delete block.argsLive;
    delete block.argsSummary;
  }
  block.isError = stream.isError ?? false;
  block.done = stream.done ?? false;
}

/**
 * `undefined` for a card KIND this build no longer recognizes. The switch is
 * exhaustive over the CURRENT `HostCommandCard` union, but a real persisted
 * record can predate that union shrinking (a disk-only `card.kind` string is
 * not bound by today's type), so this must stay a runtime `default`, not an
 * assumed-exhaustive switch — the caller drops the message rather than
 * rendering a block-less crash.
 */
function hostCommandBlock(card: HostCommandCard): DisplayBlock | undefined {
  switch (card.kind) {
    case "commit":
      return { kind: "commit", commit: card.commit };
    case "push":
      return { kind: "push", push: card.push };
    case "compaction":
      return { kind: "compaction", compaction: card.compaction };
    case "contextClear":
      return { kind: "contextClear", contextClear: card.contextClear };
    case "worktreeProvision":
      return { kind: "worktreeProvision", provision: card.provision };
    default:
      return undefined;
  }
}

function userBlocks(content: readonly AgentContentBlock[]): DisplayBlock[] {
  const out: DisplayBlock[] = [];
  for (const c of content) {
    if (c.type === "text") out.push({ kind: "text", text: c.text });
    else if (c.type === "image") {
      // The durable log holds a reference only (no bytes), so render an attachment
      // CHIP (name/type/size). Inline image preview is served separately.
      out.push({
        kind: "attachment",
        attachment: {
          id: c.ref ?? c.name ?? "attachment",
          name: c.name ?? "attachment",
          mimeType: c.mimeType,
          size: c.size ?? 0,
          ...(c.role ? { role: c.role } : {}),
        },
      });
    }
  }
  return out;
}

function assistantBlocks(
  content: readonly AgentContentBlock[],
): DisplayBlock[] {
  const out: DisplayBlock[] = [];
  for (const c of content) {
    if (c.type === "text") out.push({ kind: "text", text: c.text });
    else if (c.type === "thinking")
      out.push({
        kind: "thinking",
        text: c.text,
        ...(c.lazy ? { lazy: c.lazy } : {}),
        ...(c.live ? { live: c.live } : {}),
      });
    else if (c.type === "toolCall")
      out.push({
        kind: "tool",
        toolId: c.toolCallId,
        name: c.name,
        args: c.input,
        ...(c.inputLazy ? { argsLazy: c.inputLazy } : {}),
        ...(c.inputLive ? { argsLive: c.inputLive } : {}),
        ...(c.inputSummary ? { argsSummary: c.inputSummary } : {}),
        output: "",
        isError: false,
        done: false,
      });
  }
  return out;
}

function lazyTextRef(content: readonly AgentContentBlock[]) {
  return content.find(
    (
      c,
    ): c is Extract<AgentContentBlock, { type: "text" }> & {
      lazy: NonNullable<Extract<AgentContentBlock, { type: "text" }>["lazy"]>;
    } => c.type === "text" && c.lazy !== undefined,
  )?.lazy;
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
