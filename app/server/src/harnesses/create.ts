/**
 * Creating a session on either engine (`docs/agent-harnesses.md` step 11): the
 * one place that knows each engine's creation sequence, so a caller names what
 * the session starts with and never repeats how. Callers keep what is theirs:
 * admission, the model they resolve and how a missing one is reported, and
 * whatever they do with the session once it exists.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentType,
  Harness,
  SessionMode,
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
import { sessionSkillPreset, sessionSkills } from "../sessionSkills.ts";
import { worktreePathIfPresent } from "../worktrees/sessionCwd.ts";
import { broadcastWorktreeEdgeChange } from "../worktrees/worktrees.ts";
import { harnessRegistry } from "./registry.ts";

/** Why a session cannot run under an id another engine holds. */
export function sessionIdTakenMessage(id: string, holder: Harness): string {
  return `Session ${id} belongs to the ${holder} harness.`;
}

/** Another engine already holds the id a Claude session was to run under. */
export class SessionIdTakenError extends Error {
  constructor(
    readonly sessionId: string,
    readonly holder: Harness,
  ) {
    super(sessionIdTakenMessage(sessionId, holder));
    this.name = "SessionIdTakenError";
  }
}

/** A pi model handle, as the caller resolved it on the session's account. */
export type PiModel = Parameters<typeof piStore.acquireNew>[1];

/**
 * Where a session runs: in a worktree, whose path is its cwd and whose edge is
 * linked at creation (the durable cwd every reopen follows), or in a bare
 * directory with no edge (a merge agent in the main checkout); the app CWD
 * when neither is given. One or the other, so the two cannot disagree. A
 * worktree given without its path runs where its edge resolves, as a reopen
 * would: in its checkout when that is live, else in the app CWD.
 */
type SessionPlace =
  | {
      worktree: { id: string; path?: string | undefined };
      cwd?: undefined;
    }
  | {
      worktree?: undefined;
      cwd?: string | undefined;
    };

/** What every new session starts with, whichever engine runs it. */
type SessionStart = SessionPlace & {
  agentType: AgentType;
  thinkingLevel?: ThinkingLevel | undefined;
  mode?: SessionMode | undefined;
  credentialProfileId: string;
  /** Session-start evidence its prompt conditions freeze (Task 287). */
  promptEvidence?: SessionPromptEvidence | undefined;
  /** The title it starts with; a titled session is never auto-named. */
  title?: string | undefined;
};

/** A session to create, with what only its engine takes. */
export type NewSession =
  | (SessionStart & {
      harness: "claude-sdk";
      /**
       * The id it runs under, when the caller names one: checked against
       * everything another engine holds, a transcript on disk included.
       * Absent, a fresh id is minted here and checked against memory and the
       * row only, since no transcript can hold it. An id Claude already holds
       * reopens that session rather than creating one: its stored settings
       * win, while the worktree link and title still apply (a retried first
       * send relies on this).
       */
      id?: string | undefined;
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
    });

/**
 * Create the session and bring it live. The engine's own order holds: Claude
 * takes its id, so its worktree edge and frozen prompt conditions are in place
 * before the store resolves them; pi mints its id and freezes its prompt
 * conditions inside creation, so its row and edge follow it. Either way its
 * current library skills are frozen before its first query.
 */
export async function createSession(spec: NewSession): Promise<LiveSession> {
  // Resolved here for both engines alike: Claude's store would read a
  // pathless worktree from its edge, but pi's `acquireNew` never looks.
  const cwd = spec.worktree
    ? (spec.worktree.path ?? worktreePathIfPresent(spec.worktree.id))
    : spec.cwd;
  if (spec.harness === "claude-sdk") {
    const id = spec.id ?? randomUUID();
    // Resolved first: from the ownership check below to the session's
    // registration nothing yields, so no other engine can take the id in
    // between, and a refusal comes before anything is written for it.
    const skills = await sessionSkillPreset(id, spec.agentType);
    const holder = harnessRegistry.otherHolder(id, "claude-sdk", {
      onDisk: spec.id !== undefined,
    });
    if (holder) throw new SessionIdTakenError(id, holder);
    linkWorktree(id, spec.worktree?.id);
    if (spec.promptEvidence)
      sessionPromptConditions(id, spec.agentType, spec.promptEvidence);
    // With the names resolved, the freeze lands right here, before the
    // session exists; an existing freeze or a non-coding persona awaits
    // nothing either.
    const skillsFrozen = sessionSkills(id, spec.agentType, skills);
    const session = claudeSdkStore.acquire(id, {
      agentType: spec.agentType,
      credentialProfileId: spec.credentialProfileId,
      ...(spec.modelId !== undefined ? { modelId: spec.modelId } : {}),
      ...(spec.thinkingLevel !== undefined
        ? { thinkingLevel: spec.thinkingLevel }
        : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(spec.additionalSystemPrompt !== undefined
        ? { additionalSystemPrompt: spec.additionalSystemPrompt }
        : {}),
      ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
    });
    // Before the first prompt: `setTitle` also marks auto-naming done.
    if (spec.title !== undefined) session.setTitle(spec.title);
    await skillsFrozen;
    return session;
  }

  const live = await piStore.acquireNew(
    spec.agentType,
    spec.model,
    spec.thinkingLevel,
    {
      ...(cwd !== undefined ? { cwd } : {}),
      credentialProfileId: spec.credentialProfileId,
      // pi builds the system prompt inside creation, so the session-start
      // evidence arrives with it.
      ...(spec.promptEvidence !== undefined
        ? { promptEvidence: spec.promptEvidence }
        : {}),
      ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
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
  // pi freezes them inside creation already; this keeps the guarantee here.
  await sessionSkills(live.sessionId, spec.agentType);
  linkWorktree(live.sessionId, spec.worktree?.id);
  // A stored title keeps the first prompt from auto-naming it.
  if (spec.title !== undefined) live.rename(spec.title);
  return live;
}

function linkWorktree(sessionId: string, worktreeId: string | undefined): void {
  if (!worktreeId) return;
  linkSessionToWorktree(sessionId, worktreeId);
  broadcastWorktreeEdgeChange();
}
