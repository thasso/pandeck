/**
 * `session_control`: retract the caller's waiting peer prompts, stop an owned
 * child, or, while it is not running, dismiss its unhandled background updates
 * or make it enterprise-only. `set_runtime` sets the child's pending model,
 * effort or account, applied when its next turn starts, at any time; a model
 * its agent definition does not list asks the user on a `sessionRuntime` card
 * first (`docs/agent-definitions.md` "Switching a child"). A sender may
 * retract only its own messages. The other operations require a direct spawn
 * edge still owned by `coordinator`; user takeover revokes them.
 */
import {
  THINKING_LEVELS,
  type ApprovalCard,
  type SessionRuntimeApprovalBody,
  type SessionRuntimeChange,
  type ThinkingLevel,
} from "@assistant/shared";
import {
  dismissAllBackgroundHandling,
  unhandledBackground,
} from "../../backgroundCompletionNotices.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import { noteDelegationStandDown } from "../../delegationFailureNotice.ts";
import { resolveAgentModel } from "../../agents/agentRuntime.ts";
import { sessionAgent } from "../../agents/sessionAgent.ts";
import { pickerModels } from "../../harnesses/models.ts";
import { defineAgentTool, type AgentTool } from "../../mcp/tool.ts";
import {
  approvalCardReference,
  createApproval,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import { cancelQueuedPeerPrompts } from "../../peerPrompt.ts";
import { requireSessionEnterprise } from "../../sessionAccount.ts";
import {
  accountMoveTargetRefusal,
  accountMoveTargets,
  sessionSelection,
} from "../../sessionAccountMove.ts";
import { setSessionPendingRuntime } from "../../sessionPendingRuntime.ts";
import {
  credentialProfileById,
  listCredentialProfiles,
} from "../../credentialProfiles.ts";
import { sessionRuntime } from "../../session/runtimeInstance.ts";
import { cleanSessionId, SessionInspectionError } from "./sessionInspection.ts";

type SessionControlOperation =
  | "cancel_queued_prompts"
  | "stop"
  | "dismiss_background_updates"
  | "require_enterprise"
  | "set_runtime";
type SessionControlParams = {
  operation?: unknown;
  targetSessionId?: unknown;
  clearQueue?: unknown;
  account?: unknown;
  model?: unknown;
  effort?: unknown;
};

const RUNTIME_FIELDS = ["account", "model", "effort"] as const;

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
      "Abort a child you spawned and still own, or retract your own waiting peer deliveries. The cancellation operation removes every delivery YOU sent to the target that has not started dispatching. The stop operation aborts the child's current turn. Its `clearQueue` option cancels every not-yet-dispatched delivery queued for that child before aborting, so the idle transition does not start the next turn. A child the user took over cannot be stopped. Stopping does not archive or delete it. dismiss_background_updates is the user's Dismiss for every unhandled update of your still-owned direct child, refused while it runs; dismissal is not handling and leaves jobs and output unchanged. require_enterprise makes that idle child enterprise-only for good; its next prompt moves it to an enterprise account. set_runtime sets that child's model, effort or account for its next turn; a model its agent definition does not list, or any model change of a child not spawned from one, puts a card in front of the user and you end your turn.",
    searchHint:
      "stop abort spawned child cancel retract remove queued peer delivery clear queue dismiss unhandled background updates require enterprise account cybersecurity refusal move switch account model effort runtime",
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
            "set_runtime",
          ],
          description:
            '"cancel_queued_prompts" retracts your waiting messages. "stop" aborts an owned child. "dismiss_background_updates" dismisses its interrupted receipts. "require_enterprise" makes it enterprise-only. "set_runtime" sets its `model`, `effort` or `account`.',
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
            'Only for "set_runtime": the target account\'s name or id. Without a model change it must be another eligible account of the same kind.',
        },
        model: {
          type: "string",
          description:
            'Only for "set_runtime": the model, as `provider/id`, an id or an alias such as `opus`. Another engine\'s model moves the child there with its conversation.',
        },
        effort: {
          type: "string",
          enum: [...THINKING_LEVELS],
          description:
            'Only for "set_runtime": the thinking effort, lowered to what the model supports.',
        },
      },
    } as const,
    async execute(params, ctx) {
      for (const key of Object.keys(params))
        if (
          ![
            "operation",
            "targetSessionId",
            "clearQueue",
            ...RUNTIME_FIELDS,
          ].includes(key)
        )
          throw new Error(`session_control does not accept "${key}".`);

      const operation = readOperation(params.operation);
      const targetSessionId = requireSessionId(params.targetSessionId);
      if (operation !== "stop" && params.clearQueue !== undefined)
        throw new Error('clearQueue is only valid with operation "stop".');
      for (const field of RUNTIME_FIELDS)
        if (operation !== "set_runtime" && params[field] !== undefined)
          throw new Error(
            `${field} is only valid with operation "set_runtime".`,
          );
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

      if (operation === "set_runtime")
        return setChildRuntime(ctx, targetSessionId, params);

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

const PENDING_NOTE =
  "Nothing changed yet. Do not claim it did until the approved result appears.";

/**
 * Set an owned child's pending model, effort or account. Within the models
 * its frozen agent definition lists (and for an account or effort alone) it
 * is set now; any other model asks the user first.
 */
async function setChildRuntime(
  ctx: { session: { sessionId: string }; toolCallId?: string },
  targetSessionId: string,
  params: SessionControlParams,
) {
  const coordinator = ctx.session.sessionId;
  requireOwnedChild(coordinator, targetSessionId, "switched");
  if (RUNTIME_FIELDS.every((field) => params[field] === undefined))
    throw new Error('"set_runtime" needs a model, an effort or an account.');
  const row = sessionStore.get(targetSessionId);
  if (!row) throw new Error(`No session found with id ${targetSessionId}.`);
  const current = await sessionSelection(row);
  const effort = readEffort(params.effort);
  const model =
    params.model === undefined ? undefined : resolveChildModel(params.model);
  const changesModel =
    model !== undefined &&
    !sameModel(model, current?.model) &&
    !sameModel(model, row.pendingRuntime?.model);
  let account: { id: string; name: string; current: boolean } | undefined;
  if (params.account !== undefined) {
    if (changesModel) {
      const profile = resolveAccountName(params.account);
      account = {
        ...profile,
        current: row.credentialProfileId === profile.id,
      };
    } else {
      const target = await resolveMoveAccount(targetSessionId, params.account);
      if (target.refusal && !target.current)
        throw new Error(`${target.refusal} ${target.alternatives}`);
      account = target;
    }
  }
  const change: SessionRuntimeChange = {
    ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
    ...(effort ? { thinkingLevel: effort } : {}),
    ...(account ? { account: { kind: "account", id: account.id } } : {}),
  };
  if (changesModel && !definitionLists(targetSessionId, model))
    return proposeChildRuntime(ctx, row, current, change, model, account);
  // The user may take the child over while the selection resolves: the
  // ownership edge is asked again with the write itself.
  const pending = await setSessionPendingRuntime(
    targetSessionId,
    change,
    "coordinator",
    {
      authorize: () =>
        requireOwnedChild(coordinator, targetSessionId, "switched"),
    },
  );
  return textResult(pendingText(targetSessionId, pending));
}

/** What the child's next turn runs on now, for the coordinator. */
function pendingText(
  sessionId: string,
  pending: Awaited<ReturnType<typeof setSessionPendingRuntime>>,
): string {
  return pending
    ? `${sessionId} switches to ${runtimeText(
        pending.model,
        pending.thinkingLevel,
        pending.account.kind === "account" ? pending.account.id : undefined,
      )} when its next turn starts.`
    : `${sessionId} keeps what it runs on now; nothing is pending.`;
}

/** One picker model a coordinator names, resolved the way definitions are. */
function resolveChildModel(value: unknown) {
  if (typeof value !== "string" || !value.trim())
    throw new Error("model must be a model id, alias or provider/id.");
  return resolveAgentModel(value.trim(), pickerModels());
}

function readEffort(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if ((THINKING_LEVELS as readonly unknown[]).includes(value))
    return value as ThinkingLevel;
  throw new Error(`effort must be one of ${THINKING_LEVELS.join(", ")}.`);
}

function sameModel(
  a: { provider: string; id: string } | undefined,
  b: { provider: string; id: string } | undefined,
): boolean {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

/**
 * Whether the child's frozen agent definition lists `model`. A child not
 * spawned from one, or whose stored definition is unreadable, lists none; a
 * row frozen before definitions recorded their list lists only its own.
 */
function definitionLists(
  sessionId: string,
  model: { provider: string; id: string },
): boolean {
  let agent: ReturnType<typeof sessionAgent>;
  try {
    agent = sessionAgent(sessionId);
  } catch {
    return false;
  }
  if (!agent) return false;
  const listed = agent.listedModels ?? [
    { provider: agent.provider, id: agent.model },
  ];
  return listed.some((entry) => sameModel(entry, model));
}

function resolveAccountName(value: unknown): { id: string; name: string } {
  if (typeof value !== "string" || !value.trim())
    throw new Error("account must be an account name or id.");
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
  const match = matches[0];
  if (!match) throw new Error(`No account is named "${wanted}".`);
  return { id: match.id, name: match.name };
}

/** "Claude Opus, high effort · Work", for results and cards. */
function runtimeText(
  model: { provider: string; id: string } | undefined,
  effort: string | undefined,
  accountId?: string,
): string {
  const name = model
    ? (pickerModels().find((option) => sameModel(option, model))?.name ??
      model.id)
    : "its current model";
  const account = accountId
    ? credentialProfileById(accountId)?.name
    : undefined;
  return `${name}${effort ? `, ${effort} effort` : ""}${account ? ` · ${account}` : ""}`;
}

/** Put a model the child's definition does not list in front of the user. */
function proposeChildRuntime(
  ctx: { session: { sessionId: string }; toolCallId?: string },
  row: NonNullable<ReturnType<typeof sessionStore.get>>,
  current: Awaited<ReturnType<typeof sessionSelection>>,
  change: SessionRuntimeChange,
  model: { provider: string; id: string; name?: string },
  account: { id: string; name: string } | undefined,
) {
  let agentName: string | undefined;
  try {
    agentName = sessionAgent(row.id)?.name;
  } catch {
    agentName = undefined;
  }
  const body: SessionRuntimeApprovalBody = {
    kind: "sessionRuntime",
    targetSessionId: row.id,
    ...(row.title ? { targetTitle: row.title } : {}),
    ...(agentName ? { agentName } : {}),
    current: runtimeText(
      current?.model,
      current?.thinkingLevel,
      row.credentialProfileId,
    ),
    model: {
      provider: model.provider,
      id: model.id,
      name: model.name ?? model.id,
    },
    ...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}),
    ...(account ? { account: { id: account.id, name: account.name } } : {}),
  };
  const target = runtimeText(model, change.thinkingLevel, account?.id);
  const summary = `switch ${row.title ? `"${row.title}"` : row.id} to ${target}`;
  const card = createApproval({
    sessionId: ctx.session.sessionId,
    kind: "sessionRuntime",
    title: "Switch a child's model",
    summary,
    ...(ctx.toolCallId ? { sourceToolCallId: ctx.toolCallId } : {}),
    body,
    supersedes: (earlier) =>
      earlier.body.kind === "sessionRuntime" &&
      earlier.body.targetSessionId === row.id,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: `Asked the user to ${summary}${agentName ? `, a model agent "${agentName}" does not list` : ""}. ${PENDING_NOTE} ${approvalCardReference(card)}`,
      },
    ],
    terminate: true,
  };
}

