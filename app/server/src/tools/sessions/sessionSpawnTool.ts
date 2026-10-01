/**
 * `session_spawn`: start ordinary peer sessions, or propose them for approval.
 *
 * Three operations, one tool, because the authority differs and nothing else
 * does:
 *
 * - `profiles` ([Task-595](pa://task/595)) reads the runtimes the user has
 *   pre-approved, including their user-set cost and selection hints. Read-only.
 * - `spawn` (Task-595) creates sessions IMMEDIATELY on those exact runtimes.
 *   No model, provider, account or thinking field exists here: the roster row
 *   IS the choice the human already made, and an unknown id is refused rather
 *   than downgraded to a proposal.
 * - `propose` ([Task-553](pa://task/553)) is the original path for anything
 *   outside the roster: it creates nothing, writes one approval card and ends
 *   the turn, and the user chooses each session's runtime there.
 *
 * What either path creates is an ordinary session the user can read, re-prompt
 * and take over — never a subagent, and nothing here reaches that registry.
 */
import { defineAgentTool, type AgentTool } from "../../mcp/tool.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import {
  approvalCardReference,
  createApproval,
} from "../../pendingApprovals.ts";
import { MAX_PEER_PROMPT_CHARS } from "../../peerPrompt.ts";
import {
  directSpawnReportingSuffix,
  peerRuntimeRoster,
  PeerRuntimeRefusedError,
  MAX_CONCURRENT_DIRECT_PEER_TURNS,
} from "../../peerSpawnRuntimes.ts";
import {
  buildSpawnProposal,
  spawnApprovedPeers,
  MAX_SPAWN_ROWS,
  MAX_SPAWN_TITLE_CHARS,
  SpawnProposalError,
  type DirectSpawnRequestRow,
  type DirectSpawnRowResult,
  type SpawnRequestRow,
} from "../../sessionSpawn.ts";

type SpawnOperation = "profiles" | "spawn" | "propose";
type SpawnParams = { operation?: unknown; sessions?: unknown };

export function sessionSpawnTools(): AgentTool[] {
  return [makeSessionSpawnTool()];
}

