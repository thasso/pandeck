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
import {
  harnessForModelProvider,
  type ClientMessage,
  type CredentialProfileProvider,
  type Harness,
  type TaskSessionRef,
  type ThinkingLevel,
} from "@assistant/shared";
import { AGENT_DEFAULT_EFFORT } from "../agents/agentLibrary.ts";
import { publishAgentLibrary } from "../agents/agentLibraryList.ts";
import type { SessionAgent } from "../agents/sessionAgent.ts";
import {
  AgentSpawnRefusedError,
  resolveAgentOnRuntime,
  resolveAgentSpawn,
} from "../agents/agentSpawn.ts";
import { resolveSessionAccount } from "../sessionAccount.ts";
import type { LiveSession } from "../harness.ts";
import { findModelForProfile } from "../piSdk/models.ts";
import type { SessionPromptEvidence } from "../promptConditions.ts";
import { getSettings } from "../settings.ts";
import {
  createSession,
  SessionAgentConflictError,
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
  account(req: FirstSendRequest): Promise<AccountAdmission>;
  /** What has to be resolved before a worktree can be provisioned for it. */
  prepare(
    req: FirstSendRequest,
    profileId: string,
  ): Promise<
    { refusal: FirstSendRefusal } | { create: CreateFirstSendSession }
  >;
}

