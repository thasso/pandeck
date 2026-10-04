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
} from "@assistant/shared/settingsRegistry";
import { updateBraveSettings } from "./braveSettings.ts";
import { updateConfluenceSettings } from "./confluenceSettings.ts";
import { updateContext7Settings } from "./context7Settings.ts";
import { errorText } from "./errors.ts";
import { updateForgejoSettings } from "./forgejoSettings.ts";
import { updateGithubSettings } from "./githubSettings.ts";
import { updateGoogleSettings } from "./googleSettings.ts";
import { notifyIntegrationToolsChanged } from "./integrationToolChanges.ts";
import { updateJiraSettings } from "./jiraSettings.ts";
import { updateOpenAiCompatibleSettings } from "./openAiCompatibleSettings.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { updateSlackSettings } from "./slackSettings.ts";
import { updateTempoSettings } from "./tempoSettings.ts";
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

const ASSISTANT_PROFILE_FIELDS = [
  "name",
  "provider",
  "modelId",
  "thinkingLevel",
  "additionalInstructions",
] as const;

/**
 * Persist `patch`, run what each written section needs, then tell every
 * listener. Throws when a write fails; sections already written still run
 * their side effects and are announced, so clients never show stale values.
 */
export async function saveSettings(patch: SettingsPatch): Promise<AppSettings> {
  const appPatch: Partial<AppSettings> = {};
  const integrationKeys: IntegrationKey[] = [];
  for (const key of Object.keys(patch) as (keyof AppSettings)[]) {
    if (patch[key] === undefined) continue;
    if (isIntegrationKey(key)) integrationKeys.push(key);
    else Object.assign(appPatch, { [key]: patch[key] });
  }
  const assistantBefore = getSettings().permanentAssistant;
  const written: (keyof AppSettings)[] = [];
  try {
    if (Object.keys(appPatch).length > 0) {
      updateSettings(appPatch);
      written.push(...(Object.keys(appPatch) as (keyof AppSettings)[]));
    }
    for (const key of integrationKeys) {
      const write = INTEGRATION_WRITERS[key] as (patch: unknown) => unknown;
      write(patch[key]);
      written.push(key);
    }
  } finally {
    if (written.length > 0) await afterWrite(written, assistantBefore);
  }
  return getSettings();
}

async function afterWrite(
  sections: (keyof AppSettings)[],
  assistantBefore: AppSettings["permanentAssistant"],
): Promise<void> {
  const wrote = (key: keyof AppSettings) => sections.includes(key);
  const settings = getSettings();
  if (
    wrote("permanentAssistant") &&
    ASSISTANT_PROFILE_FIELDS.some(
      (field) => assistantBefore[field] !== settings.permanentAssistant[field],
    )
  ) {
    const { rotatePermanentAssistantSession } =
      await import("./permanentAssistant.ts");
    await rotatePermanentAssistantSession();
  }
  // The schedule fires in the profile timezone, so a zone change re-arms it.
  if (wrote("dayScan") || wrote("profile")) {
    const { reconcileDayScanSchedule } = await import("./dayScan/schedule.ts");
    reconcileDayScanSchedule();
  }
  if (wrote("slack")) {
    const { slackSocketMode } = await import("./slackSocketMode.ts");
    slackSocketMode.reconcile();
  }
  if (wrote("github")) {
    const { reconcilePackageProxy } =
      await import("./packageProxy/packageProxy.ts");
    await reconcilePackageProxy().catch((err: unknown) =>
      console.warn("[package-proxy] reconcile failed:", errorText(err)),
    );
  }
  if (wrote("openAiCompatible")) {
    const { syncConfiguredModelProviders } = await import("./piSdk/models.ts");
    syncConfiguredModelProviders();
  }
  // OpenAI-compatible models reach sessions through the model list, not tools.
  if (
    sections.some((key) => isIntegrationKey(key) && key !== "openAiCompatible")
  )
    notifyIntegrationToolsChanged();
  for (const listener of listeners) listener({ sections });
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
