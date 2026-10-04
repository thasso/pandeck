import type {
  AppSettings,
  BraveSettingsPatch,
  ConfluenceSettingsPatch,
  Context7SettingsPatch,
  ForgejoSettingsPatch,
  GithubSettingsPatch,
  GoogleSettingsPatch,
  JiraSettingsPatch,
  OpenAiCompatibleSettingsPatch,
  SlackSettingsPatch,
  TempoSettingsPatch,
} from "@assistant/shared";
import {
  settingDescriptor,
  settingValueError,
  type SettingsSectionId,
} from "@assistant/shared/settingsRegistry";
import { testBraveSettings, updateBraveSettings } from "./braveSettings.ts";
import {
  testConfluenceSettings,
  updateConfluenceSettings,
} from "./confluenceSettings.ts";
import {
  testContext7Settings,
  updateContext7Settings,
} from "./context7Settings.ts";
import { errorText } from "./errors.ts";
import { redactSecretsWith, storedSecretForms } from "./secretRedaction.ts";
import {
  testForgejoSettings,
  updateForgejoSettings,
} from "./forgejoSettings.ts";
import { testGithubSettings, updateGithubSettings } from "./githubSettings.ts";
import { testGoogleSettings, updateGoogleSettings } from "./googleSettings.ts";
import { notifyIntegrationToolsChanged } from "./integrationToolChanges.ts";
import { testJiraSettings, updateJiraSettings } from "./jiraSettings.ts";
import {
  testOpenAiCompatibleSettings,
  updateOpenAiCompatibleSettings,
} from "./openAiCompatibleSettings.ts";
import { getSettings, updateSettings } from "./settings.ts";
import {
  testSlackHuddleSettings,
  testSlackSettings,
  updateSlackSettings,
} from "./slackSettings.ts";
import { testTempoSettings, updateTempoSettings } from "./tempoSettings.ts";
import { appSettingsPatchError } from "./validateClientMessage.ts";

/**
 * The one write path for settings ([Task-729](pa://task/729)). The Settings
 * page's socket messages and the Personal Assistant's tools both land here, so
 * a write made either way runs the same side effects and reaches every open
 * client. `@assistant/shared/settingsRegistry` describes what may be written.
 */

/** Integration sections with private storage and their own write-only patch shape. */
interface IntegrationPatches {
  jira: JiraSettingsPatch;
  confluence: ConfluenceSettingsPatch;
  tempo: TempoSettingsPatch;
  google: GoogleSettingsPatch;
  slack: SlackSettingsPatch;
  openAiCompatible: OpenAiCompatibleSettingsPatch;
  brave: BraveSettingsPatch;
  context7: Context7SettingsPatch;
  github: GithubSettingsPatch;
  forgejo: ForgejoSettingsPatch;
}
type IntegrationKey = keyof IntegrationPatches;

/** Every `AppSettings` section; integration sections take their patch shape. */
export type SettingsPatch = {
  [K in keyof AppSettings]?: K extends IntegrationKey
    ? IntegrationPatches[K]
    : AppSettings[K];
};

const INTEGRATION_WRITERS: {
  [K in IntegrationKey]: (patch: IntegrationPatches[K]) => unknown;
} = {
  jira: updateJiraSettings,
  confluence: updateConfluenceSettings,
  tempo: updateTempoSettings,
  google: updateGoogleSettings,
  slack: updateSlackSettings,
  openAiCompatible: updateOpenAiCompatibleSettings,
  brave: updateBraveSettings,
  context7: updateContext7Settings,
  github: updateGithubSettings,
  forgejo: updateForgejoSettings,
};

/**
 * Every field of every integration patch. Listing them here makes a new patch
 * field a type error until it is added, and the registry coverage test then
 * requires a descriptor for it.
 */
