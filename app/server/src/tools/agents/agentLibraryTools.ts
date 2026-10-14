/**
 * The agent definitions library's `agent_*` tool group
 * (`docs/agent-definitions.md` "Authoring tools"): the shared library tool
 * factory with the agent kind's create fields, and one rule on top of it —
 * WHAT a definition runs on is the user's call. A create always sets a model,
 * so it always becomes an approval card; an edit that changes `model` or
 * `effort` becomes one too. Every other edit commits directly, after the same
 * runtime check, judged inside the locked write.
 */
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  THINKING_LEVELS,
  type AgentDefinitionApprovalBody,
  type ApprovalCard,
  type ThinkingLevel,
} from "@assistant/shared";
import {
  AGENT_DEFAULT_EFFORT,
  AGENT_PERSONAS,
  agentKind,
  agentLibraryStore,
  formatAgentManifest,
  type AgentDefinitionInput,
  type AgentManifest,
  type AgentPersona,
} from "../../agents/agentLibrary.ts";
import { checkAgentRuntime } from "../../agents/agentRuntime.ts";
import {
  assertManifest,
  assertManifestSize,
  EntryValidationError,
} from "../../library/entryManifest.ts";
import {
  createEntry,
  editEntrySource,
  MAX_ENTRY_SOURCE_BYTES,
  previewEntryEdit,
  readEntrySource,
  readLibraryOverview,
} from "../../library/libraryAuthoring.ts";
import type {
  LibraryCommitMeta,
  LibraryStore,
} from "../../library/libraryStore.ts";
import type { AgentTool, ToolCallContext } from "../../mcp/tool.ts";
import {
  approvalCardReference,
  createApproval,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import { libraryTools, type PendingApproval } from "../library/libraryTools.ts";

let libraryFactory = (): LibraryStore => agentLibraryStore;

/** Test-only seam so tool tests run against an isolated temp library. */
export function setAgentToolLibraryForTests(
  factory: (() => LibraryStore) | null,
): void {
  libraryFactory = factory ?? (() => agentLibraryStore);
}

const PENDING_NOTE =
  "Nothing is written yet. Do not claim it succeeded until the approved result appears.";

/** What a definition says it runs on, for comparing two versions of it. */
function runsOn(manifest: {
  model: string;
  effort?: ThinkingLevel | undefined;
}): string {
  return `${manifest.model}\u0000${manifest.effort ?? ""}`;
}

function manifestPath(name: string): string {
  return `${name}/${agentKind.manifestFile}`;
}

/** The server-only half of a card: what execution replays. */
interface AgentCardContext {
  meta: LibraryCommitMeta;
  edits?: { oldText: string; newText: string }[];
}

/**
 * Put one definition change in front of the user. The runtime is checked NOW,
 * so the card shows the concrete model it would run on, and again when the
 * card is approved.
 */
async function propose(
  ctx: ToolCallContext,
  action: "create" | "edit",
  before: AgentManifest | undefined,
  after: AgentManifest,
  source: string,
  context: AgentCardContext,
): Promise<PendingApproval> {
  const resolved = await resolvedModelOf(after);
  const resolvedModel = resolved.label;
  const body: AgentDefinitionApprovalBody = {
    kind: "agentDefinition",
    action,
    name: after.name,
    description: after.description,
    persona: after.persona,
    model: {
      ...(before ? { before: before.model } : {}),
      after: after.model,
    },
    resolvedModel,
    effort: {
      ...(before?.effort ? { before: before.effort } : {}),
      ...(after.effort ? { after: after.effort } : {}),
      // What the model will actually use: the requested level, or the
      // default for none, fitted to the ones it supports.
      ...(resolved.thinkingLevel !== after.effort
        ? { effective: resolved.thinkingLevel }
        : {}),
    },
    source,
    reason: context.meta.reason,
  };
  const summary = cardSummary(body);
  const card = createApproval({
    sessionId: ctx.session.sessionId,
    kind: "agentDefinition",
    title: action === "create" ? "Create agent" : "Change agent runtime",
    summary,
    sourceToolCallId: ctx.toolCallId,
    body,
    context: context as unknown as Record<string, unknown>,
    supersedes: (earlier) =>
      earlier.body.kind === "agentDefinition" &&
      earlier.body.name === after.name,
  });
  return {
    pending: {
      content: [
        {
          type: "text",
          text: `Prepared ${summary}, pending the user's approval. ${PENDING_NOTE} ${approvalCardReference(card)}`,
        },
      ],
      terminate: true,
    },
  };
}

/**
 * Run the full runtime check and name the connected model the definition runs
 * on — `provider/id`, plus the version a pin holds an alias to — as the card
 * shows it and as approval must still find it.
 */
async function resolvedModelOf(
  definition: AgentManifest,
): Promise<{ label: string; thinkingLevel: ThinkingLevel }> {
  const { model, pinnedModel, thinkingLevel } =
    (await checkAgentRuntime(definition))!;
  const label = `${model.provider}/${model.id}${
    pinnedModel ? ` (${pinnedModel})` : ""
  }`;
  return { label, thinkingLevel };
}

/** Refuse an approval whose model no longer resolves to what the card showed. */
async function assertStillResolves(
  definition: AgentManifest,
  body: AgentDefinitionApprovalBody,
): Promise<void> {
  const now = await resolvedModelOf(definition);
  if (now.label !== body.resolvedModel)
    throw new EntryValidationError(
      `"${definition.model}" now resolves to ${now.label}, not the ${body.resolvedModel} this card showed. Nothing was written; propose it again.`,
    );
  // The effort the card said the model runs at is part of what was approved:
  // a model whose supported levels changed while the card waited would run
  // the definition at another one.
  const shown = body.effort.effective ?? body.effort.after;
  if (now.thinkingLevel !== shown)
    throw new EntryValidationError(
      `${now.label} would now run "${definition.name}" at effort ${now.thinkingLevel}, not the ${shown ?? "default"} this card showed. Nothing was written; propose it again.`,
    );
}

function cardSummary(body: AgentDefinitionApprovalBody): string {
  const effort = (level: ThinkingLevel | undefined) => level ?? "default";
  if (body.action === "create")
    return `a new ${body.persona} agent "${body.name}" on ${body.model.after} (${body.resolvedModel}), effort ${effort(body.effort.after)}`;
  const changes: string[] = [];
  if (body.model.before !== body.model.after)
    changes.push(
      `model ${body.model.before} → ${body.model.after} (${body.resolvedModel})`,
    );
  if (body.effort.before !== body.effort.after)
    changes.push(
      `effort ${effort(body.effort.before)} → ${effort(body.effort.after)}`,
    );
  return `a change to agent "${body.name}": ${changes.join(", ")}`;
}

/** Refuse a create whose name a folder or a declared agent already holds. */
async function assertNameIsFree(
  library: LibraryStore,
  name: string,
): Promise<void> {
  const overview = await readLibraryOverview(library);
  const taken =
    overview.entries.some((entry) => entry.name === name) ||
    overview.diagnostics.some(
      (diagnostic) =>
        diagnostic.declaredName === name || diagnostic.folder === name,
    ) ||
    existsSync(join(library.root, name));
  if (taken)
    throw new EntryValidationError(
      `The agents library already has an entry or folder named "${name}". Choose another name, or edit that definition instead.`,
    );
}

/**
 * Parse a definition the tool is about to propose or write, size included:
 * the content rule never judges size, and a card for a definition the write
 * would refuse is a decision the user should not be asked to make.
 */
function definitionOf(source: string, name: string): AgentManifest {
  const path = manifestPath(name);
  assertManifestSize(agentKind, Buffer.byteLength(source, "utf8"), path, true);
  return assertManifest(agentKind, source, path);
}

const effortProperty = {
  type: "string",
  enum: THINKING_LEVELS,
  description: `Optional effort (thinking level), fitted to the levels the model supports. Omit to run at ${AGENT_DEFAULT_EFFORT}, fitted the same way.`,
} as const;

/** The one deferred group registered in `tools/catalog.ts`. */
export const agentLibraryTools: AgentTool[] = libraryTools({
  prefix: "agent",
  labelGroup: "Agents",
  exampleName: "test-reviewer",
  library: () => libraryFactory(),
  create: {
    description:
      "Propose a new agent definition: <name>/AGENT.md in the user's agents library, which any session can then spawn by name. The definition picks a persona, a model and an effort, may deny tools and mount library skills, and its body is the role instructions the spawned session follows. What an agent runs on is the user's call, so this always puts an approval card in front of the user and writes nothing until they approve; the model must resolve against a connected account now. Requires a completely clean library repository at approval time. Never put secrets, credentials, or tokens in a definition.",
    properties: {
      name: {
        type: "string",
        description:
          "Declared agent name and source folder: 1-64 characters, lowercase letters, digits and single hyphens.",
      },
      description: {
        type: "string",
        description:
          "One-line description (max 1024 characters) telling a coordinating agent when to spawn this agent.",
      },
      persona: {
        type: "string",
        enum: AGENT_PERSONAS,
        description:
          "The base persona: developer (works in a repository worktree) or assistant.",
      },
      model: {
        type: "string",
        description:
          "A model alias or exact id from a connected account: opus, sonnet, haiku, fable, a unique short OpenAI name such as sol, or an exact id.",
      },
      effort: effortProperty,
      denyTools: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional tools the spawned session must not have: unprefixed app tool names of the persona (e.g. worktree_push) or bash, edit, write.",
      },
      skills: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional declared library skill names to mount for this agent (developer only).",
      },
      body: {
        type: "string",
        description: `The role instructions, in Markdown, below the frontmatter. The whole file is bounded at ${agentKind.maxManifestBytes} bytes (and ${MAX_ENTRY_SOURCE_BYTES} for any manifest).`,
      },
    },
    required: ["name", "description", "persona", "model", "body"],
    async run(params, meta, library, _options, ctx) {
      const input: AgentDefinitionInput = {
        name: params.name as string,
        description: params.description as string,
        persona: params.persona as AgentPersona,
        model: params.model as string,
        ...(params.effort !== undefined
          ? { effort: params.effort as ThinkingLevel }
          : {}),
        ...(Array.isArray(params.denyTools)
          ? { denyTools: params.denyTools as string[] }
          : {}),
        ...(Array.isArray(params.skills)
          ? { skills: params.skills as string[] }
          : {}),
        body: params.body as string,
      };
      const source = formatAgentManifest(input);
      const after = definitionOf(source, input.name);
      // A card for a name approval would refuse is a wasted decision.
      await assertNameIsFree(library, after.name);
      return propose(ctx, "create", undefined, after, source, { meta });
    },
  },
  edit: {
    note: "An edit that changes model or effort is put in front of the user as an approval card and written only when they approve it; any other edit is committed directly.",
    async run(input, meta, library, options, ctx) {
      const current = await readEntrySource(input.name, library);
      if (!current)
        throw new EntryValidationError(
          `No valid agent declares the name "${input.name}". Use agent_list to see declared names and the diagnostics for folders that are not usable.`,
        );
      const before = definitionOf(current.source, input.name);
      const source = previewEntryEdit(
        agentKind,
        current.source,
        input.edits,
        current.path,
      );
      const after = definitionOf(source, input.name);
      // The name is the entry's identity, and the card names its target by it:
      // an edit that changed it would make the card address another entry.
      if (after.name !== before.name)
        throw new EntryValidationError(
          `An edit may not change the declared name ("${before.name}" → "${after.name}"). Use agent_rename, which also moves the source folder.`,
        );
      if (runsOn(before) !== runsOn(after))
        return propose(ctx, "edit", before, after, source, {
          meta,
          edits: input.edits,
        });
      return editEntrySource(input, meta, library, {
        ...options,
        // Judged again on the exact bytes being replaced: the file can change
        // between the preview above and the locked write.
        check: async (lockedBefore, lockedAfter) => {
          const was = definitionOf(lockedBefore, input.name);
          const now = definitionOf(lockedAfter, input.name);
          if (runsOn(was) !== runsOn(now))
            throw new EntryValidationError(
              `${current.path} changed since this edit was checked, and the edit would now change its model or effort; read it again and retry.`,
            );
          await checkAgentRuntime(now, { checkModel: false });
        },
      });
    },
  },
  rename: {
    description:
      "Rename an agent definition: move its source folder to the new name and rewrite the declared frontmatter name in one commit. Refused when the new name is already declared or the destination folder exists. Consequences to report to the user: agents already spawned from the OLD name keep the definition they froze, and new spawns must use the NEW name. Requires a completely clean library repository.",
    consequences: (previousName, newName) => [
      `Sessions already spawned from "${previousName}" keep the definition they froze.`,
      `New spawns must name "${newName}".`,
    ],
  },
  delete: {
    description:
      "Delete one whole agent definition folder — AGENT.md and every supporting file — resolved from its current declared name, as one commit. Git history is the only recovery path: no tool restores a deleted definition. Agents already spawned from it keep the definition they froze. Confirm with the user before deleting a definition they did not just ask you to remove. Requires a completely clean library repository.",
    consequences: (name) => [
      "The folder is recoverable only from the library's Git history.",
      `Sessions already spawned from "${name}" keep the definition they froze.`,
    ],
  },
});