function makeSessionSpawnTool() {
  return defineAgentTool<SpawnParams>({
    name: "session_spawn",
    label: "Spawn Sessions",
    description:
      'Start NEW app sessions to work alongside you — an implementer and a reviewer, say. `operation: "profiles"` shows which runtimes the user pre-approved, each with its model family, user-set relative cost and optional selection hint; it is read-only and remains available in Plan mode. `operation: "spawn"` starts sessions IMMEDIATELY on those exact approved runtimes and returns their session ids; `spawn` and `propose` are Build-only. `operation: "propose"` is for anything else: it creates nothing, puts one card in front of the user who picks each runtime, and you end your turn and continue when the decision arrives. Each session is an ordinary conversation the user can watch and take over, so use this for work that deserves its own session and stay where you are for anything smaller. YOU own what you start: keep the returned ids, expect each one to answer you with a peer message, follow up yourself when one goes quiet, and use session_control if you need to stop a still-owned child or clear queued work. Route review findings back to the implementer and re-review until the reviewer passes the exact target or you escalate to the user. Never poll or sleep waiting for them, and never read a silent session as a success.',
    searchHint:
      "spawn start delegate implementer reviewer parallel helpers approved runtimes profiles cross-family review",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["profiles", "spawn", "propose"],
          description:
            'What to do. "profiles": list the approved runtimes (no other field; read-only and available in Plan). "spawn": start sessions now (Build-only), every row naming a profileId from that list. "propose": ask the user to approve a batch (Build-only), rows may carry provider/modelId/thinkingLevel hints instead.',
        },
        sessions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SPAWN_ROWS,
          description: `The sessions, at most ${MAX_SPAWN_ROWS} — one card has to stay readable, and at most ${MAX_CONCURRENT_DIRECT_PEER_TURNS} directly spawned peer turns may run at once. Required for "spawn" and "propose", forbidden for "profiles".`,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "agentType", "prompt"],
            properties: {
              title: {
                type: "string",
                description: `The new session's title, at most ${MAX_SPAWN_TITLE_CHARS} characters. It is what the user sees in their sidebar, and it replaces automatic naming — so name a set consistently ("Implementer: auth refactor", "Reviewer: auth refactor").`,
              },
              agentType: {
                type: "string",
                enum: ["developer", "assistant"],
                description:
                  "Persona for the new session. A developer session works in a repository and REQUIRES worktreeId; an assistant session does not.",
              },
              prompt: {
                type: "string",
                description: `The opening prompt, delivered as a peer message from you. Required: a session begins with its first prompt, so there is no way to create a silent one. Max ${MAX_PEER_PROMPT_CHARS} characters. Make it self-contained — the new session has none of your context — and state its role, its exact target and what a finished result looks like. On "spawn" the server also appends your session id and tells it to report back to you.`,
              },
              profileId: {
                type: "string",
                description:
                  'Required for "spawn", forbidden for "propose": the id of an approved runtime from `operation: "profiles"`. An unknown, disabled or currently unavailable id is refused — nothing falls back to another runtime or turns into a proposal.',
              },
              worktreeId: {
                type: "string",
                description:
                  "Registered worktree the session runs in (see worktree_status / worktree_create). Never a path.",
              },
              projectId: {
                type: "string",
                description:
                  "Project context for the session. Defaults to the worktree's project.",
              },
              taskId: {
                type: "string",
                description:
                  "Task this session works on: it is linked to the Task and the prompt names it.",
              },
              responseRequested: {
                type: "boolean",
                description:
                  'Record that you are awaiting an answer from this session. Defaults to true on "spawn" (you own its closure) and false on "propose".',
              },
              provider: {
                type: "string",
                description:
                  'Only for "propose": optional model-provider hint, e.g. `claude-sdk`. Omit it and the session inherits YOUR runtime; the user picks in the card either way.',
              },
              modelId: {
                type: "string",
                description:
                  'Only for "propose": optional model hint, e.g. `sonnet`. An unavailable one is not an error, it is shown to the user as a note next to the model that would run instead.',
              },
              thinkingLevel: {
                type: "string",
                enum: [
                  "off",
                  "minimal",
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                  "max",
                ],
                description:
                  'Only for "propose": optional thinking hint, lowered to what the resolved model supports. Defaults to yours.',
              },
            },
          },
        },
      },
    } as const,
    async execute(params, ctx) {
      // Same reason as the per-row allowlist below: the schema's
      // `additionalProperties: false` is not enforced before this point, and a
      // runtime or account hint smuggled in at the top level must be an error
      // rather than a field nobody reads.
      for (const key of Object.keys(params))
        if (key !== "operation" && key !== "sessions")
          throw new Error(
            `session_spawn takes only "operation" and "sessions" (got "${key}").`,
          );
      const operation = readOperation(params.operation);
      if (operation === "profiles") {
        if (params.sessions !== undefined)
          throw new Error('operation "profiles" takes no sessions.');
        return { content: [{ type: "text", text: await rosterText() }] };
      }
      if (sessionStore.get(ctx.session.sessionId)?.mode === "plan")
        throw new Error(
          `operation "${operation}" is Build-only; operation "profiles" remains available in Plan mode.`,
        );
      const rows = readRows(params.sessions, operation);
      if (operation === "spawn") return await runDirectSpawn(rows, ctx);
      return await runProposal(rows, ctx);
    },
  });
}

/* -------------------------------- profiles -------------------------------- */

/** The roster as the coordinator reads it: bounded, ordered, honest about gaps. */
async function rosterText(): Promise<string> {
  const roster = await peerRuntimeRoster();
  if (roster.length === 0)
    return 'No peer runtimes are approved. Ask the user to add one under Settings → Peer sessions, or use operation "propose" so they can approve this batch in a card.';
  const lines = roster.map((entry) => {
    const runtime = `${entry.provider}/${entry.modelId}, ${entry.thinkingLevel} thinking${
      entry.accountName ? `, account ${entry.accountName}` : ""
    }`;
    const state = entry.available
      ? "available"
      : `UNAVAILABLE — ${entry.unavailableReason}`;
    return [
      `- ${entry.profileId}: ${entry.name} (${runtime})`,
      `  ${state}; family ${entry.family}, user-set relative cost ${entry.relativeCost}`,
      entry.description
        ? `  User selection hint: ${entry.description}`
        : "  No user selection hint provided.",
    ].join("\n");
  });
  return [
    `Approved peer runtimes (${roster.length}), in the user's order. Use one id as a row's profileId.`,
    ...lines,
    `Cost labels and selection hints are user-provided guidance, not prices or authorization beyond the exact approved row. Family is inferred by the host; "unknown" cannot satisfy a request for cross-family review — ask the user.`,
  ].join("\n");
}

/* ------------------------------ direct spawn ------------------------------ */

