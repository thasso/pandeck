import {
  GRANTABLE_OPERATIONS,
  isSessionPeerTurnCap,
  MAX_SESSION_PEER_TURN_CAP,
  requestableUpFront,
  type ApprovalCard,
  type ApprovalGrantsRequestBody,
  type ApprovalGrantsRequestItem,
  type ApprovalGrantsRequestResult,
  type ApprovalResolutionEdits,
} from "@assistant/shared";
import { defineAgentTool } from "../../mcp/tool.ts";
import {
  approvalCardReference,
  createApproval,
  effectiveGrantScope,
  grantRequestedOperations,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import {
  directPeerTurnCapOf,
  setSessionPeerTurnCap,
} from "../../peerSpawnRuntimes.ts";

const MAX_REASON_CHARS = 500;

type ApprovalGrantsRequestParams = {
  grants?: Array<{ key?: unknown; alsoSpawnedSessions?: unknown }>;
  peerTurnCap?: unknown;
  reason?: unknown;
};

const scopeText = (inheritable: boolean) =>
  inheritable ? "also sessions it starts" : "this session only";

const capText = (cap: number) =>
  `${cap} concurrent peer turn${cap === 1 ? "" : "s"}`;

export const approvalGrantsRequestTool =
  defineAgentTool<ApprovalGrantsRequestParams>({
    name: "approval_grants_request",
    label: "Request session grants",
    description:
      "Ask the user once, up front, for the Approve-for-session grants this session will need, and optionally a higher concurrent peer turn cap. Keys the session already holds (itself or inherited) with at least the requested scope, and a cap at or below the current one, are dropped; when nothing is left no card is created. Otherwise one card lists the rest and you must end your turn: nothing is granted until the user approves it, possibly only some keys or with another scope, and the outcome arrives as the next message. Card-only operations (default-branch merge, branch deletion, releases, Confluence deletes) may be requested and are marked on the card. Tag publishing, settings input and commit review overrides cannot be requested. A grant never adds a tool your definition denies.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["reason"],
      properties: {
        grants: {
          type: "array",
          maxItems: GRANTABLE_OPERATIONS.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key"],
            properties: {
              key: {
                type: "string",
                enum: GRANTABLE_OPERATIONS.map((operation) => operation.key),
              },
              alsoSpawnedSessions: {
                type: "boolean",
                description:
                  "Also cover the sessions this one starts. Default false: this session only.",
              },
            },
          },
          description: "Each grant key once.",
        },
        peerTurnCap: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SESSION_PEER_TURN_CAP,
          description: "The concurrent peer turn cap to raise this session to.",
        },
        reason: {
          type: "string",
          description: `Why the session needs them, shown on the card (at most ${MAX_REASON_CHARS} characters).`,
        },
      },
    },
    async execute(params, ctx) {
      const sessionId = ctx.session.sessionId;
      const reason =
        typeof params.reason === "string" ? params.reason.trim() : "";
      if (!reason) throw new Error("reason is required.");
      if (reason.length > MAX_REASON_CHARS)
        throw new Error(
          `reason accepts at most ${MAX_REASON_CHARS} characters.`,
        );
      const requested = parseGrants(params.grants);
      const cap = params.peerTurnCap;
      if (cap !== undefined && !isSessionPeerTurnCap(cap))
        throw new Error(
          `peerTurnCap must be an integer from 1 to ${MAX_SESSION_PEER_TURN_CAP}.`,
        );
      if (requested.length === 0 && cap === undefined)
        throw new Error("Request at least one grant or a peer turn cap.");

      const items: ApprovalGrantsRequestItem[] = [];
      const held: string[] = [];
      for (const { key, inheritable } of requested) {
        const scope = effectiveGrantScope(sessionId, key);
        if (scope === "inheritable" || (scope === "session" && !inheritable)) {
          held.push(`${key} (${scopeText(scope === "inheritable")})`);
          continue;
        }
        const operation = requestableUpFront(key)!;
        items.push({
          key,
          label: operation.label,
          covers: operation.covers,
          cardOnly: operation.cardOnly,
          inheritable,
          ...(scope === "session" ? { heldForSessionOnly: true as const } : {}),
        });
      }
      const current = directPeerTurnCapOf(sessionId);
      const capRaise =
        cap !== undefined && cap > current
          ? { current, requested: cap }
          : undefined;
      if (cap !== undefined && !capRaise) held.push(`peer turn cap ${current}`);

      if (items.length === 0 && !capRaise)
        return {
          content: [
            {
              type: "text",
              text: `Already granted, no card created: ${held.join(", ")}.`,
            },
          ],
        };

      const body: ApprovalGrantsRequestBody = {
        kind: "approvalGrantsRequest",
        reason,
        items,
        ...(capRaise ? { peerTurnCap: capRaise } : {}),
      };
      const parts = [
        ...(items.length > 0
          ? [`${items.length} grant${items.length === 1 ? "" : "s"}`]
          : []),
        ...(capRaise ? [`up to ${capText(capRaise.requested)}`] : []),
      ];
      const card = createApproval({
        sessionId,
        kind: "approvalGrantsRequest",
        title: `Allow ${parts.join(" and ")} for this session`,
        ...(items.length > 0
          ? { summary: items.map((item) => item.label).join(", ") }
          : {}),
        sourceToolCallId: ctx.toolCallId,
        body,
        supersedes: (earlier) => earlier.kind === "approvalGrantsRequest",
      });
      const skipped =
        held.length > 0 ? ` Already held, left off: ${held.join(", ")}.` : "";
      return {
        content: [
          {
            type: "text",
            text: `Asked the user on one approval card. Nothing is granted until they approve it; end your turn now.${skipped} ${approvalCardReference(card)}`,
          },
        ],
        terminate: true,
      };
    },
  });

