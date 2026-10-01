import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  JiraConnectionStatus,
  JiraSettings,
  JiraSettingsPatch,
} from "@assistant/shared";
import { DATA_DIR, JIRA_HOST } from "./config.ts";
import type { JiraApiConfig } from "./jiraClient.ts";

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

function readPrivate(): StoredJiraSettings {
  if (!existsSync(JIRA_SETTINGS_PATH)) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(
      readFileSync(JIRA_SETTINGS_PATH, "utf8"),
    ) as JiraSettingsFile;
    return normalizeStored(parsed);
  } catch (err) {
    throw new Error(
      `Failed to read Jira settings at ${JIRA_SETTINGS_PATH}: ${String(err)}`,
    );
  }
}

function writePrivate(next: StoredJiraSettings): void {
  mkdirSync(dirname(JIRA_SETTINGS_PATH), { recursive: true });
  const tmp = `${JIRA_SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, JIRA_SETTINGS_PATH);
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

export async function testJiraSettings(): Promise<JiraConnectionStatus> {
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
