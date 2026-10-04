/**
 * Creating a session on either engine (`docs/agent-harnesses.md` step 11): the
 * one place that knows each engine's creation sequence, so a caller names what
 * the session starts with and never repeats how. Callers keep what is theirs:
 * admission, the model they resolve and how a missing one is reported, and
 * whatever they do with the session once it exists.
 */
import type {
  AgentType,
  SessionMode,
  SessionScope,
  ThinkingLevel,
} from "@assistant/shared";
import { claudeSdkStore } from "../claudeSdk/claudeSdkStore.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { linkSessionToWorktree } from "../db/worktreeStore.ts";
import type { LiveSession } from "../harness.ts";
import { piStore } from "../piSdk/piStore.ts";
import {
  sessionPromptConditions,
  type SessionPromptEvidence,
} from "../promptConditions.ts";
import { sessionSkills } from "../sessionSkills.ts";
import { broadcastWorktreeEdgeChange } from "../worktrees/worktrees.ts";
import { harnessRegistry } from "./registry.ts";

/** Another engine already holds the id a Claude session was to run under. */
export class SessionIdTakenError extends Error {
  constructor(
    readonly sessionId: string,
    readonly holder: string,
  ) {
    super(`Session ${sessionId} belongs to the ${holder} harness.`);
    this.name = "SessionIdTakenError";
  }
}

/** A pi model handle, as the caller resolved it on the session's account. */
type PiModel = Parameters<typeof piStore.acquireNew>[1];

/** What every new session starts with, whichever engine runs it. */
interface SessionStart {
  agentType: AgentType;
  thinkingLevel?: ThinkingLevel | undefined;
  mode?: SessionMode | undefined;
  /** Where the session runs; the app CWD when absent. */
  cwd?: string | undefined;
  /** The worktree the session runs in: its durable cwd, linked at creation. */
  worktreeId?: string | undefined;
  credentialProfileId: string;
  /** Session-start evidence its prompt conditions freeze (Task 287). */
  promptEvidence?: SessionPromptEvidence | undefined;
  /**
   * Freeze its library skills before the first query, from these names when
   * given (`sessionSkillPreset`; with them the freeze awaits nothing). pi
   * already freezes inside creation; asking makes sure of it.
   */
  skills?: true | readonly string[] | undefined;
  /** The title it starts with; a titled session is never auto-named. */
  title?: string | undefined;
}

/** A session to create, with what only its engine takes. */
export type NewSession =
  | (SessionStart & {
      harness: "claude-sdk";
      /** The id it runs under. */
      id: string;
      /**
       * The id came from a client, so it is checked against everything another
       * engine holds, a transcript on disk included. A server-minted id is
       * checked against memory and the row only: no transcript can hold it.
       */
      clientId?: boolean | undefined;
      modelId?: string | undefined;
      /** Instructions appended to its system prompt (the Personal Assistant). */
      additionalSystemPrompt?: string | undefined;
    })
  | (SessionStart & {
      harness: "pi";
      /** pi mints the id; the model is a handle on the session's account. */
      model?: PiModel;
      /** The row's purpose when it is not an ordinary chat (`draft`). */
      purpose?: string | undefined;
      /** Declared at creation: it is persisted before the session goes live. */
      scope?: SessionScope | undefined;
    });

/**
 * Create the session and bring it live. The engine's own order holds: Claude
 * takes its id, so its worktree edge and frozen prompt conditions are in place
 * before the store resolves them; pi mints its id and freezes its prompt
 * conditions inside creation, so its row and edge follow it.
 */
export async function createSession(spec: NewSession): Promise<LiveSession> {
  if (spec.harness === "claude-sdk") {
    // The last ownership check: from here to the session's registration
    // nothing yields, so no other engine can take the id in between, and a
    // refusal comes before anything is written for it.
    const holder = harnessRegistry.otherHolder(spec.id, "claude-sdk", {
      onDisk: spec.clientId === true,
    });
    if (holder) throw new SessionIdTakenError(spec.id, holder);
    linkWorktree(spec.id, spec.worktreeId);
    if (spec.promptEvidence)
      sessionPromptConditions(spec.id, spec.agentType, spec.promptEvidence);
    // Started, not awaited: with a preset the freeze lands right here, so
    // nothing yields between the checks above and the session's registration.
    const skillsFrozen = spec.skills
      ? sessionSkills(
          spec.id,
          spec.agentType,
          spec.skills === true ? undefined : spec.skills,
        )
      : undefined;
    const session = claudeSdkStore.acquire(spec.id, {
      agentType: spec.agentType,
      credentialProfileId: spec.credentialProfileId,
      ...(spec.modelId !== undefined ? { modelId: spec.modelId } : {}),
      ...(spec.thinkingLevel !== undefined
        ? { thinkingLevel: spec.thinkingLevel }
        : {}),
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      ...(spec.additionalSystemPrompt !== undefined
        ? { additionalSystemPrompt: spec.additionalSystemPrompt }
        : {}),
      ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
    });
    await skillsFrozen;
    // Before the first prompt: `setTitle` also marks auto-naming done.
    if (spec.title !== undefined) session.setTitle(spec.title);
    return session;
  }

  const live = await piStore.acquireNew(
    spec.agentType,
    spec.model,
    spec.thinkingLevel,
    {
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      credentialProfileId: spec.credentialProfileId,
      // pi builds the system prompt inside creation, so the session-start
      // evidence arrives with it.
      ...(spec.promptEvidence !== undefined
        ? { promptEvidence: spec.promptEvidence }
        : {}),
      ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
      ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
    },
  );
  sessionStore.upsert({
    id: live.sessionId,
    harness: "pi",
    agentType: spec.agentType,
    credentialProfileId: spec.credentialProfileId,
    mode: live.sessionMode,
    ...(spec.purpose !== undefined ? { purpose: spec.purpose } : {}),
  });
  if (spec.skills)
    await sessionSkills(
      live.sessionId,
      spec.agentType,
      spec.skills === true ? undefined : spec.skills,
    );
  linkWorktree(live.sessionId, spec.worktreeId);
  // A stored title keeps the first prompt from auto-naming it.
  if (spec.title !== undefined) live.rename(spec.title);
  return live;
}

function linkWorktree(sessionId: string, worktreeId: string | undefined): void {
  if (!worktreeId) return;
  linkSessionToWorktree(sessionId, worktreeId);
  broadcastWorktreeEdgeChange();
}
