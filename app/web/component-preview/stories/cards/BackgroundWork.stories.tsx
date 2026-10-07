import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionState } from "@assistant/shared";
import { BackgroundWorkLedge } from "../../../src/components/BackgroundWorkLedge.tsx";
import { BackgroundWorkPromptCard } from "../../../src/components/BackgroundWorkPromptCard.tsx";
import { BackgroundWorkSection } from "../../../src/components/BackgroundWorkSection.tsx";
import { Composer } from "../../../src/components/Composer.tsx";
import { PendingApprovalsLedge } from "../../../src/components/PendingApprovalsLedge.tsx";
import { SpawnedSessionsLedge } from "../../../src/components/SpawnedSessionsLedge.tsx";
import type { AssistantActions } from "../../../src/hooks/useAssistant.ts";
import { spawnedSessionsView } from "../../../src/lib/sessionInbox.ts";
import {
  backgroundActivity,
  backgroundItems,
  backgroundPrompt,
  pendingApprovals,
  spawnedSessions,
} from "../../fixtures/cards.ts";

type BackgroundSurface = "ledges" | "prompt-card" | "inspector";

export interface BackgroundWorkStoryProps {
  frameWidth: number;
  surface: BackgroundSurface;
  /** The ledges' lists, opened. */
  open: boolean;
}

const session: SessionState = {
  sessionId: "root",
  harness: "claude-sdk",
  agentType: "developer",
  thinkingLevel: "high",
  canSteer: true,
};

/** Every command a story's composer could issue does nothing. */
const inertActions = new Proxy(
  {},
  { get: () => () => undefined },
) as AssistantActions;

const noop = () => {};
const noStops = new Set<string>();

function ComposerLedges({ open }: { open: boolean }) {
  return (
    <>
      <PendingApprovalsLedge cards={pendingApprovals} onRevealApproval={noop} />
      <SpawnedSessionsLedge
        sessionId="root"
        view={spawnedSessionsView({
          sessions: spawnedSessions,
          coordinatorId: "root",
        })}
        open={open}
        onToggle={noop}
        onOpenSession={noop}
        onToggleSettled={noop}
        onSettleSession={noop}
      />
      <BackgroundWorkLedge
        sessionId="session-dev"
        activity={backgroundActivity}
        items={backgroundItems}
        open={open}
        onToggle={noop}
        stopPending={noStops}
        onStop={noop}
        onStopAll={noop}
        onOpenRegistry={noop}
      />
    </>
  );
}

/** Background work and the composer's resting strips, where the chat shows them. */
export function BackgroundWorkStory({
  frameWidth,
  surface,
  open,
}: BackgroundWorkStoryProps) {
  if (surface === "prompt-card")
    return (
      <div className="bg-background p-4" style={{ width: frameWidth }}>
        <BackgroundWorkPromptCard
          presentation={backgroundPrompt}
          onOpenBackgroundWork={noop}
        />
      </div>
    );
  if (surface === "inspector")
    return (
      <div className="bg-background p-4" style={{ width: frameWidth }}>
        <BackgroundWorkSection
          sessionId="session-dev"
          items={backgroundItems}
          activity={backgroundActivity}
          stopPending={new Set(["bgw-watch"])}
          onStop={noop}
          onStopAll={noop}
          onOpenRegistry={noop}
          protectedTurnWait
        />
      </div>
    );
  return (
    <div className="flex min-h-160 flex-col justify-end bg-background p-4 pt-16">
      <div style={{ width: frameWidth }}>
        <Composer
          onSend={noop}
          onQueue={noop}
          onAbort={noop}
          streaming={false}
          disabled={false}
          contextInfo={null}
          session={session}
          models={[]}
          slashCommands={[]}
          actions={inertActions}
          ledge={<ComposerLedges open={open} />}
        />
      </div>
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "background-work",
  title: "Cards/Background work and ledges",
  component: BackgroundWorkStory,
  parameters: { layout: "fullscreen" },
  args: { frameWidth: 640, surface: "ledges", open: false },
  argTypes: {
    frameWidth: { control: { type: "range", min: 320, max: 960, step: 1 } },
    surface: {
      control: "inline-radio",
      options: ["ledges", "prompt-card", "inspector"],
    },
    open: { control: "boolean" },
  },
} satisfies Meta<typeof BackgroundWorkStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ledges: Story = {};
export const LedgesOpen: Story = { args: { open: true } };
export const LedgesOpenDark: Story = {
  args: { open: true },
  globals: { theme: "dark" },
};
export const LedgesPhone: Story = { args: { frameWidth: 375 } };
export const PromptCard: Story = { args: { surface: "prompt-card" } };
export const PromptCardDark: Story = {
  args: { surface: "prompt-card" },
  globals: { theme: "dark" },
};
export const Inspector: Story = {
  args: { surface: "inspector", frameWidth: 360 },
};
export const InspectorDark: Story = {
  args: { surface: "inspector", frameWidth: 360 },
  globals: { theme: "dark" },
};
