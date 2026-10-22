import { join } from "node:path";
import type {
  JiraConnectionStatus,
  JiraSettings,
  JiraSettingsPatch,
} from "@assistant/shared";
import { DATA_DIR, JIRA_HOST } from "./config.ts";
import type { JiraApiConfig } from "./jiraClient.ts";
import { createPrivateJsonFile } from "./privateJsonFile.ts";
import { deadlineSignal } from "./httpRetry.ts";

const JIRA_SETTINGS_PATH = join(DATA_DIR, "settings", "jira.json");

const DEFAULTS = {
  enabled: false,
  atlassianEmail: "",
  atlassianToken: "",
};

interface JiraSettingsFile {
  enabled?: boolean;
  atlassianEmail?: string;
  atlassianToken?: string;
}

type StoredJiraSettings = Required<JiraSettingsFile>;

function normalizeStored(
  parsed: JiraSettingsFile | undefined,
): StoredJiraSettings {
  return {
    enabled: Boolean(parsed?.enabled ?? DEFAULTS.enabled),
    atlassianEmail:
      typeof parsed?.atlassianEmail === "string"
        ? parsed.atlassianEmail
        : DEFAULTS.atlassianEmail,
    atlassianToken:
      typeof parsed?.atlassianToken === "string"
        ? parsed.atlassianToken
        : DEFAULTS.atlassianToken,
  };
}

const privateFile = createPrivateJsonFile(JIRA_SETTINGS_PATH, "Jira settings");
const writePrivate = privateFile.write;

function readPrivate(): StoredJiraSettings {
  return privateFile.read(normalizeStored);
}

function publicSettings(settings: StoredJiraSettings): JiraSettings {
  return {
    enabled: Boolean(settings.enabled),
    jiraHost: JIRA_HOST,
    atlassianEmail: settings.atlassianEmail || "",
    atlassianTokenConfigured: Boolean(settings.atlassianToken),
  };
}

export function getJiraSettings(): JiraSettings {
  return publicSettings(readPrivate());
}

export function updateJiraSettings(patch: JiraSettingsPatch): JiraSettings {
  const current = readPrivate();
  const next: StoredJiraSettings = {
    enabled: patch.enabled ?? current.enabled,
    atlassianEmail: (patch.atlassianEmail ?? current.atlassianEmail).trim(),
    atlassianToken: patch.clearAtlassianToken
      ? ""
      : patch.atlassianToken?.trim() || current.atlassianToken,
  };
  writePrivate(next);
  return publicSettings(next);
}

/** Full Jira credentials for tools. Throws with a Settings hint when disabled or missing creds. */
const NO_JIRA_HOST =
  "No Atlassian site configured. Set jira.host in the app config (ASSISTANT_CONFIG) or ASSISTANT_JIRA_HOST.";

export function getJiraToolConfig(): JiraApiConfig {
  const settings = readPrivate();
  if (!settings.enabled)
    throw new Error("Jira tools are disabled. Enable them in Settings → Jira.");
  if (!JIRA_HOST) throw new Error(NO_JIRA_HOST);
  if (!settings.atlassianEmail || !settings.atlassianToken) {
    throw new Error(
      "Missing Atlassian email or API token. Configure them in Settings → Jira.",
    );
  }
  return {
    jiraHost: JIRA_HOST,
    atlassianEmail: settings.atlassianEmail,
    atlassianToken: settings.atlassianToken,
  };
}

/**
 * Non-throwing Jira credentials for Tempo's issue enrichment. Returns null when the
 * Jira integration is disabled or unconfigured so Tempo can degrade gracefully instead
 * of failing solely because Jira is off.
 */
export function getJiraCredsIfAvailable(): JiraApiConfig | null {
  const settings = readPrivate();
  if (
    !settings.enabled ||
    !JIRA_HOST ||
    !settings.atlassianEmail ||
    !settings.atlassianToken
  )
    return null;
  return {
    jiraHost: JIRA_HOST,
    atlassianEmail: settings.atlassianEmail,
    atlassianToken: settings.atlassianToken,
  };
}

/** Background-workflow readiness predicate, the Jira analog of isGoogleConfigured(). */
export function isJiraConfigured(): boolean {
  const settings = readPrivate();
  return Boolean(
    settings.enabled &&
    JIRA_HOST &&
    settings.atlassianEmail &&
    settings.atlassianToken,
  );
}

export async function testJiraSettings(
  signal?: AbortSignal,
): Promise<JiraConnectionStatus> {
  const settings = readPrivate();
  const checkedAt = Date.now();
  if (!JIRA_HOST) return { ok: false, checkedAt, message: NO_JIRA_HOST };
  if (!settings.atlassianEmail || !settings.atlassianToken) {
    return {
      ok: false,
      checkedAt,
      message: "Missing Atlassian email or API token.",
    };
  }
  const auth = Buffer.from(
    `${settings.atlassianEmail}:${settings.atlassianToken}`,
  ).toString("base64");
  const res = await fetch(`https://${JIRA_HOST}/rest/api/3/myself`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    signal: deadlineSignal(15_000, signal),
  });
  if (!res.ok) {
    return {
      ok: false,
      checkedAt,
      message: `Jira API returned HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`,
    };
  }
  const json = (await res.json().catch(() => ({}))) as {
    accountId?: string;
    displayName?: string;
  };
  const displayName = json.displayName || "Jira API user";
  return {
    ok: true,
    checkedAt,
    message: `${displayName} authenticated.${json.accountId ? ` accountId=${json.accountId}` : ""}`,
    ...(json.accountId !== undefined ? { accountId: json.accountId } : {}),
    ...(json.displayName !== undefined
      ? { displayName: json.displayName }
      : {}),
  };
}
