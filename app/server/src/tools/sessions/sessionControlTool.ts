/**
 * `session_control`: retract the caller's waiting peer prompts, stop an owned
 * child, or, while it is not running, dismiss its unhandled background updates,
 * make it enterprise-only or move it to another account. A sender may retract only its own messages. The
 * other operations require a direct spawn edge still owned by `coordinator`;
 * user takeover revokes them.
 */
import {
  dismissAllBackgroundHandling,
  unhandledBackground,
} from "../../backgroundCompletionNotices.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import { noteDelegationStandDown } from "../../delegationFailureNotice.ts";
import { defineAgentTool, type AgentTool } from "../../mcp/tool.ts";
import { cancelQueuedPeerPrompts } from "../../peerPrompt.ts";
import { requireSessionEnterprise } from "../../sessionAccount.ts";
import {
  accountMoveTargets,
  moveSessionAccount,
} from "../../sessionAccountMove.ts";
import { listCredentialProfiles } from "../../credentialProfiles.ts";
import { sessionRuntime } from "../../session/runtimeInstance.ts";
import { cleanSessionId, SessionInspectionError } from "./sessionInspection.ts";

type SessionControlOperation =
  | "cancel_queued_prompts"
  | "stop"
  | "dismiss_background_updates"
  | "require_enterprise"
  | "move_account";
