/**
 * Runtime → wire gateway. Bridges a live runtime session to a connection's
 * {@link Viewer}: on attach it does the race-safe subscribe-then-snapshot and
 * sends the atomic `snapshot` (state + runtime timeline + context), then
 * projects every subsequent {@link RuntimeEvent} onto the viewer's
 * {@link ClientRuntimeEvent} vocabulary. The client reducer uses this single
 * path for optimistic reconciliation and reconnect snapshots.
 *
 * The projection is where verbose bodies leave the wire. The runtime keeps
 * every thinking block, tool input and tool output whole; a viewer receives
 * compact refs (`LiveBodyRef`) for them and the text of only those bodies it
 * has SUBSCRIBED to — the set of blocks it is actually rendering expanded and
 * near its viewport (`setLiveBodySubscriptions`). Subscribing registers the
 * demand first and snapshots the runtime's current body second, in one
 * synchronous step, so no delta can fall between the two; later deltas carry
 * the offset the viewer must already hold. Durable rows travel as
 * `timelineDelta`, projected by the same lazy policy as a reconnect snapshot.
 *
 * SessionState + ContextInfo are supplied by the caller (the connection knows the
 * harness/agentType/title/model metadata), keeping this module decoupled from the
 * registry. App-level broadcasts (settings/tasks/projects/…) are
 * orthogonal and untouched — they keep flowing on their own channels.
 *
 * This is the render path for every viewed session.
 */
import type {
  ContextInfo,
  ServerMessage,
  SessionState,
  TimelineCacheDescriptor,
} from "@assistant/shared";
import type {
  AgentContentBlock,
  LiveBodyKey,
  LiveBodyRef,
  StreamingEntry,
  StreamingMessageEntry,
  StreamingToolEntry,
} from "@assistant/shared/session";
import { liveBodyKeyId } from "@assistant/shared/session";
import {
  describeTimelineRange,
  timelineMatchesCacheDescriptor,
  timelineRangeIsRenderable,
  timelineWindowStart,
  type ClientRuntimeEvent,
} from "@assistant/shared/runtime";
import {
  toolCardReadsInput,
  toolCardReadsOutput,
} from "@assistant/shared/toolCards";
import { turnStatsSeedForWindow } from "@assistant/shared/turnStats";
import type { LiveRuntimeSession } from "../runtime/liveSession.ts";
import type { RuntimeEvent } from "../runtime/events.ts";
import {
  compactToolInput,
  completedToolCardOf,
  shouldKeepFullToolInput,
} from "../log/timelinePayloadPolicy.ts";

const MESSAGE_DELTA_BATCH_MS = 50;

export interface RuntimeViewer {
  send(message: ServerMessage): void;
}

export interface RuntimeTransportDeps {
  /** Build the full SessionState metadata shell (harness/agentType/title/model/…). */
  buildState: () => SessionState;
  /** Build the ContextInfo (token usage / cost / context window). */
  buildContextInfo: () => ContextInfo;
  /** Browser-persisted timeline RANGE offered for a tail-only snapshot. */
  timelineCache?: TimelineCacheDescriptor;
}

/** A frame waiting in the batch window, with the key later frames merge into. */
interface QueuedFrame {
  key: string | undefined;
  event: ClientRuntimeEvent;
}

/**
 * What this viewer holds of one subscribed body. `sent` is kept only for tool
 * output, whose runtime updates are REPLACEMENTS ("Starting…" then the real
 * text): the next update is a delta only when it extends what was sent. A
 * thinking block only ever appends, so its length is enough.
 */
interface LiveBodySubscription {
  key: LiveBodyKey;
  sentLength: number;
  sent?: string;
}

function countLines(text: string): number {
  let lines = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1))
    lines += 1;
  return lines;
}

function bodyRef(
  key: LiveBodyKey,
  length: number,
  lineCount?: number,
): LiveBodyRef {
  return {
    ...key,
    length,
    ...(lineCount !== undefined ? { lineCount } : {}),
  };
}

function jsonLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

