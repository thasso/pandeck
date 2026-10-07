import type {
  BackgroundWorkItemSummary,
  CredentialProfileSummary,
  SessionListItem,
} from "@assistant/shared";
import type {
  ClaudeUsageSnapshot,
  OpenAiUsageSnapshot,
} from "@assistant/shared/usage";

const now = Date.now();
const inMinutes = (minutes: number) =>
  new Date(now + minutes * 60_000).toISOString();

export const usageProfiles: CredentialProfileSummary[] = [
  {
    id: "claude-personal",
    name: "Claude personal",
    provider: "claude",
    enabled: true,
    status: "ready",
    createdAt: now - 90 * 86_400_000,
    updatedAt: now,
  },
  {
    id: "openai-work",
    name: "OpenAI work",
    provider: "openai-codex",
    enabled: true,
    status: "ready",
    createdAt: now - 50 * 86_400_000,
    updatedAt: now,
  },
];

const behaviorWindow = {
  requestCount: 82,
  sessionCount: 6,
  behaviors: [],
  topContributors: [
    { name: "Claude Sonnet 4.6", pct: 72, kind: "agent" as const },
    { name: "Review skill", pct: 18, kind: "skill" as const },
  ],
};

export const claudeUsage: ClaudeUsageSnapshot = {
  fetchedAt: now,
  subscriptionType: "max",
  rateLimitsAvailable: true,
  fiveHour: { utilizationPct: 42, resetsAt: inMinutes(170) },
  weekly: { utilizationPct: 93, resetsAt: inMinutes(9_000) },
  limits: [
    {
      kind: "weekly",
      group: "plan",
      percent: 93,
      severity: "critical",
      resetsAt: inMinutes(9_000),
      scope: { modelDisplayName: "Claude Opus 4.1" },
      isActive: true,
    },
  ],
  modelScoped: [
    {
      modelDisplayName: "Claude Opus 4.1",
      utilizationPct: 81,
      resetsAt: inMinutes(9_000),
    },
  ],
  extraUsage: {
    enabled: true,
    monthlyLimit: 10_000,
    usedCredits: 4_425,
    utilizationPct: 44.25,
    currency: "USD",
    decimalPlaces: 2,
  },
  session: { totalCostUsd: 0, totalApiDurationMs: 0, totalDurationMs: 0 },
  behaviors: { day: behaviorWindow, week: behaviorWindow },
};

export const openAiUsage: OpenAiUsageSnapshot = {
  fetchedAt: now,
  available: true,
  unavailableReason: null,
  planType: "plus",
  email: null,
  limitReached: false,
  windows: [
    {
      kind: "five_hour",
      label: null,
      usedPercent: 31,
      windowSeconds: 18_000,
      resetsAt: inMinutes(250),
    },
    {
      kind: "weekly",
      label: null,
      usedPercent: 57,
      windowSeconds: 604_800,
      resetsAt: inMinutes(8_000),
    },
  ],
  credits: {
    hasCredits: true,
    unlimited: false,
    overageLimitReached: false,
    balance: 3,
    approxLocalMessages: 20,
    approxCloudMessages: 5,
  },
  spendControl: {
    reached: false,
    source: "account_limit",
    limit: 100,
    used: 42,
    remaining: 58,
    usedPercent: 42,
    resetsAt: inMinutes(8_000),
  },
  resetCredits: {
    availableCount: 1,
    applicableCount: 1,
    credits: [
      {
        id: "preview-reset-credit",
        status: "available",
        grantedAt: inMinutes(-1_000),
        expiresAt: inMinutes(20_000),
        redeemedAt: null,
        title: "Full reset",
        description: null,
        supportedByPlan: true,
      },
    ],
  },
};

export const backgroundSessions: SessionListItem[] = [
  {
    id: "session-web-tests",
    harness: "pi",
    agentType: "developer",
    title: "Investigate web test failures",
    createdAt: now - 30 * 60_000,
    updatedAt: now - 3 * 60_000,
    messageCount: 12,
  },
];

const workItem = (
  id: string,
  partial: Partial<BackgroundWorkItemSummary>,
): BackgroundWorkItemSummary => ({
  id,
  ownerSessionId: "session-web-tests",
  backend: "host-process",
  kind: "shell",
  label: "Run the web test suite",
  state: "running",
  stopState: "none",
  createdAt: now - 8 * 60_000,
  updatedAt: now - 60_000,
  startedAt: now - 7 * 60_000,
  deadlineAt: now + 25 * 60_000,
  settingsGeneration: 3,
  command: "pnpm --filter @assistant/web test",
  ...partial,
});

export const backgroundWorks: BackgroundWorkItemSummary[] = [
  workItem("work-tests", {}),
  workItem("work-build", {
    label: "Build the browser bundle",
    state: "pending-launch",
    updatedAt: now - 30_000,
    command: "pnpm --filter @assistant/web build",
  }),
  workItem("work-completed", {
    label: "Check formatting",
    state: "completed",
    updatedAt: now - 15 * 60_000,
    terminalAt: now - 14 * 60_000,
    command: "pnpm --filter @assistant/web format:check",
  }),
];

export const longBackgroundWork: BackgroundWorkItemSummary[] = [
  workItem("work-long-label", {
    label:
      "Review all provider usage snapshots, reset-credit expiry states, and background task ownership before release",
    command:
      "pnpm --filter @assistant/web test src/components/UsagePage.test.tsx src/components/UsagePageRedeem.test.tsx src/components/backgroundTasksAnchor.test.tsx",
  }),
];
