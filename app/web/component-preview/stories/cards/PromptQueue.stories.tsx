import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  PromptQueueState,
  QueuedPeerPrompt,
  SessionState,
} from "@assistant/shared";
import { Composer } from "../../../src/components/Composer.tsx";
import { PromptQueueLedge } from "../../../src/components/PromptQueueLedge.tsx";
import type { AssistantActions } from "../../../src/hooks/useAssistant.ts";

export type PromptQueueScenario = "running" | "paused";

export interface PromptQueueStoryProps {
  frameWidth: number;
  scenario: PromptQueueScenario;
}

const session: SessionState = {
  sessionId: "session-queue",
  harness: "claude-sdk",
  agentType: "developer",
  thinkingLevel: "high",
  canSteer: true,
};

function queueFor(scenario: PromptQueueScenario): PromptQueueState {
  return {
    paused: scenario === "paused",
    items: [
      {
        id: "q1",
        text: "Also add a regression test for the double-remove race.",
        createdAt: Date.now() - 60_000,
      },
      {
        id: "q2",
        text: "Then run the full server test suite.",
        attachments: [
          {
            id: "a1",
            name: "failing-run.log",
            mimeType: "text/plain",
            size: 2048,
          },
        ],
        createdAt: Date.now() - 30_000,
      },
      {
        id: "q3",
        text: "/compact",
        command: { name: "compact", rawArgs: "" },
        createdAt: Date.now() - 10_000,
        ...(scenario === "paused"
          ? { error: "/compact is not available for this session." }
          : {}),
      },
    ],
  };
}

/** What other sessions sent, waiting behind the drafts; one is mid-steer. */
function peersFor(scenario: PromptQueueScenario): QueuedPeerPrompt[] {
  return [
    {
      id: "p1",
      senderTitle: "Review the queue rework",
      senderSessionId: "session-reviewer",
      message:
        "Two findings on the drain: the held queue never yields when its last row is removed, and the steer path skips the busy check.",
      responseRequested: true,
      createdAt: Date.now() - 20_000,
      ...(scenario === "running" ? { sending: true as const } : {}),
    },
    {
      id: "p2",
      senderTitle: "Coordinator",
      senderSessionId: "session-coordinator",
      message: "When you are done, push the branch and report back.",
      responseRequested: false,
      createdAt: Date.now() - 5_000,
    },
  ];
}

/** Every command a story's composer could issue does nothing. */
const inertActions = new Proxy(
  {},
  { get: () => () => undefined },
) as AssistantActions;

/**
 * The composer of a session whose turn is running, with the user's queue on
 * its top edge: the Steer/Queue switch, Stop beside Send, and the ledge rows —
 * the user's drafts, then the peer prompts other sessions sent.
 */
export function PromptQueueStory({
  frameWidth,
  scenario,
}: PromptQueueStoryProps) {
  const running = scenario === "running";
  return (
    <div className="flex h-[420px] flex-col justify-end bg-background p-4">
      <div style={{ width: frameWidth }}>
        <Composer
          onSend={() => {}}
          onQueue={() => {}}
          onAbort={() => {}}
          streaming={running}
          disabled={false}
          contextInfo={null}
          session={session}
          models={[]}
          slashCommands={[]}
          actions={inertActions}
          ledge={
            <PromptQueueLedge
              queue={queueFor(scenario)}
              peers={peersFor(scenario)}
              running={running}
              canSteer
              onEdit={() => {}}
              onRemove={() => {}}
              onMove={() => {}}
              onSendNow={() => {}}
              onClear={() => {}}
              onResume={() => {}}
              onSendPeerNow={() => {}}
              onWithdrawPeer={() => {}}
            />
          }
        />
      </div>
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "prompt-queue",
  title: "App/Cards/Prompt queue",
  component: PromptQueueStory,
  parameters: { layout: "fullscreen" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 360, max: 960, step: 1 } },
    scenario: { control: "radio", options: ["running", "paused"] },
  },
} satisfies Meta<typeof PromptQueueStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {
  args: { frameWidth: 720, scenario: "running" },
};

export const Paused: Story = {
  args: { frameWidth: 720, scenario: "paused" },
};

export const Phone: Story = {
  args: { frameWidth: 358, scenario: "running" },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
