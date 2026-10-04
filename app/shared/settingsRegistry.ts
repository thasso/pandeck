/**
 * The settings registry: one descriptor for every setting the Settings page
 * shows, so the page and the Personal Assistant read and change the same
 * things through the same path ([Task-729](pa://task/729)).
 *
 * A descriptor names a dotted path into `AppSettings` (integration secrets and
 * OAuth connections name the patch field that writes them), the page section
 * it appears in, and how it may be touched:
 *
 * - `value`: read and written as is.
 * - `readonly`: deployment config or derived status; shown, never written.
 * - `secret`: write-only. Reads report only its `configuredBy` flag, and the
 *   value never reaches an agent.
 * - `oauth`: connected by a browser flow; may be disconnected (`clearWith`).
 *
 * Server coverage tests fail when `getSettings()` grows a leaf, or an
 * integration patch grows a field, that no descriptor covers. A page section
 * with no descriptors must say why in {@link SETTINGS_OUTSIDE_REGISTRY}.
 */
import { MEMORY_LEARNING_MODES, MEMORY_SETTINGS_LIMITS } from "./memory.ts";
import {
  MAX_PEER_SPAWN_RUNTIMES,
  MAX_SESSION_PEER_PROMPT_MAX_HOPS,
  MIN_SESSION_PEER_PROMPT_MAX_HOPS,
} from "./peerRuntimes.ts";
import {
  BACKGROUND_WORK_SETTINGS_RANGES,
  MAX_WORKTREE_REMOTE_FETCH_MINUTES,
  OPENAI_COMPATIBLE_THINKING_FORMATS,
  SPEECH_TO_TEXT_LIMITS,
} from "./protocol.ts";
import { THINKING_LEVELS } from "./thinkingLevels.ts";