export class RuntimeTransport {
  private unsubscribe: (() => void) | undefined;
  private queue: QueuedFrame[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Per-thinking-body line counters, kept incrementally (a full recount per
   * delta is quadratic), keyed by the MESSAGE stream that owns the body and
   * then its block index. Stream ids are opaque and a tool call's id is the
   * provider's, so ownership is structural — a counter is dropped with its own
   * message stream and by nothing else — rather than read back out of a
   * serialized key.
   */
  private readonly thinkingLines = new Map<string, Map<number, number>>();
  private readonly subscriptions = new Map<string, LiveBodySubscription>();

  constructor(
    private readonly sessionId: string,
    private readonly session: LiveRuntimeSession,
    private readonly viewer: RuntimeViewer,
    private readonly deps: RuntimeTransportDeps,
  ) {}

  /** Subscribe THEN snapshot (race-safe), and send the atomic native snapshot. */
  attach(): void {
    // Subscribe first so no event fires in the gap before the snapshot.
    this.unsubscribe = this.session.subscribe((event) => this.relay(event));
    const snap = this.session.getSnapshot();
    // The chat-load payload is lazily projected once, then sent either as the
    // append-only tail after a browser-persisted range, or — with no usable
    // anchor — as a WINDOW of the most recent entries. A long session is
    // megabytes of timeline, and the reader arrives at its live tail; the rest is
    // fetched backwards on demand (`loadTimelineRange`). A stale/malformed anchor
    // simply falls back to that window, preserving snapshot authority.
    const requestedCache = this.deps.timelineCache;
    // Projected with bodies only where they are used: the tail the reader gets,
    // plus the range the browser claims to hold (which has to be fingerprinted
    // before a delta can answer it). Everything earlier is present, counted and
    // summed, but carries no blocks — see `SessionLog.clientTimelineForSnapshot`.
    let projected = this.session.clientTimelineForSnapshot(
      requestedCache?.startIndex,
    );
    let fullTimeline = projected.timeline;
    // An EMPTY descriptor is the client's "my local copy is gone" signal, not a
    // cache hit: it must fall through to the window like any other miss.
    //
    // A MATCHING range is not enough either: the renderability floor applies to
    // an accepted anchor exactly as it does to the budget walk (Task 450). A
    // browser that cached an unrenderable range — all orphan tool results, e.g.
    // one persisted by a build predating the floor — would otherwise be answered
    // with the tail delta after it (usually nothing) and render an empty
    // transcript forever, re-saving the same poisoned record on every open. The
    // range cannot be extended here (the client holds only those entries), so
    // the anchor is DROPPED and the window answers instead.
    const base =
      requestedCache &&
      requestedCache.entryCount > 0 &&
      timelineMatchesCacheDescriptor(fullTimeline, requestedCache) &&
      timelineRangeIsRenderable(
        fullTimeline,
        requestedCache.startIndex,
        fullTimeline.length,
      )
        ? requestedCache
        : undefined;
    // Where the browser will RENDER from once it prepends its cached range.
    let renderStart = base
      ? base.startIndex
      : timelineWindowStart(fullTimeline);
    // The renderability floor finds the entry that DECLARED the window's orphan
    // tool results by reading its `toolCall` blocks — so a tool loop longer than
    // the bodied tail hides that entry from it, and the walk gives up on a
    // window that renders nothing. Checking where the walk landed cannot catch
    // that (it never lands on a bodyless row; it fails to move at all), so what
    // is checked is the OUTCOME. Re-projecting in FULL, not from `renderStart`:
    // the declarer can be arbitrarily far back, which is the whole case.
    if (
      projected.contentFromRow > 0 &&
      !timelineRangeIsRenderable(fullTimeline, renderStart, fullTimeline.length)
    ) {
      projected = this.session.clientTimelineForSnapshot(0);
      fullTimeline = projected.timeline;
      renderStart = base ? base.startIndex : timelineWindowStart(fullTimeline);
    }
    const sendStart = base ? base.startIndex + base.entryCount : renderStart;
    // What precedes the rendered range — including whether the cut landed inside
    // a turn, which the renderer needs to suppress that turn's stats row.
    const seed = turnStatsSeedForWindow(fullTimeline, renderStart);
    this.viewer.send({
      type: "snapshot",
      state: this.buildMetadataState(),
      snapshot: {
        sessionId: this.sessionId,
        runState: snap.runState,
        timeline: fullTimeline.slice(sendStart),
        timelineStart: sendStart,
        totalEntryCount: fullTimeline.length,
        ...(base ? { timelineBase: base } : {}),
        timelineCache:
          base && sendStart === fullTimeline.length
            ? base
            : describeTimelineRange(fullTimeline, renderStart),
        ...(seed ? { turnStatsSeed: seed } : {}),
        streaming: snap.streaming.map((stream) => this.projectStream(stream)),
      },
      contextInfo: this.deps.buildContextInfo(),
    });
  }

  detach(): void {
    this.flush();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.subscriptions.clear();
    this.thinkingLines.clear();
  }

  /**
   * Replace this viewer's live-body demand. Bodies newly listed get a `replace`
   * snapshot of what the runtime holds RIGHT NOW, recorded as sent before the
   * next runtime event can be relayed, so the deltas that follow join it
   * exactly; bodies no longer listed simply stop. A key naming no live body
   * (a stream that already became durable, a foreign session's id) is ignored.
   */
  setLiveBodySubscriptions(keys: readonly LiveBodyKey[]): void {
    // Anything queued was projected under the OLD demand; it goes first so the
    // snapshot below is what the viewer applies last.
    this.flush();
    const wanted = new Map(keys.map((key) => [liveBodyKeyId(key), key]));
    for (const id of [...this.subscriptions.keys()])
      if (!wanted.has(id)) this.subscriptions.delete(id);
    for (const [id, key] of wanted) {
      if (this.subscriptions.has(id)) continue;
      const body = this.currentBody(key);
      if (body === undefined) continue;
      const subscription: LiveBodySubscription = {
        key,
        sentLength: body.length,
        ...(key.kind === "toolOutput" && typeof body.content === "string"
          ? { sent: body.content }
          : {}),
      };
      this.subscriptions.set(id, subscription);
      this.viewer.send({
        type: "event",
        sessionId: this.sessionId,
        event: {
          type: "liveBody",
          key,
          mode: "replace",
          offset: 0,
          content: body.content,
          length: body.length,
          ...(body.lineCount !== undefined
            ? { lineCount: body.lineCount }
            : {}),
        },
      });
    }
  }

  /** What the runtime currently holds for a body, or undefined when there is none. */
  private currentBody(
    key: LiveBodyKey,
  ): { content: unknown; length: number; lineCount?: number } | undefined {
    const stream =
      this.session.liveStream(key.streamId) ??
      // A call's input is keyed by its call id (`projectToolCall`); the tool
      // stream shares that id on every adapter, but resolve it by call id too.
      this.session
        .streamingEntries()
        .find((s) => s.kind === "tool" && s.toolCallId === key.streamId);
    if (!stream) return undefined;
    if (key.kind === "thinking") {
      if (stream.kind !== "message") return undefined;
      const block = stream.content[key.blockIndex];
      if (block?.type !== "thinking") return undefined;
      return {
        content: block.text,
        length: block.text.length,
        lineCount: countLines(block.text),
      };
    }
    if (stream.kind !== "tool" || key.blockIndex !== 0) return undefined;
    if (key.kind === "toolInput")
      return { content: stream.input, length: jsonLength(stream.input) };
    const output = stream.output ?? "";
    return { content: output, length: output.length };
  }

  /* ------------------------------ projection ----------------------------- */

  /** The compact wire form of an in-flight stream: refs in place of bodies. */
  private projectStream(stream: StreamingEntry): StreamingEntry {
    if (stream.kind === "message") return this.projectMessageStream(stream);
    return this.projectToolStream(stream);
  }

  private projectMessageStream(
    stream: StreamingMessageEntry,
  ): StreamingMessageEntry {
    const content = stream.content.map((block, blockIndex) => {
      if (block.type === "thinking") {
        const key: LiveBodyKey = {
          streamId: stream.streamId,
          blockIndex,
          kind: "thinking",
        };
        const lines = countLines(block.text);
        this.setThinkingLines(key, lines);
        return {
          type: "thinking" as const,
          text: "",
          live: bodyRef(key, block.text.length, lines),
        };
      }
      if (block.type === "toolCall") return this.projectToolCall(block);
      return block;
    });
    return { ...stream, content };
  }

  private projectToolCall(
    block: Extract<AgentContentBlock, { type: "toolCall" }>,
  ): AgentContentBlock {
    const compact = compactToolInput(
      block.name,
      block.input,
      shouldKeepFullToolInput(block.name, block.input),
    );
    if (compact.fullBytes === undefined) return block;
    return {
      ...block,
      input: compact.input,
      ...(compact.inputSummary !== undefined
        ? { inputSummary: compact.inputSummary }
        : {}),
      inputLive: bodyRef(
        // The tool stream carries the same id as its call on every adapter
        // (`nativeEvents.ts`), and the input is subscribed through the stream.
        { streamId: block.toolCallId, blockIndex: 0, kind: "toolInput" },
        compact.fullBytes,
      ),
    };
  }

  private projectToolStream(stream: StreamingToolEntry): StreamingToolEntry {
    const {
      inputLive: _inputLive,
      inputSummary: _inputSummary,
      output: _output,
      outputLive: _outputLive,
      ...rest
    } = stream;
    const output = stream.output ?? "";
    const card = stream.done
      ? completedToolCardOf(
          stream.name,
          stream.input,
          output,
          stream.isError ?? false,
        )
      : null;
    const keepInput = card !== null && toolCardReadsInput(card);
    const compact = compactToolInput(
      stream.name,
      stream.input,
      shouldKeepFullToolInput(stream.name, stream.input),
    );
    return {
      ...rest,
      input: keepInput ? stream.input : compact.input,
      ...(compact.inputSummary !== undefined && !keepInput
        ? { inputSummary: compact.inputSummary }
        : {}),
      ...(card === null && compact.fullBytes !== undefined
        ? {
            inputLive: bodyRef(
              { streamId: stream.streamId, blockIndex: 0, kind: "toolInput" },
              compact.fullBytes,
            ),
          }
        : {}),
      output: card !== null && toolCardReadsOutput(card) ? output : "",
      ...(card === null
        ? {
            outputLive: bodyRef(
              { streamId: stream.streamId, blockIndex: 0, kind: "toolOutput" },
              output.length,
              stream.done ? countLines(output) : undefined,
            ),
          }
        : {}),
    };
  }

  /* -------------------------------- relay -------------------------------- */

  private relay(event: RuntimeEvent): void {
    switch (event.type) {
      case "messageDelta":
        this.relayMessageDelta(event);
        return;
      case "toolStarted": {
        this.flush();
        const compact = compactToolInput(
          event.name,
          event.input,
          shouldKeepFullToolInput(event.name, event.input),
        );
        this.sendEvent({
          type: "toolStarted",
          streamId: event.streamId,
          toolCallId: event.toolCallId,
          name: event.name,
          input: compact.input,
          ...(compact.inputSummary !== undefined
            ? { inputSummary: compact.inputSummary }
            : {}),
          ...(compact.fullBytes !== undefined
            ? {
                inputLive: bodyRef(
                  {
                    streamId: event.streamId,
                    blockIndex: 0,
                    kind: "toolInput",
                  },
                  compact.fullBytes,
                ),
              }
            : {}),
        });
        return;
      }
      case "toolUpdated":
        this.relayToolOutput(event.streamId, event.output, false);
        return;
      case "passthrough":
        if (event.envelope.type === "toolEnd") {
          // The runtime mirrored this completion into the tool stream already
          // (`liveSession.ts`), so the body below is its final output.
          const { toolId, output, isError } = event.envelope;
          const stream = this.session.liveStream(toolId);
          const card =
            stream?.kind === "tool"
              ? completedToolCardOf(stream.name, stream.input, output, isError)
              : null;
          // A card completion below is authoritative and already carries every
          // output byte the card reads. Do not send the same final body first.
          if (card === null) this.relayToolOutput(toolId, output, true);
          this.flush();
          this.sendEvent({
            type: "toolEnded",
            streamId: toolId,
            isError,
            output:
              card !== null && toolCardReadsOutput(card)
                ? output
                : bodyRef(
                    {
                      streamId: toolId,
                      blockIndex: 0,
                      kind: "toolOutput",
                    },
                    output.length,
                    countLines(output),
                  ),
            ...(card !== null ? { card: true } : {}),
            ...(card !== null && toolCardReadsInput(card)
              ? { input: stream?.kind === "tool" ? stream.input : undefined }
              : {}),
          });
          return;
        }
        this.flush();
        this.sendEvent({ type: "passthrough", envelope: event.envelope });
        return;
      case "entryAppended": {
        // Preserve event ordering: any terminal/non-delta event must see all
        // prior text/thinking first, even if the batch window has not elapsed.
        this.flush();
        const entries = this.session.clientTimelineDelta(event.entry.id);
        // Never put a raw runtime entry on the client wire. All current append
        // sources project at least one row; an empty projection is safer to drop
        // than to bypass the lazy-body policy.
        if (entries.length === 0) return;
        this.sendEvent({
          type: "timelineDelta",
          entries,
          ...(event.clientRequestId !== undefined
            ? { clientRequestId: event.clientRequestId }
            : {}),
        });
        return;
      }
      case "messageCompleted":
        this.flush();
        this.forgetMessageStream(event.streamId);
        this.sendEvent(event);
        return;
      case "toolCompleted":
        this.flush();
        this.forgetToolStream(event.streamId);
        this.sendEvent(event);
        return;
      case "runStateChanged":
        this.flush();
        if (event.runState === "idle") this.forgetAllStreams();
        this.sendEvent(event);
        return;
      case "runStatus":
        this.flush();
        this.forgetAllStreams();
        this.sendEvent(event);
        return;
      case "sessionConfigChanged":
        this.flush();
        this.sendEvent(event);
        // Config changes also carry full SessionState fields (model/reasoning
        // labels, title/tasks/etc.) the runtime event payload doesn't. Run-state
        // changes stay on the runtime event channel only, which keeps the
        // client's working indicator sourced from one ordered stream.
        this.viewer.send({ type: "state", state: this.buildMetadataState() });
        return;
      case "messageStarted":
      case "hostCommandAppended":
        this.flush();
        this.sendEvent(event);
        return;
    }
  }

  private relayMessageDelta(
    event: Extract<RuntimeEvent, { type: "messageDelta" }>,
  ): void {
    if (event.delta.kind === "text") {
      this.enqueue(
        {
          type: "messageDelta",
          streamId: event.streamId,
          delta: { kind: "text", text: event.delta.text },
        },
        `text:${event.streamId}`,
      );
      return;
    }
    // The runtime appended this delta to its stream before emitting it, so the
    // block it landed in is the stream's last one.
    const stream = this.session.liveStream(event.streamId);
    if (stream?.kind !== "message") return;
    const blockIndex = stream.content.length - 1;
    const block = stream.content[blockIndex];
    if (block?.type !== "thinking") return;
    const key: LiveBodyKey = {
      streamId: event.streamId,
      blockIndex,
      kind: "thinking",
    };
    const id = liveBodyKeyId(key);
    const lines =
      (this.thinkingLines.get(key.streamId)?.get(blockIndex) ?? 1) +
      countLines(event.delta.text) -
      1;
    this.setThinkingLines(key, lines);
    const subscription = this.subscriptions.get(id);
    if (!subscription) {
      this.enqueue(
        {
          type: "liveBodyProgress",
          ref: bodyRef(key, block.text.length, lines),
        },
        `progress:${id}`,
      );
      return;
    }
    const offset = subscription.sentLength;
    subscription.sentLength = block.text.length;
    this.enqueue(
      {
        type: "liveBody",
        key,
        mode: "append",
        offset,
        content: event.delta.text,
        length: block.text.length,
        lineCount: lines,
      },
      `body:${id}`,
    );
  }

  /**
   * A tool output update is the WHOLE output so far. A viewer holding the
   * previous one gets the extension when it is one, and a replacement
   * otherwise ("Starting…" giving way to real output is the common case).
   */
  private relayToolOutput(
    streamId: string,
    output: string,
    done: boolean,
  ): void {
    const key: LiveBodyKey = { streamId, blockIndex: 0, kind: "toolOutput" };
    const id = liveBodyKeyId(key);
    const subscription = this.subscriptions.get(id);
    // A subscribed viewer gets authoritative length on the body frame itself.
    // Hidden viewers still need compact progress metadata for the collapsed row.
    if (!subscription) {
      if (!done)
        this.enqueue(
          { type: "liveBodyProgress", ref: bodyRef(key, output.length) },
          `progress:${id}`,
        );
      return;
    }
    const previous = subscription.sent ?? "";
    const extended =
      output.length >= previous.length && output.startsWith(previous);
    subscription.sent = output;
    subscription.sentLength = output.length;
    if (extended && output.length === previous.length) return;
    this.enqueue(
      {
        type: "liveBody",
        key,
        mode: extended ? "append" : "replace",
        offset: extended ? previous.length : 0,
        content: extended ? output.slice(previous.length) : output,
        length: output.length,
      },
      `body:${id}`,
    );
  }

  private setThinkingLines(key: LiveBodyKey, lines: number): void {
    let blocks = this.thinkingLines.get(key.streamId);
    if (!blocks) {
      blocks = new Map();
      this.thinkingLines.set(key.streamId, blocks);
    }
    blocks.set(key.blockIndex, lines);
  }

  /** A message stream ended: its thinking bodies, counters and subscriptions go. */
  private forgetMessageStream(streamId: string): void {
    this.thinkingLines.delete(streamId);
    this.forgetSubscriptions(streamId, (kind) => kind === "thinking");
  }

  /**
   * A tool call ended: its body subscriptions go. Its id is the provider's and
   * may look like anything — including a message stream's id — so it may touch
   * nothing a message owns.
   */
  private forgetToolStream(streamId: string): void {
    this.forgetSubscriptions(streamId, (kind) => kind !== "thinking");
  }

  private forgetSubscriptions(
    streamId: string,
    owned: (kind: LiveBodyKey["kind"]) => boolean,
  ): void {
    for (const [id, subscription] of this.subscriptions)
      if (
        subscription.key.streamId === streamId &&
        owned(subscription.key.kind)
      )
        this.subscriptions.delete(id);
  }

  private forgetAllStreams(): void {
    this.subscriptions.clear();
    this.thinkingLines.clear();
  }

  /* ------------------------------- batching ------------------------------ */

  private sendEvent(event: ClientRuntimeEvent): void {
    this.viewer.send({ type: "event", sessionId: this.sessionId, event });
  }

  /**
   * Hold a hot-path frame for the batch window. Only adjacent frames with the
   * same key merge: crossing a different body would reorder runtime events.
   * Text deltas concatenate, progress keeps its latest ref, and subscribed body
   * appends join behind the first offset. Every non-batched event flushes first.
   */
  private enqueue(event: ClientRuntimeEvent, key: string): void {
    const queued = this.queue.at(-1);
    if (queued?.key === key && mergeFrames(queued.event, event)) {
      if (!this.flushTimer) this.armFlush();
      return;
    }
    this.queue.push({ key, event });
    if (!this.flushTimer) this.armFlush();
  }

  private armFlush(): void {
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, MESSAGE_DELTA_BATCH_MS);
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.queue.length === 0) return;
    const frames = this.queue;
    this.queue = [];
    for (const frame of frames) this.sendEvent(frame.event);
  }

  private buildMetadataState(): SessionState {
    return this.deps.buildState();
  }
}

/** Merge `next` into the queued `into` frame of the same key; false when the pair cannot merge. */
function mergeFrames(
  into: ClientRuntimeEvent,
  next: ClientRuntimeEvent,
): boolean {
  if (into.type === "messageDelta" && next.type === "messageDelta") {
    into.delta.text += next.delta.text;
    return true;
  }
  if (into.type === "liveBodyProgress" && next.type === "liveBodyProgress") {
    into.ref = next.ref;
    return true;
  }
  if (into.type === "liveBody" && next.type === "liveBody") {
    if (next.mode === "replace") {
      into.mode = "replace";
      into.offset = 0;
      into.content = next.content;
    } else if (
      typeof into.content === "string" &&
      typeof next.content === "string"
    ) {
      into.content += next.content;
    } else return false;
    into.length = next.length;
    if (next.lineCount !== undefined) into.lineCount = next.lineCount;
    return true;
  }
  return false;
}
