import {
  CredentialSynchronizationError,
  readStoredCredential,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Credential,
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { deviceCodeInteraction } from "./codexLogin.ts";
import { chmodSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ACCOUNT_KINDS,
  accountServesModel,
  isOpenAiCompatibleModelProvider,
  loginStuckText,
  THINKING_LEVELS,
  type ModelOption,
  type ThinkingLevel,
} from "@assistant/shared";
import {
  OPENAI_COMPATIBLE_KEYLESS,
  openAiCompatibleProviderConfig,
  readOpenAiCompatibleEndpoint,
} from "../openAiCompatibleAccounts.ts";
import { normalizeCompatibleSettingsPins } from "../compatibleSettingsPins.ts";
import { errorText } from "../errors.ts";
import {
  GATEWAY_LOGIN_UNAVAILABLE_TEXT,
  takeLoginHold,
  type LoginHold,
} from "../loginHolds.ts";
import { GATEWAY_ENABLED } from "../config.ts";
import { PresenceCredentialStore } from "./presenceCredentialStore.ts";
import { guardServerRuntime } from "./serverCredentialPairing.ts";
import {
  clearCredentialProfileLoginState,
  completeCredentialProfileLogin,
  credentialProfileById,
  credentialProfilesOfKind,
  ensureDefaultPiProfile,
  listCredentialProfiles,
  migrateOpenAiCompatibleSettingsToAccount,
  openAiProfileHasCredential,
  remoteOpenAiAccountReady,
  piAgentDir,
  setCredentialProfileDeletedHandler,
  setCredentialProfileLoginState,
  subscribeCredentialProfileChanges,
  subscribeCredentialProfileDeleted,
  type CredentialProfile,
} from "../credentialProfiles.ts";

/**
 * PA never reads the user's global `~/.pi` installation or login. Its bundled
 * pi SDK gets an explicitly PA-owned agent directory for auth, models and model
 * catalog state, one per OpenAI account.
 *
 * `ModelRuntime` (pi ≥0.80.8) is the canonical async model/auth facade; the
 * synchronous `ModelRegistry` view over it serves the in-process reads
 * (`find`, `getAvailable`, `isUsingOAuth`, provider registration). `create()`
 * performs the initial availability refresh (throttled catalog fetch persisted
 * in models-store.json), so the snapshot-backed sync reads are populated before
 * this module finishes loading.
 *
 * Every per-account read goes through the account model gate below: an
 * account answers only models it serves (`accountServesModel`), whatever its
 * runtime holds. pi loads its built-in providers into every runtime, and an
 * environment key makes one of them available, so registration alone isolates
 * nothing (`docs/agent-harnesses.md`).
 */
// pi loads each provider's OAuth flow through a variable `import()` of a
// sibling file, which the single-file Bun bundle does not have: every
// subscription model there failed with "Cannot find module
// './openai-codex.js'". The statically imported flows resolve the same under
// Node and the bundle (bun-runtime-probe.mjs checks it).
registerBunOAuthFlows();
// Before any runtime exists: the former single endpoint becomes the account
// `openai-compatible`, and stored settings pins name the account a compatible
// model runs on (`docs/settings.md`). The pin pass runs whatever the migration
// did. Task-1374 must keep both calls.
migrateOpenAiCompatibleSettingsToAccount();
normalizeCompatibleSettingsPins();
const defaultPiProfile = ensureDefaultPiProfile();
const defaultAgentDir = piAgentDir(defaultPiProfile.id);
function runtimeOptions(agentDir: string) {
  return {
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    modelsStorePath: `${agentDir}/models-store.json`,
  };
}

/**
 * A server runtime's options: with the gateway on it reads its account's
 * credentials only through {@link PresenceCredentialStore}, so pi never
 * refreshes or writes them; the gateway is the only refresher
 * (`docs/workers.md` "Credentials"). The catalog fetch is unchanged.
 */
function serverRuntimeOptions(agentDir: string) {
  return GATEWAY_ENABLED
    ? {
        ...runtimeOptions(agentDir),
        credentials: new PresenceCredentialStore(join(agentDir, "auth.json")),
      }
    : runtimeOptions(agentDir);
}

/** In memory only: no auth.json, models.json or models-store.json, and no catalog fetch. */
function inMemoryRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
}

