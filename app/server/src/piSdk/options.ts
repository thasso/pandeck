/**
 * Pi option construction: the resource loader + tool policy handed to
 * `createAgentSession` for each {@link AgentType}, plus the pi session store
 * directories. Extracted from agents.ts / agentTypes.ts so the persona modules
 * stay free of pi imports; prompts and MCP toolsets are consumed from the
 * harness-independent {@link AGENT_TYPES} registry.
 */
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { AgentType } from "@assistant/shared";
import {
  CHAT_SESSION_DIR,
  CWD,
  DEVELOPER_SESSION_DIR,
  PERSONAL_ASSISTANT_SESSION_DIR,
  SKILLS_RUNTIME_DIR,
  WORKFLOW_COORDINATOR_SESSION_DIR,
  WORKSHOP_SESSION_DIR,
} from "../config.ts";
import { AGENT_TYPES } from "../agentTypes.ts";
import type { PromptConditions } from "../promptConditions.ts";
import type { AgentTool } from "../mcp/tool.ts";
import { eagerToolNamesFor } from "../tools/catalog.ts";
import { getSettings } from "../settings.ts";
import { permanentAssistantProfileInstructions } from "../permanentAssistantProfile.ts";
import { piAgentDir } from "../credentialProfiles.ts";
import { createPiOutputPolicyExtension } from "./outputPolicyExtension.ts";
import { skillLibraryStore } from "../skills/skillLibraryStore.ts";
import { scanSkillLibrary } from "../skills/skillLibraryScanner.ts";
import {
  materializeSkillRuntime,
  skillSetHash,
} from "../skills/skillRuntimeMaterializer.ts";

// Never discover ~/.pi resources/settings. Each loader receives its profile's
// PA-owned directory, including coding personas.

type ResourceLoaderReloadOptions = Parameters<
  DefaultResourceLoader["reload"]
>[0];
type DefaultResourceLoaderOptions = ConstructorParameters<
  typeof DefaultResourceLoader
>[0];

/**
 * A coding-session loader whose frozen library layout is restored before every
 * pi resource reload. The reload hook matters after generated-runtime cleanup:
 * a live session must rebuild from its frozen names, never from current
 * settings and never by silently dropping a missing runtime directory.
 */
class FrozenSkillsResourceLoader extends DefaultResourceLoader {
  private readonly frozenSkillNames: readonly string[];

  constructor(
    options: DefaultResourceLoaderOptions,
    frozenSkillNames: readonly string[],
  ) {
    const names = [...frozenSkillNames];
    super({
      ...options,
      additionalSkillPaths: [
        join(SKILLS_RUNTIME_DIR, skillSetHash(names), "skills"),
      ],
    });
    this.frozenSkillNames = names;
  }

  override async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
    await skillLibraryStore.ensureInitialized();
    const scan = await scanSkillLibrary(skillLibraryStore.root);
    await materializeSkillRuntime(this.frozenSkillNames, scan);
    await super.reload(options);
  }
}

/** Options handed to `createAgentSession`, minus the per-connection pieces. */
export interface AgentSessionOptions {
  resourceLoader: DefaultResourceLoader;
  noTools?: "all" | "builtin";
  tools?: string[];
  /**
   * The persona's resolved app tools. `piStore.create()` adapts them directly
   * into pi `customTools` (`agentToolAdapter.ts`) and manages the deferred
   * active set through `toolActivation.ts`.
   */
  agentTools: AgentTool[];
  /** Eager-tier names kept in the initial model context (`tools/catalog.ts`). */
  eagerToolNames: ReadonlySet<string>;
  /** Whether tools load on demand rather than all landing in the initial context. */
  deferToolLoading: boolean;
  /**
   * pi builtins to activate ON TOP of the four that pi turns on by default
   * (`read`/`bash`/`edit`/`write`). Every builtin DEFINITION is registered by
   * pi regardless; this only decides what is active, and `piStore` unions it
   * into the built-in half of the active-set merge. Empty for the assistant
   * personas, which run `noTools: "builtin"`.
   */
  extraBuiltinToolNames: string[];
  excludeTools: string[];
}

/**
 * pi's own bounded search builtins, off by default in pi 0.82 (Task-316). They
 * replace `bash` round trips with `grep`/`find` calls that truncate their own
 * output.
 *
 * `ls` is deliberately NOT here: Task-319 closed the harness asymmetry with the
 * app-side `ls` tool (`tools/core/lsTool.ts`, eager for both harnesses), which
 * SHADOWS pi's builtin rather than colliding with it. pi's
 * `_refreshToolRegistry` builds `definitionRegistry`/`_toolRegistry` as Maps
 * keyed by tool NAME, inserting builtins first and then `set()`-ing every custom
 * tool over them; our app tools arrive as `customTools` (`piStore.ts`), so the
 * name resolves to OUR definition and can never appear twice. Keeping `"ls"`
 * listed here would therefore be dead config that still made the prompt
 * inventory price and describe a builtin the model never receives. The ordering
 * is pi's, not ours: an app-side `ls` that ever stopped being a `customTools`
 * entry would flip which definition wins.
 */
