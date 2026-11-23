/**
 * UI capability helpers derived from a session's clean identity pair
 * `{harness, agentType}` — NOT from the legacy `kind`. These are the Stage2-B
 * replacements for the per-kind booleans that App.tsx used to compute inline
 * (`displayIsWorkspaceKind`, …).
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
 * Whether a started session's picker must refuse `model`. A started session
 * changes model only on its own harness and bound account
 * (`docs/session-runtime-switching.md`):
 *
 * - pi refuses Claude SDK models and any model its account does not serve
 *   (another endpoint's, or an endpoint's from an OpenAI login, and back);
 * - Claude refuses every non-Claude model and, once the bound account's model
 *   list is known (`accountModels`), a Claude model it does not offer.
 *
 * The server refuses them either way; this keeps the picker from offering them.
 */
export function startedModelDisabled(
  session: {
    harness: Harness | undefined;
    started: boolean;
    /** The bound account, when known. */
    account: { id: string; provider: CredentialProfileProvider } | undefined;
    /** The models the bound account offers, when its list is known. */
    accountModels?: readonly Pick<ModelOption, "provider" | "id">[] | undefined;
  },
  model: Pick<ModelOption, "provider" | "id">,
): boolean {
  if (!session.started) return false;
  if (session.harness === "claude-sdk")
    return (
      !isClaudeSdkModel(model) ||
      (session.accountModels !== undefined &&
        !session.accountModels.some(
          (offered) =>
            offered.provider === model.provider && offered.id === model.id,
        ))
    );
  // A started session whose harness is not known yet offers nothing.
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