// Every runtime that runs sessions or one-shots pairs a compatible key with
// its origin before anyone holds it, whatever the gateway switch.
const modelRuntime = guardServerRuntime(
  await ModelRuntime.create(serverRuntimeOptions(defaultAgentDir)),
);
const profileRuntimes = new Map<string, Promise<ModelRuntime>>([
  [defaultPiProfile.id, Promise.resolve(modelRuntime)],
]);
/** What each compatible account's runtime has registered, by account id. */
const compatibleRegistrations = new Map<string, string>();
/**
 * Each compatible account's created runtime. Sessions and one-shots hold it
 * for their whole run, so an account change is applied to it at once, not at
 * the next lookup.
 */
const compatibleRuntimes = new Map<string, ModelRuntime>();
/** Why a login stopped before its commit; the first one wins. */
type ProfileLoginStopReason = "cancelled" | "timedOut" | "deleted";
interface ProfileLoginOperation {
  /** The profile was deleted: callbacks are ignored, files removed after settle. */
  invalidated: boolean;
  agentDir: string;
  /** Records a pre-commit stop reason, if none yet, and aborts pi's login. */
  stop(reason: ProfileLoginStopReason): void;
}
const profileLogins = new Map<string, ProfileLoginOperation>();
setCredentialProfileDeletedHandler((id) => {
  profileRuntimes.delete(id);
  // A deleted account's held runtime serves nothing: its key goes nowhere.
  const held = compatibleRuntimes.get(id);
  if (held?.getRegisteredProviderConfig(id)) held.unregisterProvider(id);
  compatibleRuntimes.delete(id);
  compatibleRegistrations.delete(id);
  profileLogins.get(id)?.stop("deleted");
});
// An endpoint edit, a discovery or a rename is announced synchronously, before
// the write's caller hears back, so the next request on any held runtime uses
// what the account holds now.
subscribeCredentialProfileChanges((id) => {
  const held = compatibleRuntimes.get(id);
  const profile = credentialProfileById(id);
  if (held && profile) syncCompatibleRegistration(profile, held);
});

/**
 * Register the account's own provider, under its id, as its endpoint file has
 * it now: with its key, or the key-less placeholder. Nothing else is ever
 * registered on a compatible account's runtime.
 */
function syncCompatibleRegistration(
  profile: CredentialProfile,
  runtime: ModelRuntime,
): void {
  const config = openAiCompatibleProviderConfig(
    readOpenAiCompatibleEndpoint(profile.id),
    profile.name,
  );
  const signature = config ? JSON.stringify(config) : "none";
  const registered = compatibleRegistrations.get(profile.id);
  if (signature === registered) return;
  // Fail closed: a registration that did not take leaves none, never the
  // previous key and origin.
  compatibleRegistrations.delete(profile.id);
  if (runtime.getRegisteredProviderConfig(profile.id))
    runtime.unregisterProvider(profile.id);
  if (config) runtime.registerProvider(profile.id, config);
  compatibleRegistrations.set(profile.id, signature);
}

/**
 * The isolated pi runtime of one pi account. An OpenAI account's lives in its
 * agent directory; an OpenAI-compatible account's is in memory and holds only
 * its own provider, re-registered whenever its endpoint changed.
 */
