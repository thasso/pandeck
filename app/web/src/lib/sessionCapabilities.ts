/**
 * UI capability helpers derived from a session's clean identity pair
 * `{harness, agentType}` — NOT from the legacy `kind`. These are the Stage2-B
 * replacements for the per-kind booleans that App.tsx used to compute inline
 * (`displayIsWorkspaceKind`, `modelLocked`, …).
 *
 * `harness`/`agentType` are server-populated on every `SessionState` and
 * `SessionListItem`; the optimistic synthetic session staged on the client sets
 * them too, so these read the same off either shape.
 */
import {
  accountServesModel,
  isClaudeSdkModel,
  type AgentType,
  type CredentialProfileProvider,
  type Harness,
  type ModelOption,
} from "@assistant/shared";

/** The subset of a session needed to derive its UI capabilities. */
interface SessionCaps {
  harness?: Harness;
  agentType?: AgentType;
}

/**
 * Whether the session has the Build/Plan mode axis. Every interactive persona
 * gets it on both harnesses: coding sessions lose file writers and every
 * persona loses side-effecting app tools. The server-owned workflow coordinator
 * is not an interactive planning surface.
 */
export function hasModeAxis(s: SessionCaps): boolean {
  return Boolean(s.agentType && s.agentType !== "workflow-coordinator");
}

/**
 * Non-pi harnesses reject post-turn model/thinking changes server-side (Claude
 * SDK), so once started their pickers are read-only. pi sessions can switch
 * freely.
 */
export function locksModelAfterStart(s: SessionCaps): boolean {
  return s.harness !== "pi";
}

/**
 * Whether a started session's picker must refuse `model`. Its model change
 * stays on the session's harness and bound account, so a pi session refuses
 * Claude SDK models and any model its account does not serve (another
 * endpoint's, or an endpoint's from an OpenAI login, and back). The server
 * refuses them either way; this keeps the picker from offering them.
 */
export function startedModelDisabled(
  session: {
    harness: Harness | undefined;
    started: boolean;
    /** The bound account, when known. */
    account: { id: string; provider: CredentialProfileProvider } | undefined;
  },
  model: Pick<ModelOption, "provider" | "id">,
): boolean {
  if (!session.started) return false;
  // Non-pi harnesses lock the model outright (`locksModelAfterStart`).
  if (session.harness !== "pi") return true;
  if (isClaudeSdkModel(model)) return true;
  return (
    session.account !== undefined &&
    !accountServesModel(session.account, model.provider)
  );
}

/**
 * Whether a harness is created optimistically on the client (staged, then
 * created on first prompt via `harnessSend`) rather than via the pi
 * `newSession` bootstrap. Every non-pi harness is optimistic.
 */
export function isOptimisticHarness(harness: Harness): boolean {
  return harness !== "pi";
}
