/**
 * A host-driven ("synthetic") assistant turn: one in-progress tool block a
 * slash command streams progress into, ended by plain tool output or by a
 * host-command card (`hostSlashCommands.ts`). Both engine session classes emit
 * the turn through these, to their viewers and their runtime adapter alike;
 * the session's own state (turn ids, running, teardown) stays with the engine.
 */
import type { DisplayMessage, ServerMessage } from "@assistant/shared";
import type { HostCommandCard } from "@assistant/shared/runtime";
import type { NativeAdapterEventSource } from "../session/adapters/nativeEvents.ts";
import { updateTool } from "../session/runtime/liveBlocks.ts";

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** The card a host command ends its turn with, before it takes the turn's id. */
export type HostCommandResult = WithoutId<HostCommandCard>;

/** Where a host-command turn is shown: the session's viewers and its runtime adapter. */
export interface HostCommandTurnTarget {
  readonly sessionId: string;
  broadcast(message: ServerMessage): void;
  readonly adapterEvents: NativeAdapterEventSource;
}

const STARTING = "Starting…";

/** The live turn `assistantId`: one in-progress tool block. */
export function hostCommandTurn(
  assistantId: string,
  toolId: string,
  name: string,
  args: unknown,
): DisplayMessage {
  return {
    id: assistantId,
    role: "assistant",
    blocks: [
      {
        kind: "tool",
        toolId,
        name,
        args,
        output: STARTING,
        isError: false,
        done: false,
      },
    ],
    streaming: true,
  };
}

/**
 * Show a turn {@link hostCommandTurn} built. The session holds it as its live
 * turn first, so whatever these reach already sees it.
 */
export function openHostCommandTurn(
  target: HostCommandTurnTarget,
  turn: DisplayMessage,
): void {
  const tool = turn.blocks[0];
  if (tool?.kind !== "tool")
    throw new Error("A host-command turn opens with its tool block.");
  const { toolId, name, args } = tool;
  const { sessionId, adapterEvents } = target;
  const assistantId = turn.id;
  target.broadcast({ type: "assistantStart", sessionId, id: assistantId });
  adapterEvents.messageStarted(assistantId);
  target.broadcast({
    type: "toolStart",
    sessionId,
    id: assistantId,
    toolId,
    name,
    args,
  });
  adapterEvents.toolStarted(toolId, name, args);
  target.broadcast({
    type: "toolUpdate",
    sessionId,
    id: assistantId,
    toolId,
    output: STARTING,
  });
  adapterEvents.toolUpdated(toolId, STARTING);
}

/** Stream progress text into the turn's tool block. */
export function updateHostCommandTool(
  target: HostCommandTurnTarget,
  turn: DisplayMessage,
  toolId: string,
  output: string,
): void {
  updateTool(turn.blocks, toolId, { output });
  target.broadcast({
    type: "toolUpdate",
    sessionId: target.sessionId,
    id: turn.id,
    toolId,
    output,
  });
  target.adapterEvents.toolUpdated(toolId, output);
}

/** Drop the turn without a durable entry (a normal skipped phase). */
export function discardHostCommandTurn(
  target: HostCommandTurnTarget,
  turn: DisplayMessage,
): void {
  target.broadcast({
    type: "assistantEnd",
    sessionId: target.sessionId,
    id: turn.id,
  });
  target.adapterEvents.hostCommandDiscarded();
}

/** End the turn with plain tool output; an error output is the turn's error. */
export function finishHostCommandTool(
  target: HostCommandTurnTarget,
  turn: DisplayMessage,
  toolId: string,
  output: string,
  isError: boolean,
): void {
  const { sessionId, adapterEvents } = target;
  updateTool(turn.blocks, toolId, { output, isError, done: true });
  turn.streaming = false;
  const toolEnd = {
    type: "toolEnd" as const,
    sessionId,
    id: turn.id,
    toolId,
    output,
    isError,
  };
  target.broadcast(toolEnd);
  adapterEvents.toolCompleted(toolEnd);
  target.broadcast({
    type: "assistantEnd",
    sessionId,
    id: turn.id,
    ...(isError ? { error: output } : {}),
  });
  adapterEvents.messageCompleted(turn.id, {
    ...(isError ? { errorMessage: output } : {}),
  });
}

/**
 * End the turn with a host-command card, which replaces its tool block. The
 * returned card is what a session that keeps its own transcript appends.
 */
export function finishHostCommandCard(
  target: HostCommandTurnTarget,
  turn: DisplayMessage,
  result: HostCommandResult,
): { name: string; card: HostCommandCard } {
  const { sessionId, adapterEvents } = target;
  turn.blocks = [result];
  turn.streaming = false;
  const card = { ...result, id: turn.id } as HostCommandCard;
  const { name, envelope } = cardMessage(sessionId, card);
  target.broadcast(envelope);
  adapterEvents.hostCommandCard(name, card, envelope);
  target.broadcast({ type: "assistantEnd", sessionId, id: turn.id });
  adapterEvents.messageCompleted(turn.id);
  return { name, card };
}

/** The durable entry name and the live envelope of a card. */
function cardMessage(
  sessionId: string,
  card: HostCommandCard,
): { name: string; envelope: ServerMessage } {
  const id = card.id;
  switch (card.kind) {
    case "commit":
      return {
        name: "commit",
        envelope: { type: "commitResult", sessionId, id, commit: card.commit },
      };
    case "push":
      return {
        name: "push",
        envelope: { type: "pushResult", sessionId, id, push: card.push },
      };
    case "compaction":
      return {
        name: "compaction",
        envelope: {
          type: "compactionResult",
          sessionId,
          id,
          compaction: card.compaction,
        },
      };
    case "contextClear":
      return {
        name: "contextClear",
        envelope: {
          type: "contextClearResult",
          sessionId,
          id,
          contextClear: card.contextClear,
        },
      };
    case "worktreeProvision":
      return {
        name: "worktree",
        envelope: {
          type: "worktreeProvisionResult",
          sessionId,
          id,
          provision: card.provision,
        },
      };
  }
}
