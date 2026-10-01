/**
 * Confluence integration settings.
 *
 * Confluence holds no credentials of its own. It is the same Atlassian site as
 * Jira, reached with the same account email and API token, so this module owns
 * only the enable switch and reads credentials from `jiraSettings`. That is the
 * dependency Tempo already has on Jira (`docs/jira-tempo.md`), with one
 * difference: Confluence cannot degrade, since every call it makes is
 * authenticated. Without Jira credentials its tools fail fast with a hint
 * rather than returning an unauthenticated half-answer.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  ConfluenceConnectionStatus,
  ConfluenceSettings,
  ConfluenceSettingsPatch,
} from "@assistant/shared";
import { atlassianFetch } from "./atlassian/atlassianFetch.ts";
import { CONFLUENCE_HOST, DATA_DIR } from "./config.ts";
import type { ConfluenceApiConfig } from "./atlassian/confluenceClient.ts";
import { getJiraCredsIfAvailable } from "./jiraSettings.ts";

const CONFLUENCE_SETTINGS_PATH = join(DATA_DIR, "settings", "confluence.json");

interface ConfluenceSettingsFile {
  enabled?: boolean;
}

function readPrivate(): Required<ConfluenceSettingsFile> {
  if (!existsSync(CONFLUENCE_SETTINGS_PATH)) return { enabled: false };
  try {
    const parsed = JSON.parse(
      readFileSync(CONFLUENCE_SETTINGS_PATH, "utf8"),
    ) as ConfluenceSettingsFile;
    return { enabled: Boolean(parsed?.enabled) };
  } catch (err) {
    throw new Error(
      `Failed to read Confluence settings at ${CONFLUENCE_SETTINGS_PATH}: ${String(err)}`,
    );
  }
}

function writePrivate(next: Required<ConfluenceSettingsFile>): void {
  mkdirSync(dirname(CONFLUENCE_SETTINGS_PATH), { recursive: true });
  const tmp = `${CONFLUENCE_SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, CONFLUENCE_SETTINGS_PATH);
}

export function getConfluenceSettings(): ConfluenceSettings {
  return {
    enabled: readPrivate().enabled,
    confluenceHost: CONFLUENCE_HOST,
    credentialsAvailable: getJiraCredsIfAvailable() !== null,
  };
}

export function updateConfluenceSettings(
  patch: ConfluenceSettingsPatch,
): ConfluenceSettings {
  const current = readPrivate();
  writePrivate({ enabled: patch.enabled ?? current.enabled });
  return getConfluenceSettings();
}

/** Credentials for Confluence tools. Throws with a Settings hint when unusable. */
export function getConfluenceToolConfig(): ConfluenceApiConfig {
  if (!readPrivate().enabled)
    throw new Error(
      "Confluence tools are disabled. Enable them in Settings → Confluence.",
    );
  const creds = getJiraCredsIfAvailable();
  if (!creds)
    throw new Error(
      "Confluence uses the Atlassian credentials of the Jira integration, which is disabled or unconfigured. Enable Jira and save an Atlassian email and API token in Settings → Jira.",
    );
  return {
    host: CONFLUENCE_HOST,
    atlassianEmail: creds.atlassianEmail,
    atlassianToken: creds.atlassianToken,
  };
}

/**
 * Verify Confluence access with the Jira integration's credentials. The
 * identity call is tried first because a name and accountId make the status
 * line useful; a site that refuses it still counts as reachable when the space
 * listing answers, which is what the tools actually need.
 */
export async function testConfluenceSettings(): Promise<ConfluenceConnectionStatus> {
  const checkedAt = Date.now();
  const creds = getJiraCredsIfAvailable();
  if (!creds) {
    return {
      ok: false,
      checkedAt,
      message:
        "No Atlassian credentials. Configure the Jira integration in Settings → Jira; Confluence shares its email and API token.",
    };
  }
  const config = {
    host: CONFLUENCE_HOST,
    atlassianEmail: creds.atlassianEmail,
    atlassianToken: creds.atlassianToken,
  };
  try {
    const user = await atlassianFetch<{
      accountId?: string;
      displayName?: string;
    }>(config, "Confluence", "GET", "/wiki/rest/api/user/current");
    const displayName = user.displayName || "Confluence API user";
    return {
      ok: true,
      checkedAt,
      message: `${displayName} authenticated on ${CONFLUENCE_HOST}.`,
      ...(user.accountId !== undefined ? { accountId: user.accountId } : {}),
      ...(user.displayName !== undefined
        ? { displayName: user.displayName }
        : {}),
    };
  } catch (identityError) {
    try {
      await atlassianFetch(
        config,
        "Confluence",
        "GET",
        "/wiki/api/v2/spaces",
        undefined,
        {
          limit: 1,
        },
      );
      return {
        ok: true,
        checkedAt,
        message: `Confluence on ${CONFLUENCE_HOST} is reachable; the current-user call was refused (${String(identityError).slice(0, 120)}).`,
      };
    } catch (err) {
      return { ok: false, checkedAt, message: String(err).slice(0, 300) };
    }
  }
}