export const PI_SEARCH_BUILTIN_TOOLS = ["grep", "find"] as const;

/** Pi builtins removed from coding personas while their session is in Plan. */
export const PI_PLAN_RESTRICTED_BUILTIN_TOOLS = ["edit", "write"] as const;

/**
 * Build the resource loader + tool policy for an {@link AgentType}. Async because
 * the loader must `reload()` before a session can use it. Delegates to the
 * harness-independent {@link AGENT_TYPES} registry (the single source of truth)
 * so any harness can apply any agentType.
 *
 * `conditions` and `frozenSkillNames` are the session's frozen session-start
 * records. pi rebuilds resources and its system prompt during a session, so
 * these must be the SAME values on reopen/fork as on creation — the caller
 * reads them from the session record rather than recomputing live settings.
 */
export async function buildAgentOptions(
  agentType: AgentType,
  cwd: string = CWD,
  credentialProfileId = "default",
  conditions?: PromptConditions,
  frozenSkillNames: readonly string[] = [],
): Promise<AgentSessionOptions> {
  return buildPiOptions(
    agentType,
    cwd,
    credentialProfileId,
    conditions,
    frozenSkillNames,
  );
}

/**
 * Build the pi resource loader + tool policy for an agentType. The toolset is
 * always `AGENT_TYPES[agentType].tools()` — the single source of truth shared
 * with the Claude harness; only the loader construction is pi-specific.
 */
async function buildPiOptions(
  agentType: AgentType,
  cwd: string,
  credentialProfileId: string,
  conditions: PromptConditions | undefined,
  frozenSkillNames: readonly string[],
): Promise<AgentSessionOptions> {
  const agentDir = piAgentDir(credentialProfileId);
  const promptOptions = conditions ? { conditions } : undefined;
  const agentTools = AGENT_TYPES[agentType].tools();
  switch (agentType) {
    case "assistant":
    case "personal-assistant":
    case "workflow-coordinator": {
      // Clean slate: no AGENTS.md context, no extensions/skills, a minimal prompt,
      // and only the dedicated integration tools. The permanent singleton
      // (`personal-assistant`) always carries the profile suffix.
      const withProfileSuffix = agentType === "personal-assistant";
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [
          {
            name: "bounded-output",
            factory: createPiOutputPolicyExtension(),
            hidden: true,
          },
        ],
        systemPrompt: withProfileSuffix
          ? `${AGENT_TYPES[agentType].systemPrompt(promptOptions)}\n\n## Personal profile instructions\n\n${permanentAssistantProfileInstructions(getSettings().permanentAssistant)}`
          : AGENT_TYPES[agentType].systemPrompt(promptOptions),
      });
      await loader.reload();
      // noTools "builtin" (not a `tools:` allowlist): pi force-re-activates
      // every allowlisted tool on registry refresh, which would defeat the
      // deferred active set managed by toolActivation.ts.
      return {
        resourceLoader: loader,
        noTools: "builtin",
        agentTools,
        eagerToolNames: eagerToolNamesFor(agentType, conditions),
        deferToolLoading: agentType !== "workflow-coordinator",
        // No builtins at all here — not even the search ones.
        extraBuiltinToolNames: [],
        excludeTools: ["ask_question"],
      };
    }
    case "workshop":
    case "developer": {
      // Keep pi's full prompt + discovery + tools, just append the persona
      // extension so we still benefit from upstream prompt updates.
      const extension = AGENT_TYPES[agentType].systemPrompt(promptOptions);
      const loader = new FrozenSkillsResourceLoader(
        {
          cwd,
          agentDir,
          extensionFactories: [
            {
              name: "bounded-output",
              factory: createPiOutputPolicyExtension(),
              hidden: true,
            },
          ],
          appendSystemPromptOverride: (base) => [...base, extension],
        },
        frozenSkillNames,
      );
      await loader.reload();
      // ask_question blocks on an interactive responder the web app doesn't have.
      return {
        resourceLoader: loader,
        agentTools,
        eagerToolNames: eagerToolNamesFor(agentType, conditions),
        deferToolLoading: true,
        extraBuiltinToolNames: [...PI_SEARCH_BUILTIN_TOOLS],
        excludeTools: ["ask_question"],
      };
    }
  }
}

/** Where each agent kind's pi sessions are stored on disk. */
const SESSION_DIRS: Record<AgentType, string> = {
  assistant: CHAT_SESSION_DIR,
  "personal-assistant": PERSONAL_ASSISTANT_SESSION_DIR,
  workshop: WORKSHOP_SESSION_DIR,
  developer: DEVELOPER_SESSION_DIR,
  "workflow-coordinator": WORKFLOW_COORDINATOR_SESSION_DIR,
};

/** Absolute session store directory for an agent kind. */
export function sessionDirFor(kind: AgentType): string {
  return SESSION_DIRS[kind];
}
