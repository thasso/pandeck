/**
 * Which registry settings the Settings page's hand-written sections own
 * ([Task-729](pa://task/729)). Every other setting of a section is rendered
 * from its registry descriptor below the section (`RegistrySettingFields`), so
 * a setting added to the registry reaches the page without touching this file.
 *
 * A path is claimed one of two ways: RENDERED by a section's own UI, or
 * OMITTED on purpose, with the reason. Secrets, OAuth connections, `json`
 * values and writable integration fields need hand-built UI, so a test
 * requires each of them to be claimed.
 */
/** Paths a section's own UI renders. */
export const RENDERED_SETTING_PATHS: readonly string[] = [
  // appearance
  "appearance.separatorBeforeFinalResponse",
  "appearance.separatorAtTurnEnd",
  "appearance.turnStatsRow",
  "appearance.turnStatsPerRequest",
  // profile
  "profile.displayName",
  "profile.timeZone",
  "profile.effectiveTimeZone",
  // models
  "models.hidden",
  "models.order",
  // claude-sdk
  "claudeSdk.enabled",
  // openai-compatible
  "openAiCompatible.enabled",
  "openAiCompatible.name",
  "openAiCompatible.baseUrl",
  "openAiCompatible.thinkingFormat",
  "openAiCompatible.apiKey",
  "openAiCompatible.models",
  // personal-assistant
  "permanentAssistant.name",
  "permanentAssistant.provider",
  "permanentAssistant.modelId",
  "permanentAssistant.thinkingLevel",
  "permanentAssistant.credentialProfileId",
  "permanentAssistant.additionalInstructions",
  // memory
  "memory.loadingEnabled",
  "memory.learningMode",
  "memory.maintenanceEnabled",
  "memory.maxCards",
  "memory.maxRenderedChars",
  "memory.processor.provider",
  "memory.processor.modelId",
  "memory.processor.thinkingLevel",
  "memory.processor.credentialProfileId",
  "memory.maxCallsPerHour",
  "memory.maxCostPerDayUsd",
  // knowledge-base
  "knowledgeBase.enabled",
  "knowledgeBase.path",
  "knowledgeBase.effectivePath",
  // naming
  "sessionNaming.enabled",
  "sessionNaming.provider",
  "sessionNaming.modelId",
  "sessionNaming.thinkingLevel",
  "sessionNaming.credentialProfileId",
  // refinement
  "promptRefinement.provider",
  "promptRefinement.modelId",
  "promptRefinement.thinkingLevel",
  "promptRefinement.credentialProfileId",
  // dictation
  "speechToText.enabled",
  "speechToText.modelId",
  "speechToText.numThreads",
  "speechToText.idleShutdownSeconds",
  "speechToText.maxUtteranceSeconds",
  "speechToText.vocabulary",
  // worktrees
  "worktrees.root",
  "projectsRoot",
  "worktrees.namingAgent.provider",
  "worktrees.namingAgent.modelId",
  "worktrees.namingAgent.thinkingLevel",
  "worktrees.namingAgent.credentialProfileId",
  "worktrees.mergeAgent.provider",
  "worktrees.mergeAgent.modelId",
  "worktrees.mergeAgent.thinkingLevel",
  "worktrees.mergeAgent.credentialProfileId",
  "worktrees.defaultMergeStrategy",
  "worktrees.remoteFetchMinutes",
  // skills
  "skills",
  // peer-runtimes
  "peerSpawnRuntimes",
  "sessionPeerPromptMaxHops",
  // background-processes
  "backgroundWork.enabled",
  "backgroundWork.ownerSessionCap",
  "backgroundWork.taskLifetimeMinutes",
  "backgroundWork.claudeEmptyHostGraceSeconds",
  // commit
  "commitAgent.provider",
  "commitAgent.modelId",
  "commitAgent.thinkingLevel",
  "commitAgent.credentialProfileId",
  // pull-request
  "prAgent.provider",
  "prAgent.modelId",
  "prAgent.thinkingLevel",
  "prAgent.credentialProfileId",
  // task-intake
  "taskIntakeAgent.provider",
  "taskIntakeAgent.modelId",
  "taskIntakeAgent.thinkingLevel",
  "taskIntakeAgent.credentialProfileId",
  "taskIntakeAgent.projectId",
  "taskIntakeAgent.additionalInstructions",
  // pdf-conversion
  "pdfConversion.fallbackEnabled",
  "pdfConversion.provider",
  "pdfConversion.modelId",
  "pdfConversion.thinkingLevel",
  "pdfConversion.credentialProfileId",
  "pdfConversion.timeoutMs",
  // browserTools
  "browserTools.headed",
  "browserTools.rawMcpEnabled",
  // google
  "google.enabled",
  "google.connection",
  "google.accountEmail",
  "google.oauthClientConfigured",
  "google.gmailArchiveAuthorized",
  // slack
  "slack.enabled",
  "slack.connection",
  "slack.oauthClientConfigured",
  // jira
  "jira.enabled",
  "jira.atlassianEmail",
  "jira.atlassianToken",
  "jira.jiraHost",
  // confluence
  "confluence.enabled",
  "confluence.confluenceHost",
  "confluence.credentialsAvailable",
  // tempo
  "tempo.enabled",
  "tempo.apiBaseUrl",
  "tempo.connection",
  "tempo.oauthClientConfigured",
  // github
  "github.enabled",
  "github.token",
  "github.defaultOwner",
  "github.packageProxyEnabled",
  // forgejo
  "forgejo.enabled",
  "forgejo.baseUrl",
  "forgejo.token",
  "forgejo.defaultOwner",
  // web-search
  "brave.enabled",
  "brave.apiKey",
  // context7
  "context7.enabled",
  "context7.apiKey",
];

/** Paths no section shows, on purpose, and why. */
export const OMITTED_SETTING_PATHS: Readonly<Record<string, string>> = {
  "slack.userToken":
    "Slack connects through OAuth on the page; there is no manual token entry.",
  "slack.botToken":
    "Slack connects through OAuth on the page; there is no manual token entry.",
  "google.scopes":
    "The OAuth scopes the app requests: a protocol detail, not a setting.",
  "google.redirectUri":
    "The OAuth app's redirect URI: deployment setup, not an end-user setting.",
  "tempo.redirectUri":
    "The OAuth app's redirect URI: deployment setup, not an end-user setting.",
};

export const CLAIMED_SETTING_PATHS: ReadonlySet<string> = new Set([
  ...RENDERED_SETTING_PATHS,
  ...Object.keys(OMITTED_SETTING_PATHS),
]);
