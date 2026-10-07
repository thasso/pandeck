import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PeerPromptCard, SessionState } from "@assistant/shared";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";
import { entriesToDisplayMessages } from "@assistant/shared/display";
import { MessageList } from "../../../src/components/MessageList.tsx";
import { Composer } from "../../../src/components/Composer.tsx";
import type { TranscriptViewPrefs } from "../../../src/components/transcriptView.ts";
import type { AssistantActions } from "../../../src/hooks/useAssistant.ts";

const view: TranscriptViewPrefs = {
  showTools: false,
  showThinking: false,
  expandTools: false,
  expandThinking: false,
  wrapToolLines: false,
};
const session: SessionState = {
  sessionId: "side-activity-preview",
  harness: "claude-sdk",
  agentType: "developer",
  thinkingLevel: "high",
  canSteer: false,
};
const inertActions = new Proxy(
  {},
  { get: () => () => undefined },
) as AssistantActions;
const models: [] = [];
const slashCommands: [] = [];
const noop = () => {};
const envelope = (seq: number) => ({
  id: `activity-${seq}`,
  seq,
  createdAt: "2026-10-04T12:00:00Z",
  forkable: true as const,
});
const sent: PeerPromptCard = {
  direction: "sent",
  messageKey: "review-request",
  senderTitle: "Implementer",
  recipientTitle: "Sol",
  peerSessionId: "sol-review",
  message:
    "Review the collapse behavior and keyboard interaction.\n\nCheck that peer messages start collapsed and opening a session does not expand the message.",
  responseRequested: true,
  state: "delivered",
};
const received: PeerPromptCard = {
  ...sent,
  direction: "received",
  messageKey: "review-response",
  senderTitle: "Sol",
  recipientTitle: "Implementer",
  message:
    "The collapse behavior looks good.\n\n- Keep the peer link separate from the expand button.\n- Long names must not push the status offscreen.\n\nKeyboard navigation passes.",
  responseRequested: false,
  state: "replied",
};
const timeline: ClientTimelineEntry[] = [
  {
    ...envelope(0),
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [
      {
        type: "text",
        text: "Make peer messages collapsible. Keep the focus on our conversation.",
      },
    ],
  },
  {
    ...envelope(1),
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "I'll ask Sol to review the interaction while I check the mobile layout.",
      },
    ],
  },
  {
    ...envelope(2),
    type: "message",
    role: "assistant",
    content: [
      {
        type: "toolCall",
        toolCallId: "send-review",
        name: "session_send_prompt",
        input: { targetSessionId: "sol-review", prompt: sent.message },
      },
    ],
  },
  {
    ...envelope(3),
    type: "message",
    role: "toolResult",
    toolCallId: "send-review",
    toolName: "session_send_prompt",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          renderKind: "sessionPeerPrompt",
          version: 1,
          card: sent,
        }),
      },
    ],
  },
  {
    ...envelope(4),
    type: "message",
    role: "user",
    origin: {
      kind: "system",
      source: "background-completion",
      presentation: {
        kind: "background-work",
        updates: [
          {
            taskId: "preview-tests",
            label: "Component tests",
            description: "Component tests",
            command: "pnpm --filter @assistant/web test",
            status: "completed",
            exitCode: 0,
            humanLink: "/background-tasks?task=preview-tests",
            outcomeSummary: "Exited with code 0",
          },
        ],
      },
    },
    content: [{ type: "text", text: "Model-only background envelope." }],
  },
  {
    ...envelope(5),
    type: "message",
    role: "user",
    origin: { kind: "agent", agentId: "sol-review" },
    peerPrompt: received,
    content: [{ type: "text", text: "Model-only peer envelope." }],
  },
  {
    ...envelope(6),
    type: "command.result",
    name: "compact",
    card: {
      kind: "compaction",
      id: "compaction-preview",
      compaction: {
        tokensBefore: 62400,
        tokensAfter: 8100,
        summary:
          "The user approved compact side-activity rows.\n\nKeep peer messages, background updates, and visible automation collapsed by default. Preserve human messages, questions, and actionable cards.",
      },
    },
  },
  {
    ...envelope(7),
    type: "message",
    role: "user",
    origin: { kind: "agent", agentId: "post-reload-continuation" },
    content: [
      {
        type: "text",
        text: "Continue checking the chat layout at desktop and mobile widths.\n\nDo not open a pull request before the user reviews the screenshots.",
      },
    ],
  },
  {
    ...envelope(8),
    type: "message",
    role: "assistant",
    content: [
      {
        type: "toolCall",
        toolCallId: "send-failed",
        name: "session_send_prompt",
        input: {
          targetSessionId: "opus-review",
          prompt: "Check the final screenshots.",
        },
      },
    ],
  },
  {
    ...envelope(9),
    type: "message",
    role: "toolResult",
    toolCallId: "send-failed",
    toolName: "session_send_prompt",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          renderKind: "sessionPeerPrompt",
          version: 1,
          card: {
            ...sent,
            messageKey: "failed-review",
            recipientTitle: "Opus",
            peerSessionId: "opus-review",
            message: "Check the final screenshots.",
            state: "failed",
            failureReason: "The recipient session is no longer available.",
          },
        }),
      },
    ],
  },
  {
    ...envelope(10),
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "The rows now stay on one line. Expand any exchange to read it here, or open the other session from its name.\n\nOpus was unavailable, so I'll finish the visual check here.",
      },
    ],
  },
];
const messages = entriesToDisplayMessages(timeline, [], undefined, {
  harness: "claude-sdk",
});

