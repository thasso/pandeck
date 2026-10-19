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
 *   IS the choice the human already made, including Automatic or a pinned
 *   account, and an unknown id is refused rather
 *   than downgraded to a proposal.
 * - `propose` ([Task-553](pa://task/553)) is the original path for anything
 *   outside the roster: it creates nothing, writes one approval card and ends
 *   the turn, and the user chooses each session's runtime there.
 * - `agents` ([Task-783](pa://task/783)) reads the agent definitions and what
 *   each would run on now. Read-only. A `spawn` row naming one with `agent`
 *   takes its persona and effort from the definition the user approved, and
 *   one of the models it lists (`modelId`, else the first), instead of a
 *   roster row; a `propose` row naming one keeps the role on whatever runtime
 *   the user picks ([Task-795](pa://task/795), `docs/agent-definitions.md`).
 *
 * What either path creates is an ordinary session the user can read, re-prompt
 * and take over — never a subagent, and nothing here reaches that registry.
 */
import type { AgentModelChoice } from "../../agents/agentRuntime.ts";
import {
  listSpawnableAgents,
  type SpawnableAgent,
} from "../../agents/agentSpawn.ts";
import { MAX_LISTED_ENTRIES } from "../library/libraryTools.ts";
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

type SpawnOperation = "profiles" | "agents" | "spawn" | "propose";
type SpawnParams = { operation?: unknown; sessions?: unknown };

export function sessionSpawnTools(): AgentTool[] {
  return [makeSessionSpawnTool()];
}

function makeSessionSpawnTool() {
  return defineAgentTool<SpawnParams>({
    name: "session_spawn",
    label: "Spawn Sessions",
    description:
      'Start NEW app sessions to work alongside you — an implementer and a reviewer, say. `operation: "profiles"` shows which runtimes the user pre-approved, each with its model family, user-set relative cost and optional selection hint; a second read-only operation shows the user\'s named role definitions (a test reviewer, say, each with its own instructions, the models it may run on and an effort; see `operation`); both are read-only and remain available in Plan mode. `operation: "spawn"` starts sessions IMMEDIATELY on those exact approved runtimes or as one of those definitions on a model it lists, and returns their session ids; `spawn` and `propose` are Build-only. `operation: "propose"` is for anything else: it creates nothing, puts one card in front of the user who picks each runtime, and you end your turn and continue when the decision arrives. Each child is an ordinary conversation the user can watch and take over. Use this for work that deserves its own session, not small tasks. Choose owner "user" for work the user will run or follow themselves; those sessions go to their inbox and owe you no reply. Default owner "coordinator" is for helpers whose results you need to continue, such as your implementer and reviewer. YOU own those helpers: keep their ids, expect peer replies, chase quiet ones, and use session_control to stop a still-owned child or clear queued work. Route review findings back to the implementer and re-review until the reviewer passes the exact target or you escalate to the user. Never poll or sleep waiting for them, and never read a silent session as a success.',
    searchHint:
      "spawn start delegate implementer reviewer parallel helpers approved runtimes profiles cross-family review named role definitions",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["profiles", "agents", "spawn", "propose"],
          description:
            'What to do. "profiles": list the approved runtimes (no other field; read-only and available in Plan). "agents": list the agent definitions and what each runs on (no other field; read-only and available in Plan). "spawn": start sessions now (Build-only), every row naming a profileId from "profiles" or an agent from "agents". "propose": ask the user to approve a batch (Build-only), rows may carry provider/modelId/thinkingLevel hints instead.',
        },
        sessions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SPAWN_ROWS,
          description: `The sessions, at most ${MAX_SPAWN_ROWS} — one card has to stay readable, and at most ${MAX_CONCURRENT_DIRECT_PEER_TURNS} directly spawned peer turns may run at once. Required for "spawn" and "propose", forbidden for "profiles" and "agents".`,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "prompt"],
            properties: {
              title: {
                type: "string",
                description: `The new session's title, at most ${MAX_SPAWN_TITLE_CHARS} characters. It is what the user sees in their sidebar, and it replaces automatic naming — so name a set consistently ("Implementer: auth refactor", "Reviewer: auth refactor").`,
              },
              agentType: {
                type: "string",
                enum: ["developer", "assistant"],
                description:
                  "Persona for the new session. A developer session works in a repository and REQUIRES worktreeId; an assistant session does not. Required, except on an agent row, whose definition decides it.",
              },
              prompt: {
                type: "string",
                description: `The opening prompt, delivered as a peer message from you. Required: a session begins with its first prompt, so there is no way to create a silent one. Max ${MAX_PEER_PROMPT_CHARS} characters. Make it self-contained — the new session has none of your context — and state its role, its exact target and what a finished result looks like. On coordinator-owned "spawn" the server appends a report-back instruction, reducing the available prompt budget; user-owned rows get the full limit.`,
              },
              profileId: {
                type: "string",
                description:
                  'On "spawn", this or agent is required; forbidden for "propose": the id of an approved runtime from `operation: "profiles"`. Automatic rows route the account, never the model or effort. An unknown, disabled or unavailable id is refused, never substituted or proposed.',
              },
              agent: {
                type: "string",
                description:
                  'Instead of profileId and agentType: the name of an agent definition from `operation: "agents"`. The session runs as that agent — its persona, instructions, denied tools and skills — and a developer agent still needs worktreeId. On "spawn" it tries the definition\'s first model at its effort, then the next listed model with eligible accounts if the first is benched or unhealthy. An explicit modelId selects exactly that listed model, never a fallback. On "propose" the user picks any runtime for it in the card. The prompt names the target and the task; the definition is the role.',
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
              owner: {
                type: "string",
                enum: ["coordinator", "user"],
                description:
                  'Who owns this work from creation. Defaults to "coordinator"; "user" keeps provenance without reporting instructions or coordinator stop authority.',
              },
              responseRequested: {
                type: "boolean",
                description:
                  'Record an awaited answer. Defaults to true on coordinator-owned "spawn", false on "propose" and user-owned rows.',
              },
              inheritGrants: {
                type: "boolean",
                description:
                  "Defaults to true: the new session's cards are covered by every Approve-for-session grant you or your spawn ancestors hold. Set false for a session that should ask for everything itself, such as a reviewer; nothing reaches it, or its own spawns, from above it.",
              },
              provider: {
                type: "string",
                description:
                  'Only for "propose": optional model-provider hint, e.g. `claude-sdk`. Omit it and the session inherits YOUR runtime, or an agent row its definition\'s first model; the user picks in the card either way.',
              },
              modelId: {
                type: "string",
                description:
                  'On "propose": optional model hint, e.g. `sonnet`. An unavailable one is not an error, it is shown to the user as a note next to the model that would run instead. On "spawn", only with agent: one of the models that definition lists; any other is refused.',
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
              requiresEnterprise: {
                type: "boolean",
                description:
                  "true runs this session only on an account marked enterprise: Automatic and agent rows route among enterprise accounts, and a personal account pin is refused, never replaced. If your session requires enterprise, every child does and false cannot relax it.",
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
      if (operation === "profiles" || operation === "agents") {
        if (params.sessions !== undefined)
          throw new Error(`operation "${operation}" takes no sessions.`);
        const text =
          operation === "profiles" ? await rosterText() : await agentsText();
        return { content: [{ type: "text", text }] };
      }
      if (sessionStore.get(ctx.session.sessionId)?.mode === "plan")
        throw new Error(
          `operation "${operation}" is Build-only; operations "profiles" and "agents" remain available in Plan mode.`,
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

/* --------------------------------- agents --------------------------------- */

/** The definitions as the coordinator reads them, with why any cannot run. */
async function agentsText(): Promise<string> {
  return spawnableAgentsText(
    await listSpawnableAgents(undefined, { allowModelFallback: true }),
  );
}

/** A description longer than this is cut; `agent_get` reads it whole. */
const MAX_LISTED_DESCRIPTION_CHARS = 300;

/**
 * The listing, bounded like `agent_list`: a hand-authored library has no
 * entry ceiling, and this answer lands in the caller's context whole. The
 * header states the true total, and any definition can still be spawned by
 * name or read with `agent_get`.
 */
export function spawnableAgentsText(agents: readonly SpawnableAgent[]): string {
  if (agents.length === 0)
    return "No agent definitions exist. The user, or agent_create with their approval, can add one.";
  const shown = agents.slice(0, MAX_LISTED_ENTRIES);
  const lines = shown.map((agent) => {
    if ("problem" in agent) {
      // A default that cannot run may leave other listed models to try; they
      // resolve, and their accounts are checked when one is named.
      const runnable = (agent.listed ?? []).filter((choice) => choice.runtime);
      if (runnable.length === 0)
        return `- ${agent.name}: CANNOT SPAWN — ${clip(agent.problem, "spawning it refuses with the whole reason")}`;
      return [
        `- ${agent.name}: ${clip(agent.description ?? "", "agent_get reads it whole")}`,
        `  its default model cannot run — ${clip(agent.problem, "spawning it refuses with the whole reason")}`,
        `  other listed models that resolve now, named as modelId: ${runnable.map(listedText).join("; ")}`,
      ].join("\n");
    }
    const { runtime } = agent;
    // The other listed models, as a caller names them in modelId.
    const others = runtime.listed
      .filter(
        (choice) =>
          choice.runtime?.model.provider !== runtime.provider ||
          choice.runtime.model.id !== runtime.modelId,
      )
      .map(listedText);
    return [
      `- ${agent.name}: ${clip(agent.description, "agent_get reads it whole")}`,
      `  ${runtime.agent.persona} on ${runtime.provider}/${runtime.modelId}${
        runtime.agent.pinnedModel
          ? ` (pinned ${runtime.agent.pinnedModel})`
          : ""
      }, ${runtime.thinkingLevel} effort${
        runtime.accountName ? `, account ${runtime.accountName}` : ""
      }${runtime.agent.persona === "developer" ? "; needs a worktreeId" : ""}`,
      ...(runtime.agent.modelFallbackReason
        ? [`  ${runtime.agent.modelFallbackReason}`]
        : []),
      ...(others.length > 0 ? [`  also runs on: ${others.join("; ")}`] : []),
    ].join("\n");
  });
  const omitted = agents.length - shown.length;
  return [
    `Agent definitions (${agents.length}${omitted > 0 ? `, the first ${shown.length} listed` : ""}). Spawn one with a row naming it as agent (no profileId, no agentType); it tries its first model, then the next listed model with eligible accounts if the first is benched or unhealthy. An explicit modelId never falls back. Any other runtime needs operation "propose" with the agent. The prompt still states the target and the task.`,
    ...lines,
    ...(omitted > 0
      ? [
          `${omitted} more not listed; any definition can still be spawned by its name.`,
        ]
      : []),
  ].join("\n");
}

/** One listed model as a caller names it in modelId, or why it cannot run. */
function listedText(choice: AgentModelChoice): string {
  return choice.runtime
    ? `${choice.spec} (${choice.runtime.model.provider}/${choice.runtime.model.id}, ${choice.runtime.thinkingLevel} effort)`
    : `${choice.spec} (cannot run: ${clip(choice.problem, "spawning on it refuses with the whole reason")})`;
}

/** `text`, cut with a pointer to where the rest is. */
function clip(text: string, whereWhole: string): string {
  return text.length > MAX_LISTED_DESCRIPTION_CHARS
    ? `${text.slice(0, MAX_LISTED_DESCRIPTION_CHARS)}… (${whereWhole})`
    : text;
}

/* ------------------------------ direct spawn ------------------------------ */

async function runDirectSpawn(
  rows: ReturnType<typeof readRows>,
  ctx: { session: { sessionId: string } },
) {
  const suffixChars = directSpawnReportingSuffix(ctx.session.sessionId).length;
  const coordinatorBudget = MAX_PEER_PROMPT_CHARS - suffixChars;
  // Runtime hints and unknown properties were refused on the RAW row
  // (`checkRawRow`), where a stated value cannot be confused with an omitted
  // one. What is left here is this operation's own requirement.
  const direct: DirectSpawnRequestRow[] = rows.map((row) => {
    if (!row.profileId && !row.agent)
      throw new Error(
        `"${row.title}" has no profileId or agent. Call operation "profiles" or "agents" and name one approved runtime or one agent definition per row.`,
      );
    const budget =
      row.owner === "user" ? MAX_PEER_PROMPT_CHARS : coordinatorBudget;
    if (row.prompt.length > budget)
      throw new Error(
        `The opening prompt for "${row.title}" is ${row.prompt.length} characters; the limit is ${budget}${row.owner === "user" ? "." : " (the server appends your session id and the reporting instructions)."}`,
      );
    return {
      title: row.title,
      prompt: row.prompt,
      ...(row.owner === undefined ? {} : { owner: row.owner }),
      ...(row.agent
        ? {
            agent: row.agent,
            ...(row.modelId === undefined ? {} : { modelId: row.modelId }),
          }
        : { profileId: row.profileId!, agentType: row.agentType! }),
      ...(row.responseRequested === undefined
        ? {}
        : { responseRequested: row.responseRequested }),
      ...(row.inheritGrants === undefined
        ? {}
        : { inheritGrants: row.inheritGrants }),
      ...(row.worktreeId ? { worktreeId: row.worktreeId } : {}),
      ...(row.projectId ? { projectId: row.projectId } : {}),
      ...(row.taskId ? { taskId: row.taskId } : {}),
      ...(row.requiresEnterprise === undefined
        ? {}
        : { requiresEnterprise: row.requiresEnterprise }),
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
      ? `${row.runtime.name} (${row.runtime.provider}/${row.runtime.modelId}, ${row.runtime.thinkingLevel} thinking, family ${row.runtime.family}${
          row.runtime.relativeCost
            ? `, relative cost ${row.runtime.relativeCost}`
            : ""
        })`
      : row.agent
        ? `agent ${row.agent}`
        : `profile ${row.profileId}`;
    if (!row.sessionId)
      return `- "${row.title}" NOT started on ${runtime}: ${row.error ?? "unknown error"}`;
    return `- "${row.title}" → session ${row.sessionId} on ${runtime}, owner ${row.owner}${
      row.inheritGrants === false ? ", doesn't inherit your approvals" : ""
    }${row.runtime?.modelFallbackReason ? `; ${row.runtime.modelFallbackReason}` : ""}${
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
    ...(started.some((row) => row.owner === "coordinator")
      ? [
          "Coordinator-owned sessions were told to report back to you with session_send_prompt. Keep these ids: nothing else will tell you how they finish, an idle session is not a success, and closing the loop — chasing a quiet one, handing findings back, re-reviewing, or stopping a still-owned child with session_control — is yours.",
        ]
      : []),
    ...(started.some((row) => row.owner === "user")
      ? ["User-owned sessions are in the user's inbox; they owe you no report."]
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
      // `checkRawRow` proved each row names an agent or an agentType.
      rows: rows.map(
        ({ profileId: _profile, agent, agentType, ...row }): SpawnRequestRow =>
          agent !== undefined
            ? { ...row, agent }
            : { ...row, agentType: agentType! },
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
  if (
    value === "profiles" ||
    value === "agents" ||
    value === "spawn" ||
    value === "propose"
  )
    return value;
  throw new Error(
    'operation must be "profiles", "agents", "spawn" or "propose" (got ' +
      `${JSON.stringify(value)}).`,
  );
}

/**
 * One row as parsed off the wire; which fields are legal is the caller's rule.
 * `agentType` is absent exactly on an agent row.
 */
type ParsedRow = Omit<SpawnRequestRow, "agentType" | "agent"> & {
  agentType?: "developer" | "assistant";
  profileId?: string;
  agent?: string;
};

/** Every property a row may carry, on any operation. */
const ROW_PROPERTIES = [
  "title",
  "agentType",
  "prompt",
  "profileId",
  "agent",
  "worktreeId",
  "projectId",
  "taskId",
  "responseRequested",
  "inheritGrants",
  "owner",
  "provider",
  "modelId",
  "thinkingLevel",
  "requiresEnterprise",
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
  operation: Exclude<SpawnOperation, "profiles" | "agents">,
): void {
  const where = `sessions[${index}]`;
  for (const key of Object.keys(row))
    if (!(ROW_PROPERTIES as readonly string[]).includes(key))
      throw new Error(
        `${where} sets "${key}", which is not a field of a session request (allowed: ${ROW_PROPERTIES.join(", ")}). In particular the provider ACCOUNT is never a parameter here: on "spawn" the approved runtime named by profileId decides it, and on "propose" the user chooses it in the card.`,
      );

  if (operation === "spawn") {
    for (const key of RUNTIME_HINTS)
      if (stated(row, key) && !(key === "modelId" && stated(row, "agent")))
        throw new Error(
          stated(row, "agent")
            ? `${where} sets ${key}, which an agent row does not accept: the definition decides the effort, modelId picks one of its listed models, and the account follows from the model. Use operation "propose" with the agent to ask the user for a different runtime.`
            : `${where} sets ${key}, which operation "spawn" does not accept: the approved runtime named by profileId decides the account, model and thinking level. Use operation "propose" to ask the user for a different runtime.`,
        );
    if (stated(row, "agent") && stated(row, "profileId"))
      throw new Error(
        `${where} names an agent and sets profileId: an agent runs on one of the models its definition lists, chosen with modelId. Drop profileId, or use operation "propose" with the agent to ask the user for another runtime.`,
      );
  } else if (stated(row, "profileId"))
    throw new Error(
      `${where} names a profileId, which belongs to operation "spawn". A proposal lets the user pick the runtime, so drop it or spawn directly.`,
    );
  if (stated(row, "agent") && stated(row, "agentType"))
    throw new Error(
      `${where} names an agent and sets agentType: the definition decides the persona, so drop agentType.`,
    );

  // Kind checks for what remains. A stated value of the wrong type is refused
  // rather than ignored, for the same reason: silence would hide the request.
  for (const key of ROW_PROPERTIES) {
    if (!stated(row, key)) continue;
    const value = row[key];
    if (
      key === "responseRequested" ||
      key === "requiresEnterprise" ||
      key === "inheritGrants"
    ) {
      if (typeof value !== "boolean")
        throw new Error(`${where}.${key} must be true or false.`);
      continue;
    }
    if (typeof value !== "string" || !value.trim())
      throw new Error(
        `${where}.${key} must be a non-empty string — omit the field instead of sending ${JSON.stringify(value)}.`,
      );
  }

  for (const key of ["title", "prompt"] as const)
    if (!stated(row, key)) throw new Error(`${where}.${key} is required.`);
  if (!stated(row, "agent") && !stated(row, "agentType"))
    throw new Error(
      `${where}.agentType is required unless the row names an agent.`,
    );
}

/** Shape-check the array, then read the rows it is now safe to read. */
function readRows(
  value: unknown,
  operation: Exclude<SpawnOperation, "profiles" | "agents">,
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
      ...(stated(row, "agentType")
        ? { agentType: text(row.agentType) as ParsedRow["agentType"] }
        : {}),
      prompt: text(row.prompt),
      ...(typeof row.responseRequested === "boolean"
        ? { responseRequested: row.responseRequested }
        : {}),
      ...(typeof row.requiresEnterprise === "boolean"
        ? { requiresEnterprise: row.requiresEnterprise }
        : {}),
      ...(typeof row.inheritGrants === "boolean"
        ? { inheritGrants: row.inheritGrants }
        : {}),
      ...optional(row, "owner"),
      ...optional(row, "profileId"),
      ...optional(row, "agent"),
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
