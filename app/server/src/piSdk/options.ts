/**
 * The engine half of pi option construction: the resource loader and tool
 * universe `createAgentSession` gets, built from the {@link PiPersonaOptions}
 * the server computed (`piEngineStart.ts`) and the session's frozen records,
 * plus the pi session store directories. Nothing here reads settings or the
 * session store; the frozen skills' materialization before every reload is
 * the one server reach left (`docs/workers.md`).
 */
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { AgentType } from "@assistant/shared";
import {
  CHAT_SESSION_DIR,
  DEVELOPER_SESSION_DIR,
  PERSONAL_ASSISTANT_SESSION_DIR,
  SKILLS_RUNTIME_DIR,
  WORKFLOW_COORDINATOR_SESSION_DIR,
  WORKSHOP_SESSION_DIR,
} from "../config.ts";
import { AGENT_TYPES } from "../agentTypes.ts";
import { withoutDeniedTools } from "../agents/agentDefinitionPolicy.ts";
import type { SessionAgent } from "../agents/sessionAgent.ts";
import type { AgentTool } from "../mcp/tool.ts";
import { createPiOutputPolicyExtension } from "./outputPolicyExtension.ts";
import { scanSkillLibrary, skillLibraryStore } from "../skills/skillLibrary.ts";
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
   * into the built-in half of the active-set merge. Empty for personas without
   * native access, which run `noTools: "builtin"`.
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
 * A persona's pi options as the server computes them at open
 * (`piEngineStart.ts`), as JSON: everything settings, the persona registry
 * and the frozen conditions and agent decide.
 */
export interface PiPersonaOptions {
  /**
   * The assistant personas' whole system prompt on a clean-slate loader
   * (`replace`), or the layers a coding persona appends to pi's own prompt and
   * resource discovery (`append`).
   */
  systemPrompt: { replace: string } | { append: string[] };
  /** The credential profile's pi agent directory: a path, never a secret. */
  agentDir: string;
  noTools?: "builtin";
  eagerToolNames: string[];
  deferToolLoading: boolean;
  extraBuiltinToolNames: string[];
  excludeTools: string[];
}

/** How the bounded-output extension persists an elided result's full output. */
export type PiOutputPersist = Parameters<
  typeof createPiOutputPolicyExtension
>[0]["persistOutput"];

/**
 * Build the resource loader and tool universe from the server's
 * {@link PiPersonaOptions}. Async because the loader must `reload()` before a
 * session can use it.
 *
 * `skillNames` and `agent` are the session's frozen start records. pi rebuilds
 * resources and its system prompt during a session, so these must be the SAME
 * values on reopen/fork as on creation — the server resolves them from the
 * session record rather than recomputing live settings.
 */
export async function buildPiEngineOptions(input: {
  kind: AgentType;
  cwd: string;
  persona: PiPersonaOptions;
  skillNames: readonly string[];
  agent: SessionAgent | undefined;
  persistOutput: PiOutputPersist;
}): Promise<AgentSessionOptions> {
  const { persona } = input;
  // The persona's tools from the registry the server's app-tool binding
  // reads too, narrowed by a spawned agent definition; its prompt layer is
  // already in `persona.systemPrompt` (`docs/agent-definitions.md`).
  const agentTools = withoutDeniedTools(
    AGENT_TYPES[input.kind].tools(),
    input.agent,
  );
  const extensionFactories = [
    {
      name: "bounded-output",
      factory: createPiOutputPolicyExtension({
        persistOutput: input.persistOutput,
      }),
      hidden: true,
    },
  ];
  const { systemPrompt } = persona;
  // Clean slate: no AGENTS.md context, no extensions/skills, a minimal
  // prompt, and the persona's dedicated tools. Coding personas keep pi's full
  // prompt + discovery + tools, with the persona's layers appended so they
  // still benefit from upstream prompt updates.
  const loader =
    "replace" in systemPrompt
      ? new DefaultResourceLoader({
          cwd: input.cwd,
          agentDir: persona.agentDir,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noContextFiles: true,
          extensionFactories,
          systemPrompt: systemPrompt.replace,
        })
      : new FrozenSkillsResourceLoader(
          {
            cwd: input.cwd,
            agentDir: persona.agentDir,
            extensionFactories,
            appendSystemPromptOverride: (base) => [
              ...base,
              ...systemPrompt.append,
            ],
          },
          input.skillNames,
        );
  await loader.reload();
  return {
    resourceLoader: loader,
    ...(persona.noTools !== undefined ? { noTools: persona.noTools } : {}),
    agentTools,
    eagerToolNames: new Set(persona.eagerToolNames),
    deferToolLoading: persona.deferToolLoading,
    extraBuiltinToolNames: [...persona.extraBuiltinToolNames],
    excludeTools: [...persona.excludeTools],
  };
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