export interface ChatActivityTranscriptProps {
  frameWidth: number;
  expanded: boolean;
}

/** The production transcript and composer, driven by the ordinary wire projection. */
export function ChatActivityTranscript({
  frameWidth,
  expanded,
}: ChatActivityTranscriptProps) {
  const host = useRef<HTMLDivElement>(null);
  const [destination, setDestination] = useState("");
  useEffect(() => {
    // Preview only: show the exact result of the reader opening this row.
    if (expanded)
      host.current
        ?.querySelector<HTMLButtonElement>(
          '[data-message-id="activity-5"] button[aria-expanded="false"]',
        )
        ?.click();
  }, [expanded]);
  return (
    <div
      ref={host}
      style={{
        width: frameWidth,
        maxWidth: "100%",
        height: expanded ? 1150 : 930,
      }}
      className="flex flex-col bg-background text-foreground"
    >
      <header className="shrink-0 border-b border-border px-4 py-3 text-sm font-medium">
        Collapsible chat activity
      </header>
      <MessageList
        sessionId={session.sessionId}
        messages={messages}
        timeline={timeline}
        view={view}
        onOpenSession={setDestination}
        onOpenBackgroundWork={setDestination}
        onForkMessage={noop}
        onResendPrompt={noop}
      />
      {destination ? (
        <p role="status" className="px-4 text-sm text-muted-foreground">
          Preview navigation: {destination}
        </p>
      ) : null}
      <div className="shrink-0 px-3 pb-3">
        <Composer
          onSend={noop}
          onAbort={noop}
          streaming={false}
          disabled={false}
          contextInfo={null}
          session={session}
          models={models}
          slashCommands={slashCommands}
          actions={inertActions}
        />
      </div>
    </div>
  );
}

const meta = {
  id: "chat-activity-transcript",
  title: "Chat/Integrated side activity",
  component: ChatActivityTranscript,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ChatActivityTranscript>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Desktop = {
  args: { frameWidth: 960, expanded: false },
} satisfies Story;
export const Phone = {
  args: { frameWidth: 390, expanded: false },
  parameters: { viewport: { defaultViewport: "mobile1" } },
} satisfies Story;
export const Expanded = {
  args: { frameWidth: 960, expanded: true },
} satisfies Story;
export const NarrowLargeText = {
  args: { frameWidth: 320, expanded: false },
  parameters: { viewport: { defaultViewport: "mobile1" } },
} satisfies Story;
export const PhoneExpanded = {
  args: { frameWidth: 390, expanded: true },
  parameters: { viewport: { defaultViewport: "mobile1" } },
} satisfies Story;
