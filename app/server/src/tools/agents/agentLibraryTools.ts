/**
 * The agent definitions library's `agent_*` tool group
 * (`docs/agent-definitions.md` "Authoring tools"): the shared library tool
 * factory with the agent kind's create fields, and one rule on top of it —
 * what a definition runs AS and ON is the user's call. A create always sets a
 * model, so it always becomes an approval card; an edit that changes
 * `persona`, the listed models, `effort` or `peer-turns` becomes one too. Every other edit commits directly, after the same
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
  MAX_AGENT_MODELS,
  agentKind,
  agentLibraryStore,
  formatAgentManifest,
  type AgentDefinitionInput,
  type AgentManifest,
  type AgentPersona,
} from "../../agents/agentLibrary.ts";
import {
  agentRuntimeLabel,
  checkAgentRuntime,
} from "../../agents/agentRuntime.ts";
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

/**
 * What a definition says it runs AS and ON, for comparing two versions of it:
 * a change to any of these needs the user's approval. The persona belongs
 * here because it decides the tools — a developer has native Bash, Edit and
 * Write an assistant does not — so moving to it widens what the agent can do.
 */
function runsOn(manifest: {
  persona: AgentPersona;
  models: string[];
  effort?: ThinkingLevel | undefined;
  peerTurns?: number | undefined;
  compactionWindow?: number | undefined;
}): string {
  // Order counts: the first model is the one a spawn runs without choosing.
  return `${manifest.persona}\u0000${manifest.models.join("\u0001")}\u0000${manifest.effort ?? ""}\u0000${manifest.peerTurns ?? ""}\u0000${manifest.compactionWindow ?? ""}`;
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
  const resolvedModels = await resolvedModelsOf(after);
  // Every read is done: a call stopped meanwhile must not leave a card — one
  // an existing grant would then execute.
  if (ctx.signal?.aborted) throw new Error("Operation aborted");
  const body: AgentDefinitionApprovalBody = {
    kind: "agentDefinition",
    action,
    name: after.name,
    description: after.description,
    persona: after.persona,
    ...(before && before.persona !== after.persona
      ? { personaBefore: before.persona }
      : {}),
    model: {
      ...(before ? { before: before.models } : {}),
      after: after.models,
    },
    resolvedModels,
    effort: {
      ...(before?.effort ? { before: before.effort } : {}),
      ...(after.effort ? { after: after.effort } : {}),
    },
    peerTurns: {
      ...(before?.peerTurns !== undefined ? { before: before.peerTurns } : {}),
      ...(after.peerTurns !== undefined ? { after: after.peerTurns } : {}),
    },
    compactionWindow: {
      ...(before?.compactionWindow !== undefined
        ? { before: before.compactionWindow }
        : {}),
      ...(after.compactionWindow !== undefined
        ? { after: after.compactionWindow }
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
 * Run the full runtime check and name the connected model each listed one
 * runs on — `provider/id`, plus the version a pin holds an alias to — with
 * the effort it runs at, as the card shows them and as approval must still
 * find them.
 */
async function resolvedModelsOf(
  definition: AgentManifest,
): Promise<AgentDefinitionApprovalBody["resolvedModels"]> {
  return (await checkAgentRuntime(definition))!.map((choice) => ({
    model: agentRuntimeLabel(choice.runtime!),
    effort: choice.runtime!.thinkingLevel,
    ...(choice.runtime!.compactionWindow
      ? { compactionWindow: choice.runtime!.compactionWindow }
      : {}),
  }));
}

/** Refuse an approval whose models no longer resolve to what the card showed. */
async function assertStillResolves(
  definition: AgentManifest,
  body: AgentDefinitionApprovalBody,
): Promise<void> {
  const now = await resolvedModelsOf(definition);
  const shown = body.resolvedModels;
  for (const [at, spec] of definition.models.entries()) {
    const was = shown[at];
    const is = now[at]!;
    if (was?.model !== is.model)
      throw new EntryValidationError(
        `"${spec}" now resolves to ${is.model}, not the ${was?.model ?? "nothing"} this card showed. Nothing was written; propose it again.`,
      );
    if (was.compactionWindow?.tokens !== is.compactionWindow?.tokens)
      throw new EntryValidationError(
        `${is.model}'s compaction window estimate changed. Nothing was written; propose it again.`,
      );
    // The effort the card said a model runs at is part of what was approved:
    // a model whose supported levels changed while the card waited would run
    // the definition at another one.
    if (was.effort !== is.effort)
      throw new EntryValidationError(
        `${is.model} would now run "${definition.name}" at effort ${is.effort}, not the ${was.effort} this card showed. Nothing was written; propose it again.`,
      );
  }
}

function cardSummary(body: AgentDefinitionApprovalBody): string {
  const effort = (level: ThinkingLevel | undefined) => level ?? "default";
  const models = body.resolvedModels
    .map((resolved) => `${resolved.model} at ${resolved.effort}`)
    .join(", ");
  if (body.action === "create")
    return `a new ${body.persona} agent "${body.name}" on ${models}, peer turns ${body.peerTurns?.after ?? "default (4)"}`;
  const changes: string[] = [];
  if (body.personaBefore !== undefined)
    changes.push(`persona ${body.personaBefore} → ${body.persona}`);
  if (body.model.before?.join(", ") !== body.model.after.join(", "))
    changes.push(
      `models ${body.model.before?.join(", ")} → ${body.model.after.join(", ")}`,
    );
  if (body.effort.before !== body.effort.after)
    changes.push(
      `effort ${effort(body.effort.before)} → ${effort(body.effort.after)}`,
    );
  if (body.compactionWindow?.before !== body.compactionWindow?.after)
    changes.push(
      `compaction window ${body.compactionWindow?.before ?? "default"} → ${body.compactionWindow?.after ?? "default"}`,
    );
  if (body.peerTurns?.before !== body.peerTurns?.after)
    changes.push(
      `peer turns ${body.peerTurns?.before ?? "default (4)"} → ${body.peerTurns?.after ?? "default (4)"}`,
    );
  return `a change to agent "${body.name}": ${changes.join(", ")}; it would run on ${models}`;
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
  description: `Optional effort (thinking level), fitted to the levels each model supports. Omit to run at ${AGENT_DEFAULT_EFFORT}, fitted the same way.`,
} as const;

/** The one deferred group registered in `tools/catalog.ts`. */
export const agentLibraryTools: AgentTool[] = libraryTools({
  prefix: "agent",
  labelGroup: "Agents",
  exampleName: "test-reviewer",
  library: () => libraryFactory(),
  create: {
    description:
      "Propose a new agent definition: <name>/AGENT.md in the user's agents library, which any session can then spawn by name. The definition picks a persona, the models it may run on (the first is the default) and an effort, may deny tools and mount library skills, and its body is the role instructions the spawned session follows. What an agent runs on is the user's call, so this always puts an approval card in front of the user and writes nothing until they approve; the model must resolve against a connected account now. Requires a completely clean library repository at approval time. Never put secrets, credentials, or tokens in a definition.",
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
      models: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_AGENT_MODELS,
        description:
          "The models it may run on, the default first. Each a model alias or exact id from a connected account: opus, sonnet, haiku, fable, a unique short OpenAI name such as sol, or an exact id. A spawn may pick any of them without asking the user.",
      },
      effort: effortProperty,
      peerTurns: {
        type: "integer",
        minimum: 1,
        maximum: 16,
        description:
          "Optional concurrent peer turn cap for new sessions, default 4. Requires user approval.",
      },
      compactionWindow: {
        type: "integer",
        minimum: 1,
        maximum: 1_000_000,
        description:
          "Optional creation-time window in tokens, clamped to the model's user range. Requires user approval.",
      },
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
      inheritGrants: {
        type: "boolean",
        description:
          "Optional spawn default: false means sessions spawned as this agent inherit none of the spawner's approvals unless the spawn row says so.",
      },
      body: {
        type: "string",
        description: `The role instructions, in Markdown, below the frontmatter. The whole file is bounded at ${agentKind.maxManifestBytes} bytes (and ${MAX_ENTRY_SOURCE_BYTES} for any manifest).`,
      },
    },
    required: ["name", "description", "persona", "models", "body"],
    async run(params, meta, library, _options, ctx) {
      if (ctx.signal?.aborted) throw new Error("Operation aborted");
      const input: AgentDefinitionInput = {
        name: params.name as string,
        description: params.description as string,
        persona: params.persona as AgentPersona,
        models: params.models as string[],
        ...(params.effort !== undefined
          ? { effort: params.effort as ThinkingLevel }
          : {}),
        ...(params.peerTurns !== undefined
          ? { peerTurns: params.peerTurns as number }
          : {}),
        ...(params.compactionWindow !== undefined
          ? { compactionWindow: params.compactionWindow as number }
          : {}),
        // Typed by the tool's schema, checked before `run` (`withCheckedArguments`).
        ...(params.denyTools !== undefined
          ? { denyTools: params.denyTools as string[] }
          : {}),
        ...(params.skills !== undefined
          ? { skills: params.skills as string[] }
          : {}),
        ...(params.inheritGrants !== undefined
          ? { inheritGrants: params.inheritGrants as boolean }
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
    note: "An edit that changes persona, the listed models, effort, peer-turns or compactionWindow is put in front of the user as an approval card and written only when they approve it; any other edit is committed directly.",
    async run(input, meta, library, options, ctx) {
      if (ctx.signal?.aborted) throw new Error("Operation aborted");
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
              `${current.path} changed since this edit was checked, and the edit would now change its persona, model, effort, peer-turns or compactionWindow; read it again and retry.`,
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