export function modelRuntimeForProfile(
  profileId = defaultPiProfile.id,
): Promise<ModelRuntime> {
  const profile = credentialProfileById(profileId);
  if (!profile || ACCOUNT_KINDS[profile.provider].harness !== "pi")
    throw new Error("That credential profile cannot run pi models.");
  let runtime = profileRuntimes.get(profileId);
  if (!runtime) {
    if (profile.provider === "openai-compatible") {
      const creating: Promise<ModelRuntime> = inMemoryRuntime().then(
        (created) => {
          guardServerRuntime(created);
          // Unless the account was deleted while it was made: then it holds
          // nothing and hears nothing.
          if (profileRuntimes.get(profileId) === creating)
            compatibleRuntimes.set(profileId, created);
          return created;
        },
      );
      runtime = creating;
    } else {
      runtime = ModelRuntime.create(
        serverRuntimeOptions(piAgentDir(profileId)),
      ).then(guardServerRuntime);
    }
    profileRuntimes.set(profileId, runtime);
  }
  if (profile.provider !== "openai-compatible") return runtime;
  return runtime.then((created) => {
    // Registers what the account holds now, edits made meanwhile included.
    if (compatibleRuntimes.get(profileId) === created) {
      const current = credentialProfileById(profileId);
      if (current) syncCompatibleRegistration(current, created);
    }
    return created;
  });
}

/**
 * Start every isolated OpenAI runtime outside the credential-projection request
 * path. The promises remain in `profileRuntimes`, so a page request arriving
 * during warm-up joins the same work instead of creating another runtime.
 */
export async function warmCredentialProfileModelRuntimes(): Promise<void> {
  await Promise.all(
    listCredentialProfiles()
      .filter((profile) => profile.provider === "openai-codex")
      .map((profile) =>
        modelRuntimeForProfile(profile.id).then(() => undefined),
      ),
  );
}

export const modelRegistry = new ModelRegistry(modelRuntime);

/**
 * Every compatible account's models for display and the global lookup
 * ({@link listModels}, {@link findModel}). It holds no key and nothing runs
 * on it: runs resolve on their own account's runtime.
 */
const compatibleCatalog = new ModelRegistry(await inMemoryRuntime());
const compatibleCatalogRegistrations = new Map<string, string>();

function syncCompatibleCatalog(): void {
  const wanted = new Map<
    string,
    NonNullable<ReturnType<typeof openAiCompatibleProviderConfig>>
  >();
  for (const profile of credentialProfilesOfKind("openai-compatible")) {
    const config = openAiCompatibleProviderConfig(
      readOpenAiCompatibleEndpoint(profile.id),
      profile.name,
    );
    if (config)
      wanted.set(profile.id, { ...config, apiKey: OPENAI_COMPATIBLE_KEYLESS });
  }
  for (const id of [...compatibleCatalogRegistrations.keys()])
    if (!wanted.has(id)) {
      compatibleCatalog.unregisterProvider(id);
      compatibleCatalogRegistrations.delete(id);
    }
  for (const [id, config] of wanted) {
    const signature = JSON.stringify(config);
    if (compatibleCatalogRegistrations.get(id) === signature) continue;
    compatibleCatalog.registerProvider(id, config);
    compatibleCatalogRegistrations.set(id, signature);
  }
}

/** Minimal structural view of a pi Model — avoids importing nested pi-ai types. */
export interface PiModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null | undefined>>;
  contextWindow: number;
}

function supportedThinkingLevels(model: PiModel): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * A compatible model's `providerName` is its account's name; a projection of
 * many models reads the names once and passes the model's in.
 */
export function toModelOption(
  model: PiModel,
  accountName: string | undefined = isOpenAiCompatibleModelProvider(
    model.provider,
  )
    ? credentialProfileById(model.provider)?.name
    : undefined,
): ModelOption {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    supportedThinkingLevels: supportedThinkingLevels(model),
    contextWindow: model.contextWindow,
    ...(isOpenAiCompatibleModelProvider(model.provider) && accountName
      ? { providerName: accountName }
      : {}),
  };
}

/**
 * The available models `serves` admits, projected. `includePersistedOpenAi`
 * adds the catalog's Codex models a logged-in account has not refreshed yet.
 */
