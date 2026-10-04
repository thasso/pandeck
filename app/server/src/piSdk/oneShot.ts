/**
 * Headless one-shot run against a pi agent session.
 *
 * The pi engine half of `runOneShot` (`harnesses/oneShot.ts`), the only caller
 * of `runPiOneShot` and `findPiModelExact`. `selectPiModelWithFallback` also
 * serves `permanentAssistant.ts` until model selection moves behind the models
 * port (`docs/agent-harnesses.md`, step 6). It builds a locked-down resource loader
 * (no extensions/skills/prompt-templates/context files, custom system
 * prompt), runs a single prompt against an in-memory session, optionally
 * exposing an explicit app-tool allowlist through the direct AgentTool
 * adapter, accumulates the streamed assistant text, races a timeout, and
 * disposes the session.
 */
import { DEFAULT_HELPER_MODEL, type ThinkingLevel } from "@assistant/shared";
import type { AgentUsage } from "@assistant/shared/session";
import { CWD } from "../config.ts";
import { piAgentDir } from "../credentialProfiles.ts";
import type { AgentTool } from "../mcp/tool.ts";
import type { findModel } from "./models.ts";

// pi's SDK, the model registry and the tool adapter load on the first run:
// importing them costs ~0.75s, and `harnesses/oneShot.ts` is reached through
// the helper agents (commit messages, naming, memory, minutes) from most of the
// server long before any of them runs.
async function loadPi() {
  const { DefaultResourceLoader, SessionManager, createAgentSession } =
    await import("@earendil-works/pi-coding-agent");
  const { modelRegistryForProfile, modelRuntimeForProfile } =
    await import("./models.ts");
  const { toPiToolDefinitions } = await import("./agentToolAdapter.ts");
  return {
    DefaultResourceLoader,
    SessionManager,
    createAgentSession,
    modelRegistryForProfile,
    modelRuntimeForProfile,
    toPiToolDefinitions,
  };
}

/** Model handle as returned by pi's model registry (`findModel`/`getAvailable`). */
export type PiRegistryModel = NonNullable<ReturnType<typeof findModel>>;

/**
 * Resolve the model for a helper agent against the account it will actually run
 * on: the configured provider/model if that account offers it, otherwise the
 * recommended cheap fallback, then any available non-reasoning text model, then
 * any available model at all. Always scoped to one profile — a model handle
 * from another account's registry would not be usable here.
 *
 * The fallback follows {@link DEFAULT_HELPER_MODEL}. It used to be
 * `github-copilot/gpt-4.1`, the catalog's last non-reasoning Copilot model; pi
 * 0.87 dropped it and every remaining Copilot model reports `reasoning: true`,
 * so the non-reasoning tier below now only ever matches other providers.
 */
export async function selectPiModelWithFallback(
  settings: { provider: string; modelId: string },
  credentialProfileId: string,
): Promise<PiRegistryModel | undefined> {
  const { modelRegistryForProfile } = await loadPi();
  const registry = await modelRegistryForProfile(credentialProfileId);
  const configured = registry.find(settings.provider, settings.modelId);
  if (configured) return configured;

  const preferred = registry.find(
    DEFAULT_HELPER_MODEL.provider,
    DEFAULT_HELPER_MODEL.modelId,
  );
  if (preferred) return preferred;

  const available = registry.getAvailable();
  return (
    available.find((m) => !m.reasoning && m.input.includes("text")) ??
    available[0]
  );
}

/** The configured model if the account offers it; never a fallback. */
export async function findPiModelExact(
  settings: { provider: string; modelId: string },
  credentialProfileId: string,
): Promise<PiRegistryModel | undefined> {
  const { modelRegistryForProfile } = await loadPi();
  const registry = await modelRegistryForProfile(credentialProfileId);
  return registry.find(settings.provider, settings.modelId);
}