async function runDirectSpawn(
  rows: ReturnType<typeof readRows>,
  ctx: { session: { sessionId: string } },
) {
  const suffixChars = directSpawnReportingSuffix(ctx.session.sessionId).length;
  const budget = MAX_PEER_PROMPT_CHARS - suffixChars;
  // Runtime hints and unknown properties were refused on the RAW row
  // (`checkRawRow`), where a stated value cannot be confused with an omitted
  // one. What is left here is this operation's own requirement.
  const direct: DirectSpawnRequestRow[] = rows.map((row) => {
    if (!row.profileId)
      throw new Error(
        `"${row.title}" has no profileId. Call operation "profiles" and name one approved runtime per row.`,
      );
    if (row.prompt.length > budget)
      throw new Error(
        `The opening prompt for "${row.title}" is ${row.prompt.length} characters; on a direct spawn the limit is ${budget} (the server appends your session id and the reporting instructions).`,
      );
    return {
      title: row.title,
      agentType: row.agentType,
      prompt: row.prompt,
      profileId: row.profileId,
      ...(row.responseRequested === undefined
        ? {}
        : { responseRequested: row.responseRequested }),
      ...(row.worktreeId ? { worktreeId: row.worktreeId } : {}),
      ...(row.projectId ? { projectId: row.projectId } : {}),
      ...(row.taskId ? { taskId: row.taskId } : {}),
    };
  });

  let results: DirectSpawnRowResult[];
  try {
    results = await spawnApprovedPeers({
      senderSessionId: ctx.session.sessionId,
      rows: direct,
    });
  } catch (err) {
    if (
      err instanceof SpawnProposalError ||
      err instanceof PeerRuntimeRefusedError
    )
      throw new Error(err.message);
    throw err;
  }
  return {
    content: [{ type: "text" as const, text: directSpawnText(results) }],
  };
}

/** Every id and runtime, so the coordinator can address and compare them. */
function directSpawnText(results: DirectSpawnRowResult[]): string {
  const started = results.filter((row) => row.sessionId);
  const lines = results.map((row) => {
    const runtime = row.runtime
      ? `${row.runtime.name} (${row.runtime.provider}/${row.runtime.modelId}, ${row.runtime.thinkingLevel} thinking, family ${row.runtime.family}, relative cost ${row.runtime.relativeCost})`
      : `profile ${row.profileId}`;
    if (!row.sessionId)
      return `- "${row.title}" NOT started on ${runtime}: ${row.error ?? "unknown error"}`;
    return `- "${row.title}" → session ${row.sessionId} on ${runtime}${
      row.error ? ` — created, but its opening prompt failed: ${row.error}` : ""
    }`;
  });
  const head =
    started.length === 0
      ? "No session was started."
      : `Started ${started.length} session${started.length === 1 ? "" : "s"}.`;
  return [
    head,
    ...lines,
    ...(started.length > 0
      ? [
          "They were told to report back to you with session_send_prompt. Keep these ids: nothing else will tell you how they finish, an idle session is not a success, and closing the loop — chasing a quiet one, handing findings back, re-reviewing, or stopping a still-owned child with session_control — is yours.",
        ]
      : []),
  ].join("\n");
}

/* -------------------------------- proposal -------------------------------- */

async function runProposal(
  rows: ReturnType<typeof readRows>,
  ctx: { toolCallId: string; session: { sessionId: string } },
) {
  for (const row of rows) {
    if (row.prompt.length > MAX_PEER_PROMPT_CHARS)
      throw new Error(
        `The opening prompt for "${row.title}" is ${row.prompt.length} characters; the limit is ${MAX_PEER_PROMPT_CHARS}.`,
      );
  }
  let body;
  try {
    body = await buildSpawnProposal({
      senderSessionId: ctx.session.sessionId,
      rows: rows.map(
        ({ profileId: _ignored, ...row }) => row as SpawnRequestRow,
      ),
    });
  } catch (err) {
    if (err instanceof SpawnProposalError) throw new Error(err.message);
    throw err;
  }
  const count = body.items.length;
  const card = createApproval({
    sessionId: ctx.session.sessionId,
    kind: "sessionSpawn",
    title: count === 1 ? "Start a session" : `Start ${count} sessions`,
    summary: body.items.map((item) => item.title).join(", "),
    sourceToolCallId: ctx.toolCallId,
    body,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: `Proposed ${count} session${count === 1 ? "" : "s"} (${body.items
          .map((item) => item.title)
          .join(
            ", ",
          )}) pending the user's approval. Nothing exists yet. End your turn: the decision, and the new session ids, arrive as a separate message. ${approvalCardReference(card)}`,
      },
    ],
    terminate: true,
  };
}

/* ------------------------------- parameters ------------------------------- */

function readOperation(value: unknown): SpawnOperation {
  if (value === "profiles" || value === "spawn" || value === "propose")
    return value;
  throw new Error(
    'operation must be "profiles", "spawn" or "propose" (got ' +
      `${JSON.stringify(value)}).`,
  );
}

/** One row as parsed off the wire; which fields are legal is the caller's rule. */
interface ParsedRow extends SpawnRequestRow {
  profileId?: string;
}