export const INTEGRATION_PATCH_FIELDS: {
  [K in IntegrationKey]: Record<keyof Required<IntegrationPatches[K]>, true>;
} = {
  jira: {
    enabled: true,
    atlassianEmail: true,
    atlassianToken: true,
    clearAtlassianToken: true,
  },
  confluence: { enabled: true },
  tempo: { enabled: true, apiBaseUrl: true, clearTokens: true },
  google: { enabled: true, clearTokens: true, gmailMinutesLabelName: true },
  slack: {
    enabled: true,
    userToken: true,
    botToken: true,
    huddlesEnabled: true,
    clientToken: true,
    clientCookieD: true,
    clearUserToken: true,
    clearBotToken: true,
    clearClientToken: true,
    clearClientCookie: true,
  },
  openAiCompatible: {
    enabled: true,
    name: true,
    baseUrl: true,
    thinkingFormat: true,
    apiKey: true,
    clearApiKey: true,
  },
  brave: { enabled: true, apiKey: true, clearApiKey: true },
  context7: { enabled: true, apiKey: true, clearApiKey: true },
  github: {
    enabled: true,
    token: true,
    clearToken: true,
    defaultOwner: true,
    packageProxyEnabled: true,
  },
  forgejo: {
    enabled: true,
    baseUrl: true,
    token: true,
    clearToken: true,
    defaultOwner: true,
  },
};

function isIntegrationKey(key: string): key is IntegrationKey {
  return Object.hasOwn(INTEGRATION_WRITERS, key);
}

export interface SettingsChange {
  /** The sections that were written. */
  sections: (keyof AppSettings)[];
}

type SettingsChangeListener = (change: SettingsChange) => void;
const listeners = new Set<SettingsChangeListener>();

