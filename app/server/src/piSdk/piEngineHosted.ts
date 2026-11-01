/**
 * The pi engine as the Worker's engine table hosts it (`docs/workers.md`):
 * {@link openPiEngine}'s local handle, served as a harness-neutral
 * `HostedEngine`. The server drives it through `piSdk/remotePiEngine.ts`.
 *
 * Items, in one order per engine:
 * - `event`: one engine event, after the engine's policy, with the state and
 *   the transcript change at its emission;
 * - `disposition`: what the engine did with a submit or a continuation,
 *   before pi's first event of it;
 * - `state`: after every command, success or failure, before its answer.
 *
 * A submit is reconciled here, on the engine's own streaming state: a
 * `steerOnly` steer on an idle engine is refused (`steer_not_taken`) and
 * reaches no pi call; any other submit steers exactly when the engine
 * streams, so a steer that found the engine idle runs as a new turn and
 * reports `"started"`.
 */
import type {
  AgentSessionEvent,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { CompactionWindowHarnessStatus } from "../harness.ts";
import { WorkerMethodError } from "../workerProtocol/connection.ts";
import type {
  EngineDiscard,
  HostedEngine,
  HostedEngineFactory,
  HostedEngineItem,
} from "../workerProtocol/engineMethods.ts";
import {
  piEngineToolMirror,
  type PiEngineHandle,
  type PiEngineModel,
  type PiTranscriptView,
} from "./piEngine.ts";
import {
  openPiEngine,
  type PiEngineOpenSpec,
  type PiModelPort,
} from "./piEngineHost.ts";
import type { PiToolState } from "./toolActivation.ts";

/** A `steerOnly` submit found the engine idle: nothing was sent to pi. */
export const STEER_NOT_TAKEN = "steer_not_taken";

type PiTranscriptHeader = ReturnType<PiTranscriptView["getHeader"]>;
export type PiTranscriptEntry = ReturnType<
  PiTranscriptView["getEntries"]
>[number];

/** Every synchronous read of the handle but the transcript. */
export interface PiHostedState {
  sessionId: string;
  sessionFile?: string;
  isStreaming: boolean;
  sessionName?: string;
  model?: PiEngineModel;
  thinkingLevel?: PiEngineHandle["thinkingLevel"];
  stats: SessionStats;
  contextMessageCount: number;
  skills: Array<{ name: string; filePath: string }>;
  compactionWindowStatus: CompactionWindowHarnessStatus;
  /** The tool activation's state; absent for an engine without app tools. */
  tools?: PiToolState;
}

/**
 * What changed in the transcript since the last item: appended entries and
 * the leaf, or, after the file was replaced, all of it (`reset`).
 */
export interface PiHostedTranscriptChange {
  reset?: true;
  header?: PiTranscriptHeader;
  entries?: PiTranscriptEntry[];
  leafId?: string | null;
}

export interface PiHostedSnapshot {
  state: PiHostedState;
  /** Every tool definition's wire size: fixed at open, so sent only here. */
  toolDefinitionChars?: Record<string, number>;
  header: PiTranscriptHeader;
  entries: PiTranscriptEntry[];
  leafId: string | null;
}

/** An item's harness fields; `state` is present only when it changed. */
export type PiHostedItem =
  | {
      kind: "event";
      event: AgentSessionEvent;
      state?: PiHostedState;
      transcript?: PiHostedTranscriptChange;
    }
  | {
      kind: "state";
      state?: PiHostedState;
      transcript?: PiHostedTranscriptChange;
      /** Set only on the item {@link refreshHostedPiEngine} emits. */
      refresh?: number;
    }
  | {
      kind: "disposition";
      commandId: number;
      disposition: "steered" | "started";
    };

type SubmitArgs = Parameters<PiEngineHandle["submit"]>;

/** The hosted engines, by engine id, for the handle's test seams. */
const hosted = new Map<
  number,
  { local: PiEngineHandle; refresh: (token: number) => void }
>();

/**
 * Serve `local` as a hosted engine. `findModel` resolves a `setModel`'s
 * model; `engineId` registers it for the test seams until it is disposed.
 */
export function hostPiEngine(
  local: PiEngineHandle,
  info: unknown,
  options: { findModel: PiModelPort["find"]; engineId?: number },
): HostedEngine {
  const { engineId } = options;
  let listener: ((item: HostedEngineItem) => void) | undefined;
  let sentState: string | undefined;
  let sentHeader: PiTranscriptHeader | undefined;
  let sentLeaf: string | null = null;
  let sentLength = 0;
  let stats: { key: string; value: SessionStats } | undefined;
  let lastModel: PiEngineModel | undefined;
  let modelEpoch = 0;
  /** A continuation whose disposition has not been emitted yet. */
  let continuing: { commandId: number } | undefined;

  const readState = (): PiHostedState => {
    const { sessionFile, sessionName, model, thinkingLevel } = local;
    if (model !== lastModel) {
      lastModel = model;
      modelEpoch += 1;
    }
    const contextMessageCount = local.contextMessageCount();
    // pi's stats walk every entry; recompute only when an input changed.
    const key = JSON.stringify([
      sentLength,
      local.transcript.getLeafId(),
      sessionFile,
      modelEpoch,
      contextMessageCount,
    ]);
    if (stats?.key !== key) stats = { key, value: local.stats() };
    const tools = piEngineToolMirror(local)?.state();
    return {
      sessionId: local.sessionId,
      ...(sessionFile !== undefined ? { sessionFile } : {}),
      isStreaming: local.isStreaming,
      ...(sessionName !== undefined ? { sessionName } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      stats: stats.value,
      contextMessageCount,
      skills: [...local.skills()],
      compactionWindowStatus: local.compactionWindowStatus(),
      ...(tools ? { tools } : {}),
    };
  };

  /** Appends are detected by the leaf, which every append moves. */
  const transcriptChange = (): PiHostedTranscriptChange | undefined => {
    const { transcript } = local;
    const header = transcript.getHeader();
    const leafId = transcript.getLeafId();
    if (header === sentHeader && leafId === sentLeaf) return undefined;
    const entries = transcript.getEntries();
    const reset = header !== sentHeader;
    const appended = reset ? entries : entries.slice(sentLength);
    sentHeader = header;
    sentLeaf = leafId;
    sentLength = entries.length;
    return reset
      ? { reset: true, header, entries: appended, leafId }
      : { ...(appended.length > 0 ? { entries: appended } : {}), leafId };
  };

  const emit = (item: PiHostedItem): void => {
    if (!listener) return;
    if (item.kind === "disposition") {
      listener(item);
      return;
    }
    const transcript = transcriptChange();
    const state = readState();
    const json = JSON.stringify(state);
    const changed = json !== sentState;
    sentState = json;
    listener({
      ...item,
      ...(changed ? { state } : {}),
      ...(transcript ? { transcript } : {}),
    });
  };

  const emitContinuation = (): void => {
    if (!continuing) return;
    const { commandId } = continuing;
    continuing = undefined;
    emit({ kind: "disposition", commandId, disposition: "started" });
  };

  const unsubscribe = local.subscribe((event) => {
    // A continuation's first event proves its transcript write succeeded.
    emitContinuation();
    emit({ kind: "event", event });
  });

  const run = (name: string, args: unknown[], commandId: number) => {
    switch (name) {
      case "submit": {
        const [text, images, intent] = args as SubmitArgs;
        if (intent.steerOnly && !local.isStreaming)
          throw new WorkerMethodError(
            STEER_NOT_TAKEN,
            "The engine is idle, so it took no steer.",
          );
        const steer = local.isStreaming;
        emit({
          kind: "disposition",
          commandId,
          disposition: steer ? "steered" : "started",
        });
        return local.submit(text, images, { ...intent, steer }).settled;
      }
      case "continueFailedTurn": {
        const pending = { commandId };
        continuing = pending;
        const continued = local.continueFailedTurn(args[0] as string);
        void continued.disposition.then(
          () => {
            if (continuing === pending) emitContinuation();
          },
          () => {
            if (continuing === pending) continuing = undefined;
          },
        );
        return continued.disposition.then(() => continued.settled);
      }
      case "setModel": {
        const { provider, id } = args[0] as { provider: string; id: string };
        const model = options.findModel(provider, id);
        if (!model)
          throw new Error(`Model ${provider}/${id} is not available.`);
        return local.setModel(model);
      }
      case "appendCustomEntry":
        return local
          .toolSessionManager()
          .appendCustomEntry(args[0] as string, args[1]);
      case "markToolUsed":
        local.markToolUsed(args[0] as string);
        return undefined;
      case "dropEncryptedReasoning":
        return local.dropEncryptedReasoning();
      case "abort":
        return local.abort();
      case "compact":
        return local.compact(args[0] as string | undefined);
      case "clearContext":
        return local.clearContext();
      case "setThinkingLevel":
        return local.setThinkingLevel(
          args[0] as Parameters<PiEngineHandle["setThinkingLevel"]>[0],
        );
      case "setSessionName":
        return local.setSessionName(args[0] as string);
      case "applyCompactionWindow":
        return local.applyCompactionWindow(args[0] as number | null);
      case "lowerCompactionWindow":
        return local.lowerCompactionWindow(args[0] as number);
      case "restoreCompactionWindow":
        return local.restoreCompactionWindow(
          args[0] as number | null,
          args[1] as string,
        );
      case "setIntegrationGates":
        return local.setIntegrationGates(
          args[0] as Parameters<PiEngineHandle["setIntegrationGates"]>[0],
        );
      case "setToolMode":
        return local.setToolMode(
          args[0] as Parameters<PiEngineHandle["setToolMode"]>[0],
        );
      case "commitStaged":
        return local.commitStaged(
          args[0] as Parameters<PiEngineHandle["commitStaged"]>[0],
        );
      default:
        throw new Error(`Unknown pi engine command ${JSON.stringify(name)}.`);
    }
  };

  if (engineId !== undefined)
    hosted.set(engineId, {
      local,
      refresh: (token) => emit({ kind: "state", refresh: token }),
    });
  return {
    info,
    snapshot(): PiHostedSnapshot {
      const entries = local.transcript.getEntries();
      sentHeader = local.transcript.getHeader();
      sentLeaf = local.transcript.getLeafId();
      sentLength = entries.length;
      const state = readState();
      sentState = JSON.stringify(state);
      const toolDefinitionChars = piEngineToolMirror(local)?.definitionChars;
      return {
        state,
        ...(toolDefinitionChars ? { toolDefinitionChars } : {}),
        header: sentHeader,
        entries,
        leafId: sentLeaf,
      };
    },
    command(name, args, commandId) {
      let outcome: Promise<unknown>;
      try {
        outcome = Promise.resolve(
          run(name, Array.isArray(args) ? args : [], commandId),
        );
      } catch (err) {
        outcome = Promise.reject(err);
      }
      // The command's effect reaches the server before its answer does.
      return outcome.finally(() => emit({ kind: "state" }));
    },
    onItem(receive) {
      listener = receive;
    },
    async dispose(discard?: EngineDiscard) {
      unsubscribe();
      listener = undefined;
      if (engineId !== undefined && hosted.get(engineId)?.local === local)
        hosted.delete(engineId);
      await (discard ? local.discard(discard) : local.dispose());
    },
  };
}

/**
 * The `"pi"` factory a Worker hosts, reaching pi's model runtime through
 * `models`; the composition root injects the server's (`piStore.ts`).
 */
export function createPiHostedEngineFactory({
  models,
}: {
  models: PiModelPort;
}): HostedEngineFactory {
  return async (spec, host) => {
    const { engine, info } = await openPiEngine(spec as PiEngineOpenSpec, {
      childEnv: host.childEnv,
      appToolExecutor: (sessionId) => (tool, args, ctx) =>
        host.callAppTool(
          { sessionId, tool, toolCallId: ctx.toolCallId, args },
          {
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
            ...(ctx.progress !== undefined ? { onProgress: ctx.progress } : {}),
          },
        ),
      models,
      persistOutput: (request) => host.persistOutput(request),
      materializeSkills: (names) => host.materializeSkills(names),
      backgroundWork: host.backgroundWork,
    });
    return hostPiEngine(engine, info, {
      findModel: models.find,
      engineId: host.engineId,
    });
  };
}

/**
 * The local handle a hosted engine drives, while the in-process Worker holds
 * it: what the handle's test seams see through a remote handle.
 */
export function hostedPiEngine(engineId: number): PiEngineHandle | undefined {
  return hosted.get(engineId)?.local;
}

/**
 * Emit a `state` item carrying `token` from a hosted engine, with whatever
 * its local handle changed outside a command (a test's native pi write).
 * Only `syncPiEngineMirrorForTests`, through the remote handle's link, calls
 * it: no command or method reaches it, so no server request can. Answers
 * false when the engine is not hosted.
 */
export function refreshHostedPiEngine(
  engineId: number,
  token: number,
): boolean {
  const engine = hosted.get(engineId);
  engine?.refresh(token);
  return engine !== undefined;
}
