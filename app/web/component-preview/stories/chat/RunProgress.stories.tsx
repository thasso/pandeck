import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RunProgress } from "@assistant/shared/session";
import {
  RunProgressContext,
  RunProgressLine,
  type RunProgressContextValue,
} from "../../../src/components/RunProgressLine.tsx";

export interface RunProgressStoryProps {
  frameWidth: number;
}

/** One running turn per state the line can state, aged from "now". */
function cases(now: number): {
  name: string;
  value: RunProgressContextValue;
  lastBlock?: string;
}[] {
  const base: RunProgress = {
    startedAt: now - 9 * 60_000,
    observedAt: now,
    lastActivityAt: now,
    runningTools: [],
  };
  const none = { peers: 0, background: 0 };
  return [
    {
      name: "Before any progress arrives",
      value: { live: null, queues: none },
    },
    {
      name: "Two tools running",
      value: {
        live: {
          receivedAt: now,
          progress: {
            ...base,
            runningTools: [
              { toolCallId: "a", name: "Bash", startedAt: now - 48_000 },
              { toolCallId: "b", name: "Read", startedAt: now - 2_000 },
            ],
          },
        },
        queues: none,
      },
    },
    {
      name: "Waiting for the model after a tool",
      value: {
        live: {
          receivedAt: now,
          progress: {
            ...base,
            awaitingModelSince: now - 95_000,
            lastModelOutputAt: now - 110_000,
            lastTool: { name: "Edit", state: "completed", at: now - 95_000 },
          },
        },
        queues: { peers: 2, background: 1 },
      },
    },
    {
      name: "Provider retrying",
      value: {
        live: {
          receivedAt: now,
          progress: {
            ...base,
            awaitingModelSince: now - 14 * 60_000,
            retry: { attempt: 4, maxAttempts: 10, status: 529, at: now },
          },
        },
        queues: { peers: 1, background: 0 },
      },
    },
    {
      name: "Answering, output paused",
      lastBlock: "text",
      value: {
        live: {
          receivedAt: now,
          progress: { ...base, lastModelOutputAt: now - 25_000 },
        },
        queues: none,
      },
    },
  ];
}

/**
 * Every state of the running turn's progress line, one per row, as the
 * transcript shows it under the streaming message.
 */
export function RunProgressStory({ frameWidth }: RunProgressStoryProps) {
  // Fixed at mount: the lines age themselves on their own clock.
  const [now] = useState(() => Date.now());
  return (
    <div className="bg-background p-4">
      <div className="flex flex-col gap-3" style={{ width: frameWidth }}>
        {cases(now).map(({ name, value, lastBlock }) => (
          <div key={name} className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">{name}</span>
            <RunProgressContext.Provider value={value}>
              <RunProgressLine fallback="Thinking" lastBlock={lastBlock} />
            </RunProgressContext.Provider>
          </div>
        ))}
      </div>
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "run-progress",
  title: "App/Chat/Run progress",
  component: RunProgressStory,
  parameters: { layout: "fullscreen" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 320, max: 960, step: 1 } },
  },
} satisfies Meta<typeof RunProgressStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStates: Story = { args: { frameWidth: 720 } };

export const Phone: Story = {
  args: { frameWidth: 358 },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