/** Hear about every settings write; the hub pushes fresh settings to each client. */
export function onSettingsChanged(
  listener: SettingsChangeListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The profile fields whose change starts the Personal Assistant afresh. */
export const ASSISTANT_PROFILE_FIELDS = [
  "name",
  "provider",
  "modelId",
  "thinkingLevel",
  "additionalInstructions",
] as const;

/**
 * Persist `patch`, run what each written section needs, then tell every
 * listener. Sections written before a failing write still run their effects
 * and are announced, so clients never show stale values; the write's own error
 * is what then throws. When every write lands but an effect fails, the throw
 * says the settings were saved and names what failed.
 */
export async function saveSettings(patch: SettingsPatch): Promise<AppSettings> {
  const appPatch: Partial<AppSettings> = {};
  const integrationKeys: IntegrationKey[] = [];
  for (const key of Object.keys(patch) as (keyof AppSettings)[]) {
    if (patch[key] === undefined) continue;
    if (isIntegrationKey(key)) integrationKeys.push(key);
    else Object.assign(appPatch, { [key]: patch[key] });
  }
  // Read only when needed: a full read touches every integration's file, and
  // one unreadable file must not block saving an unrelated section.
  const assistantBefore = appPatch.permanentAssistant
    ? getSettings().permanentAssistant
    : undefined;
  // A section counts once its writer has run, even if it then threw: a writer
  // may persist before it fails (`updateSettings` re-reads everything after
  // writing), and announcing an unchanged section costs only a fresh copy.
  const written: (keyof AppSettings)[] = [];
  let writeFailed = false;
  let writeError: unknown;
  try {
    if (Object.keys(appPatch).length > 0) {
      written.push(...(Object.keys(appPatch) as (keyof AppSettings)[]));
      updateSettings(appPatch);
    }
    for (const key of integrationKeys) {
      written.push(key);
      const write = INTEGRATION_WRITERS[key] as (patch: unknown) => unknown;
      write(patch[key]);
    }
  } catch (err) {
    writeFailed = true;
    writeError = err;
  }
  const effectFailures =
    written.length > 0 ? await settingsWritten(written, assistantBefore) : [];
  if (writeFailed) throw writeError;
  if (effectFailures.length > 0)
    throw new Error(`Settings saved, but ${effectFailures.join("; ")}`);
  return getSettings();
}

/**
 * Run the effects of, and announce, sections a module persisted on its own: a
 * connection test that stores discovered models, an OAuth callback that stores
 * tokens. Throws, after announcing, when an effect fails.
 */
export async function announceSettingsWritten(
  sections: (keyof AppSettings)[],
): Promise<void> {
  const failures = await settingsWritten(sections);
  if (failures.length > 0) throw new Error(failures.join("; "));
}

/**
 * Each effect runs on its own, so one failure never skips the rest or the
 * announcement. Returns what failed. Listener failures are logged: they belong
 * to the client being told, not to the caller that wrote.
 */
async function settingsWritten(
  sections: (keyof AppSettings)[],
  assistantBefore?: AppSettings["permanentAssistant"],
): Promise<string[]> {
  const failures: string[] = [];
  const effect = async (name: string, run: () => unknown): Promise<void> => {
    try {
      await run();
    } catch (err) {
      failures.push(`${name} failed: ${errorText(err)}`);
    }
  };
  const wrote = (key: keyof AppSettings) => sections.includes(key);
  if (assistantBefore && wrote("permanentAssistant"))
    await effect("restarting the Personal Assistant", async () => {
      const after = getSettings().permanentAssistant;
      if (
        !ASSISTANT_PROFILE_FIELDS.some(
          (field) => assistantBefore[field] !== after[field],
        )
      )
        return;
      const { rotatePermanentAssistantSession } =
        await import("./permanentAssistant.ts");
      await rotatePermanentAssistantSession();
    });
  // The schedule fires in the profile timezone, so a zone change re-arms it.
  if (wrote("dayScan") || wrote("profile"))
    await effect("re-arming the day scan", async () => {
      const { reconcileDayScanSchedule } =
        await import("./dayScan/schedule.ts");
      reconcileDayScanSchedule();
    });
  if (wrote("slack"))
    await effect("reconnecting Slack", async () => {
      const { slackSocketMode } = await import("./slackSocketMode.ts");
      slackSocketMode.reconcile();
    });
  if (wrote("github"))
    await effect("reconciling the package proxy", async () => {
      const { reconcilePackageProxy } =
        await import("./packageProxy/packageProxy.ts");
      await reconcilePackageProxy();
    });
  if (wrote("openAiCompatible"))
    await effect("syncing model providers", async () => {
      const { syncConfiguredModelProviders } =
        await import("./piSdk/models.ts");
      syncConfiguredModelProviders();
    });
  // OpenAI-compatible models reach sessions through the model list, not tools.
  if (
    sections.some((key) => isIntegrationKey(key) && key !== "openAiCompatible")
  )
    await effect("updating session tools", notifyIntegrationToolsChanged);
  for (const listener of listeners) {
    try {
      listener({ sections });
    } catch (err) {
      console.warn("[settings] change listener failed:", errorText(err));
    }
  }
  return failures;
}

/** One path-addressed write, as an agent states it. */
export interface SettingWrite {
  path: string;
  /** `null` clears a secret or disconnects an OAuth connection. */
  value: unknown;
}

/**
 * Turn path-addressed writes into a {@link SettingsPatch}, checking each
 * against its registry descriptor. App sections are replaced whole by
 * `updateSettings`, so a leaf write carries the rest of its current section.
 * Throws on the first write that cannot be made.
 */
export function settingsPatchForWrites(
  writes: readonly SettingWrite[],
  current: AppSettings = getSettings(),
): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const { path, value } of writes) {
    const descriptor = settingDescriptor(path);
    if (!descriptor) throw new Error(`Unknown setting: ${path}`);
    const [section = "", ...rest] = path.split(".");
    if (descriptor.access === "readonly")
      throw new Error(
        `${path} is read-only${descriptor.hint ? `: ${descriptor.hint}` : "."}`,
      );
    if (descriptor.access === "oauth" && value !== null)
      throw new Error(
        `${path} is connected through the browser; only null (disconnect) can be written.`,
      );
    if (isIntegrationKey(section)) {
      const target = (patch[section] ??= {}) as Record<string, unknown>;
      if (value === null && descriptor.clearWith) {
        target[descriptor.clearWith] = true;
        continue;
      }
      const reason = settingValueError(descriptor, value);
      if (reason) throw new Error(`${path} ${reason}`);
      target[rest.join(".")] = value;
      continue;
    }
    const reason = settingValueError(descriptor, value);
    if (reason) throw new Error(`${path} ${reason}`);
    if (rest.length === 0) {
      patch[section] = value;
      continue;
    }
    const sectionValue = (patch[section] ??= structuredClone(
      current[section as keyof AppSettings],
    )) as Record<string, unknown>;
    setLeaf(sectionValue, rest, value, descriptor.optional === true);
  }
  const appPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => !isIntegrationKey(key)),
  );
  const reason = appSettingsPatchError(appPatch);
  if (reason) throw new Error(reason);
  return patch as SettingsPatch;
}

