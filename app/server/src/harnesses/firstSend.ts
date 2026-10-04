/**
 * What a session's first send asks of its engine (`docs/agent-harnesses.md`
 * step 10). `Connection.handleFirstSend` runs one flow for both engines: the
 * view claim, the worktree, the session context, viewing the new session, its
 * genesis card, the context links and the prompt, and the persona guard, which
 * stays there. The engine answers only what differs: whether it is switched
 * off, whether the client's id becomes the session's and may be taken, which
 * persona gate applies, the account, what it resolves before a worktree can be
 * provisioned, and what its session is created with (`create.ts` knows how).
 */
import type { ClientMessage, Harness, TaskSessionRef } from "@assistant/shared";
import {
  defaultOpenAiProfileId,
  enabledCredentialProfileById,
} from "../credentialProfiles.ts";
import type { LiveSession } from "../harness.ts";
import { findModelForProfile } from "../piSdk/models.ts";
import type { SessionPromptEvidence } from "../promptConditions.ts";
import { getSettings } from "../settings.ts";
import {
  createSession,
  SessionIdTakenError,
  sessionIdTakenMessage,
} from "./create.ts";
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

/**
 * Which persona gate a first send on this engine passes (`Connection` applies
 * it; persona creation guards live there): `available` is pi's environment
 * gate; `ordinarily-creatable` refuses only the server-owned personas, so a
 * Claude workshop stays creatable in production.
 */
export type PersonaGate = "available" | "ordinarily-creatable";

interface FirstSendEngine {
  /** Whether the send's own id becomes the session's; the view claims it then. */
  readonly takesClientId: boolean;
  readonly personaGate: PersonaGate;
  /** Whether the engine is switched off: its sends are ignored outright. */
  disabled(): boolean;
  /** Whether the send's id may be the session's; asked before the persona. */
  admitId(req: FirstSendRequest): FirstSendRefusal | undefined;
  /** The account the session runs on, or why the send names none it may use. */
  account(
    req: FirstSendRequest,
  ): { refusal: FirstSendRefusal } | { profileId: string };
  /** What has to be resolved before a worktree can be provisioned for it. */
  prepare(
    req: FirstSendRequest,
    profileId: string,
  ): Promise<
    { refusal: FirstSendRefusal } | { create: CreateFirstSendSession }
  >;
}

/** A Claude send names its id, so one another engine holds is refused. */
function claudeOwnershipRefusal(id: string): FirstSendRefusal | undefined {
  const holder = harnessRegistry.otherHolder(id, "claude-sdk");
  return holder
    ? {
        message: sessionIdTakenMessage(id, holder),
        onSession: true,
      }
    : undefined;
}

const engines: Record<Harness, FirstSendEngine> = {
  pi: {
    // pi mints the session id; the client's only names the optimistic view.
    takesClientId: false,
    personaGate: "available",
    disabled: () => false,
    admitId: () => undefined,
    account(req) {
      const profileId = req.credentialProfileId ?? defaultOpenAiProfileId();
      if (enabledCredentialProfileById(profileId)?.provider !== "openai-codex")
        return {
          refusal: {
            message: "Select an OpenAI credential profile for this pi session.",
          },
        };
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
            refusal: {
              message: `Model ${req.modelProvider}/${req.modelId} is not available.`,
            },
          };
      }
      const create: CreateFirstSendSession = async ({ worktree, evidence }) => {
        const live = await createSession({
          harness: "pi",
          agentType: req.agentType,
          model,
          thinkingLevel: req.thinkingLevel,
          mode: req.mode,
          cwd: worktree?.path,
          worktreeId: worktree?.id,
          credentialProfileId: profileId,
          promptEvidence: evidence,
          skills: true,
        });
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
      return { create };
    },
  },
  "claude-sdk": {
    takesClientId: true,
    personaGate: "ordinarily-creatable",
    disabled: () => !getSettings().claudeSdk.enabled,
    // Before anything is written for the client-supplied id.
    admitId: (req) => claudeOwnershipRefusal(req.id),
    account(req) {
      const profileId = req.credentialProfileId?.trim();
      if (
        !profileId ||
        enabledCredentialProfileById(profileId)?.provider !== "claude"
      )
        return {
          refusal: {
            message: "Select a Claude credential profile for this session.",
          },
        };
      return { profileId };
    },
    async prepare(req, profileId) {
      const create: CreateFirstSendSession = async ({ worktree, evidence }) => {
        let live: LiveSession;
        try {
          live = await createSession({
            harness: "claude-sdk",
            // The client's id: checked again, disk included, right before the
            // session registers.
            id: req.id,
            agentType: req.agentType,
            modelId: req.modelId,
            thinkingLevel: req.thinkingLevel,
            mode: req.mode,
            cwd: worktree?.path,
            worktreeId: worktree?.id,
            credentialProfileId: profileId,
            promptEvidence: evidence,
            skills: true,
          });
        } catch (err) {
          if (err instanceof SessionIdTakenError)
            return { refusal: { message: err.message, onSession: true } };
          throw err;
        }
        return {
          live,
          ref: {
            harness: "claude-sdk",
            agentType: req.agentType,
            sessionId: req.id,
          },
        };
      };
      return { create };
    },
  },
};

/** The first-send steps of `harness`. */
export function firstSendEngine(harness: Harness): FirstSendEngine {
  return engines[harness];
}
