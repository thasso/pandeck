import type {
  CredentialProfileSummary,
  ModelOption,
  ProjectRecord,
  SessionState,
  SlashCommandInfo,
  WorktreeRecord,
} from "@assistant/shared";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";
import type { StreamingEntry } from "@assistant/shared/session";
import type { AssistantActions } from "../../src/hooks/useAssistant.ts";

export const noop = () => {};
export const chatActions = new Proxy(
  {},
  { get: () => noop },
) as AssistantActions;
export const chatModels: ModelOption[] = [
  {
    provider: "claude-sdk",
    id: "sonnet",
    name: "Claude Sonnet 4.6",
    contextWindow: 200_000,
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high"],
  },
  {
    provider: "claude-sdk",
    id: "opus",
    name: "Claude Opus 4.6",
    contextWindow: 200_000,
    reasoning: true,
    supportedThinkingLevels: ["low", "medium", "high", "max"],
  },
  {
    provider: "openai-codex",
    id: "gpt-5.4",
    name: "GPT-5.4",
    contextWindow: 272_000,
    reasoning: true,
  },
];
export const chatSession: SessionState = {
  sessionId: "chat-controls-preview",
  harness: "claude-sdk",
  agentType: "developer",
  model: chatModels[0]!,
  thinkingLevel: "high",
  canSteer: true,
};
export const chatCommands: SlashCommandInfo[] = [
  {
    name: "review",
    description: "Start a code review",
    usage: "/review [focus]",
    agentTypes: ["developer", "workshop"],
    execution: "client",
  },
  {
    name: "commit",
    description: "Commit this work",
    usage: "/commit [message]",
    agentTypes: ["developer", "workshop"],
  },
];
export const chatProjects: ProjectRecord[] = [
  {
    id: "pandeck",
    key: "PD",
    name: "Pandeck",
    localPaths: [{ path: "/work/pandeck", kind: "repo" }],
  },
  {
    id: "docs",
    key: "DOC",
    name: "Documentation",
    localPaths: [{ path: "/work/docs", kind: "repo" }],
  },
];
export const chatWorktrees: WorktreeRecord[] = [
  {
    id: "main",
    projectId: "pandeck",
    mainRepoRoot: "/work/pandeck",
    path: "/work/pandeck",
    branch: "main",
    baseBranch: "main",
    baseCommit: "abc123",
    status: "active",
    sessionIds: [],
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
    isMain: true,
  },
  {
    id: "shadcn",
    projectId: "pandeck",
    mainRepoRoot: "/work/pandeck",
    path: "/work/pandeck-shadcn",
    branch: "shadcn-ui-port",
    baseBranch: "main",
    baseCommit: "abc123",
    status: "active",
    sessionIds: [],
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
  },
];
export const chatAccounts: CredentialProfileSummary[] = [
  {
    id: "claude-work",
    name: "Work account",
    provider: "claude",
    enabled: true,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "openai-work",
    name: "OpenAI",
    provider: "openai-codex",
    enabled: true,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
  },
];
const envelope = (seq: number) => ({
  id: `rich-${seq}`,
  seq,
  createdAt: "2026-10-06T12:00:00Z",
  forkable: true as const,
});
export const richChatTimeline: ClientTimelineEntry[] = [
  {
    ...envelope(1),
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [
      {
        type: "text",
        text: "Show the proposed retry helper and the compatibility matrix.",
      },
    ],
  },
  {
    ...envelope(2),
    type: "message",
    role: "assistant",
    usage: {
      inputTokens: 2400,
      outputTokens: 1800,
      cacheReadTokens: 32_000,
      cacheCreationTokens: 4600,
      contextTokens: 39_000,
      contextWindowTokens: 200_000,
      costUSD: 0.12,
    },
    stopReason: "end",
    content: [
      {
        type: "text",
        text: [
          "## Retry helper",
          "",
          "```typescript",
          ...Array.from(
            { length: 28 },
            (_, i) =>
              `const attempt${i + 1} = await request({ timeout: 5000, retryDelay: ${100 * (i + 1)} });`,
          ),
          "```",
          "",
          "| Runtime | Streaming | Tools | Cancellation | Persistent state |",
          "| --- | --- | --- | --- | --- |",
          "| Claude SDK | Yes | Native | Abort signal | Session cache |",
          "| Codex | Yes | Native | Interrupt | Session cache |",
          "| Pi | Yes | Adapter | Abort signal | Timeline |",
        ].join("\n"),
      },
    ],
  },
];
export const streamingChatTimeline: ClientTimelineEntry[] = [
  {
    ...envelope(1),
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [
      { type: "text", text: "Run the chat regressions before committing." },
    ],
  },
];
export const chatStreams: StreamingEntry[] = [
  {
    streamId: "chat-stream",
    kind: "message",
    role: "assistant",
    content: [
      {
        type: "thinking",
        text: "The chat changes touch viewport-gated tool output and keyboard focus. I'll run those tests first.",
      },
      {
        type: "toolCall",
        toolCallId: "running-tests",
        name: "bash",
        input: {
          command: "pnpm exec vitest run Composer MessageList Markdown",
          description: "Run chat regressions",
        },
      },
    ],
  },
  {
    streamId: "tests-tool-stream",
    kind: "tool",
    toolCallId: "running-tests",
    name: "bash",
    input: { command: "pnpm exec vitest run Composer MessageList Markdown" },
    output:
      "RUN v4.1.11\n✓ Composer.test.tsx (40 tests)\nRunning MessageList.test.tsx…",
  },
];