function listRegistryModels(
  registry: ModelRegistry,
  serves: (provider: string) => boolean,
  includePersistedOpenAi = false,
): ModelOption[] {
  const models = registry
    .getAvailable()
    .filter((model) => serves(model.provider));
  if (includePersistedOpenAi && serves("openai-codex")) {
    const seen = new Set(
      models.map((model) => `${model.provider}:${model.id}`),
    );
    for (const model of registry.getAll()) {
      const key = `${model.provider}:${model.id}`;
      if (model.provider === "openai-codex" && !seen.has(key)) {
        models.push(model);
        seen.add(key);
      }
    }
  }
  const accountNames = models.some((model) =>
    isOpenAiCompatibleModelProvider(model.provider),
  )
    ? new Map(
        credentialProfilesOfKind("openai-compatible").map((profile) => [
          profile.id,
          profile.name,
        ]),
      )
    : undefined;
  return models
    .map((m) =>
      toModelOption(m as unknown as PiModel, accountNames?.get(m.provider)),
    )
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
    );
}

/**
 * Every model the pickers offer: the default OpenAI account's, and every
 * enabled compatible account's. A display list only: no run resolves here.
 */
export function listModels(): ModelOption[] {
  syncCompatibleCatalog();
  const enabled = new Set(
    credentialProfilesOfKind("openai-compatible")
      .filter((profile) => profile.enabled)
      .map((profile) => profile.id),
  );
  return [
    ...listRegistryModels(
      modelRegistry,
      (provider) => !isOpenAiCompatibleModelProvider(provider),
      openAiProfileHasCredential(defaultPiProfile.id) ||
        remoteOpenAiAccountReady(),
    ),
    ...listRegistryModels(compatibleCatalog, (provider) =>
      enabled.has(provider),
    ),
  ].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
  );
}

/**
 * The account model gate: whether `profileId` may answer models of
 * `provider`. An unknown account is left to its runtime, which refuses it.
 */
function gateAdmits(profileId: string, provider: string): boolean {
  const profile = credentialProfileById(profileId);
  return !profile || accountServesModel(profile, provider);
}

/** Project only the models one account serves from its isolated runtime. */
export async function listModelsForProfile(
  profileId: string,
): Promise<ModelOption[]> {
  const registry = new ModelRegistry(await modelRuntimeForProfile(profileId));
  return listRegistryModels(
    registry,
    (provider) => gateAdmits(profileId, provider),
    openAiProfileHasCredential(profileId),
  );
}

/** The models one account serves and can run now, as pi's model objects. */
export async function availableModelsForProfile(profileId: string) {
  const registry = new ModelRegistry(await modelRuntimeForProfile(profileId));
  return registry
    .getAvailable()
    .filter((model) => gateAdmits(profileId, model.provider));
}

/**
 * Label the per-provider catalog failures a refresh RESOLVED with. Pi does not
 * throw them: `refresh()` catches each provider's fetch error into
 * `result.errors` and resolves normally, and `getError()` covers a different
 * set (models.json config, provider composition, availability) — so a discarded
 * map means an unreachable catalog looks exactly like a successful update.
 */
function refreshErrors(
  result: { errors: ReadonlyMap<string, Error> },
  profileName?: string,
): string[] {
  const scope = profileName ? `${profileName} / ` : "";
  return [...result.errors].map(
    ([providerId, error]) => `${scope}${providerId}: ${errorText(error)}`,
  );
}

