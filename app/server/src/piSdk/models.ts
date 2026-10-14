import {
  CredentialSynchronizationError,
  readStoredCredential,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Credential } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { chmodSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  THINKING_LEVELS,
  type ModelOption,
  type ThinkingLevel,
} from "@assistant/shared";
import {
  getOpenAiCompatibleName,
  getOpenAiCompatibleProviderConfigForRegistry,
} from "../openAiCompatibleSettings.ts";
import { errorText } from "../errors.ts";
import {
  clearCredentialProfileLoginState,
  completeCredentialProfileLogin,
  credentialProfileById,
  ensureDefaultPiProfile,
  listCredentialProfiles,
  openAiProfileHasCredential,
  piAgentDir,
  setCredentialProfileDeletedHandler,
  setCredentialProfileLoginState,
  subscribeCredentialProfileDeleted,
} from "../credentialProfiles.ts";

/**
 * PA never reads the user's global `~/.pi` installation or login. Its bundled
 * pi SDK gets an explicitly PA-owned agent directory for auth, models and model
 * catalog state. A profile-specific runtime can use the same factory later.
 *
 * `ModelRuntime` (pi ≥0.80.8) is the canonical async model/auth facade; the
 * synchronous `ModelRegistry` view over it serves the in-process reads
 * (`find`, `getAvailable`, `isUsingOAuth`, provider registration). `create()`
 * performs the initial availability refresh (throttled catalog fetch persisted
 * in models-store.json), so the snapshot-backed sync reads are populated before
 * this module finishes loading.
 */
// pi loads each provider's OAuth flow through a variable `import()` of a
// sibling file, which the single-file Bun bundle does not have: every
// subscription model there failed with "Cannot find module
// './openai-codex.js'". The statically imported flows resolve the same under
// Node and the bundle (bun-runtime-probe.mjs checks it).
registerBunOAuthFlows();
const defaultPiProfile = ensureDefaultPiProfile();
const defaultAgentDir = piAgentDir(defaultPiProfile.id);
function runtimeOptions(agentDir: string) {
  return {
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    modelsStorePath: `${agentDir}/models-store.json`,
  };
}

const modelRuntime = await ModelRuntime.create(runtimeOptions(defaultAgentDir));
const profileRuntimes = new Map<string, Promise<ModelRuntime>>([
  [defaultPiProfile.id, Promise.resolve(modelRuntime)],
]);
interface ProfileLoginOperation {
  invalidated: boolean;
  agentDir: string;
}
const profileLogins = new Map<string, ProfileLoginOperation>();
setCredentialProfileDeletedHandler((id) => {
  profileRuntimes.delete(id);
  const operation = profileLogins.get(id);
  if (operation) operation.invalidated = true;
});

/** Returns the isolated pi runtime for one OpenAI credential profile. */
export function modelRuntimeForProfile(
  profileId = defaultPiProfile.id,
): Promise<ModelRuntime> {
  const profile = credentialProfileById(profileId);
  if (!profile || profile.provider !== "openai-codex")
    throw new Error("That credential profile cannot run pi models.");
  let runtime = profileRuntimes.get(profileId);
  if (!runtime) {
    runtime = ModelRuntime.create(runtimeOptions(piAgentDir(profileId)));
    profileRuntimes.set(profileId, runtime);
  }
  return runtime;
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

let openAiCompatibleProviderSignature: string | undefined;

/** Apply app-owned provider settings to pi's registry without writing ~/.pi config. */
export function syncConfiguredModelProviders(): void {
  const config = getOpenAiCompatibleProviderConfigForRegistry();
  const signature = config ? JSON.stringify(config) : "disabled";
  if (signature === openAiCompatibleProviderSignature) return;
  if (config)
    modelRegistry.registerProvider(OPENAI_COMPATIBLE_PROVIDER_ID, config);
  else if (openAiCompatibleProviderSignature !== undefined)
    modelRegistry.unregisterProvider(OPENAI_COMPATIBLE_PROVIDER_ID);
  openAiCompatibleProviderSignature = signature;
}

/** Minimal structural view of a pi Model — avoids importing nested pi-ai types. */
export interface PiModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
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
 * `openAiCompatibleName` is the endpoint's display name; a projection of many
 * models reads it once and passes it in rather than re-reading per model.
 */
export function toModelOption(
  model: PiModel,
  openAiCompatibleName: string | undefined = model.provider ===
  OPENAI_COMPATIBLE_PROVIDER_ID
    ? getOpenAiCompatibleName()
    : undefined,
): ModelOption {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    supportedThinkingLevels: supportedThinkingLevels(model),
    contextWindow: model.contextWindow,
    ...(model.provider === OPENAI_COMPATIBLE_PROVIDER_ID && openAiCompatibleName
      ? { providerName: openAiCompatibleName }
      : {}),
  };
}

function listRegistryModels(
  registry: ModelRegistry,
  includePersistedOpenAi = false,
): ModelOption[] {
  const models = [...registry.getAvailable()];
  const openAiCompatibleName = models.some(
    (model) => model.provider === OPENAI_COMPATIBLE_PROVIDER_ID,
  )
    ? getOpenAiCompatibleName()
    : undefined;
  if (includePersistedOpenAi) {
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
  return models
    .map((m) => toModelOption(m as unknown as PiModel, openAiCompatibleName))
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
    );
}

