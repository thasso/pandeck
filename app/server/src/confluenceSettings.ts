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
import { join } from "node:path";
import type {
  ConfluenceConnectionStatus,
  ConfluenceSettings,
  ConfluenceSettingsPatch,
} from "@assistant/shared";
import { atlassianFetch } from "./atlassian/atlassianFetch.ts";
import { CONFLUENCE_HOST, DATA_DIR } from "./config.ts";
import type { ConfluenceApiConfig } from "./atlassian/confluenceClient.ts";
import { getJiraCredsIfAvailable } from "./jiraSettings.ts";
import { createPrivateJsonFile } from "./privateJsonFile.ts";

const CONFLUENCE_SETTINGS_PATH = join(DATA_DIR, "settings", "confluence.json");

interface ConfluenceSettingsFile {
  enabled?: boolean;
}

const privateFile = createPrivateJsonFile(
  CONFLUENCE_SETTINGS_PATH,
  "Confluence settings",
);
const writePrivate = privateFile.write;

function readPrivate(): Required<ConfluenceSettingsFile> {
  return privateFile.read((parsed: ConfluenceSettingsFile | undefined) => ({
    enabled: Boolean(parsed?.enabled),
  }));
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