export async function refreshModels(): Promise<{
  models: ModelOption[];
  error?: string;
}> {
  // Canonical refresh (pi ≥0.80.8): reloads models.json + credentials and
  // recomputes availability — replaces authStorage.reload() + sync refresh().
  //
  // `force` because this is only ever the user's explicit Refresh: without it
  // pi keeps its own four-hour freshness window (REMOTE_CATALOG_REFRESH_
  // INTERVAL_MS) and a second click inside that window never reaches the
  // network, so a model published an hour ago stays invisible with no sign
  // that nothing was fetched.
  //
  // Every OpenAI credential profile refreshes too: each has its OWN isolated
  // runtime and models-store.json, and only its own login had ever fetched
  // one, leaving a second account's picker weeks behind the default's. Their
  // failures do not fail the button — the default runtime's projection is what
  // this returns — but they are collected so the caller can name them.
  const collected = await Promise.all([
    modelRuntime.refresh({ force: true }).then(refreshErrors),
    ...listCredentialProfiles()
      .filter(
        (profile) =>
          profile.provider === "openai-codex" &&
          profile.id !== defaultPiProfile.id,
      )
      .map(async (profile) => {
        try {
          const runtime = await modelRuntimeForProfile(profile.id);
          // A rejection here is the runtime itself failing (a missing or
          // unreadable agent directory), NOT a catalog fetch: those resolve in
          // `errors` and `refreshErrors` names them.
          return refreshErrors(
            await runtime.refresh({ force: true }),
            profile.name,
          );
        } catch (err) {
          return [`${profile.name}: ${errorText(err)}`];
        }
      }),
  ]);
  const runtimeError = modelRuntime.getError();
  const errors = [
    ...(runtimeError ? [String(runtimeError)] : []),
    ...collected.flat(),
  ];
  return {
    models: listModels(),
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

const OPENAI_PROFILE_LOGIN_TIMEOUT_MS = 10 * 60_000;
let openAiProfileLoginTimeoutMs = OPENAI_PROFILE_LOGIN_TIMEOUT_MS;
type OpenAiProfileLogin = (
  runtime: ModelRuntime,
  interaction: Parameters<ModelRuntime["login"]>[2],
  onCredentialCommitted: () => void,
  authPath: string,
) => Promise<unknown>;

const loginWithCommitSignal: OpenAiProfileLogin = async (
  runtime,
  interaction,
  committed,
  authPath,
) => {
  const provider = runtime.getProvider("openai-codex");
  const oauth = provider?.auth.oauth;
  if (!provider || !oauth)
    throw new Error("OpenAI device-code login is unavailable.");
  let ownCredential: Credential | undefined;
  let notified = false;
  const checkCommit = () => {
    if (notified || !ownCredential) return;
    // Match the credential obtained by THIS flow, never an arbitrary file change.
    const stored = readStoredCredential("openai-codex", authPath);
    if (stored && JSON.stringify(stored) === JSON.stringify(ownCredential)) {
      notified = true;
      clearInterval(check);
      committed();
    }
  };
  runtime.registerNativeProvider({
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        ...oauth,
        async login(input, options) {
          const credential = await oauth.login(input, options);
          ownCredential = credential;
          return credential;
        },
      },
    },
  });
  const check = setInterval(checkCommit, 250);
  check.unref?.();
  try {
    return await runtime.login("openai-codex", "oauth", interaction);
  } catch (error) {
    if (
      error instanceof CredentialSynchronizationError &&
      error.providerId === "openai-codex" &&
      error.operation === "login"
    )
      committed();
    throw error;
  } finally {
    checkCommit();
    clearInterval(check);
  }
};
let runOpenAiProfileLogin: OpenAiProfileLogin = loginWithCommitSignal;

/** Inject the provider login operation without exposing credentials (tests only). */
export function setOpenAiProfileLoginForTests(
  login: OpenAiProfileLogin | null,
): OpenAiProfileLogin {
  runOpenAiProfileLogin = login ?? loginWithCommitSignal;
  return loginWithCommitSignal;
}

/** Override the operation timeout without waiting ten minutes (tests only). */
export function setOpenAiProfileLoginTimeoutForTests(
  timeoutMs: number | null,
): void {
  openAiProfileLoginTimeoutMs = timeoutMs ?? OPENAI_PROFILE_LOGIN_TIMEOUT_MS;
}

const OPENAI_LOGIN_TIMED_OUT_TEXT =
  "OpenAI device-code login timed out. The active login will finish before another can start.";
const OPENAI_LOGIN_DELETED_TEXT = "Profile deleted; OpenAI login cancelled.";

/** How a profile login ended, told once its provider work has settled. */
export type OpenAiProfileLoginOutcome = "ready" | "cancelled" | "error";

/** What the login dialog's run hears from one profile login. */
export interface OpenAiProfileLoginObserver {
  /** The device code's link and code: short-lived, never logged or stored. */
  device(verificationUri: string, userCode: string): void;
  /**
   * Once, after the hold's release, the file cleanup and the operation's
   * removal: a new login can start from here.
   */
  settled(outcome: OpenAiProfileLoginOutcome, text?: string): void;
}