/** Unique, requestable keys with their scope; anything else throws. */
function parseGrants(
  grants: ApprovalGrantsRequestParams["grants"],
): Array<{ key: string; inheritable: boolean }> {
  if (grants === undefined) return [];
  if (!Array.isArray(grants)) throw new Error("grants must be an array.");
  const seen = new Set<string>();
  return grants.map((grant) => {
    const key = typeof grant?.key === "string" ? grant.key : "";
    if (!requestableUpFront(key))
      throw new Error(
        `"${key}" cannot be requested: use a key the grants schema lists. Tag publishing, settings input and commit review overrides are never requestable.`,
      );
    if (seen.has(key)) throw new Error(`${key} is listed twice.`);
    seen.add(key);
    if (
      grant.alsoSpawnedSessions !== undefined &&
      typeof grant.alsoSpawnedSessions !== "boolean"
    )
      throw new Error(`alsoSpawnedSessions of ${key} must be a boolean.`);
    return { key, inheritable: grant.alsoSpawnedSessions === true };
  });
}

function requestBody(card: ApprovalCard): ApprovalGrantsRequestBody {
  if (card.body.kind !== "approvalGrantsRequest")
    throw new Error("Mismatched approval body for approvalGrantsRequest.");
  return card.body;
}

/**
 * Settle the user's selection while the card is still pending: only keys the
 * card lists, a scope each, and a cap within bounds or none. It reads no live
 * state, so a refusal changes nothing and leaves the card to fix.
 */
function settleSelection(
  body: ApprovalGrantsRequestBody,
  edits: ApprovalResolutionEdits | undefined,
): NonNullable<ApprovalGrantsRequestBody["approved"]> {
  if (edits?.kind !== "approvalGrantsRequest")
    return {
      keys: body.items.map(({ key, inheritable }) => ({ key, inheritable })),
      ...(body.peerTurnCap ? { peerTurnCap: body.peerTurnCap.requested } : {}),
    };
  const listed = new Set(body.items.map((item) => item.key));
  const seen = new Set<string>();
  for (const { key, inheritable } of edits.keys) {
    if (!listed.has(key) || seen.has(key))
      throw new Error(`${key} is not on this request.`);
    if (typeof inheritable !== "boolean")
      throw new Error(`Choose a scope for ${key}.`);
    seen.add(key);
  }
  if (edits.peerTurnCap !== undefined) {
    if (!body.peerTurnCap)
      throw new Error("This request does not ask for a peer turn cap.");
    if (!isSessionPeerTurnCap(edits.peerTurnCap))
      throw new Error(
        `The peer turn cap must be an integer from 1 to ${MAX_SESSION_PEER_TURN_CAP}.`,
      );
  }
  if (edits.keys.length === 0 && edits.peerTurnCap === undefined)
    throw new Error("Tick at least one grant or the cap, or reject the card.");
  return {
    keys: edits.keys.map(({ key, inheritable }) => ({ key, inheritable })),
    ...(edits.peerTurnCap !== undefined
      ? { peerTurnCap: edits.peerTurnCap }
      : {}),
  };
}

/** One line for the card and the agent: what was granted, declined and raised. */
function resultText(result: ApprovalGrantsRequestResult): string {
  const lines: string[] = [];
  if (result.granted.length > 0)
    lines.push(
      `Granted: ${result.granted
        .map(({ key, inheritable }) => `${key} (${scopeText(inheritable)})`)
        .join(", ")}.`,
    );
  if (result.declined.length > 0)
    lines.push(`Not granted: ${result.declined.join(", ")}.`);
  const cap = result.peerTurnCap;
  if (cap?.outcome === "raised")
    lines.push(`Peer turn cap raised from ${cap.from} to ${cap.to}.`);
  else if (cap?.outcome === "unchanged")
    lines.push(`Peer turn cap unchanged (${cap.current}).`);
  else if (cap?.outcome === "declined")
    lines.push("Peer turn cap not raised: the user unticked it.");
  return lines.join(" ");
}

registerApprovalExecutor("approvalGrantsRequest", {
  async prepare(card, edits) {
    const body = requestBody(card);
    return { ...body, approved: settleSelection(body, edits) };
  },
  async execute(card) {
    const body = requestBody(card);
    const approved = body.approved;
    if (!approved) throw new Error("The request has no settled selection.");
    // Grants first, recorded on the live body before the cap: a cap failure
    // keeps them, and the failed card and its handoff still say so.
    const granted = grantRequestedOperations(card, approved.keys);
    const chosen = new Set(approved.keys.map(({ key }) => key));
    const result: ApprovalGrantsRequestResult = {
      granted,
      declined: body.items
        .map((item) => item.key)
        .filter((key) => !chosen.has(key)),
    };
    body.result = result;
    if (body.peerTurnCap) {
      if (approved.peerTurnCap === undefined)
        result.peerTurnCap = { outcome: "declined" };
      else {
        // Read, compare and set with no await between: only ever a raise.
        const current = directPeerTurnCapOf(card.sessionId);
        if (approved.peerTurnCap <= current)
          result.peerTurnCap = { outcome: "unchanged", current };
        else
          try {
            setSessionPeerTurnCap(card.sessionId, approved.peerTurnCap);
            result.peerTurnCap = {
              outcome: "raised",
              from: current,
              to: approved.peerTurnCap,
            };
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            result.peerTurnCap = { outcome: "failed", error };
            throw new Error(
              `${resultText(result)} Peer turn cap not raised: ${error}`.trim(),
            );
          }
      }
    }
    return { resultSummary: resultText(result) };
  },
});

export const approvalGrantsRequestTools = [approvalGrantsRequestTool];
