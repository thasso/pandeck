import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionState } from "@assistant/shared";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";
import { entriesToDisplayMessages } from "@assistant/shared/display";
import { MessageList } from "../../../src/components/MessageList.tsx";
import { Composer } from "../../../src/components/Composer.tsx";
import type { TranscriptViewPrefs } from "../../../src/components/transcriptView.ts";
import type { AssistantActions } from "../../../src/hooks/useAssistant.ts";
import {
  chatModels,
  chatStreams,
  richChatTimeline,
  streamingChatTimeline,
} from "../../fixtures/chat.ts";

const session: SessionState = {
  sessionId: "conversation-preview",
  harness: "claude-sdk",
  agentType: "developer",
  thinkingLevel: "high",
  model: chatModels[0]!,
  canSteer: false,
};
const inertActions = new Proxy(
  {},
  { get: () => () => undefined },
) as AssistantActions;
const noop = () => {};
const appearance = {
  separatorBeforeFinalResponse: true,
  separatorAtTurnEnd: true,
  turnStatsRow: true,
  turnStatsPerRequest: true,
};
let seq = 0;
const envelope = () => {
  seq += 1;
  return {
    id: `conversation-${seq}`,
    seq,
    createdAt: "2026-10-06T12:00:00Z",
    forkable: true as const,
  };
};
const tool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  output: string,
): ClientTimelineEntry[] => [
  {
    ...envelope(),
    type: "message",
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: id, name, input }],
  },
  {
    ...envelope(),
    type: "message",
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: output }],
  },
];

const timeline: ClientTimelineEntry[] = [
  {
    ...envelope(),
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [
      {
        type: "text",
        text: "The session list flickers when a broadcast arrives. Can you find out why and fix it?",
      },
    ],
  },
  {
    ...envelope(),
    type: "message",
    role: "assistant",
    content: [
      {
        type: "thinking",
        text: "A flicker on broadcast usually means a row remounts. Check whether the row key or a handler prop changes identity per render.",
      },
      {
        type: "text",
        text: "I'll start by looking at how the rows are keyed.",
      },
    ],
  },
  ...tool(
    "grep-1",
    "Grep",
    { pattern: "data-list-row-id", path: "app/web/src" },
    "app/web/src/components/SessionRow.tsx:88\napp/web/src/components/SessionInbox.tsx:214",
  ),
  ...tool(
    "read-1",
    "Read",
    { file_path: "app/web/src/components/SessionRow.tsx" },
    "export const SessionRow = memo(function SessionRow({ row, onOpen }) {\n  return <li data-list-row-id={row.id} onClick={() => onOpen(row)}>…</li>;\n});",
  ),
  ...tool(
    "bash-1",
    "Bash",
    {
      command: "pnpm --filter @assistant/web test -- SessionInbox",
      description: "Run the session inbox tests",
    },
    " ✓ SessionInbox.test.tsx (24 tests) 412ms\n\n Test Files  1 passed (1)\n      Tests  24 passed (24)",
  ),
  {
    ...envelope(),
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: [
          "## Cause",
          "",
          "`SessionRow` closes over `row` in its click handler, so the host has to pass a **new** `onOpen` every render and `memo` never holds:",
          "",
          "```tsx",
          "<li data-list-row-id={row.id} onClick={() => onOpen(row)}>",
          "```",
          "",
          "## Fix",
          "",
          "1. Pass the row id instead of the row.",
          "2. Make `onOpen` a stable `useCallback` in `SessionInbox`.",
          "3. Assert the redraw count in `uiLoadScenario.test.ts`.",
          "",
          "| Metric | Before | After |",
          "| --- | ---: | ---: |",
          "| Rows redrawn per broadcast | 48 | 1 |",
          "| Commit time | 31 ms | 4 ms |",
          "",
          "> The other lists already follow this pattern.",
        ].join("\n"),
      },
    ],
  },
  {
    ...envelope(),
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "Great, go ahead." }],
  },
];
const messages = entriesToDisplayMessages(timeline, [], undefined, {
  harness: "claude-sdk",
});

export interface ChatConversationProps {
  frameWidth: number;
  showTools: boolean;
  state?: "conversation" | "streaming" | "long";
}

/** A typical coding turn: thinking, tool calls, Markdown and the composer. */
export function ChatConversation({
  frameWidth,
  showTools,
  state = "conversation",
}: ChatConversationProps) {
  const shownTimeline =
    state === "long"
      ? richChatTimeline
      : state === "streaming"
        ? streamingChatTimeline
        : timeline;
  const shownMessages =
    state === "conversation"
      ? messages
      : entriesToDisplayMessages(
          shownTimeline,
          state === "streaming" ? chatStreams : [],
          undefined,
          {
            harness: "claude-sdk",
          },
        );
  const view: TranscriptViewPrefs = {
    showTools,
    showThinking: true,
    expandTools: false,
    expandThinking: false,
    wrapToolLines: false,
  };
  return (
    <div
      style={{ width: frameWidth, maxWidth: "100%", height: "100dvh" }}
      className="flex flex-col bg-background text-foreground"
    >
      <MessageList
        sessionId={session.sessionId}
        messages={shownMessages}
        timeline={shownTimeline}
        view={view}
        appearance={appearance}
        onOpenSession={noop}
        onOpenBackgroundWork={noop}
        onForkMessage={noop}
        onResendPrompt={noop}
      />
      <div className="shrink-0 px-3 pb-3">
        <Composer
          onSend={noop}
          onAbort={noop}
          streaming={state === "streaming"}
          disabled={false}
          contextInfo={null}
          session={session}
          models={chatModels}
          slashCommands={[]}
          actions={inertActions}
        />
      </div>
    </div>
  );
}

const meta = {
  id: "chat-conversation",
  title: "Chat/Conversation",
  component: ChatConversation,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ChatConversation>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Desktop = {
  args: { frameWidth: 960, showTools: true },
} satisfies Story;
export const DesktopDark = {
  ...Desktop,
  globals: { theme: "dark" },
} satisfies Story;
export const Phone = {
  args: { frameWidth: 390, showTools: true },
  globals: { viewport: { value: "paPhone", isRotated: false } },
} satisfies Story;
export const PhoneDark = {
  ...Phone,
  globals: { theme: "dark", viewport: { value: "paPhone", isRotated: false } },
} satisfies Story;
export const StreamingTurn = {
  args: { frameWidth: 960, showTools: true, state: "streaming" },
} satisfies Story;
export const LongCodeAndTable = {
  args: { frameWidth: 960, showTools: true, state: "long" },
} satisfies Story;
