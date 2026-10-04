import type { AgentInfo, AgentType } from "@assistant/shared";
import { personaPromptText, type PromptAssetOptions } from "./promptAssets.ts";
import { IS_PROD } from "./config.ts";

/**
 * Static persona metadata for each agent. The prompt/tool policy lives in the
 * harness-independent registry ({@link ./agentTypes.ts}); prompt-layer
 * resolution and its report live in {@link ./promptAssets.ts}; pi
 * option/session-dir construction lives in {@link ./piSdk/options.ts}.
 */
interface AgentDef {
  kind: AgentType;
  label: string;
  /** Only offered in local dev mode (the app-modifying Workshop agent). */
  devOnly: boolean;
}

const AGENTS: Record<AgentType, AgentDef> = {
  assistant: {
    kind: "assistant",
    label: "Assistant",
    devOnly: false,
  },
  workshop: {
    kind: "workshop",
    label: "Workshop",
    devOnly: true,
  },
  developer: {
    kind: "developer",
    label: "Developer",
    devOnly: false,
  },
  "personal-assistant": {
    kind: "personal-assistant",
    label: "Personal Assistant",
    devOnly: false,
  },
  "workflow-coordinator": {
    kind: "workflow-coordinator",
    label: "Workflow coordinator",
    devOnly: false,
  },
};

/**
 * The workshop agent's full system prompt text (pi's base prompt is appended to
 * this by the SDK; here we return just our appended extension + context prompts).
 * Reused to make embedded Claude Code sessions behave like the workshop agent.
 */
export function workshopSystemPromptText(opts?: PromptAssetOptions): string {
  return personaPromptText("workshop", opts);
}

/**
 * The assistant agent's system prompt text. Reused to make assistant-flavored
 * Claude sessions behave like the pi assistant.
 */
export function assistantSystemPromptText(opts?: PromptAssetOptions): string {
  return personaPromptText("assistant", opts);
}

/**
 * The permanent Personal Assistant's system prompt text. Shares the ordinary
 * Assistant's context prompts (Project Registry + KB) but owns dedicated
 * behavior guidance in `personal-assistant.md`. The permanent profile suffix is
 * appended by the harness option builders, not here.
 */
export function personalAssistantSystemPromptText(
  opts?: PromptAssetOptions,
): string {
  return personaPromptText("personal-assistant", opts);
}

/**
 * The developer agent's system prompt: a generic software-engineering coding
 * agent (no app-self-modification / dev-supervisor assumptions), usable in prod
 * on any project. Shares the same context prompts as the other personas.
 */
export function developerSystemPromptText(opts?: PromptAssetOptions): string {
  return personaPromptText("developer", opts);
}

/** Minimal evidence-only prompt for the internal Workflow Run coordinator. */
export function workflowCoordinatorSystemPromptText(
  opts?: PromptAssetOptions,
): string {
  return personaPromptText("workflow-coordinator", opts);
}

/**
 * Whether an existing session with this persona may be loaded right now.
 * Server-owned personas are loadable even though ordinary creation excludes
 * them; only environment-gated personas (Workshop in production) are refused.
 */
export function isAgentSessionAvailable(kind: AgentType): boolean {
  const def = AGENTS[kind];
  if (!def) return false;
  return !def.devOnly || !IS_PROD;
}

/**
 * Whether a persona can be created/selected through ordinary paths right now
 * (Workshop is dev-only). Server-owned `personal-assistant` and
 * `workflow-coordinator` sessions are created only by their dedicated acquisition
 * paths, so every generic client creation path guarded by this rejects them.
 */
export function isAgentAvailable(kind: AgentType): boolean {
  if (kind === "personal-assistant" || kind === "workflow-coordinator")
    return false;
  return isAgentSessionAvailable(kind);
}

/**
 * Agent TYPES to advertise to the Composer's agent-type picker — keyed by the
 * clean {@link AgentType}, independent of harness. Only the two pi personas are
 * selectable here (the Claude harnesses are chosen via the model picker). Dev-only
 * ones are hidden in production.
 */
export function availableAgents(): AgentInfo[] {
  const out: AgentInfo[] = [];
  for (const kind of ["assistant", "workshop", "developer"] as const) {
    const def = AGENTS[kind];
    if (!isAgentAvailable(kind)) continue;
    out.push({ agentType: kind, label: def.label, devOnly: def.devOnly });
  }
  return out;
}