/**
 * Start pi's provider-owned OpenAI device-code flow without exposing a token.
 * With the gateway switch on, the profile's login hold is taken before the
 * runtime, and released only once the provider's login has settled, never on
 * the UI timeout or a cancel. Clear refuses this login while it runs here
 * (DQ2). Answers false, starting nothing, while the profile's login runs.
 *
 * Outcome precedence (Task-1402 B1, `docs/workers.md` "Credentials"):
 * - The commit wins: once this flow's own credential is attested, or pi's
 *   login resolved, the outcome is `ready`; a later cancel or timeout records
 *   nothing and aborts nothing, and a later rejection is no error.
 * - Before the commit the first stop reason wins: cancel, the UI timeout or
 *   deletion records it and aborts pi's login through its signal. Only
 *   deletion invalidates, so a commit racing a cancel's abort still counts.
 * - At settle, uncommitted: cancelled clears the login state; a timeout sets
 *   its error; deletion ends cancelled; otherwise pi's error.
 */
export function startOpenAiProfileLogin(
  profileId: string,
  observer?: OpenAiProfileLoginObserver,
): boolean {
  if (profileLogins.has(profileId)) return false;
  const profile = credentialProfileById(profileId);
  if (!profile || profile.provider !== "openai-codex")
    throw new Error("That is not an OpenAI profile.");
  const agentDir = piAgentDir(profileId);
  const abort = new AbortController();
  let stopReason: ProfileLoginStopReason | undefined;
  // The commit flag: set once, final.
  let completed = false;
  const operation: ProfileLoginOperation = {
    invalidated: false,
    agentDir,
    stop(reason) {
      if (reason === "deleted") operation.invalidated = true;
      // A committed login is never aborted: pi may still be synchronizing.
      if (completed || stopReason) return;
      stopReason = reason;
      abort.abort();
    },
  };
  const isCurrent = () =>
    !operation.invalidated && profileLogins.get(profileId) === operation;
  const completeLogin = () => {
    if (!isCurrent() || completed) return;
    completed = true;
    completeCredentialProfileLogin(profileId);
    // The login-only facade does not update the runtime used by actual sessions.
    // Refresh that account's snapshot independently; failure cannot undo login.
    let deleted = operation.invalidated;
    const unsubscribe = subscribeCredentialProfileDeleted((id) => {
      if (id === profileId) deleted = true;
    });
    void Promise.resolve()
      .then(async () => {
        if (deleted) return;
        const runtime = await modelRuntimeForProfile(profileId);
        if (!deleted) await runtime.refresh({ force: true });
      })
      .catch(() => {})
      .finally(() => {
        unsubscribe();
        // A refresh may outlive the login operation and recreate SDK files.
        if (deleted) {
          try {
            rmSync(dirname(agentDir), { recursive: true, force: true });
          } catch {
            /* Best-effort retirement of this deleted account's SDK state. */
          }
        }
      });
  };
  profileLogins.set(profileId, operation);
  clearCredentialProfileLoginState(profileId);
  setCredentialProfileLoginState(profileId, { status: "connecting" });
  let hold: LoginHold | undefined;
  let providerLogin: Promise<unknown> | undefined;
  /** The hold refused the login: its text, and whether the account shows it. */
  let unstarted: { error: string; onAccount: boolean } | undefined;
  let failure: string | undefined;
  void (async () => {
    const taken = await takeLoginHold(profile, () => {
      throw new Error(OPENAI_LOGIN_TIMED_OUT_TEXT);
    });
    if (taken.kind === "held") hold = taken.hold;
    if (!isCurrent() || stopReason) return;
    if (taken.kind === "stuck") {
      // The account shows U7's text from its login-stuck flag.
      unstarted = { error: loginStuckText(profile.name), onAccount: false };
      return;
    }
    if (taken.kind === "unavailable") {
      unstarted = { error: GATEWAY_LOGIN_UNAVAILABLE_TEXT, onAccount: true };
      return;
    }
    // A login-only facade can attest its own OAuth result without changing a
    // live run's provider. The SDK still owns all credential serialization.
    // It keeps pi's file store under either switch: the login, under its
    // gateway hold, is the server's only credential writer.
    const runtime = await ModelRuntime.create({
      ...runtimeOptions(agentDir),
      refreshOnCreate: false,
    });
    if (!isCurrent() || stopReason) return;
    providerLogin = runOpenAiProfileLogin(
      runtime,
      deviceCodeInteraction((verificationUri, userCode) => {
        if (isCurrent() && !completed && !stopReason)
          observer?.device(verificationUri, userCode);
      }, abort.signal),
      completeLogin,
      `${agentDir}/auth.json`,
    );
    // The UI timeout aborts an uncommitted login; the run still ends only
    // once pi's login settled.
    const timeout = setTimeout(
      () => operation.stop("timedOut"),
      openAiProfileLoginTimeoutMs,
    );
    try {
      await providerLogin;
      completeLogin();
    } finally {
      clearTimeout(timeout);
    }
  })()
    .catch((error) => {
      failure =
        error instanceof Error
          ? error.message.slice(0, 180)
          : "OpenAI login failed.";
    })
    .finally(() => {
      // The writer is pi's provider login: the hold ends once it settled.
      void Promise.allSettled([providerLogin]).then(() => {
        hold?.release();
        if (operation.invalidated) {
          // Deletion ignores every callback; after the operation settles,
          // remove anything it may have written through its stale paths.
          rmSync(dirname(operation.agentDir), { recursive: true, force: true });
        } else {
          // pi owns the token serialization; tighten the file after every
          // login/refresh.
          try {
            chmodSync(`${agentDir}/auth.json`, 0o600);
          } catch {
            /* no credential was written */
          }
        }
        const [outcome, text] = profileLoginOutcome();
        if (profileLogins.get(profileId) === operation)
          profileLogins.delete(profileId);
        observer?.settled(outcome, text);
      });
    });

  /** The account's effects at settle, and the dialog's outcome. */
  function profileLoginOutcome(): [OpenAiProfileLoginOutcome, string?] {
    if (operation.invalidated) return ["cancelled", OPENAI_LOGIN_DELETED_TEXT];
    if (completed) return ["ready"];
    if (stopReason === "cancelled") {
      clearCredentialProfileLoginState(profileId);
      return ["cancelled"];
    }
    const error =
      stopReason === "timedOut"
        ? OPENAI_LOGIN_TIMED_OUT_TEXT
        : (unstarted?.error ?? failure ?? "OpenAI login failed.");
    if (unstarted && !unstarted.onAccount)
      clearCredentialProfileLoginState(profileId);
    else setCredentialProfileLoginState(profileId, { status: "error", error });
    return ["error", error];
  }
  return true;
}

/**
 * Cancels the profile's running login: aborts pi's login unless it already
 * committed or stopped. Never invalidates, so a racing commit still counts.
 */
export function cancelOpenAiProfileLogin(profileId: string): void {
  profileLogins.get(profileId)?.stop("cancelled");
}

/**
 * Resolve a model on the account's own runtime, through the account model
 * gate: undefined for a model the account does not serve, before the runtime
 * is asked.
 */
export async function findModelForProfile(
  profileId: string,
  provider: string,
  id: string,
) {
  if (!gateAdmits(profileId, provider)) return undefined;
  const runtime = await modelRuntimeForProfile(profileId);
  return new ModelRegistry(runtime).find(provider, id);
}

/**
 * The global lookup for display: the default OpenAI account's model, or a
 * compatible account's from the key-less catalog. No run, open or model
 * change resolves through it.
 */
export function findModel(provider: string, id: string) {
  if (!isOpenAiCompatibleModelProvider(provider))
    return modelRegistry.find(provider, id);
  syncCompatibleCatalog();
  return compatibleCatalog.find(provider, id);
}
