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
import {
  IntegrationRefusal,
  forgetAtlassianStatus,
  lastAtlassianStatus,
  rememberAtlassianStatus,
  remoteIntegrationPort,
  type IntegrationStatus,
  type RemoteIntegrationPort,
} from "./remoteIntegrations.ts";

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
  // Client mode (Task-1397): the credential is the gateway's; jira.json keeps
  // only `enabled` here, and any old local email or token stays unread.
  if (remoteIntegrationPort()) {
    const last = lastAtlassianStatus();
    return {
      enabled: Boolean(settings.enabled),
      jiraHost: JIRA_HOST,
      atlassianEmail: last.email ?? "",
      atlassianTokenConfigured: last.stored,
      credentialStore: "gateway",
    };
  }
  return {
    enabled: Boolean(settings.enabled),
    jiraHost: JIRA_HOST,
    atlassianEmail: settings.atlassianEmail || "",
    atlassianTokenConfigured: Boolean(settings.atlassianToken),
    credentialStore: "local",
  };
}

export function getJiraSettings(): JiraSettings {
  return publicSettings(readPrivate());
}

/** A gateway refusal as this section's fixed error. */
async function onGateway<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new Error(
      `Jira: ${err instanceof IntegrationRefusal ? err.message : "the credential gateway is unreachable; try again shortly."}`,
    );
  }
}

/**
 * Client mode: the credential goes to the gateway, decided before anything
 * is written. A clear wins over any email or token in the same patch; a new
 * email needs the token again, since the gateway never hands one back.
 */
async function updateGatewayJira(
  port: RemoteIntegrationPort,
  patch: JiraSettingsPatch,
): Promise<JiraSettings> {
  if (!JIRA_HOST) throw new Error(NO_JIRA_HOST);
  const last = lastAtlassianStatus();
  const token = patch.atlassianToken?.trim();
  const email = patch.atlassianEmail?.trim();
  if (patch.clearAtlassianToken) {
    await onGateway(() => port.clear());
    forgetAtlassianStatus();
  } else if (token) {
    rememberAtlassianStatus(
      await onGateway(() =>
        port.set({ site: JIRA_HOST, email: email ?? last.email ?? "", token }),
      ),
    );
  } else if (email !== undefined && email !== (last.email ?? ""))
    throw new Error("Jira: enter the API token again to change the email.");
  const current = readPrivate();
  const next = { ...current, enabled: patch.enabled ?? current.enabled };
  if (next.enabled !== current.enabled) writePrivate(next);
  return publicSettings(next);
}

export async function updateJiraSettings(
  patch: JiraSettingsPatch,
): Promise<JiraSettings> {
  const port = remoteIntegrationPort();
  if (port) return updateGatewayJira(port, patch);
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

const GATEWAY_JIRA = "In gateway client mode Jira runs on the gateway.";

export function getJiraToolConfig(): JiraApiConfig {
  if (remoteIntegrationPort()) throw new Error(GATEWAY_JIRA);
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
  // Client mode keeps no local credential (D3, a later slice).
  if (remoteIntegrationPort()) return null;
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
  if (remoteIntegrationPort()) return false;
  const settings = readPrivate();
  return Boolean(
    settings.enabled &&
    JIRA_HOST &&
    settings.atlassianEmail &&
    settings.atlassianToken,
  );
}

const GATEWAY_PROBLEMS: Record<
  NonNullable<IntegrationStatus["problem"]>,
  string
> = {
  vault_locked: "The gateway's vault is locked.",
  vault_unavailable: "The gateway's vault did not answer; try again.",
  invalid:
    "The gateway's Jira credential is invalid; enter the API token again.",
  rejected: "Atlassian rejected the email and API token.",
  unreachable: "Atlassian could not be reached; try again.",
  failed: "Atlassian could not check the credential; try again.",
};

/** The gateway's check of its stored credential. */
async function testGatewayJira(
  port: RemoteIntegrationPort,
): Promise<JiraConnectionStatus> {
  const checkedAt = Date.now();
  if (!JIRA_HOST) return { ok: false, checkedAt, message: NO_JIRA_HOST };
  let status: IntegrationStatus;
  try {
    status = await port.status(true);
  } catch (err) {
    return {
      ok: false,
      checkedAt,
      message:
        err instanceof IntegrationRefusal
          ? `Jira: ${err.message}`
          : "Jira: the credential gateway is unreachable; try again shortly.",
    };
  }
  rememberAtlassianStatus(status);
  if (!status.connected)
    return {
      ok: false,
      checkedAt,
      message: status.problem
        ? GATEWAY_PROBLEMS[status.problem]
        : "Missing Atlassian email or API token.",
    };
  const displayName = status.displayName || "Jira API user";
  return {
    ok: true,
    checkedAt,
    message: `${displayName} authenticated.${status.accountId ? ` accountId=${status.accountId}` : ""}`,
    ...(status.accountId !== undefined ? { accountId: status.accountId } : {}),
    ...(status.displayName !== undefined
      ? { displayName: status.displayName }
      : {}),
  };
}

export async function testJiraSettings(
  signal?: AbortSignal,
): Promise<JiraConnectionStatus> {
  const port = remoteIntegrationPort();
  if (port) return testGatewayJira(port);
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
