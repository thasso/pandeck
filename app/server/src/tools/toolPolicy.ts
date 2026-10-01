/**
 * Tool POLICY that does not depend on which tools exist: the Settings-driven
 * integration gates, and the Plan-mode rule read off a tool's own
 * `sideEffects` classification.
 *
 * It lives beside the catalog rather than inside it because the modules that
 * apply the policy — `promptConditions.ts`, the harness option builders — sit
 * BELOW the catalog in the import graph: the catalog composes every tool
 * module, so anything a tool can reach must not read the catalog back.
 */
import type { AgentTool } from "../mcp/tool.ts";
import { getGoogleSettings } from "../googleSettings.ts";
import { getConfluenceSettings } from "../confluenceSettings.ts";
import { getJiraSettings } from "../jiraSettings.ts";
import { getGithubSettings } from "../githubSettings.ts";
import { isForgejoConfigured } from "../forgejoSettings.ts";
import {
  getSlackHuddleCapabilitySettings,
  getSlackRuntimeSettings,
} from "../slackSettings.ts";
import { getTempoSettings } from "../tempoSettings.ts";
import { getBrowserToolSettings } from "../browserSettings.ts";

/** Integration gates (Settings-driven) that switch optional tool groups. */
export interface IntegrationToolGates {
  jira: boolean;
  /** Confluence pages; authenticates with the Jira integration's Atlassian credentials. */
  confluence: boolean;
  tempo: boolean;
  google: boolean;
  slack: boolean;
  slackHuddles: boolean;
  github: boolean;
  /** Self-hosted Forgejo instance (enabled + a base URL configured). */
  forgejo: boolean;
  /** Raw Playwright MCP passthrough escape hatch (workshop/developer only). */
  browserRawMcp: boolean;
}

/** Current values of every integration gate (reads Settings). */
export function currentIntegrationToolGates(): IntegrationToolGates {
  const slack = getSlackRuntimeSettings();
  const huddles = getSlackHuddleCapabilitySettings();
  return {
    jira: getJiraSettings().enabled,
    confluence: getConfluenceSettings().enabled,
    tempo: getTempoSettings().enabled,
    google: getGoogleSettings().enabled,
    slack: slack.enabled,
    slackHuddles:
      huddles.huddlesEnabled &&
      huddles.clientTokenConfigured &&
      huddles.clientCookieConfigured,
    github: getGithubSettings().enabled,
    forgejo: isForgejoConfigured(),
    browserRawMcp: getBrowserToolSettings().rawMcpEnabled,
  };
}

/**
 * Plan mode permits the user's Task list to be organized without permitting
 * repository or product changes. All other durable mutations remain blocked.
 */
const PLAN_MODE_ALLOWED_MUTATING_TOOLS = new Set([
  "task_manage",
  // Background Stop is an explicit safety control, not a new-work mutation;
  // list/status and Stop must remain available while planning.
  "background_tasks",
  // The discriminated `profiles` operation is read-only; the tool itself
  // rejects `spawn` and `propose` against the caller's persisted Plan mode
  // before either operation can create anything.
  "session_spawn",
]);

/** Whether a catalog tool stays usable while the session is in Plan mode. */
export function isPlanModeToolAllowed(tool: AgentTool): boolean {
  return (
    tool.sideEffects === "none" ||
    PLAN_MODE_ALLOWED_MUTATING_TOOLS.has(tool.name)
  );
}
