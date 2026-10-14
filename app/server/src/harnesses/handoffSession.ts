/**
 * The new session a review handoff opens in a worktree, on the engine the
 * client picked (`docs/agent-harnesses.md`). Each engine checks the account and
 * model its own way, then creates through `createSession`; the connection keeps
 * the comments, the persona guard, the view and the prompt.
 */
import type {
  AgentType,
  Harness,
  SessionMode,
  ThinkingLevel,
} from "@assistant/shared";
import { resolveSessionAccount } from "../sessionAccount.ts";
import type { LiveSession } from "../harness.ts";
import { getSettings } from "../settings.ts";
import { createSession, type PiModel } from "./create.ts";
import { piModelForAccount } from "./models.ts";

/** What the client asked the new session to run as. */
interface HandoffTarget {
  agentType: AgentType;
  credentialProfileId?: string | undefined;
  requiresEnterprise?: boolean | undefined;
  modelProvider?: string | undefined;
  modelId?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  mode?: SessionMode | undefined;
}

interface HandoffEngine {
  /**
   * Whether the persona must also be one an existing session of this engine
   * may run as (pi); a Claude session waits only on its SDK setting.
   */
  readonly guardsPersona: boolean;
  /**
   * Create the session in the worktree. Throws, with a message for the reader,
   * when the engine is off, the account is not one it runs on, or the account
   * does not offer the model.
   */
  create(
    target: HandoffTarget,
    worktree: { id: string; path: string },
  ): Promise<LiveSession>;
}

const engines: Record<Harness, HandoffEngine> = {
  "claude-sdk": {
    guardsPersona: false,
    async create(target, worktree) {
      if (!getSettings().claudeSdk.enabled)
        throw new Error("Claude SDK sessions are disabled.");
      const profileId = await resolveSessionAccount("claude", target);
      return createSession({
        harness: "claude-sdk",
        agentType: target.agentType,
        modelId: target.modelId,
        thinkingLevel: target.thinkingLevel,
        mode: target.mode,
        worktree,
        credentialProfileId: profileId,
        ...(target.requiresEnterprise !== undefined
          ? { requiresEnterprise: target.requiresEnterprise }
          : {}),
      });
    },
  },
  pi: {
    guardsPersona: true,
    async create(target, worktree) {
      const profileId = await resolveSessionAccount("openai-codex", target);
      let model: PiModel | undefined;
      if (target.modelProvider && target.modelId) {
        model =
          (await piModelForAccount(
            profileId,
            target.modelProvider,
            target.modelId,
          )) ?? undefined;
        if (!model)
          throw new Error(
            `Model ${target.modelProvider}/${target.modelId} is not available.`,
          );
      }
      return createSession({
        harness: "pi",
        agentType: target.agentType,
        model,
        thinkingLevel: target.thinkingLevel,
        mode: target.mode,
        worktree,
        credentialProfileId: profileId,
        ...(target.requiresEnterprise !== undefined
          ? { requiresEnterprise: target.requiresEnterprise }
          : {}),
      });
    },
  },
};

/** How a review handoff opens a new session on `harness`. */
export function handoffEngine(harness: Harness): HandoffEngine {
  return engines[harness];
}
