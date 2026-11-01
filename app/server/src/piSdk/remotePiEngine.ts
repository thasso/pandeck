/**
 * The production {@link PiEngineHandle}: a pi engine hosted by the session's
 * Worker (`piSdk/piEngineHosted.ts`), driven over the engine methods
 * (`docs/workers.md`). In phase 1 that Worker is the in-process one.
 *
 * Every synchronous read answers from a mirror the engine's items keep: its
 * state, and its transcript as entries, an id index, the leaf and the
 * header. Each item is applied before listeners see it, so a listener reads
 * the engine as of that event. Every command is an `engine.command`, settled
 * only once the items before its answer are applied, so a read after
 * awaiting one sees its effect. `markToolUsed` is sent without waiting, in
 * order before any later command.
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentType } from "@assistant/shared";
import { setImmediate } from "node:timers";
import type { EngineItem } from "../workerProtocol/engineMethods.ts";
import {
  openEngineChannel,
  type EngineChannel,
  type EngineSink,
} from "../workers/engineClient.ts";
import { ensureInProcessWorker } from "../workers/inProcessWorker.ts";
import {
  linkRemotePiEngine,
  type PiEngineHandle,
  type PiTranscriptView,
} from "./piEngine.ts";
import {
  hostedPiEngine,
  refreshHostedPiEngine,
  type PiHostedItem,
  type PiHostedSnapshot,
  type PiHostedState,
  type PiHostedTranscriptChange,
  type PiTranscriptEntry,
} from "./piEngineHosted.ts";
import type { PiEngineOpened, PiEngineOpenSpec } from "./piEngineHost.ts";
import { piToolExposureOf, piToolLoadingOf } from "./toolActivation.ts";

type RunDisposition = "steered" | "started";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The engine's transcript as its items rebuilt it. */
class TranscriptMirror {
  private header: PiHostedSnapshot["header"];
  private entries: PiTranscriptEntry[];
  private readonly byId = new Map<string, PiTranscriptEntry>();
  private leafId: string | null;

  constructor(snapshot: PiHostedSnapshot) {
    this.header = snapshot.header;
    this.entries = [];
    this.leafId = snapshot.leafId;
    this.append(snapshot.entries);
  }

  private append(entries: PiTranscriptEntry[]): void {
    for (const entry of entries) {
      this.entries.push(entry);
      this.byId.set(entry.id, entry);
    }
  }

  apply(change: PiHostedTranscriptChange): void {
    if (change.reset) {
      this.header = change.header ?? null;
      this.entries = [];
      this.byId.clear();
    }
    this.append(change.entries ?? []);
    if ("leafId" in change) this.leafId = change.leafId ?? null;
  }

  view(sessionId: () => string): PiTranscriptView {
    return {
      getSessionId: sessionId,
      getHeader: () => this.header,
      getEntries: () => [...this.entries],
      getEntry: (id) => this.byId.get(id),
      // As pi's own SessionManager walks it: parents from the leaf.
      getBranch: () => {
        const path: PiTranscriptEntry[] = [];
        let current =
          this.leafId !== null ? this.byId.get(this.leafId) : undefined;
        while (current) {
          path.push(current);
          current = current.parentId
            ? this.byId.get(current.parentId)
            : undefined;
        }
        return path.reverse();
      },
      getLeafId: () => this.leafId,
    };
  }
}

/** Lets a run's consumers react to its disposition before its events. */
const yieldToRunConsumers = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