type SessionControlParams = {
  operation?: unknown;
  targetSessionId?: unknown;
  clearQueue?: unknown;
  account?: unknown;
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
      "Abort a child you spawned and still own, or retract your own waiting peer deliveries. The cancellation operation removes every delivery YOU sent to the target that has not started dispatching. The stop operation aborts the child's current turn. Its `clearQueue` option cancels every not-yet-dispatched delivery queued for that child before aborting, so the idle transition does not start the next turn. A child the user took over cannot be stopped. Stopping does not archive or delete it. dismiss_background_updates is the user's Dismiss for every unhandled update of your still-owned direct child, refused while it runs; dismissal is not handling and leaves jobs and output unchanged. require_enterprise makes that idle child enterprise-only for good; its next prompt moves it to an enterprise account. move_account moves that idle child to another eligible account of the same kind now.",
    searchHint:
      "stop abort spawned child cancel retract remove queued peer delivery clear queue dismiss unhandled background updates require enterprise account cybersecurity refusal move switch account",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["operation", "targetSessionId"],
      properties: {
        operation: {
          type: "string",
          enum: [
            "cancel_queued_prompts",
            "stop",
            "dismiss_background_updates",
            "require_enterprise",
            "move_account",
          ],
          description:
            '"cancel_queued_prompts" retracts your waiting messages. "stop" aborts an owned child. "dismiss_background_updates" dismisses its interrupted receipts. "require_enterprise" makes it enterprise-only. "move_account" moves it to `account`.',
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
        account: {
          type: "string",
          description:
            'Only for "move_account", and required there: the target account\'s name or id.',
        },
      },
    } as const,
    async execute(params, ctx) {
      for (const key of Object.keys(params))
        if (
          !["operation", "targetSessionId", "clearQueue", "account"].includes(
            key,
          )
        )
          throw new Error(`session_control does not accept "${key}".`);

      const operation = readOperation(params.operation);
      const targetSessionId = requireSessionId(params.targetSessionId);
      if (operation !== "stop" && params.clearQueue !== undefined)
        throw new Error('clearQueue is only valid with operation "stop".');
      if (operation !== "move_account" && params.account !== undefined)
        throw new Error('account is only valid with operation "move_account".');
      if (targetSessionId === ctx.session.sessionId)
        throw new Error(
          "Cannot control the current session through session_control.",
        );
      requireUserTarget(targetSessionId);

      if (operation === "cancel_queued_prompts") {
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

      if (operation === "dismiss_background_updates") {
        requireOwnedChild(ctx.session.sessionId, targetSessionId, "dismissed");
        if (runtime().isRunning(targetSessionId))
          throw new Error(
            `Session ${targetSessionId} is running; dismiss its background updates once its turn ends.`,
          );
        const dismissed = dismissAllBackgroundHandling(targetSessionId);
        const remaining = unhandledBackground(targetSessionId).count;
        return textResult(
          dismissed === 0
            ? `${targetSessionId} had no unhandled background updates. Dismissed 0; ${remaining} remain.`
            : `Dismissed ${dismissed} unhandled background update${dismissed === 1 ? "" : "s"} of ${targetSessionId}; they were not handled, and their jobs and output files are unchanged. ${remaining} remain.`,
        );
      }

      if (operation === "require_enterprise") {
        requireOwnedChild(
          ctx.session.sessionId,
          targetSessionId,
          "made enterprise-only",
        );
        return textResult(
          requireSessionEnterprise(targetSessionId, runtime())
            ? `${targetSessionId} already requires an enterprise account; nothing changed.`
            : `${targetSessionId} now requires an enterprise account. Its next prompt moves it to an eligible enterprise account first, or is refused when none is available. This cannot be undone.`,
        );
      }

      if (operation === "move_account") {
        const coordinator = ctx.session.sessionId;
        const authorize = () => {
          requireUserTarget(targetSessionId);
          requireOwnedChild(coordinator, targetSessionId, "moved");
        };
        authorize();
        if (runtime().isRunning(targetSessionId))
          throw new Error(
            `Session ${targetSessionId} is running; move it once its turn ends.`,
          );
        const target = await resolveMoveAccount(
          targetSessionId,
          params.account,
        );
        try {
          const moved = await moveSessionAccount({
            sessionId: targetSessionId,
            targetProfileId: target.id,
            by: "coordinator",
            authorize,
          });
          return textResult(
            `Moved ${targetSessionId} from ${moved.from} to ${moved.to}.`,
          );
        } catch (err) {
          // An account that was not eligible a moment ago: its own reason,
          // and what the coordinator could pick instead.
          if (target.eligible || !(err instanceof Error)) throw err;
          throw new Error(`${err.message} ${target.alternatives}`);
        }
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
      // Whatever the harness reports for the turn this stops, the coordinator
      // asked for it: no failure notice comes back to it.
      if (wasRunning) noteDelegationStandDown(targetSessionId);
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
  if (
    value === "cancel_queued_prompts" ||
    value === "stop" ||
    value === "dismiss_background_updates" ||
    value === "require_enterprise" ||
    value === "move_account"
  )
    return value;
  throw new Error(
    'operation must be "cancel_queued_prompts", "stop", "dismiss_background_updates", "require_enterprise" or "move_account".',
  );
}

/**
 * The account `move_account` names, by id or exact (case-insensitive) name,
 * and whether it is eligible right now. An unknown name lists the child's
 * eligible accounts; the move re-judges the target itself.
 */
async function resolveMoveAccount(
  sessionId: string,
  value: unknown,
): Promise<{ id: string; eligible: boolean; alternatives: string }> {
  if (typeof value !== "string" || !value.trim())
    throw new Error('operation "move_account" requires an account name or id.');
  const wanted = value.trim();
  const profiles = listCredentialProfiles();
  const byId = profiles.find((profile) => profile.id === wanted);
  const matches = byId
    ? [byId]
    : profiles.filter(
        (profile) => profile.name.toLowerCase() === wanted.toLowerCase(),
      );
  if (matches.length > 1)
    throw new Error(
      `More than one account is named "${wanted}" (${matches.map((profile) => profile.id).join(", ")}); name it by id.`,
    );
  const eligible = await accountMoveTargets(sessionId);
  const names = eligible.map((account) => account.name).join(", ");
  const alternatives = names
    ? `Eligible accounts: ${names}.`
    : "No account is eligible for this session now.";
  const match = matches[0];
  if (!match)
    throw new Error(`No account is named "${wanted}". ${alternatives}`);
  return {
    id: match.id,
    eligible: eligible.some((account) => account.id === match.id),
    alternatives,
  };
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
  verb = "stopped",
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
      `Session ${childSessionId} is no longer owned by the current session (${spawn.ownership}); it cannot be ${verb} here.`,
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