registerApprovalExecutor("sessionRuntime", {
  async execute(card: ApprovalCard) {
    if (card.body.kind !== "sessionRuntime")
      throw new Error("Mismatched approval body for sessionRuntime.");
    const body = card.body;
    const coordinator = card.sessionId;
    const target = body.targetSessionId;
    // Approval answers for the coordinator that asked, and only while it
    // still owns the child: a takeover meanwhile fails the card, asked again
    // with the write itself.
    requireUserTarget(target);
    requireOwnedChild(coordinator, target, "switched");
    const pending = await setSessionPendingRuntime(
      target,
      {
        model: { provider: body.model.provider, id: body.model.id },
        ...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel } : {}),
        ...(body.account
          ? { account: { kind: "account" as const, id: body.account.id } }
          : {}),
      },
      "coordinator",
      { authorize: () => requireOwnedChild(coordinator, target, "switched") },
    );
    return { resultSummary: pendingText(target, pending) };
  },
});

function readOperation(value: unknown): SessionControlOperation {
  if (
    value === "cancel_queued_prompts" ||
    value === "stop" ||
    value === "dismiss_background_updates" ||
    value === "require_enterprise" ||
    value === "set_runtime"
  )
    return value;
  throw new Error(
    'operation must be "cancel_queued_prompts", "stop", "dismiss_background_updates", "require_enterprise" or "set_runtime".',
  );
}

/**
 * The account `set_runtime` names, by id or exact (case-insensitive) name,
 * and whether it is eligible right now. An unknown name lists the child's
 * eligible accounts; the move re-judges the target itself.
 */
async function resolveMoveAccount(
  sessionId: string,
  value: unknown,
): Promise<{
  id: string;
  name: string;
  /** Why it is not an eligible target now; undefined when it is. */
  refusal?: string;
  /** Whether the child runs on it now. */
  current: boolean;
  alternatives: string;
}> {
  if (typeof value !== "string" || !value.trim())
    throw new Error("account must be an account name or id.");
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
  const refusal = eligible.some((account) => account.id === match.id)
    ? undefined
    : await accountMoveTargetRefusal(sessionId, match.id);
  return {
    id: match.id,
    name: match.name,
    ...(refusal ? { refusal } : {}),
    current: sessionStore.get(sessionId)?.credentialProfileId === match.id,
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
