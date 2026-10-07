import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionListItem } from "@assistant/shared";
import { ActiveSessionCard } from "../../../src/components/ActiveSessionCard.tsx";
import {
  classifySessionStatus,
  tierForStatus,
  type SessionInboxCard,
} from "../../../src/lib/sessionInbox.ts";
import type { RowDensity } from "../../../src/lib/rowDensity.ts";
import { session } from "../../fixtures/shell.ts";

function inboxCard(item: SessionListItem): SessionInboxCard {
  const status = classifySessionStatus(item);
  return { session: item, status, tier: tierForStatus(status) };
}

/**
 * The most crowded status line a card can have: a coordinator whose fold runs
 * peers and jobs, a peer waiting on the user with a long title, a stalled
 * tree, background work and a failing pull request. What is addressed to the
 * user (the waiting peer, the stall) must stay on the line at every width;
 * the fold toggle and the other signals give way first.
 */
function CrowdedCardStory({
  width,
  density,
}: {
  width: number;
  density: RowDensity;
}) {
  const [now] = useState(() => Date.now());
  const [card] = useState<SessionInboxCard>(() => {
    const asker = inboxCard(
      session(now, "asker", "Review the attention list changes before merge", {
        awaitingInput: true,
        attention: "question",
        spawnedBySessionId: "root",
      }),
    );
    const runner = inboxCard(
      session(now, "runner", "Tighten the session row spacing", {
        isStreaming: true,
        runStartedAt: now - 30_000,
        spawnedBySessionId: "root",
      }),
    );
    const root = inboxCard(
      session(now, "root", "Coordinate the shadcn shell port", {
        agentType: "workflow-coordinator",
        backgroundActivity: {
          activeCount: 2,
          shellCount: 2,
          monitorCommandCount: 0,
          monitorWebsocketCount: 0,
          startingCount: 0,
          stoppingCount: 0,
          oldestStartedAt: now - 90_000,
        },
        pullRequest: {
          status: "open",
          number: 412,
          ci: { state: "failure", total: 9 },
        },
      }),
    );
    return {
      ...root,
      cluster: {
        children: [asker, runner],
        childrenWithSettled: [asker, runner],
        settledCount: 0,
        counts: {
          total: 2,
          working: 1,
          running: 1,
          jobs: 3,
          services: 0,
          waiting: 1,
          failed: 0,
        },
        bubbled: asker,
      },
      stall: { peers: [asker.session], askers: [] },
    };
  });
  return (
    <div className="bg-card p-2" style={{ width }}>
      <ActiveSessionCard
        card={card}
        now={now}
        active={false}
        relations={{
          projectId: "personal-assistant",
          projectName: "Pandeck",
          projectKey: "PA",
        }}
        density={density}
        onOpen={() => {}}
        onSettle={() => {}}
        onRename={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onToggleCluster={() => {}}
      />
    </div>
  );
}

const meta = {
  title: "App/Shell/Session card",
  component: CrowdedCardStory,
  parameters: { layout: "fullscreen" },
  args: { width: 390, density: "comfortable" },
  argTypes: {
    width: { control: { type: "range", min: 220, max: 480, step: 1 } },
    density: { control: "inline-radio", options: ["tight", "comfortable"] },
  },
} satisfies Meta<typeof CrowdedCardStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CrowdedPhone: Story = {
  globals: { viewport: { value: "paPhone", isRotated: false } },
};

export const CrowdedPhoneDark: Story = {
  globals: { theme: "dark", viewport: { value: "paPhone", isRotated: false } },
};

export const CrowdedRail: Story = { args: { width: 256, density: "tight" } };

export const CrowdedMinimumRail: Story = {
  args: { width: 220, density: "tight" },
};