export interface PiOneShotOptions {
  model: PiRegistryModel;
  /** OpenAI account this run authenticates as; also selects the private agent directory. */
  credentialProfileId: string;
  thinkingLevel: ThinkingLevel;
  /** Full system prompt for the locked-down resource loader. */
  systemPrompt: string;
  /** The single user prompt. */
  prompt: string;
  /** Reject the run after this many ms. */
  timeoutMs: number;
  /** Error message thrown on timeout. */
  timeoutMessage: string;
  /** Explicit app-tool allowlist. Built-in file/shell tools remain disabled. */
  tools?: AgentTool[];
}

export interface PiOneShotResult {
  text: string;
  /** Normalized session usage, read from the session stats after the prompt completes. */
  usage: AgentUsage;
  /** Set when the assistant turn ended with stopReason "error" or "aborted". */
  stopReason?: "error" | "aborted";
  /** The assistant's error message when {@link stopReason} is set (may be empty). */
  errorMessage?: string;
}

/**
 * Run a single pi prompt and return the assistant text + usage. By default the
 * run has no tools; callers may provide an explicit app-tool allowlist.
 * Throws on timeout or prompt failure; always disposes the session.
 */
export async function runPiOneShot(
  opts: PiOneShotOptions,
): Promise<PiOneShotResult> {
  const {
    DefaultResourceLoader,
    SessionManager,
    createAgentSession,
    modelRuntimeForProfile,
    toPiToolDefinitions,
  } = await loadPi();
  const loader = new DefaultResourceLoader({
    cwd: CWD,
    // PA-owned, profile-private agent directory — never a global `~/.pi`.
    agentDir: piAgentDir(opts.credentialProfileId),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt: opts.systemPrompt,
  });
  await loader.reload();

  const sessionManager = SessionManager.inMemory(CWD);
  const customTools = opts.tools?.length
    ? toPiToolDefinitions(opts.tools, {
        session: () => ({
          sessionId: sessionManager.getSessionId(),
          harness: "pi",
          agentType: "assistant",
          cwd: CWD,
          sessionManager,
        }),
      })
    : undefined;

  const { session } = await createAgentSession({
    cwd: CWD,
    modelRuntime: await modelRuntimeForProfile(opts.credentialProfileId),
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    sessionManager,
    resourceLoader: loader,
    ...(customTools
      ? { noTools: "builtin" as const, customTools }
      : { noTools: "all" as const }),
  });

  let text = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_update") return;
    const ev = event.assistantMessageEvent;
    if (ev.type === "text_delta") text += ev.delta;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.prompt(opts.prompt, { expandPromptTemplates: false }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(opts.timeoutMessage)),
          opts.timeoutMs,
        );
      }),
    ]);
    // Fall back to the final committed assistant message when no deltas were
    // streamed, and surface an errored/aborted assistant stop to the caller.
    const finalAssistant = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant") as
      | { stopReason?: string; errorMessage?: string; content?: unknown }
      | undefined;
    if (!text.trim()) text = assistantMessageText(finalAssistant);
    const stats = session.getSessionStats();
    const usage: AgentUsage = {
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadTokens: stats.tokens.cacheRead,
      cacheCreationTokens: stats.tokens.cacheWrite,
      costUSD: stats.cost,
      ...(stats.contextUsage?.contextWindow !== undefined
        ? { contextWindowTokens: stats.contextUsage?.contextWindow }
        : {}),
    };
    const stopReason =
      finalAssistant?.stopReason === "error" ||
      finalAssistant?.stopReason === "aborted"
        ? finalAssistant.stopReason
        : undefined;
    return {
      text,
      usage,
      ...(stopReason
        ? { stopReason, errorMessage: finalAssistant?.errorMessage ?? "" }
        : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe();
    session.dispose();
  }
}

function assistantMessageText(
  message: { content?: unknown } | undefined,
): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part?.text === "string"
        ? part.text
        : typeof part?.content === "string"
          ? part.content
          : "",
    )
    .join("");
}
