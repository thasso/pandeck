/**
 * What a session's first send asks of its engine (`docs/agent-harnesses.md`
 * step 10). `Connection.handleFirstSend` runs one flow for both engines: the
 * view claim, the worktree, the session context, viewing the new session, its
 * genesis card, the context links and the prompt. The engine answers only what
 * differs: whether it takes the send at all, what it resolves before a
 * worktree can be provisioned, and how it brings the session live.
 */
import {
  isOrdinarilyCreatableAgentType,
  type ClientMessage,
  type Harness,
  type TaskSessionRef,
} from "@assistant/shared";
import { isAgentAvailable } from "../agents.ts";
import {
  defaultOpenAiProfileId,
  enabledCredentialProfileById,
} from "../credentialProfiles.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { linkSessionToWorktree } from "../db/worktreeStore.ts";
import type { LiveSession } from "../harness.ts";
import { hub } from "../hub.ts";
import { findModelForProfile } from "../piSdk/models.ts";
import {
  sessionPromptConditions,
  type SessionPromptEvidence,
} from "../promptConditions.ts";
import { sessionSkillPreset, sessionSkills } from "../sessionSkills.ts";
import { getSettings } from "../settings.ts";
import { broadcastWorktreeEdgeChange } from "../worktrees/worktrees.ts";
import { harnessRegistry } from "./registry.ts";

/** A first send: the `harnessSend` the client opens a session with. */
export type FirstSendRequest = Extract<ClientMessage, { type: "harnessSend" }>;

/** Why a first send is refused, as the client is told. */
export interface FirstSendRefusal {
  message: string;
  /** Said on the session the send named, retiring its optimistic prompt. */
  onSession?: boolean;
}

/** What the shared flow has settled by the time the session is created. */
interface FirstSendStart {
  /** The worktree the session runs in, staged or just provisioned. */
  worktree: { id: string; path: string } | null;
  /** The session-start evidence its prompt conditions freeze. */
  evidence: SessionPromptEvidence;
}

/** The session a first send created, and how a Task link names it. */
interface FirstSendSession {
  live: LiveSession;
  ref: TaskSessionRef;
}

/** Bring the session live; a refusal here still writes nothing. */
type CreateFirstSendSession = (
  start: FirstSendStart,
) => Promise<{ refusal: FirstSendRefusal } | FirstSendSession>;

interface FirstSendEngine {
  /** Whether the send's own id becomes the session's; the view claims it then. */
  readonly takesClientId: boolean;
  /** Whether the engine is switched off: its sends are ignored outright. */
  disabled(): boolean;
  /** The engine's own admission, in its order: the account it runs on, or why not. */
  admit(req: FirstSendRequest): FirstSendRefusal | { profileId: string };
  /** What has to be resolved before a worktree can be provisioned for it. */
  prepare(
    req: FirstSendRequest,
    profileId: string,
  ): Promise<FirstSendRefusal | CreateFirstSendSession>;
}

/** A Claude send names its id, so one another engine holds is refused. */
function claudeOwnershipRefusal(id: string): FirstSendRefusal | undefined {
  const holder = harnessRegistry.otherHolder(id, "claude-sdk");
  return holder
    ? {
        message: `Session ${id} belongs to the ${holder} harness.`,
        onSession: true,
      }
    : undefined;
}