/** Every property a row may carry, on any operation. */
const ROW_PROPERTIES = [
  "title",
  "agentType",
  "prompt",
  "profileId",
  "worktreeId",
  "projectId",
  "taskId",
  "responseRequested",
  "provider",
  "modelId",
  "thinkingLevel",
] as const;

/** The runtime fields only a PROPOSAL may carry: the user picks them in the card. */
const RUNTIME_HINTS = ["provider", "modelId", "thinkingLevel"] as const;

/**
 * A property the caller actually stated.
 *
 * `undefined` reads as absent because JSON cannot express it and a harness that
 * spells an omitted field that way is saying nothing. Every other value —
 * including `null`, `7` and `""` — is a statement, and this path's whole
 * safety argument is that a statement is never silently dropped.
 */
function stated(row: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(row, key) && row[key] !== undefined;
}

/**
 * Shape-check one raw row for this operation, before anything reads a field.
 *
 * Two rules, both enforced on the RAW object rather than on parsed values.
 *
 * The schema says `additionalProperties: false` and declares each field's type,
 * but nothing between the model and here applies it: arguments arrive as raw
 * JSON. So an unknown property is an error, and so is a known property whose
 * value this tool would otherwise discard — `provider: 7`, `modelId: null`,
 * `thinkingLevel: ""`. Coercing those to "absent" was the bug: a direct spawn
 * would then SUCCEED on the roster's runtime while the caller's runtime request
 * left no trace anywhere.
 *
 * Which fields are forbidden depends on the operation, and that decision has to
 * happen here too: after parsing, a dropped value and an omitted field are
 * indistinguishable, which is exactly how a forbidden hint slipped through.
 */
function checkRawRow(
  row: Record<string, unknown>,
  index: number,
  operation: Exclude<SpawnOperation, "profiles">,
): void {
  const where = `sessions[${index}]`;
  for (const key of Object.keys(row))
    if (!(ROW_PROPERTIES as readonly string[]).includes(key))
      throw new Error(
        `${where} sets "${key}", which is not a field of a session request (allowed: ${ROW_PROPERTIES.join(", ")}). In particular the provider ACCOUNT is never a parameter here: on "spawn" the approved runtime named by profileId decides it, and on "propose" the user chooses it in the card.`,
      );

  if (operation === "spawn") {
    for (const key of RUNTIME_HINTS)
      if (stated(row, key))
        throw new Error(
          `${where} sets ${key}, which operation "spawn" does not accept: the approved runtime named by profileId decides the account, model and thinking level. Use operation "propose" to ask the user for a different runtime.`,
        );
  } else if (stated(row, "profileId"))
    throw new Error(
      `${where} names a profileId, which belongs to operation "spawn". A proposal lets the user pick the runtime, so drop it or spawn directly.`,
    );

  // Kind checks for what remains. A stated value of the wrong type is refused
  // rather than ignored, for the same reason: silence would hide the request.
  for (const key of ROW_PROPERTIES) {
    if (!stated(row, key)) continue;
    const value = row[key];
    if (key === "responseRequested") {
      if (typeof value !== "boolean")
        throw new Error(`${where}.responseRequested must be true or false.`);
      continue;
    }
    if (typeof value !== "string" || !value.trim())
      throw new Error(
        `${where}.${key} must be a non-empty string — omit the field instead of sending ${JSON.stringify(value)}.`,
      );
  }

  for (const key of ["title", "agentType", "prompt"] as const)
    if (!stated(row, key)) throw new Error(`${where}.${key} is required.`);
}

/** Shape-check the array, then read the rows it is now safe to read. */
function readRows(
  value: unknown,
  operation: Exclude<SpawnOperation, "profiles">,
): ParsedRow[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("sessions must be a non-empty array of session requests.");
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new Error(`sessions[${index}] must be an object.`);
    const row = entry as Record<string, unknown>;
    checkRawRow(row, index, operation);
    return {
      title: text(row.title),
      agentType: text(row.agentType) as SpawnRequestRow["agentType"],
      prompt: text(row.prompt),
      ...(typeof row.responseRequested === "boolean"
        ? { responseRequested: row.responseRequested }
        : {}),
      ...optional(row, "profileId"),
      ...optional(row, "worktreeId"),
      ...optional(row, "projectId"),
      ...optional(row, "taskId"),
      ...optional(row, "provider"),
      ...optional(row, "modelId"),
      ...optional(row, "thinkingLevel"),
    } as ParsedRow;
  });
}

/** Trim a value `checkRawRow` has already proven to be a non-empty string. */
function text(value: unknown): string {
  return String(value).trim();
}

function optional(
  row: Record<string, unknown>,
  key: string,
): Record<string, string> {
  return stated(row, key) ? { [key]: text(row[key]) } : {};
}