function remotePiEngine(
  kind: AgentType,
  snapshot: PiHostedSnapshot,
  channel: EngineChannel,
  onLost: (engine: PiEngineHandle) => void,
): { engine: PiEngineHandle; sink: EngineSink } {
  let state: PiHostedState = snapshot.state;
  const definitionChars = snapshot.toolDefinitionChars ?? {};
  const transcript = new TranscriptMirror(snapshot);
  const transcriptView = transcript.view(() => state.sessionId);
  const listeners: Array<(event: AgentSessionEvent) => void> = [];
  const dispositions = new Map<number, Deferred<RunDisposition>>();
  /** The test seam's refreshes awaiting their item. */
  const refreshes = new Map<number, Deferred<void>>();
  let nextCommandId = 1;
  let nextRefresh = 1;
  let released = false;

  const command = <T>(name: string, args: unknown[] = []): Promise<T> =>
    channel.command(nextCommandId++, name, args) as Promise<T>;

  /** A submit or continuation: its disposition item, then its answer. */
  const run = (name: string, args: unknown[]) => {
    const commandId = nextCommandId++;
    const disposition = deferred<RunDisposition>();
    dispositions.set(commandId, disposition);
    const settled = channel.command(commandId, name, args).then(
      () => {
        dispositions.delete(commandId);
        disposition.reject(
          new Error(`The engine answered ${name} without a disposition.`),
        );
      },
      (err: unknown) => {
        dispositions.delete(commandId);
        disposition.reject(err);
        throw err;
      },
    );
    disposition.promise.catch(() => {});
    settled.catch(() => {});
    return { disposition: disposition.promise, settled };
  };

  const sink: EngineSink = {
    apply(entry: EngineItem): void | Promise<void> {
      const item = entry as unknown as PiHostedItem;
      if (item.kind === "disposition") {
        const waiting = dispositions.get(item.commandId);
        dispositions.delete(item.commandId);
        waiting?.resolve(item.disposition);
        return yieldToRunConsumers();
      }
      if (item.state) state = item.state;
      if (item.transcript) transcript.apply(item.transcript);
      if (item.kind !== "event") {
        if (item.refresh !== undefined) {
          refreshes.get(item.refresh)?.resolve();
          refreshes.delete(item.refresh);
        }
        return undefined;
      }
      for (const listener of [...listeners])
        try {
          listener(item.event);
        } catch (err) {
          // One listener's failure must not cost the others, or later items.
          console.error("[pi] engine event listener failed:", err);
        }
      return undefined;
    },
    onLost() {
      released = true;
      for (const waiting of dispositions.values())
        waiting.reject(new Error("The pi engine's Worker connection ended."));
      dispositions.clear();
      for (const waiting of refreshes.values())
        waiting.reject(new Error("The pi engine's Worker connection ended."));
      refreshes.clear();
      onLost(engine);
    },
  };

  const engine: PiEngineHandle = {
    get sessionId() {
      return state.sessionId;
    },
    get sessionFile() {
      return state.sessionFile;
    },
    get isStreaming() {
      return state.isStreaming;
    },
    get sessionName() {
      return state.sessionName;
    },
    get model() {
      return state.model;
    },
    get thinkingLevel() {
      return state.thinkingLevel;
    },
    stats: () => state.stats,
    contextMessageCount: () => state.contextMessageCount,
    skills: () => state.skills,
    transcript: transcriptView,
    compactionWindowStatus: () => state.compactionWindowStatus,
    toolSessionManager: () => ({
      getSessionId: () => transcriptView.getSessionId(),
      getBranch: () => transcriptView.getBranch(),
      getEntry: (id) => transcriptView.getEntry(id),
      appendCustomEntry: (type, data) =>
        command<string>("appendCustomEntry", [type, data]),
    }),
    toolLoading: () =>
      state.tools && piToolLoadingOf(state.tools, definitionChars),
    toolExposure: () =>
      state.tools && piToolExposureOf(kind, state.tools, definitionChars),

    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },

    submit: (text, images, intent) => run("submit", [text, images, intent]),
    continueFailedTurn: (context) => run("continueFailedTurn", [context]),
    dropEncryptedReasoning: () => command("dropEncryptedReasoning"),
    abort: () => command("abort"),
    compact: (instructions) =>
      command("compact", instructions === undefined ? [] : [instructions]),
    clearContext: () => command("clearContext"),
    setModel: (model) =>
      command("setModel", [{ provider: model.provider, id: model.id }]),
    setThinkingLevel: (level) => command("setThinkingLevel", [level]),
    setSessionName: (name) => command("setSessionName", [name]),
    applyCompactionWindow: (tokens) =>
      command("applyCompactionWindow", [tokens]),
    lowerCompactionWindow: (tokens) =>
      command("lowerCompactionWindow", [tokens]),
    restoreCompactionWindow: (previous, reason) =>
      command("restoreCompactionWindow", [previous, reason]),
    setIntegrationGates: (gates) => command("setIntegrationGates", [gates]),
    setToolMode: (mode) => command("setToolMode", [mode]),
    commitStaged: (options) => command("commitStaged", [options]),
    markToolUsed(name) {
      command("markToolUsed", [name]).catch((err: unknown) => {
        if (!released)
          console.warn(`[pi] marking ${name} as used failed:`, err);
      });
    },
    async discard(options) {
      released = true;
      await channel.dispose(options);
    },
    async dispose() {
      released = true;
      await channel.dispose();
    },
  };
  linkRemotePiEngine(engine, {
    local: () => hostedPiEngine(channel.engineId),
    // Test seam only (`syncPiEngineMirrorForTests`): resolves once the
    // refresh item, ordered after every earlier item, is applied.
    refresh() {
      const token = nextRefresh++;
      const waiting = deferred<void>();
      refreshes.set(token, waiting);
      if (!refreshHostedPiEngine(channel.engineId, token)) {
        refreshes.delete(token);
        waiting.reject(new Error("The pi engine is no longer hosted."));
      }
      return waiting.promise;
    },
  });
  return { engine, sink };
}

/**
 * Open `spec`'s engine on the in-process Worker. `onLost` runs once if the
 * Worker connection ends while the engine is open.
 */
export async function openRemotePiEngine(
  spec: PiEngineOpenSpec,
  onLost: (engine: PiEngineHandle) => void,
): Promise<PiEngineOpened> {
  const { info, value: engine } = await openEngineChannel(
    ensureInProcessWorker(),
    "pi",
    spec,
    ({ snapshot }, channel) => {
      const remote = remotePiEngine(
        spec.kind,
        snapshot as PiHostedSnapshot,
        channel,
        onLost,
      );
      return { sink: remote.sink, value: remote.engine };
    },
  );
  return { engine, info: info as PiEngineOpened["info"] };
}