function setLeaf(
  target: Record<string, unknown>,
  keys: string[],
  value: unknown,
  optional: boolean,
): void {
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    node = (
      next && typeof next === "object" ? next : (node[key] = {})
    ) as Record<string, unknown>;
  }
  const leaf = keys[keys.length - 1]!;
  if (optional && value === "") delete node[leaf];
  else node[leaf] = value;
}

/** The outcome of an integration's connection test, as the Settings page shows it. */
export interface SettingsSectionTest {
  ok: boolean;
  message: string;
}

/**
 * The Settings page sections with a connection test, and the test each runs.
 * Tests that make their HTTP calls directly stop them when `signal` aborts;
 * the rest (Confluence, Google, Slack) only read, so an abandoned one ends at
 * its own request timeouts and changes nothing. A test that stores what it
 * discovers (OpenAI-compatible models) checks `signal` before it stores and
 * announces what it stored.
 */
const SECTION_TESTS: Partial<
  Record<
    SettingsSectionId,
    (signal: AbortSignal) => Promise<SettingsSectionTest>
  >
> = {
  jira: testJiraSettings,
  confluence: () => testConfluenceSettings(),
  tempo: testTempoSettings,
  google: () => testGoogleSettings(),
  slack: () => testSlackSettings(),
  "slack-huddles": () => testSlackHuddleSettings(),
  "openai-compatible": async (signal) => {
    const status = await testOpenAiCompatibleSettings(signal);
    await announceSettingsWritten(["openAiCompatible"]);
    return status;
  },
  "web-search": testBraveSettings,
  context7: testContext7Settings,
  github: testGithubSettings,
  forgejo: testForgejoSettings,
};

export const TESTABLE_SETTINGS_SECTIONS = Object.keys(
  SECTION_TESTS,
) as SettingsSectionId[];

/** Longest a connection test may run; each makes at most a few HTTP calls. */
const SECTION_TEST_DEADLINE_MS = 45_000;

/**
 * Run a section's connection test for an agent.
 *
 * A failure is reported in words the server writes: the section, the HTTP
 * status when there was one, and where the details are. The tests' own
 * failure text was written for the Settings page and quotes what the endpoint
 * sent back, which may echo the credential it received; no scrubbing of that
 * text can be complete. A success message, built from what the service says
 * about the account, is scrubbed of every credential stored before the test
 * started, of any length, and of every one stored after it.
 *
 * Throws for a section without a test, when `signal` aborts, or past the
 * deadline.
 */
export async function testSettingsSection(
  section: SettingsSectionId,
  signal?: AbortSignal,
): Promise<SettingsSectionTest> {
  const test = SECTION_TESTS[section];
  if (!test) throw new Error(`${section} has no connection test`);
  const details = `The Settings page shows the details: /settings/${section}.`;
  const stop = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(SECTION_TEST_DEADLINE_MS),
  ]);
  const credentials = storedSecretForms(1);
  const stopped = () =>
    new Error(
      signal?.aborted
        ? `The ${section} connection test was cancelled.`
        : `The ${section} connection test took longer than ${SECTION_TEST_DEADLINE_MS / 1000}s.`,
    );
  if (stop.aborted) throw stopped();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(stopped());
    stop.addEventListener("abort", onAbort, { once: true });
  });
  let result: SettingsSectionTest;
  try {
    result = await Promise.race([test(stop), aborted]);
  } catch {
    if (stop.aborted) throw stopped();
    throw new Error(`The ${section} connection test could not run. ${details}`);
  } finally {
    stop.removeEventListener("abort", onAbort);
  }
  // A test that caught its own aborted request reports it as a failure.
  if (stop.aborted) throw stopped();
  if (!result.ok) {
    const status = /\bHTTP (\d{3})\b/.exec(result.message)?.[1];
    return {
      ok: false,
      message: `The ${section} connection test failed${status ? ` with HTTP ${status}` : ""}. ${details}`,
    };
  }
  const forms = [...new Set([...credentials, ...storedSecretForms(1)])].sort(
    (a, b) => b.length - a.length,
  );
  return { ok: true, message: redactSecretsWith(result.message, forms) };
}