export function listModels(): ModelOption[] {
  syncConfiguredModelProviders();
  return listRegistryModels(
    modelRegistry,
    openAiProfileHasCredential(defaultPiProfile.id),
  );
}

export async function modelRegistryForProfile(
  profileId: string,
): Promise<ModelRegistry> {
  const runtime = await modelRuntimeForProfile(profileId);
  if (profileId === defaultPiProfile.id) {
    syncConfiguredModelProviders();
    return modelRegistry;
  }
  const registry = new ModelRegistry(runtime);
  const config = getOpenAiCompatibleProviderConfigForRegistry();
  if (config) registry.registerProvider(OPENAI_COMPATIBLE_PROVIDER_ID, config);
  return registry;
}

/** Project only the models available to one profile's isolated runtime. */
export async function listModelsForProfile(
  profileId: string,
): Promise<ModelOption[]> {
  return listRegistryModels(
    await modelRegistryForProfile(profileId),
    openAiProfileHasCredential(profileId),
  );
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
  openAiCompatibleProviderSignature = undefined;
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
  syncConfiguredModelProviders();
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

/** Start pi's provider-owned OpenAI device-code flow without exposing a token. */
export function startOpenAiProfileLogin(profileId: string): void {
  if (profileLogins.has(profileId)) return;
  const profile = credentialProfileById(profileId);
  if (!profile || profile.provider !== "openai-codex")
    throw new Error("That is not an OpenAI profile.");
  const agentDir = piAgentDir(profileId);
  const operation: ProfileLoginOperation = { invalidated: false, agentDir };
  const isCurrent = () =>
    !operation.invalidated && profileLogins.get(profileId) === operation;
  let completed = false;
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
  void (async () => {
    // A login-only facade can attest its own OAuth result without changing a
    // live run's provider. The SDK still owns all credential serialization.
    const runtime = await ModelRuntime.create({
      ...runtimeOptions(agentDir),
      refreshOnCreate: false,
    });
    const providerLogin = runOpenAiProfileLogin(
      runtime,
      {
        notify(event) {
          // Device codes/URLs are short-lived authorization instructions, not
          // credentials. Keep them out of persistent metadata and logs.
          if (event.type === "device_code" && isCurrent() && !completed)
            setCredentialProfileLoginState(profileId, {
              status: "connecting",
              verificationUri: event.verificationUri,
              userCode: event.userCode,
            });
        },
        async prompt(prompt) {
          // The provider asks once to choose browser vs device code. Our remote UI
          // deliberately selects its documented headless/device-code option.
          if (
            prompt.type === "select" &&
            prompt.options.some((option) => option.id === "device_code")
          )
            return "device_code";
          throw new Error("This OpenAI login requires the device-code flow.");
        },
      },
      completeLogin,
      `${agentDir}/auth.json`,
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        providerLogin,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "OpenAI device-code login timed out. The active login will finish before another can start.",
                ),
              ),
            openAiProfileLoginTimeoutMs,
          );
        }),
      ]);
      completeLogin();
    } catch (error) {
      if (completed) {
        // Retain serialization until a hanging post-login refresh actually
        // settles, but never turn a committed login back into an error.
        await providerLogin.catch(() => {});
        return;
      }
      if (
        error instanceof Error &&
        error.message.startsWith("OpenAI device-code login timed out.")
      ) {
        if (isCurrent()) {
          setCredentialProfileLoginState(profileId, {
            status: "error",
            error: error.message,
          });
        }
        // Promise.race cannot abort the SDK login. Keep this operation in the
        // in-flight map until it truly settles, so a retry cannot race its auth
        // file; then surface its actual result.
        await providerLogin;
        completeLogin();
        return;
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  })()
    .catch((error) => {
      if (isCurrent() && !completed) {
        setCredentialProfileLoginState(profileId, {
          status: "error",
          error:
            error instanceof Error
              ? error.message.slice(0, 180)
              : "OpenAI login failed.",
        });
      }
    })
    .finally(() => {
      if (operation.invalidated) {
        // The provider API has no cancellation signal. Deletion invalidates all
        // callbacks immediately; after the operation settles, remove anything it
        // may have written through its now-stale runtime paths.
        rmSync(dirname(operation.agentDir), { recursive: true, force: true });
      } else {
        // pi owns the token serialization; tighten the file after every login/refresh.
        try {
          chmodSync(`${agentDir}/auth.json`, 0o600);
        } catch {
          /* no credential was written */
        }
      }
      if (profileLogins.get(profileId) === operation)
        profileLogins.delete(profileId);
    });
}

/** Resolve a model against the selected profile's isolated auth/runtime. */
export async function findModelForProfile(
  profileId: string,
  provider: string,
  id: string,
) {
  return (await modelRegistryForProfile(profileId)).find(provider, id);
}

export function findModel(provider: string, id: string) {
  syncConfiguredModelProviders();
  return modelRegistry.find(provider, id);
}
