/**
 * The server half of opening a pi engine (`docs/workers.md` "pi engine start
 * resolution (W9c-1)"): everything fixed at open that the server owns,
 * resolved before the open into the JSON {@link PiEngineOpenSpec}, and the
 * session-start records frozen under the id the open minted.
 *
 * A reopen (a known id) reads its stored records; a new session or a fork
 * resolves what it will freeze, and `piStore` freezes exactly that after a
 * successful open, before the session is tracked. The engine builds from the
 * spec alone and reads no settings, session record or frozen row.
 */
import { hasNativeTools, type AgentType } from "@assistant/shared";
import { AGENT_TYPES } from "../agentTypes.ts";
import {
  AGENT_NATIVE_TOOLS,
  type AgentNativeTool,
} from "../agents/agentLibrary.ts";
import { agentPromptLayer } from "../agents/agentDefinitionPolicy.ts";
import {
  freezeSessionAgent,
  sessionAgent,
  type SessionAgent,
} from "../agents/sessionAgent.ts";
import { CWD } from "../config.ts";
import { piAgentDir } from "../credentialProfiles.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { permanentAssistantProfileInstructions } from "../permanentAssistantProfile.ts";
import {
  sessionPromptConditions,
  startPromptConditions,
  type PromptConditions,
  type SessionPromptEvidence,
} from "../promptConditions.ts";
import { sessionSkills, startSessionSkillNames } from "../sessionSkills.ts";
import { getSettings } from "../settings.ts";
import { eagerToolNamesFor } from "../tools/catalog.ts";
import { persistSessionOutput } from "../workers/inProcessWorker.ts";
import {
  buildPiEngineOptions,
  PI_SEARCH_BUILTIN_TOOLS,
  type AgentSessionOptions,
  type PiPersonaOptions,
} from "./options.ts";
import type { PiEngineOpenSpec, PiEngineStartRecords } from "./piEngineHost.ts";

/**
 * pi's tools behind each harness-neutral name an agent definition may deny.
 * `bash` is command execution as a whole: pi's own shells and the background
 * `monitor` runner too.
 */
const PI_TOOLS_FOR_AGENT_DENY: Readonly<
  Record<AgentNativeTool, readonly string[]>
> = {
  bash: ["bash", "powershell", "monitor"],
  edit: ["edit"],
  write: ["write"],
};

/**
 * The persona's pi options for a session with these frozen `conditions` and
 * `agent`. Delegates to the harness-independent {@link AGENT_TYPES} registry
 * (the single source of truth) so any harness can apply any agentType. Reads
 * settings once: an engine already open keeps the prompt it was built with.
 */
export function piPersonaOptions(
  agentType: AgentType,
  credentialProfileId: string,
  conditions: PromptConditions | undefined,
  agent: SessionAgent | undefined,
): PiPersonaOptions {
  const promptOptions = conditions ? { conditions } : undefined;
  // A spawned agent definition adds one system-prompt layer after the
  // persona's (`docs/agent-definitions.md`).
  const agentLayer = agent ? [agentPromptLayer(agent)] : [];
  // EVERY denied name is excluded, not just the natives: pi has built-ins and
  // extension tools of its own under app-tool names (`ls`), which repository
  // settings could otherwise switch back on.
  const deniedTools = [
    ...new Set(
      (agent?.denyTools ?? []).flatMap((name) =>
        (AGENT_NATIVE_TOOLS as readonly string[]).includes(name)
          ? PI_TOOLS_FOR_AGENT_DENY[name as AgentNativeTool]
          : [name],
      ),
    ),
  ];
  const agentDir = piAgentDir(credentialProfileId);
  const eagerToolNames = [...eagerToolNamesFor(agentType, conditions)];
  // ask_question blocks on an interactive responder the web app doesn't have.
  const excludeTools = ["ask_question", ...deniedTools];
  switch (agentType) {
    case "assistant":
    case "personal-assistant":
    case "workflow-coordinator": {
      // Native access is independent of project discovery. The permanent
      // singleton (`personal-assistant`) always carries the profile suffix.
      const persona = AGENT_TYPES[agentType].systemPrompt(promptOptions);
      return {
        systemPrompt: {
          replace: [
            agentType === "personal-assistant"
              ? `${persona}\n\n## Personal profile instructions\n\n${permanentAssistantProfileInstructions(getSettings().permanentAssistant)}`
              : persona,
            ...agentLayer,
          ].join("\n\n"),
        },
        agentDir,
        // noTools "builtin" (not a `tools:` allowlist): pi force-re-activates
        // every allowlisted tool on registry refresh, which would defeat the
        // deferred active set managed by toolActivation.ts.
        ...(hasNativeTools(agentType) ? {} : { noTools: "builtin" as const }),
        eagerToolNames,
        deferToolLoading: agentType !== "workflow-coordinator",
        extraBuiltinToolNames: hasNativeTools(agentType)
          ? [...PI_SEARCH_BUILTIN_TOOLS]
          : [],
        excludeTools,
      };
    }
    case "workshop":
    case "developer":
      return {
        systemPrompt: {
          append: [
            AGENT_TYPES[agentType].systemPrompt(promptOptions),
            ...agentLayer,
          ],
        },
        agentDir,
        eagerToolNames,
        deferToolLoading: true,
        extraBuiltinToolNames: [...PI_SEARCH_BUILTIN_TOOLS],
        // pi's own built-ins carry the harness-neutral native names.
        excludeTools,
      };
  }
}

