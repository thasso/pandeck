/**
 * The account-kind table (`docs/account-routing.md`): for each kind of
 * credential profile, which harness it runs, how it holds its credential,
 * whether it is a subscription login, where its models come from and where
 * Settings edits it. Code that needs one of these reads the descriptor, never
 * the kind id.
 *
 * Which account may run a model is decided per model, by
 * {@link accountServesModel}: an OpenAI-compatible model runs only on the one
 * account whose id is its pi provider id.
 */
import { CLAUDE_SDK_PROVIDER, type Harness } from "./harnesses.ts";
import type { CredentialProfileProvider } from "./protocol.ts";

/**
 * The OpenAI-compatible account kind, and the id and pi provider id of the
 * account the former single endpoint migrated to. Every later account's id
 * adds a 12-hex suffix.
 */
export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";

export interface AccountKindDescriptor {
  /** The harness every model of this kind runs on. */
  readonly harness: Harness;
  /**
   * How the account holds its credential: a provider login PA keeps in the
   * profile's directory, or an endpoint (URL and optional key) the user
   * enters in Settings.
   */
  readonly credential: "login" | "endpoint";
  /**
   * A subscription login with health, limits, usage, benches and failover.
   * Nothing of the kind is recorded or shown for any other account.
   */
  readonly subscription: boolean;
  /** The model provider whose runs speak for the subscription login. */
  readonly subscriptionModelProvider?: string;
  /** Where its models come from: pi's catalog, a curated list, or the endpoint's `/models`. */
  readonly models: "catalog" | "curated" | "endpoint";
  /** The Settings section that lists and edits accounts of this kind. */
  readonly settingsSection: string;
  /** The kind's name as Settings and pickers show it. */
  readonly label: string;
  /** Whether the Usage page lists it. */
  readonly usagePage: boolean;
}

export const ACCOUNT_KINDS: Readonly<
  Record<CredentialProfileProvider, AccountKindDescriptor>
> = {
  "openai-codex": {
    harness: "pi",
    credential: "login",
    subscription: true,
    subscriptionModelProvider: "openai-codex",
    models: "catalog",
    settingsSection: "openai",
    label: "OpenAI",
    usagePage: true,
  },
  claude: {
    harness: "claude-sdk",
    credential: "login",
    subscription: true,
    subscriptionModelProvider: CLAUDE_SDK_PROVIDER,
    models: "curated",
    settingsSection: "claude-sdk",
    label: "Claude",
    usagePage: true,
  },
  "openai-compatible": {
    harness: "pi",
    credential: "endpoint",
    subscription: false,
    models: "endpoint",
    settingsSection: "openai-compatible",
    label: "OpenAI-compatible",
    usagePage: false,
  },
};

/** Whether an untrusted value names an account kind this app runs. */
export function isAccountKind(
  value: unknown,
): value is CredentialProfileProvider {
  return typeof value === "string" && Object.hasOwn(ACCOUNT_KINDS, value);
}

/** The kinds whose descriptor says `subscription`. */
export type SubscriptionAccountKind = "openai-codex" | "claude";

/**
 * Whether accounts of `kind` are subscription logins: only those have health,
 * limits, usage, benches and failover.
 */
export function isSubscriptionAccountKind(
  kind: CredentialProfileProvider,
): kind is SubscriptionAccountKind {
  return ACCOUNT_KINDS[kind].subscription;
}

const COMPATIBLE_ACCOUNT_ID = /^openai-compatible-[0-9a-f]{12}$/;

/**
 * Whether a pi model provider id is an OpenAI-compatible account's. The
 * migrated endpoint keeps the plain id; every later one gets a 12-hex suffix.
 * Only that kind is ever given an id in this grammar, so for a pi account the
 * same test on its id tells its kind.
 */
export function isOpenAiCompatibleModelProvider(
  provider: string | undefined,
): boolean {
  return (
    provider === OPENAI_COMPATIBLE_PROVIDER_ID ||
    (provider !== undefined && COMPATIBLE_ACCOUNT_ID.test(provider))
  );
}

/**
 * Whether `account` may run a model of `modelProvider`. A compatible account
 * serves only its own provider; an OpenAI account every other pi provider; a
 * Claude account only Claude models. Never across.
 */
export function accountServesModel(
  account: { id: string; provider: CredentialProfileProvider },
  modelProvider: string,
): boolean {
  if (isOpenAiCompatibleModelProvider(modelProvider))
    return (
      account.provider === "openai-compatible" && account.id === modelProvider
    );
  if (account.provider === "openai-compatible") return false;
  return (
    ACCOUNT_KINDS[account.provider].harness ===
    (modelProvider === CLAUDE_SDK_PROVIDER ? "claude-sdk" : "pi")
  );
}

/**
 * {@link accountServesModel} for a pi account known by its id alone, as the
 * Worker knows it: an id in the compatible grammar is that kind.
 */
export function piAccountServesModel(
  accountId: string,
  modelProvider: string,
): boolean {
  return isOpenAiCompatibleModelProvider(accountId)
    ? modelProvider === accountId
    : !isOpenAiCompatibleModelProvider(modelProvider) &&
        modelProvider !== CLAUDE_SDK_PROVIDER;
}

/**
 * Rule P: the exact account a stored pin means for a model. A compatible
 * model is served by exactly one account, whose id is its provider, so that
 * is its pin whatever was stored; any other pin is returned unchanged.
 * Missing, disabled and enterprise refusals still apply to the result.
 */
export function accountPinForModel(
  modelProvider: string,
  pin: string | undefined,
): string | undefined {
  return isOpenAiCompatibleModelProvider(modelProvider) ? modelProvider : pin;
}