/** Every Settings page section, in navigation order. Routes are `/settings/<id>`. */
export const SETTINGS_SECTION_IDS = [
  "appearance",
  "profile",
  "about",
  "models",
  "claude-sdk",
  "openai",
  "openai-compatible",
  "personal-assistant",
  "memory",
  "naming",
  "refinement",
  "dictation",
  "notifications",
  "worktrees",
  "skills",
  "peer-runtimes",
  "background-processes",
  "port-forwarding",
  "commit",
  "pull-request",
  "task-intake",
  "day-scan",
  "minutes-scanner",
  "pdf-conversion",
  "browserTools",
  "google",
  "slack",
  "slack-huddles",
  "jira",
  "confluence",
  "tempo",
  "github",
  "forgejo",
  "web-search",
  "context7",
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export type SettingValueSpec =
  | { kind: "boolean" }
  | { kind: "string"; multiline?: boolean }
  | { kind: "integer"; min: number; max: number }
  | { kind: "number"; min: number; max: number }
  | { kind: "enum"; values: readonly string[] }
  /** A structured value written whole; `shape` describes it for a writer. */
  | { kind: "json"; shape: string };

export type SettingAccess = "value" | "readonly" | "secret" | "oauth";

export interface SettingDescriptor {
  path: string;
  section: SettingsSectionId;
  label: string;
  access: SettingAccess;
  /**
   * What a write must look like (`value` and `secret` access). A `readonly`
   * setting a client echoes back declares the kind it reads as.
   */
  value?: SettingValueSpec;
  /** Writing `""` removes the field, e.g. an account pin back to automatic. */
  optional?: boolean;
  /** `secret`/`oauth`: the readable flag that says whether it is set. */
  configuredBy?: string;
  /** `secret`/`oauth`: the integration patch flag that clears it. */
  clearWith?: string;
  /** `oauth`: the server route that starts the browser flow. */
  connectPath?: string;
  /** Units, or what an empty value means. */
  hint?: string;
}

/**
 * What a page section shows that the registry does not hold, and where it
 * lives instead. A section with no descriptors at all must appear here.
 */
export const SETTINGS_OUTSIDE_REGISTRY: Partial<
  Record<SettingsSectionId, string>
> = {
  about: "Build and server information; nothing to set.",
  "claude-sdk":
    "Claude accounts are credential profiles: list and manage them with accounts_read and accounts_update, sign them in with accounts_sign_in.",
  openai:
    "OpenAI accounts are credential profiles: list and manage them with accounts_read and accounts_update, sign them in with accounts_sign_in.",
  memory:
    "Memory cards themselves are managed with the memory tools, not settings.",
  notifications:
    "Push subscriptions belong to each browser or app install, not the server.",
  "port-forwarding":
    "Forwards run in the macOS app on the user's machine, not the server.",
  "background-processes":
    "The list of running background work is live state, not settings.",
};

const BOOLEAN: SettingValueSpec = { kind: "boolean" };
const STRING: SettingValueSpec = { kind: "string" };
const TEXT: SettingValueSpec = { kind: "string", multiline: true };

function integer(min: number, max: number): SettingValueSpec {
  return { kind: "integer", min, max };
}

function oneOf(values: readonly string[]): SettingValueSpec {
  return { kind: "enum", values };
}

function setting(
  path: string,
  section: SettingsSectionId,
  label: string,
  value: SettingValueSpec,
  extra: Pick<SettingDescriptor, "optional" | "hint"> = {},
): SettingDescriptor {
  return { path, section, label, access: "value", value, ...extra };
}

function readonly(
  path: string,
  section: SettingsSectionId,
  label: string,
  hint?: string,
): SettingDescriptor {
  return {
    path,
    section,
    label,
    access: "readonly",
    ...(hint ? { hint } : {}),
  };
}

function secret(
  path: string,
  section: SettingsSectionId,
  label: string,
  configuredBy: string,
  clearWith: string,
): SettingDescriptor {
  return {
    path,
    section,
    label,
    access: "secret",
    value: STRING,
    configuredBy,
    clearWith,
  };
}

function oauth(
  path: string,
  section: SettingsSectionId,
  label: string,
  configuredBy: string,
  clearWith: string,
  connectPath: string,
): SettingDescriptor {
  return {
    path,
    section,
    label,
    access: "oauth",
    configuredBy,
    clearWith,
    connectPath,
  };
}

/** The four fields every configured model slot shares. */
function modelSlot(
  prefix: string,
  section: SettingsSectionId,
  what: string,
): SettingDescriptor[] {
  return [
    setting(`${prefix}.provider`, section, `${what} provider`, STRING),
    setting(`${prefix}.modelId`, section, `${what} model`, STRING),
    setting(
      `${prefix}.thinkingLevel`,
      section,
      `${what} thinking level`,
      oneOf(THINKING_LEVELS),
    ),
    setting(
      `${prefix}.credentialProfileId`,
      section,
      `${what} account`,
      STRING,
      {
        optional: true,
        hint: "Credential profile id; empty means pick an account automatically.",
      },
    ),
  ];
}

const bg = BACKGROUND_WORK_SETTINGS_RANGES;
const mem = MEMORY_SETTINGS_LIMITS;
const stt = SPEECH_TO_TEXT_LIMITS;

export const SETTINGS_REGISTRY: readonly SettingDescriptor[] = [
  // General
  setting(
    "appearance.separatorBeforeFinalResponse",
    "appearance",
    "Rule before the final answer",
    BOOLEAN,
  ),
  setting(
    "appearance.separatorAtTurnEnd",
    "appearance",
    "Rule at the end of each turn",
    BOOLEAN,
  ),
  setting(
    "appearance.turnStatsRow",
    "appearance",
    "Token and cost row after each turn",
    BOOLEAN,
  ),
  setting(
    "appearance.turnStatsPerRequest",
    "appearance",
    "Per-request detail in the stats row",
    BOOLEAN,
  ),
  setting("profile.displayName", "profile", "Display name", STRING),
  setting("profile.timeZone", "profile", "Time zone", STRING, {
    hint: "IANA zone such as Europe/Berlin; empty means the server's zone.",
  }),
  // The Settings page echoes this back in a profile patch, so it declares the
  // kind it reads as and a wrong-kind echo is refused.
  {
    path: "profile.effectiveTimeZone",
    section: "profile",
    label: "Time zone in effect",
    access: "readonly",
    value: STRING,
  },

  // Models & providers
  setting("models.hidden", "models", "Models hidden from the picker", {
    kind: "json",
    shape: 'array of model keys ("provider:modelId")',
  }),
  setting("models.order", "models", "Model picker order", {
    kind: "json",
    shape: 'array of model keys ("provider:modelId"); unlisted models follow',
  }),
  setting("claudeSdk.enabled", "claude-sdk", "Claude SDK harness", BOOLEAN),
  setting(
    "openAiCompatible.enabled",
    "openai-compatible",
    "OpenAI-compatible provider",
    BOOLEAN,
  ),
  setting(
    "openAiCompatible.name",
    "openai-compatible",
    "Provider name",
    STRING,
  ),
  setting("openAiCompatible.baseUrl", "openai-compatible", "Base URL", STRING),
  setting(
    "openAiCompatible.thinkingFormat",
    "openai-compatible",
    "Thinking format",
    oneOf(OPENAI_COMPATIBLE_THINKING_FORMATS),
  ),
  secret(
    "openAiCompatible.apiKey",
    "openai-compatible",
    "API key",
    "openAiCompatible.apiKeyConfigured",
    "clearApiKey",
  ),
  readonly("openAiCompatible.models", "openai-compatible", "Discovered models"),

  // Assistant behavior
  setting(
    "permanentAssistant.name",
    "personal-assistant",
    "Assistant name",
    STRING,
  ),
  ...modelSlot("permanentAssistant", "personal-assistant", "Assistant"),
  setting(
    "permanentAssistant.additionalInstructions",
    "personal-assistant",
    "Additional instructions",
    TEXT,
  ),
  setting("memory.loadingEnabled", "memory", "Load memory into turns", BOOLEAN),
  setting(
    "memory.learningMode",
    "memory",
    "Learning mode",
    oneOf(MEMORY_LEARNING_MODES),
  ),
  setting(
    "memory.maintenanceEnabled",
    "memory",
    "Automatic maintenance",
    BOOLEAN,
  ),
  setting(
    "memory.maxCards",
    "memory",
    "Cards per turn",
    integer(mem.maxCards.min, mem.maxCards.max),
  ),
  setting(
    "memory.maxRenderedChars",
    "memory",
    "Characters per snapshot",
    integer(mem.maxRenderedChars.min, mem.maxRenderedChars.max),
  ),
  ...modelSlot("memory.processor", "memory", "Memory processor"),
  setting(
    "memory.maxCallsPerHour",
    "memory",
    "Processor calls per hour",
    integer(mem.maxCallsPerHour.min, mem.maxCallsPerHour.max),
  ),
  setting(
    "memory.maxCostPerDayUsd",
    "memory",
    "Processor cost per day",
    {
      kind: "number",
      min: mem.maxCostPerDayUsd.min,
      max: mem.maxCostPerDayUsd.max,
    },
    { hint: "US dollars." },
  ),
  setting("sessionNaming.enabled", "naming", "Name new sessions", BOOLEAN),
  ...modelSlot("sessionNaming", "naming", "Session naming"),
  ...modelSlot("promptRefinement", "refinement", "Prompt refinement"),
  setting("speechToText.enabled", "dictation", "Dictation", BOOLEAN),
  setting("speechToText.modelId", "dictation", "Recognition model", STRING, {
    hint: "Installed model directory; empty means the first installed model.",
  }),
  setting(
    "speechToText.numThreads",
    "dictation",
    "Recognizer threads",
    integer(stt.numThreads.min, stt.numThreads.max),
  ),
  setting(
    "speechToText.idleShutdownSeconds",
    "dictation",
    "Unload after idle",
    integer(stt.idleShutdownSeconds.min, stt.idleShutdownSeconds.max),
    { hint: "Seconds; 0 keeps the recognizer loaded." },
  ),
  setting(
    "speechToText.maxUtteranceSeconds",
    "dictation",
    "Longest utterance",
    integer(stt.maxUtteranceSeconds.min, stt.maxUtteranceSeconds.max),
    { hint: "Seconds." },
  ),
  setting("speechToText.vocabulary", "dictation", "Vocabulary corrections", {
    kind: "json",
    shape: `array of { from, to } replacements, at most ${stt.vocabularyEntries}`,
  }),

  // Developer workflow
  setting("worktrees.root", "worktrees", "Worktree folder", STRING),
  setting("projectsRoot", "worktrees", "Projects folder", STRING, {
    hint: "New projects are cloned to <projects folder>/<project id>.",
  }),
  ...modelSlot("worktrees.namingAgent", "worktrees", "Worktree naming"),
  ...modelSlot("worktrees.mergeAgent", "worktrees", "Merge agent"),
  setting(
    "worktrees.defaultMergeStrategy",
    "worktrees",
    "Default merge strategy",
    oneOf(["squash", "merge", "rebase"]),
  ),
  setting(
    "worktrees.remoteFetchMinutes",
    "worktrees",
    "Remote fetch interval",
    integer(0, MAX_WORKTREE_REMOTE_FETCH_MINUTES),
    { hint: "Minutes; 0 turns automatic fetching off." },
  ),
  setting("skills", "skills", "Skills turned on", {
    kind: "json",
    shape:
      'map of skill name to "on" or "off"; a name with no entry is off. Written whole.',
  }),
  setting("peerSpawnRuntimes", "peer-runtimes", "Approved peer runtimes", {
    kind: "json",
    shape: `array of at most ${MAX_PEER_SPAWN_RUNTIMES} { id, name?, relativeCost, description?, credentialProfileId, provider, modelId, thinkingLevel, enabled }. Written whole.`,
  }),
  setting(
    "sessionPeerPromptMaxHops",
    "peer-runtimes",
    "Agent-to-agent prompt chain limit",
    integer(MIN_SESSION_PEER_PROMPT_MAX_HOPS, MAX_SESSION_PEER_PROMPT_MAX_HOPS),
  ),
  setting(
    "backgroundWork.enabled",
    "background-processes",
    "Background work",
    BOOLEAN,
  ),
  setting(
    "backgroundWork.ownerSessionCap",
    "background-processes",
    "Sessions that may own background work",
    integer(bg.ownerSessionCap.min, bg.ownerSessionCap.max),
  ),
  setting(
    "backgroundWork.taskLifetimeMinutes",
    "background-processes",
    "Background task lifetime",
    integer(bg.taskLifetimeMinutes.min, bg.taskLifetimeMinutes.max),
    { hint: "Minutes." },
  ),
  setting(
    "backgroundWork.claudeEmptyHostGraceSeconds",
    "background-processes",
    "Idle Claude host grace",
    integer(
      bg.claudeEmptyHostGraceSeconds.min,
      bg.claudeEmptyHostGraceSeconds.max,
    ),
    { hint: "Seconds." },
  ),
  ...modelSlot("commitAgent", "commit", "Commit agent"),
  ...modelSlot("prAgent", "pull-request", "Pull request agent"),

  // Tasks & automation
  ...modelSlot("taskIntakeAgent", "task-intake", "Task intake"),
  setting(
    "taskIntakeAgent.projectId",
    "task-intake",
    "Default project",
    STRING,
    { hint: "Project id; empty means no default." },
  ),
  setting(
    "taskIntakeAgent.additionalInstructions",
    "task-intake",
    "Additional instructions",
    TEXT,
  ),
  setting(
    "dayScan.identities.googleEmail",
    "day-scan",
    "Google email",
    STRING,
    { optional: true },
  ),
  setting(
    "dayScan.identities.jiraAccountId",
    "day-scan",
    "Jira account id",
    STRING,
    { optional: true },
  ),
  setting("dayScan.identities.jiraEmail", "day-scan", "Jira email", STRING, {
    optional: true,
  }),
  setting(
    "dayScan.identities.githubLogin",
    "day-scan",
    "GitHub login",
    STRING,
    { optional: true },
  ),
  setting(
    "dayScan.identities.tempoAccountId",
    "day-scan",
    "Tempo account id",
    STRING,
    { optional: true },
  ),
  setting(
    "dayScan.taskProposalPolicy",
    "day-scan",
    "Task proposals",
    oneOf(["auto", "review"]),
  ),
  setting(
    "dayScan.changelogIssueCap",
    "day-scan",
    "Changelog issues per scan",
    integer(1, 500),
  ),
  setting(
    "dayScan.maxMinutesDocsPerRun",
    "day-scan",
    "Minutes documents per run",
    integer(1, 50),
  ),
  setting(
    "dayScan.schedule.enabled",
    "day-scan",
    "Scheduled daily scan",
    BOOLEAN,
  ),
  setting("dayScan.schedule.time", "day-scan", "Scan time", STRING, {
    hint: "HH:MM, 24-hour, in the profile time zone.",
  }),
  setting(
    "dayScan.schedule.synthesize",
    "day-scan",
    "Write the day summary after scanning",
    BOOLEAN,
  ),
  ...modelSlot("meetingMinutesScanner", "minutes-scanner", "Minutes scanner"),
  setting(
    "meetingMinutesScanner.maxSourceChars",
    "minutes-scanner",
    "Characters read per source",
    integer(5_000, 200_000),
  ),
  setting(
    "meetingMinutesScanner.maxSnippetChars",
    "minutes-scanner",
    "Characters per snippet",
    integer(2_000, 60_000),
  ),
  setting(
    "meetingMinutesScanner.timeoutMs",
    "minutes-scanner",
    "Scanner timeout",
    integer(10_000, 240_000),
    { hint: "Milliseconds." },
  ),
  ...modelSlot("calendarDaySession", "minutes-scanner", "Calendar day session"),
  setting(
    "pdfConversion.fallbackEnabled",
    "pdf-conversion",
    "Model fallback for hard PDFs",
    BOOLEAN,
  ),
  ...modelSlot("pdfConversion", "pdf-conversion", "PDF fallback"),
  setting(
    "pdfConversion.timeoutMs",
    "pdf-conversion",
    "Fallback timeout",
    integer(30_000, 600_000),
    { hint: "Milliseconds." },
  ),

  // Integrations
  setting("browserTools.headed", "browserTools", "Visible browser", BOOLEAN),
  setting(
    "browserTools.rawMcpEnabled",
    "browserTools",
    "Raw Playwright MCP tool",
    BOOLEAN,
  ),
  setting("google.enabled", "google", "Google Workspace", BOOLEAN),
  setting(
    "google.gmailMinutesLabelName",
    "google",
    "Gmail label for meeting minutes",
    STRING,
  ),
  oauth(
    "google.connection",
    "google",
    "Google account connection",
    "google.refreshTokenConfigured",
    "clearTokens",
    "/api/google/oauth/start",
  ),
  readonly("google.redirectUri", "google", "OAuth redirect URI"),
  readonly("google.accountEmail", "google", "Connected account"),
  readonly("google.scopes", "google", "Requested scopes"),
  readonly(
    "google.oauthClientConfigured",
    "google",
    "OAuth client configured",
    "Set in the deployment environment.",
  ),
  readonly(
    "google.gmailArchiveAuthorized",
    "google",
    "Gmail archiving authorized",
  ),
  setting("slack.enabled", "slack", "Slack", BOOLEAN),
  secret(
    "slack.userToken",
    "slack",
    "User token",
    "slack.userTokenConfigured",
    "clearUserToken",
  ),
  secret(
    "slack.botToken",
    "slack",
    "Bot token",
    "slack.botTokenConfigured",
    "clearBotToken",
  ),
  oauth(
    "slack.connection",
    "slack",
    "Slack workspace connection",
    "slack.connected",
    "disconnect",
    "/api/slack/oauth/start",
  ),
  readonly(
    "slack.oauthClientConfigured",
    "slack",
    "OAuth client configured",
    "Set in the deployment environment.",
  ),
  setting("slack.huddlesEnabled", "slack-huddles", "Slack Huddles", BOOLEAN),
  secret(
    "slack.clientToken",
    "slack-huddles",
    "Browser client token",
    "slack.clientTokenConfigured",
    "clearClientToken",
  ),
  secret(
    "slack.clientCookieD",
    "slack-huddles",
    "Browser d cookie",
    "slack.clientCookieConfigured",
    "clearClientCookie",
  ),
  setting("jira.enabled", "jira", "Jira", BOOLEAN),
  setting("jira.atlassianEmail", "jira", "Atlassian email", STRING),
  secret(
    "jira.atlassianToken",
    "jira",
    "Atlassian API token",
    "jira.atlassianTokenConfigured",
    "clearAtlassianToken",
  ),
  readonly(
    "jira.jiraHost",
    "jira",
    "Atlassian site",
    "Set in the deployment config.",
  ),
  setting("confluence.enabled", "confluence", "Confluence", BOOLEAN),
  readonly(
    "confluence.confluenceHost",
    "confluence",
    "Confluence site",
    "Set in the deployment config.",
  ),
  readonly(
    "confluence.credentialsAvailable",
    "confluence",
    "Atlassian credentials available",
    "Confluence signs in with the Jira credentials.",
  ),
  setting("tempo.enabled", "tempo", "Tempo", BOOLEAN),
  setting("tempo.apiBaseUrl", "tempo", "Tempo API base URL", STRING),
  oauth(
    "tempo.connection",
    "tempo",
    "Tempo connection",
    "tempo.refreshTokenConfigured",
    "clearTokens",
    "/api/tempo/oauth/start",
  ),
  readonly("tempo.redirectUri", "tempo", "OAuth redirect URI"),
  readonly(
    "tempo.oauthClientConfigured",
    "tempo",
    "OAuth client configured",
    "Set in the deployment environment.",
  ),
  readonly("tempo.authorAccountId", "tempo", "Worklog author account"),
  setting("github.enabled", "github", "GitHub", BOOLEAN),
  secret(
    "github.token",
    "github",
    "Personal access token",
    "github.tokenConfigured",
    "clearToken",
  ),
  setting("github.defaultOwner", "github", "Default owner", STRING),
  setting(
    "github.packageProxyEnabled",
    "github",
    "Package proxy for agent builds",
    BOOLEAN,
  ),
  setting("forgejo.enabled", "forgejo", "Forgejo", BOOLEAN),
  setting("forgejo.baseUrl", "forgejo", "Instance URL", STRING),
  secret(
    "forgejo.token",
    "forgejo",
    "Access token",
    "forgejo.tokenConfigured",
    "clearToken",
  ),
  setting("forgejo.defaultOwner", "forgejo", "Default owner", STRING),
  setting("brave.enabled", "web-search", "Web search", BOOLEAN),
  secret(
    "brave.apiKey",
    "web-search",
    "Brave API key",
    "brave.apiKeyConfigured",
    "clearApiKey",
  ),
  setting("context7.enabled", "context7", "Context7", BOOLEAN),
  secret(
    "context7.apiKey",
    "context7",
    "Context7 API key",
    "context7.apiKeyConfigured",
    "clearApiKey",
  ),
];

const BY_PATH = new Map(SETTINGS_REGISTRY.map((d) => [d.path, d]));

/** The value at a dotted settings path, or undefined where the path ends. */
export function valueAtPath(root: unknown, path: string): unknown {
  let node = root;
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

export function settingDescriptor(path: string): SettingDescriptor | undefined {
  return BY_PATH.get(path);
}

/** A numeric setting's bounds. Asking for any other setting is a coding error. */
export function settingBounds(path: string): { min: number; max: number } {
  const spec = settingDescriptor(path)?.value;
  if (spec?.kind !== "integer" && spec?.kind !== "number")
    throw new Error(`${path} is not a numeric setting`);
  return { min: spec.min, max: spec.max };
}

/**
 * Why `value` cannot be written to `descriptor`, or null when it can. Only the
 * kind and bounds are checked here; a `json` value is checked by the server's
 * settings validation, which knows each structure.
 */
export function settingValueError(
  descriptor: SettingDescriptor,
  value: unknown,
): string | null {
  const spec = descriptor.value;
  if (!spec) return `${descriptor.path} cannot be written`;
  switch (spec.kind) {
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "string":
      return typeof value === "string" ? null : "must be a string";
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return "must be a number";
      if (spec.kind === "integer" && !Number.isInteger(value))
        return "must be a whole number";
      if (value < spec.min || value > spec.max)
        return `must be between ${spec.min} and ${spec.max}`;
      return null;
    }
    case "enum":
      return typeof value === "string" && spec.values.includes(value)
        ? null
        : `must be one of ${spec.values.join(", ")}`;
    case "json":
      return value === undefined || value === null
        ? `must be ${spec.shape}`
        : null;
  }
}