/** What the server knows about a session it is about to open. */
interface PiEngineStartInput {
  kind: AgentType;
  credentialProfileId: string;
  /**
   * The id of the transcript a reopen opens: its stored records win, and a
   * session that predates a freeze freezes on this first use.
   */
  knownId?: string;
  /** What a new session starts with (attachments, Project). */
  evidence?: SessionPromptEvidence;
  /** A fork's parent's frozen conditions. */
  inheritConditions?: PromptConditions;
  /** A fork's parent's frozen skill names. */
  inheritSkills?: string[];
  /** The definition a spawn, or a fork's parent, runs as. */
  agent?: SessionAgent;
}

/**
 * The spec fields {@link resolvePiEngineStart} fills: the start records, the
 * persona's options and a reopen's compaction window.
 */
export type PiEngineStartFields = Pick<PiEngineOpenSpec, "start" | "persona"> &
  Partial<Pick<PiEngineOpenSpec, "compactionWindow">>;

/**
 * Resolve everything the engine reads at open, before the open. The server
 * calls this before every `openEngine`; nothing is recomputed afterwards.
 */
export async function resolvePiEngineStart(
  input: PiEngineStartInput,
): Promise<PiEngineStartFields> {
  const { kind, knownId } = input;
  // Session-START prompt conditions (Task 287): pi rebuilds the system prompt
  // on every active-tool change and every reopen, so a known id reads its
  // frozen record, and creation is the only open that decides it.
  const conditions =
    knownId !== undefined
      ? sessionPromptConditions(knownId, kind)
      : startPromptConditions(kind, input.evidence, input.inheritConditions);
  // The agent definition, when it has one: the start's, else the stored row a
  // reopen reads. Before the skills, which it adds to.
  const agent =
    input.agent ?? (knownId !== undefined ? sessionAgent(knownId) : undefined);
  const skillNames =
    knownId !== undefined
      ? await sessionSkills(knownId, kind)
      : (input.inheritSkills ??
        (await startSessionSkillNames(kind, input.agent?.skills)));
  const compactionWindow =
    knownId !== undefined
      ? sessionStore.get(knownId)?.compactionWindow
      : undefined;
  const start: PiEngineStartRecords = {
    conditions,
    skillNames,
    ...(agent ? { agent } : {}),
  };
  return {
    start,
    persona: piPersonaOptions(
      kind,
      input.credentialProfileId,
      conditions,
      agent,
    ),
    ...(compactionWindow !== undefined ? { compactionWindow } : {}),
  };
}

/**
 * Freeze a new or forked session's start records under the id its open
 * minted, insert-only, before anything reads them (`track` registers the
 * app tools from the frozen agent). Throws when a record cannot be stored;
 * the caller runs the refusal cleanup.
 */
export async function freezePiEngineStart(
  sessionId: string,
  kind: AgentType,
  start: PiEngineStartRecords,
): Promise<void> {
  sessionPromptConditions(sessionId, kind, undefined, start.conditions);
  if (start.agent) freezeSessionAgent(sessionId, start.agent);
  await sessionSkills(sessionId, kind, start.skillNames);
}

/**
 * Both halves for one persona, as an engine opened with these records builds
 * them: what the option and prompt suites assert on.
 */
export async function buildAgentOptions(
  agentType: AgentType,
  cwd: string = CWD,
  credentialProfileId = "default",
  conditions?: PromptConditions,
  frozenSkillNames: readonly string[] = [],
  agent?: SessionAgent,
): Promise<AgentSessionOptions> {
  return buildPiEngineOptions({
    kind: agentType,
    cwd,
    persona: piPersonaOptions(
      agentType,
      credentialProfileId,
      conditions,
      agent,
    ),
    skillNames: frozenSkillNames,
    agent,
    persistOutput: persistSessionOutput,
  });
}