registerApprovalExecutor("agentDefinition", {
  async execute(card: ApprovalCard, context: Record<string, unknown>) {
    if (card.body.kind !== "agentDefinition")
      throw new Error("Mismatched approval body for agentDefinition.");
    const body = card.body;
    const { meta, edits } = context as unknown as AgentCardContext;
    const library = libraryFactory();
    if (body.action === "create") {
      const definition = definitionOf(body.source, body.name);
      await assertStillResolves(definition, body);
      const outcome = await createEntry(
        { name: body.name, source: body.source },
        meta,
        library,
      );
      body.resultCommit = outcome.commit.shortCommit;
      return {
        resultSummary: `Created agent "${body.name}" (commit ${outcome.commit.shortCommit}).`,
      };
    }
    if (!edits) throw new Error("An agent edit card carries no edits.");
    const outcome = await editEntrySource(
      { name: body.name, edits },
      meta,
      library,
      {
        // Approval means exactly what the card showed: the locked result must
        // be byte-for-byte that AGENT.md, so a hand edit made while the card
        // waited refuses rather than being carried along.
        check: async (_before, after) => {
          if (after !== body.source)
            throw new EntryValidationError(
              `${manifestPath(body.name)} changed since this was proposed, so the edit would no longer produce exactly the AGENT.md the card showed. Nothing was written; propose it again.`,
            );
          await assertStillResolves(definitionOf(after, body.name), body);
        },
      },
    );
    body.resultCommit = outcome.commit.shortCommit;
    return {
      resultSummary: `Changed agent "${body.name}" (commit ${outcome.commit.shortCommit}).`,
    };
  },
});