const engines: Record<Harness, FirstSendEngine> = {
  pi: {
    // pi mints the session id; the client's only names the optimistic view.
    takesClientId: false,
    disabled: () => false,
    admit(req) {
      const profileId = req.credentialProfileId ?? defaultOpenAiProfileId();
      if (enabledCredentialProfileById(profileId)?.provider !== "openai-codex")
        return {
          message: "Select an OpenAI credential profile for this pi session.",
        };
      if (!isAgentAvailable(req.agentType))
        return { message: `The "${req.agentType}" agent is not available.` };
      return { profileId };
    },
    async prepare(req, profileId) {
      // A model the account does not offer ends the send before a worktree is
      // provisioned for it.
      let model: Awaited<ReturnType<typeof findModelForProfile>>;
      if (req.modelProvider && req.modelId) {
        model = await findModelForProfile(
          profileId,
          req.modelProvider,
          req.modelId,
        );
        if (!model)
          return {
            message: `Model ${req.modelProvider}/${req.modelId} is not available.`,
          };
      }
      return async ({ worktree, evidence }) => {
        const live = await hub.acquireNew(
          req.agentType,
          model,
          req.thinkingLevel,
          {
            ...(worktree ? { cwd: worktree.path } : {}),
            credentialProfileId: profileId,
            // pi builds the system prompt inside creation, so the
            // session-start evidence arrives with it (Task 287).
            promptEvidence: evidence,
            ...(req.mode ? { mode: req.mode } : {}),
          },
        );
        sessionStore.upsert({
          id: live.sessionId,
          harness: "pi",
          agentType: req.agentType,
          credentialProfileId: profileId,
          mode: live.sessionMode,
        });
        await sessionSkills(live.sessionId, req.agentType);
        if (worktree) {
          linkSessionToWorktree(live.sessionId, worktree.id);
          broadcastWorktreeEdgeChange();
        }
        return {
          live,
          ref: {
            harness: "pi",
            agentType: req.agentType,
            sessionId: live.sessionId,
            ...(live.sessionFile !== undefined
              ? { sessionFile: live.sessionFile }
              : {}),
          },
        };
      };
    },
  },
  "claude-sdk": {
    takesClientId: true,
    disabled: () => !getSettings().claudeSdk.enabled,
    admit(req) {
      // Before anything is written for the client-supplied id.
      const held = claudeOwnershipRefusal(req.id);
      if (held) return held;
      // The singleton `personal-assistant` persona is server-owned; a crafted
      // send must not be able to create it. Claude workshop must stay creatable
      // in production, so this is not pi's availability gate.
      if (!isOrdinarilyCreatableAgentType(req.agentType))
        return {
          message: `The "${String(req.agentType)}" agent cannot be created.`,
        };
      const profileId = req.credentialProfileId?.trim();
      if (
        !profileId ||
        enabledCredentialProfileById(profileId)?.provider !== "claude"
      )
        return {
          message: "Select a Claude credential profile for this session.",
        };
      return { profileId };
    },
    async prepare(req, profileId) {
      return async ({ worktree, evidence }) => {
        // Everything the writes below need is resolved first: from the
        // ownership check to the session's registration nothing awaits, so no
        // other engine can take the id in between, and a refusal comes before
        // any write.
        const skillPreset = await sessionSkillPreset(req.id, req.agentType);
        const held = claudeOwnershipRefusal(req.id);
        if (held) return { refusal: held };
        // Linked before the session exists: the store resolves its cwd from
        // the edge.
        if (worktree) {
          linkSessionToWorktree(req.id, worktree.id);
          broadcastWorktreeEdgeChange();
        }
        // Frozen before the first query builds the system prompt (Task 287):
        // every resumed query then reproduces it.
        sessionPromptConditions(req.id, req.agentType, evidence);
        // With the preset, the freeze awaits nothing: it lands before the session.
        const skillsFrozen = sessionSkills(req.id, req.agentType, skillPreset);
        const live = hub.acquireClaudeSdk(
          req.id,
          req.modelId,
          req.thinkingLevel,
          req.agentType,
          worktree?.path,
          undefined,
          profileId,
          req.mode,
        );
        await skillsFrozen;
        return {
          live,
          ref: {
            harness: "claude-sdk",
            agentType: req.agentType,
            sessionId: req.id,
          },
        };
      };
    },
  },
};

/** The first-send steps of `harness`. */
export function firstSendEngine(harness: Harness): FirstSendEngine {
  return engines[harness];
}
