/**
 * `session_control`: cancel the caller's queued peer prompts, or stop a peer
 * session that the caller spawned and still owns.
 *
 * The two operations share one target and one authority boundary. A sender may
 * retract only its own not-yet-dispatched messages. A coordinator may abort only
 * a child whose durable spawn edge still says `coordinator`; direct human
 * takeover revokes that authority.
 */
import { sessionStore } from "../../db/sessionStore.ts";
import { defineAgentTool, type AgentTool } from "../../mcp/tool.ts";
import { cancelQueuedPeerPrompts } from "../../peerPrompt.ts";
import { sessionRuntime } from "../../session/runtimeInstance.ts";
import { cleanSessionId, SessionInspectionError } from "./sessionInspection.ts";

type SessionControlOperation = "cancel_queued_prompts" | "stop";
type SessionControlParams = {
  operation?: unknown;
  targetSessionId?: unknown;
  clearQueue?: unknown;
};

interface SessionControlRuntime {
  isRunning(sessionId: string): boolean;
  abort(sessionId: string): void | Promise<void>;
}

let runtimeOverride: SessionControlRuntime | undefined;

/** Test-only seam for a running child without starting a provider runtime. */
export function setSessionControlRuntimeForTests(
  runtime: SessionControlRuntime | undefined,
): void {
  runtimeOverride = runtime;
}

function runtime(): SessionControlRuntime {
  return runtimeOverride ?? sessionRuntime;
}

export function sessionControlTools(): AgentTool[] {
  return [makeSessionControlTool()];
}

function makeSessionControlTool() {
  return defineAgentTool<SessionControlParams>({
    name: "session_control",
    label: "Control Session",
    description:
      "Abort a child you spawned and still own, or retract your own waiting peer deliveries. The cancellation operation removes every delivery YOU sent to the target that has not started dispatching. The stop operation aborts the child's current turn. Its `clearQueue` option cancels every not-yet-dispatched delivery queued for that child before aborting, so the idle transition does not start the next turn. A child the user took over cannot be stopped. Stopping does not archive or delete it.",
    searchHint:
      "stop abort spawned child cancel retract remove queued peer delivery clear queue",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["operation", "targetSessionId"],
      properties: {
        operation: {
          type: "string",
          enum: ["cancel_queued_prompts", "stop"],
          description:
            '"cancel_queued_prompts" retracts only your own waiting messages. "stop" aborts a still-owned spawned child.',
        },
        targetSessionId: {
          type: "string",
          description: "Copied id of the target session.",
        },
        clearQueue: {
          type: "boolean",
          description:
            'Only for "stop". Cancel every waiting prompt to the owned child before aborting. Defaults to false.',
        },
      },
    } as const,
    async execute(params, ctx) {
      for (const key of Object.keys(params))
        if (!["operation", "targetSessionId", "clearQueue"].includes(key))
          throw new Error(`session_control does not accept "${key}".`);

      const operation = readOperation(params.operation);
      const targetSessionId = requireSessionId(params.targetSessionId);
      if (targetSessionId === ctx.session.sessionId)
        throw new Error(
          "Cannot control the current session through session_control.",
        );
      requireUserTarget(targetSessionId);

      if (operation === "cancel_queued_prompts") {
        if (params.clearQueue !== undefined)
          throw new Error('clearQueue is only valid with operation "stop".');
        const cancelled = cancelQueuedPeerPrompts({
          senderSessionId: ctx.session.sessionId,
          recipientSessionId: targetSessionId,
          reason: "Cancelled by the sending session before delivery.",
        });
        return textResult(
          cancelled.length === 0
            ? `No queued prompts from this session to ${targetSessionId} were waiting.`
            : `Cancelled ${cancelled.length} queued prompt${cancelled.length === 1 ? "" : "s"} from this session to ${targetSessionId}.`,
        );
      }

      const clearQueue = readOptionalBoolean(params.clearQueue, "clearQueue");
      requireOwnedChild(ctx.session.sessionId, targetSessionId);
      const cancelled = clearQueue
        ? cancelQueuedPeerPrompts({
            recipientSessionId: targetSessionId,
            reason:
              "Cancelled when the owning coordinator stopped the session.",
          })
        : [];
      const control = runtime();
      const wasRunning = control.isRunning(targetSessionId);
      if (wasRunning) await control.abort(targetSessionId);
      const queueText = clearQueue
        ? ` Cancelled ${cancelled.length} queued prompt${cancelled.length === 1 ? "" : "s"} first.`
        : "";
      return textResult(
        `${wasRunning ? "Stopped the current turn in" : "Session was already idle:"} ${targetSessionId}.${queueText}`,
      );
    },
  });
}

function readOperation(value: unknown): SessionControlOperation {
  if (value === "cancel_queued_prompts" || value === "stop") return value;
  throw new Error('operation must be "cancel_queued_prompts" or "stop".');
}

function requireSessionId(value: unknown): string {
  try {
    return cleanSessionId(value, "targetSessionId");
  } catch (err) {
    if (err instanceof SessionInspectionError) throw new Error(err.message);
    throw err;
  }
}

function requireUserTarget(sessionId: string): void {
  const target = sessionStore.getIncludingDeleted(sessionId);
  if (!target) throw new Error(`No session found with id ${sessionId}.`);
  if (target.deletedAt)
    throw new Error(
      `Session ${sessionId} was deleted and cannot be controlled.`,
    );
  if (target.scope !== "user")
    throw new Error(
      `Session ${sessionId} is not a user session and cannot be controlled.`,
    );
}

function requireOwnedChild(
  coordinatorSessionId: string,
  childSessionId: string,
): void {
  const spawn = sessionStore
    .spawnedParentsByChildIds([childSessionId])
    .get(childSessionId);
  if (!spawn || spawn.parentSessionId !== coordinatorSessionId)
    throw new Error(
      `Session ${childSessionId} was not spawned by the current session.`,
    );
  if (spawn.ownership !== "coordinator")
    throw new Error(
      `Session ${childSessionId} is no longer owned by the current session (${spawn.ownership}); it cannot be stopped here.`,
    );
}

function readOptionalBoolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
