/**
 * Which optional integrations the user can set up from chat, and what each
 * needs (`docs/onboarding.md`, step 3c). Computed from the settings the
 * Settings page shows, so an integration whose Atlassian site or OAuth client
 * the deployment has not configured is reported with that blocker instead of
 * being offered. Read-only: values go through `settings_update`, credentials
 * through `settings_request_input`.
 *
 * GitHub is not listed: it has its own setup (`github_pat_setup_link`).
 * Context7 and the browser tools are not offered either: Context7 is a coding
 * docs lookup most users never need, and the browser tools need no setup.
 */
import type { AppSettings } from "@assistant/shared";
import {
  settingDescriptor,
  valueAtPath,
  type SettingsSectionId,
} from "@assistant/shared/settingsRegistry";
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import { settingIsSet } from "../../settingsInput.ts";
import { getSettings } from "../../settings.ts";

/** A readonly setting the deployment must make truthy before setup can work. */
interface Requirement {
  path: string;
  missing: string;
}

export interface ChatIntegration {
  section: SettingsSectionId;
  /** The boolean setting that turns it on; its label names the integration. */
  turnOn: string;
  /** Non-secret values to ask for, saved before the credential. */
  ask?: readonly string[];
  /** Non-secret values worth offering, never required. */
  optional?: readonly string[];
  /** The secret or OAuth connection, entered only in its card. */
  credential?: string;
  /** The integration whose sign-in this one uses; it must be set up and on. */
  uses?: SettingsSectionId;
  note?: string;
  requires?: readonly Requirement[];
}

const ATLASSIAN_SITE: Requirement = {
  path: "jira.jiraHost",
  missing: "this server has no Atlassian site configured",
};

/** In the order the setup card offers them. */
export const CHAT_INTEGRATIONS: readonly ChatIntegration[] = [
  {
    section: "forgejo",
    turnOn: "forgejo.enabled",
    ask: ["forgejo.baseUrl"],
    optional: ["forgejo.defaultOwner"],
    credential: "forgejo.token",
    note: "The access token is created on the Forgejo instance under Settings → Applications, with repository read and write access.",
  },
  {
    section: "jira",
    turnOn: "jira.enabled",
    ask: ["jira.atlassianEmail"],
    credential: "jira.atlassianToken",
    requires: [ATLASSIAN_SITE],
  },
  {
    section: "confluence",
    turnOn: "confluence.enabled",
    uses: "jira",
    requires: [
      {
        path: "confluence.confluenceHost",
        missing: "this server has no Confluence site configured",
      },
    ],
  },
  {
    section: "google",
    turnOn: "google.enabled",
    credential: "google.connection",
    requires: [
      {
        path: "google.oauthClientConfigured",
        missing: "this server has no Google OAuth client configured",
      },
    ],
  },
  {
    section: "slack",
    turnOn: "slack.enabled",
    credential: "slack.connection",
    requires: [
      {
        path: "slack.oauthClientConfigured",
        missing: "this server has no Slack app configured",
      },
    ],
  },
  {
    section: "tempo",
    turnOn: "tempo.enabled",
    credential: "tempo.connection",
    requires: [
      {
        path: "tempo.oauthClientConfigured",
        missing: "this server has no Tempo OAuth client configured",
      },
      ATLASSIAN_SITE,
    ],
  },
  {
    section: "web-search",
    turnOn: "brave.enabled",
    credential: "brave.apiKey",
  },
];

/** Each integration as the tool reports it against `settings`. */
export function chatIntegrationStates(settings: AppSettings) {
  return CHAT_INTEGRATIONS.map((integration) => {
    const { section, turnOn, ask, optional, credential, uses, note } =
      integration;
    const blockers = (integration.requires ?? [])
      .filter(({ path }) => !valueAtPath(settings, path))
      .map(({ missing }) => missing);
    const credentialDescriptor = credential
      ? settingDescriptor(credential)
      : undefined;
    return {
      section,
      name: settingDescriptor(turnOn)?.label ?? section,
      on: valueAtPath(settings, turnOn) === true,
      ...(credentialDescriptor
        ? { credentialSet: settingIsSet(credentialDescriptor, settings) }
        : {}),
      ...(blockers.length > 0
        ? {
            available: false,
            blocker: `${blockers.join("; ")}. Only the server's deployment config can change that.`,
          }
        : {
            available: true,
            setup: {
              ...(ask ? { ask } : {}),
              ...(optional ? { optional } : {}),
              ...(credential ? { credential } : {}),
              ...(uses ? { uses } : {}),
              turnOn,
              test: section,
              ...(note ? { note } : {}),
            },
          }),
    };
  });
}

const integrationSetupReadTool = defineAgentTool<Record<string, unknown>>({
  name: "integration_setup_read",
  label: "Integrations to Set Up",
  description:
    "The optional integrations the user can set up from chat, whether each is on and its credential set, and how to set it up. One that is not available names its blocker: explain it, never ask for credentials it cannot use. Set up one chosen integration at a time: save its setup.ask values (and setup.optional ones the user wants) with settings_update first, then request setup.credential with settings_request_input, never in chat; once it is saved, turn setup.turnOn on and test setup.test in one settings_update. setup.uses names the integration whose sign-in it shares, which must be set up and on first: ask before setting that one up if the user did not choose it. Never turn on one the user did not choose.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  execute: async () =>
    jsonResult({ integrations: chatIntegrationStates(getSettings()) }),
});

export const integrationSetupTools = [integrationSetupReadTool];
