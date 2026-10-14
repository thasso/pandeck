import {
  DEFAULT_BACKGROUND_WORK_SETTINGS,
  type AccountModelOption,
  type AppSettings,
  type CredentialProfileSummary,
  type EntryLibraryList,
} from "@assistant/shared";
import type { UseMemory } from "../../src/hooks/useMemory.ts";
import type { Prefs } from "../../src/hooks/usePrefs.ts";
import { DEFAULT_NAV_SLOTS } from "../../src/hooks/useSidebarSection.ts";
import { ALL_PROJECT_FILTER } from "../../src/lib/backlogTreeModel.ts";
import { ready } from "../../src/lib/loadState.ts";

export const settingsProfiles: CredentialProfileSummary[] = [
  {
    id: "claude-default",
    name: "Claude personal",
    provider: "claude",
    enabled: true,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "default",
    name: "OpenAI work",
    provider: "openai-codex",
    enabled: true,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
  },
];
export const settingsModels: AccountModelOption[] = [
  {
    provider: "claude-sdk",
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    contextWindow: 200_000,
    credentialProfileId: "claude-default",
    accountName: "Claude personal",
  },
  {
    provider: "openai-codex",
    id: "gpt-5.4",
    name: "GPT-5.4",
    reasoning: true,
    contextWindow: 272_000,
    credentialProfileId: "default",
    accountName: "OpenAI work",
  },
];
const agent = {
  provider: "claude-sdk",
  modelId: "claude-sonnet-4-6",
  thinkingLevel: "medium" as const,
  credentialProfileId: "claude-default",
};
export const settingsFixture: AppSettings = {
  models: { hidden: [], order: [] },
  permanentAssistant: {
    ...agent,
    name: "Personal Assistant",
    additionalInstructions:
      "Keep technical answers concise and ask before changing external systems.",
  },
  sessionNaming: { ...agent, enabled: true },
  commitAgent: agent,
  prAgent: agent,
  sessionStatus: { ...agent, thinkingLevel: "high" },
  promptRefinement: agent,
  pdfConversion: { ...agent, fallbackEnabled: true, timeoutMs: 120_000 },
  speechToText: {
    enabled: true,
    modelId: "parakeet",
    numThreads: 4,
    idleShutdownSeconds: 300,
    maxUtteranceSeconds: 120,
    vocabulary: [
      { from: "forge joe", to: "Forgejo" },
      { from: "pan deck", to: "Pandeck" },
    ],
  },
  taskIntakeAgent: {
    ...agent,
    projectId: "",
    additionalInstructions: "Preserve unresolved questions in the description.",
  },
  browserTools: { headed: false, rawMcpEnabled: false },
  backgroundWork: DEFAULT_BACKGROUND_WORK_SETTINGS,
  jira: {
    enabled: true,
    jiraHost: "example.atlassian.net",
    atlassianEmail: "alex@example.com",
    atlassianTokenConfigured: true,
  },
  confluence: {
    enabled: true,
    confluenceHost: "example.atlassian.net",
    credentialsAvailable: true,
  },
  tempo: {
    enabled: true,
    apiBaseUrl: "https://api.tempo.io/4",
    redirectUri: "https://assistant.example.com/api/tempo/oauth/callback",
    oauthClientConfigured: true,
    refreshTokenConfigured: true,
    authorAccountId: "preview-user",
  },
  google: {
    enabled: true,
    redirectUri: "https://assistant.example.com/api/google/oauth/callback",
    accountEmail: "alex@example.com",
    scopes: [],
    oauthClientConfigured: true,
    refreshTokenConfigured: true,
    gmailArchiveAuthorized: true,
  },
  slack: {
    enabled: true,
    oauthClientConfigured: true,
    userTokenConfigured: true,
    botTokenConfigured: true,
    connected: true,
  },
  openAiCompatible: {
    enabled: true,
    name: "Local inference",
    baseUrl: "https://models.example.com/v1",
    apiKeyConfigured: false,
    thinkingFormat: "qwen-chat-template",
    models: [
      {
        id: "qwen3",
        name: "Qwen 3",
        input: ["text"],
        reasoning: true,
        contextWindow: 131_072,
        maxTokens: 8192,
      },
    ],
  },
  brave: { enabled: true, apiKeyConfigured: true },
  context7: { enabled: true, apiKeyConfigured: true },
  github: {
    enabled: true,
    tokenConfigured: true,
    defaultOwner: "example",
    packageProxyEnabled: true,
  },
  forgejo: {
    enabled: true,
    tokenConfigured: true,
    baseUrl: "https://git.example.com",
    defaultOwner: "example",
  },
  claudeSdk: { enabled: true },
  worktrees: {
    root: "~/worktrees",
    namingAgent: agent,
    mergeAgent: agent,
    defaultMergeStrategy: "squash",
    remoteFetchMinutes: 5,
  },
  projectsRoot: "~/projects",
  memory: {
    loadingEnabled: true,
    learningMode: "off",
    maintenanceEnabled: true,
    maxCards: 8,
    maxRenderedChars: 4000,
    processor: agent,
    maxCallsPerHour: 12,
    maxCostPerDayUsd: 2,
  },
  peerSpawnRuntimes: [
    {
      ...agent,
      id: "reviewer",
      enabled: true,
      relativeCost: "medium",
      name: "Focused reviewer",
      description: "Review TypeScript and browser interaction changes.",
    },
  ],
  sessionPeerPromptMaxHops: 10,
  skills: {},
  appearance: {
    separatorBeforeFinalResponse: true,
    separatorAtTurnEnd: false,
    turnStatsRow: true,
    turnStatsPerRequest: false,
  },
  profile: {
    displayName: "Alex",
    timeZone: "Europe/Berlin",
    effectiveTimeZone: "Europe/Berlin",
  },
  knowledgeBase: {
    enabled: true,
    path: "",
    effectivePath: "/home/alex/assistant/knowledge",
  },
};
export const settingsPrefs: Prefs = {
  theme: "light",
  textScale: 100,
  showThinking: false,
  showTools: true,
  expandThinking: false,
  expandTools: false,
  wrapToolLines: false,
  sidebarWidth: 256,
  navSlots: [...DEFAULT_NAV_SLOTS],
  taskDrawerWidth: 320,
  backlogMasterWidth: 360,
  animateLeftSidebar: true,
  animateRightDrawer: true,
  animateListChanges: true,
  backlogStatusFilter: ["todo", "doing", "done"],
  backlogView: "backlog",
  backlogViewMode: "normal",
  backlogProjectFilter: ALL_PROJECT_FILTER,
  worktreeChangesRailWidth: 300,
  worktreeChangesRailCollapsed: false,
  worktreeNavigatorViewMode: "tree",
  diffStyle: "unified",
  diffWordLevel: true,
  diffIgnoreWhitespace: true,
  diffWrap: false,
  diffExpandContext: false,
};
export const settingsMemory: UseMemory = {
  list: ready({ cards: [], total: 0, hasMore: false }),
  filter: { states: ["active"] },
  lineageById: {},
  loadsBySession: {},
  processorStatus: { configured: true },
  setFilter: () => {},
  refresh: () => {},
  mutate: async () => ({ ok: false, error: "not-found" }),
  openLineage: () => {},
  clearLineage: () => {},
  fetchLoads: () => {},
  fetchStatus: () => {},
};
export const settingsSkills: EntryLibraryList = {
  libraryPath: "/home/alex/assistant/skills",
  entries: [],
  diagnostics: [],
};