/** What a first send starts as: the definition's role, on one runtime. */
interface FirstSendAgent {
  peerTurnCap?: number;
  compactionWindow?: number;
  agent: SessionAgent;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * The runtime a send names, when it names a model: the user picked it on the
 * new-session page, and that pick is their approval. A send naming none runs
 * the definition's default.
 */
function pickedRuntime(
  req: FirstSendRequest,
):
  | { provider: string; modelId: string; thinkingLevel: ThinkingLevel }
  | undefined {
  if (req.modelProvider === undefined || req.modelId === undefined)
    return undefined;
  return {
    provider: req.modelProvider,
    modelId: req.modelId,
    thinkingLevel: req.thinkingLevel ?? AGENT_DEFAULT_EFFORT,
  };
}

/**
 * The definition a send starts its session as, resolved now: its role, on
 * the runtime the send names or else its default on the picked account. The
 * persona and engine the client staged must be its own.
 */
async function firstSendAgent(
  req: FirstSendRequest,
  profileId: string,
): Promise<{ refusal: FirstSendRefusal } | { agent?: FirstSendAgent }> {
  const resolved = await resolveFirstSendAgent(req, profileId);
  // The browser picked from the `agents` list it holds. A refusal means that
  // list no longer matches the library (a hand edit, a model or account
  // change), so it is published again: the draft then follows it, and the
  // next send runs what the pickers show rather than being refused again.
  if ("refusal" in resolved) void publishAgentLibrary().catch(() => undefined);
  return resolved;
}

/**
 * The definition read AGAIN right before the session is created, which is
 * what it freezes — as a spawn does. A worktree provisioned after `prepare`
 * can take seconds, and a hand edit landing then (a tool denied, the body
 * rewritten, the folder deleted) must not be lost to the earlier read. A
 * runtime that moved since `prepare` refuses, like `prepare` does.
 */
async function agentAtCreation(
  req: FirstSendRequest,
  profileId: string,
  prepared: FirstSendAgent | undefined,
): Promise<
  | { refusal: FirstSendRefusal }
  | { agent?: SessionAgent; peerTurnCap?: number; compactionWindow?: number }
> {
  if (!prepared) return {};
  // The same checks as `prepare`: a persona or engine that no longer matches
  // the send refuses here, so only the runtime is left to compare below.
  const again = await firstSendAgent(req, profileId);
  if ("refusal" in again) return again;
  const now = again.agent!;
  if (
    now.provider !== prepared.provider ||
    now.modelId !== prepared.modelId ||
    now.thinkingLevel !== prepared.thinkingLevel
  ) {
    void publishAgentLibrary().catch(() => undefined);
    return {
      refusal: {
        message: `Agent "${now.agent.name}" changed while the session was being set up: it now runs on ${now.provider}/${now.modelId} at ${now.thinkingLevel} effort. The pickers now show its current runtime; send again to start it.`,
      },
    };
  }
  return {
    agent: now.agent,
    ...(now.compactionWindow !== undefined
      ? { compactionWindow: now.compactionWindow }
      : {}),
    ...(now.peerTurnCap !== undefined ? { peerTurnCap: now.peerTurnCap } : {}),
  };
}

async function resolveFirstSendAgent(
  req: FirstSendRequest,
  profileId: string,
): Promise<{ refusal: FirstSendRefusal } | { agent?: FirstSendAgent }> {
  if (req.agent === undefined) return {};
  let agent: FirstSendAgent;
  try {
    const picked = pickedRuntime(req);
    agent = picked
      ? {
          ...picked,
          ...(await resolveAgentOnRuntime(req.agent, picked, profileId)),
        }
      : await resolveAgentSpawn(req.agent, undefined, {
          profileId,
          requiresEnterprise: req.requiresEnterprise === true,
        });
  } catch (error) {
    if (error instanceof AgentSpawnRefusedError)
      return { refusal: { message: error.message } };
    throw error;
  }
  if (agent.agent.persona !== req.agentType)
    return {
      refusal: {
        // The draft drops a definition whose persona changed rather than
        // switch persona (and so worktree) under the user.
        message: `Agent "${agent.agent.name}" runs as the ${agent.agent.persona} persona, not ${req.agentType}. It is no longer picked: send again for a plain ${req.agentType} session, or pick it on a new session.`,
      },
    };
  const harnessRefusal = agentHarnessRefusal(req.harness, agent);
  if (harnessRefusal) return { refusal: harnessRefusal };
  return { agent };
}

function agentHarnessRefusal(
  harness: Harness,
  agent: FirstSendAgent,
): FirstSendRefusal | undefined {
  return harnessForModelProvider(agent.provider) === harness
    ? undefined
    : {
        message: `Agent "${agent.agent.name}" runs on ${agent.provider}/${agent.modelId}, which this engine does not run.`,
      };
}

type AccountAdmission = { refusal: FirstSendRefusal } | { profileId: string };

async function firstSendAccount(
  req: FirstSendRequest,
  provider: CredentialProfileProvider,
): Promise<AccountAdmission> {
  try {
    // A named definition without a picked runtime fixes its default model and
    // effort before Automatic chooses an account; a picked runtime routes like
    // any send.
    const agent =
      req.agent !== undefined &&
      req.credentialProfileId === undefined &&
      !pickedRuntime(req)
        ? await resolveAgentSpawn(req.agent, undefined, {
            requiresEnterprise: req.requiresEnterprise === true,
          })
        : undefined;
    const harnessRefusal = agent
      ? agentHarnessRefusal(req.harness, agent)
      : undefined;
    if (harnessRefusal) return { refusal: harnessRefusal };
    return {
      profileId: await resolveSessionAccount(
        provider,
        agent
          ? {
              ...req,
              credentialProfileId: agent.credentialProfileId,
              modelProvider: agent.provider,
              modelId: agent.modelId,
              thinkingLevel: agent.thinkingLevel,
            }
          : req,
      ),
    };
  } catch (error) {
    if (req.agent !== undefined)
      void publishAgentLibrary().catch(() => undefined);
    return {
      refusal: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
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

async function applyDefinitionWindow(
  live: LiveSession,
  tokens: number | undefined,
): Promise<FirstSendRefusal | undefined> {
  if (tokens === undefined) return undefined;
  const { setSessionCompactionWindow } =
    await import("../sessionCompactionWindow.ts");
  const result = await setSessionCompactionWindow(live.sessionId, tokens, {
    spawn: "definition",
  });
  return result.ok
    ? undefined
    : {
        message: `Session ${live.sessionId} was created, but its compaction window could not be saved: ${result.message}; the message was not sent.`,
        onSession: true,
      };
}

const engines: Record<Harness, FirstSendEngine> = {
  pi: {
    // pi mints the session id; the client's only names the optimistic view.
    takesClientId: false,
    personaGate: "available",
    disabled: () => false,
    admitId: () => undefined,
    account: (req) => firstSendAccount(req, "openai-codex"),
    async prepare(req, profileId) {
      const started = await firstSendAgent(req, profileId);
      if ("refusal" in started) return started;
      const { agent } = started;
      // A model the account does not offer ends the send before a worktree is
      // provisioned for it. An agent's is the one it resolved to.
      const provider = agent?.provider ?? req.modelProvider;
      const modelId = agent?.modelId ?? req.modelId;
      let model: Awaited<ReturnType<typeof findModelForProfile>>;
      if (provider && modelId) {
        model = await findModelForProfile(profileId, provider, modelId);
        if (!model)
          return {
            refusal: {
              message: `Model ${provider}/${modelId} is not available.`,
            },
          };
      }
      const create: CreateFirstSendSession = async ({ worktree, evidence }) => {
        const frozen = await agentAtCreation(req, profileId, agent);
        if ("refusal" in frozen) return frozen;
        const live = await createSession({
          harness: "pi",
          agentType: req.agentType,
          model,
          thinkingLevel: agent?.thinkingLevel ?? req.thinkingLevel,
          ...(frozen.agent ? { agent: frozen.agent } : {}),
          ...(frozen.peerTurnCap !== undefined
            ? { peerTurnCap: frozen.peerTurnCap }
            : {}),
          mode: req.mode,
          ...(worktree ? { worktree } : {}),
          credentialProfileId: profileId,
          requiresEnterprise: req.requiresEnterprise,
          promptEvidence: evidence,
        });
        const windowRefusal = await applyDefinitionWindow(
          live,
          frozen.compactionWindow,
        );
        if (windowRefusal) return { refusal: windowRefusal };
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
    account: (req) => firstSendAccount(req, "claude"),
    async prepare(req, profileId) {
      const started = await firstSendAgent(req, profileId);
      if ("refusal" in started) return started;
      const { agent } = started;
      const create: CreateFirstSendSession = async ({ worktree, evidence }) => {
        const frozen = await agentAtCreation(req, profileId, agent);
        if ("refusal" in frozen) return frozen;
        let live: LiveSession;
        try {
          live = await createSession({
            harness: "claude-sdk",
            // The client's id: checked again, disk included, right before the
            // session registers.
            id: req.id,
            agentType: req.agentType,
            modelId: agent?.modelId ?? req.modelId,
            thinkingLevel: agent?.thinkingLevel ?? req.thinkingLevel,
            ...(frozen.agent ? { agent: frozen.agent } : {}),
            ...(frozen.peerTurnCap !== undefined
              ? { peerTurnCap: frozen.peerTurnCap }
              : {}),
            mode: req.mode,
            ...(worktree ? { worktree } : {}),
            credentialProfileId: profileId,
            requiresEnterprise: req.requiresEnterprise,
            promptEvidence: evidence,
          });
        } catch (err) {
          if (
            err instanceof SessionIdTakenError ||
            err instanceof SessionAgentConflictError
          )
            return { refusal: { message: err.message, onSession: true } };
          throw err;
        }
        const windowRefusal = await applyDefinitionWindow(
          live,
          frozen.compactionWindow,
        );
        if (windowRefusal) return { refusal: windowRefusal };
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
