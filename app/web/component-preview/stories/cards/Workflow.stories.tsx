import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WorkflowRunCard as WorkflowRunCardData } from "@assistant/shared";
import { WorkflowRunCard } from "../../../src/components/WorkflowRunCard.tsx";
import { WorkflowRunStartSheet } from "../../../src/components/WorkflowRunStartSheet.tsx";
import {
  workflowCard,
  workflowModels,
  workflowRun,
  workflowSessions,
} from "../../fixtures/cards.ts";

type WorkflowState = "active" | "ceiling" | "merge" | "cancelled" | "start";

export interface WorkflowStoryProps {
  frameWidth: number;
  state: WorkflowState;
}

const noop = () => {};

/** The card once the run is no longer moving. */
const { activity: _activity, ...stoppedCard } = workflowCard;

function cardFor(state: WorkflowState): {
  lifecycle: "active" | "paused" | "completed" | "cancelled";
  card: WorkflowRunCardData;
} {
  switch (state) {
    case "ceiling":
      return {
        lifecycle: "paused",
        card: {
          ...stoppedCard,
          nextAction: "The run wants another review pass.",
          canRetry: true,
          ceilingDecision: {
            blocked: "review-passes",
            wanted: "buy fresh eyes on the fix at abc1234",
            allowedChoices: ["raise", "deliver", "cancel"],
            ceilings: { maxIterations: 3, maxReviewPasses: 2 },
            spent: { iterations: 2, reviewPasses: 2, sessions: 4 },
            headCarriesDiscoveryReview: false,
            suggestedRaise: 2,
          },
        },
      };
    case "merge":
      return {
        lifecycle: "active",
        card: {
          ...stoppedCard,
          phase: "merge",
          mergeDecisionReady: true,
          nextAction: "Waiting for your merge decision.",
          latestAssessment: {
            ...workflowCard.latestAssessment!,
            verdict: "pass",
            findings: [],
          },
          pullRequest: {
            cardId: "pr-42",
            sessionId: "impl",
            number: 42,
            url: "https://github.com/acme/pandeck/pull/42",
            delivery: {
              canMerge: true,
              canCleanUp: false,
              settleStillNeeded: false,
              mergeMethods: ["squash", "merge"],
              defaultMergeMethod: "squash",
            },
          },
        },
      };
    case "cancelled":
      return {
        lifecycle: "cancelled",
        card: {
          ...stoppedCard,
          nextAction: "Cancelled.",
        },
      };
    default:
      return { lifecycle: "active", card: workflowCard };
  }
}

/** A Task's workflow run card in each state, or the start flow that opens one. */
export function WorkflowStory({ frameWidth, state }: WorkflowStoryProps) {
  if (state === "start")
    return (
      <WorkflowRunStartSheet
        task={{ id: "742", title: "Back off between provider retries" }}
        tasks={[]}
        models={workflowModels}
        worktrees={[]}
        storedRuntimes={undefined}
        storedLimits={undefined}
        startStates={{}}
        onStart={noop}
        onRemember={noop}
        onContinueInBackground={noop}
        onClearStart={noop}
        onClose={noop}
      />
    );
  const { lifecycle, card } = cardFor(state);
  return (
    <div className="bg-background p-4" style={{ width: frameWidth }}>
      <WorkflowRunCard
        run={{
          ...workflowRun,
          lifecycle,
          ...(lifecycle === "paused"
            ? { lifecycleReason: "The review-pass ceiling was reached." }
            : {}),
        }}
        card={card}
        sessions={workflowSessions}
        onOpenSession={noop}
        onPause={noop}
        onResume={noop}
        onCancel={noop}
        onDelete={noop}
        onRetry={noop}
        onAnswerCeiling={noop}
        onRebaseAndReview={noop}
        onMerge={noop}
        onCleanUp={noop}
      />
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "workflow-run",
  title: "App/Cards/Workflow run",
  component: WorkflowStory,
  parameters: { layout: "fullscreen" },
  args: { frameWidth: 640, state: "active" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 320, max: 960, step: 1 } },
    state: {
      control: "inline-radio",
      options: ["active", "ceiling", "merge", "cancelled", "start"],
    },
  },
} satisfies Meta<typeof WorkflowStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {};
export const ActiveDark: Story = { globals: { theme: "dark" } };
export const Ceiling: Story = { args: { state: "ceiling" } };
export const CeilingDark: Story = {
  args: { state: "ceiling" },
  globals: { theme: "dark" },
};
export const MergeDecision: Story = { args: { state: "merge" } };
export const Cancelled: Story = { args: { state: "cancelled" } };
export const Start: Story = { args: { state: "start" } };
export const StartDark: Story = {
  args: { state: "start" },
  globals: { theme: "dark" },
};