/** Two runnable agents and one whose model no longer resolves. */
export const settingsAgents: EntryLibraryList = {
  libraryPath: "/home/alex/assistant/agents",
  entries: [
    {
      name: "test-reviewer",
      description:
        "Checks that every new test fails without the change it tests.",
      path: "test-reviewer/AGENT.md",
    },
    {
      name: "release-scribe",
      description: "Drafts release notes from merged pull requests.",
      path: "release-scribe/AGENT.md",
    },
    {
      name: "legacy-auditor",
      description: "Audits a dependency upgrade.",
      path: "legacy-auditor/AGENT.md",
    },
  ],
  diagnostics: [
    {
      code: "invalid-field",
      folder: "half-written",
      path: "half-written/AGENT.md",
      declaredName: "half-written",
      error: 'persona must be "developer" or "assistant".',
    },
  ],
  agentRuntimes: {
    "test-reviewer": {
      persona: "developer",
      provider: "claude-sdk",
      modelId: "opus",
      pinnedModel: "claude-opus-5-5",
      thinkingLevel: "high",
    },
    "release-scribe": {
      persona: "assistant",
      provider: "openai-codex",
      modelId: "gpt-6.1-sol",
      thinkingLevel: "medium",
    },
    "legacy-auditor": {
      problem:
        'Agent "legacy-auditor" cannot run: No enabled account offers a model "gemini".',
    },
  },
};
