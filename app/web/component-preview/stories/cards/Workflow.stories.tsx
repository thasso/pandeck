import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { WorkflowRunCard } from "../../../src/components/WorkflowRunCard.tsx";
import { WorkflowRunStartSheet } from "../../../src/components/WorkflowRunStartSheet.tsx";
import { Button } from "../../../src/components/ui/button.tsx";
import { workflowModels } from "../../fixtures/cards.ts";
import {
  workflowReplaySessions,
  workflowReplayStages,
  type WorkflowReplayStage,
} from "../../fixtures/workflowReplay.ts";

const noop = () => {};

/**
 * Run 118's accounts, by credential profile id and name: the replay was taken
 * before the card carried a role's account, so the plan's ids are put back.
 */
const ACCOUNT_NAMES: Record<string, string> = {
  cp_7bd1b212a5394e00: "Claude Private",
  default: "Default OpenAI",
};

function withAccounts(stage: WorkflowReplayStage): WorkflowReplayStage {
  const { workPlan, reviewDecision } = stage.card;
  return {
    ...stage,
    card: {
      ...stage.card,
      ...(workPlan
        ? {
            workPlan: {
              ...workPlan,
              implementer: {
                ...workPlan.implementer,
                credentialProfileId: "cp_7bd1b212a5394e00",
              },
              reviewer: {
                ...workPlan.reviewer,
                credentialProfileId: "default",
              },
            },
          }
        : {}),
      ...(reviewDecision?.fixer
        ? {
            reviewDecision: {
              ...reviewDecision,
              fixer: {
                ...reviewDecision.fixer,
                credentialProfileId: "default",
              },
            },
          }
        : {}),
    },
  };
}

/**
 * The replayed run's stages, plus a cancelled ending: run 118 was never
 * cancelled, so that one is its fix round with the run called off.
 */
const fixRound = workflowReplayStages.find((stage) => stage.key === "fixing")!;
const { activity: _activity, ...stoppedFixRound } = fixRound.card;
const cancelledStage: WorkflowReplayStage = {
  key: "cancelled",
  label: "Cancelled (illustration)",
  run: {
    ...fixRound.run,
    lifecycle: "cancelled",
    endedAt: fixRound.run.updatedAt,
  },
  card: stoppedFixRound,
};
/**
 * Run 118's commit at step 2215, as the commit-check handling treats it. The
 * run happened before that handling existed and only paused there; the check's
 * words are the real ones, the kind and file are what the check now reports
 * with them.
 */
const refused = workflowReplayStages.find((stage) => stage.key === "blocked")!;
const { blockedReason, ...rest } = refused.card;
const refusedCard = { ...rest, canRetry: false };
const refusalReason = (blockedReason?.summary ?? "").replace(
  /^commit phase blocked:\s*/,
  "",
);
const refusalBlockers = [
  {
    kind: "unsafe" as const,
    file: "app/server/src/peerPrompt.ts",
    reason: refusalReason,
  },
];
const commitCheckFixStage: WorkflowReplayStage = {
  key: "commitCheckFix",
  label: "Commit refused: implementer fixing it (illustration)",
  run: { ...refused.run, lifecycle: "active" },
  card: {
    ...refusedCard,
    phase: "implement",
    activity: "running",
    nextAction: "Working: fixing what the commit check found",
  },
  // The refused change came from the fixer, so its fix runs in that session.
  ...(refusedCard.fixerSessionId
    ? { streamingSessionId: refusedCard.fixerSessionId }
    : {}),
};
const commitCheckDecisionStage: WorkflowReplayStage = {
  key: "commitCheckDecision",
  label: "Commit refused again: your decision (illustration)",
  run: {
    ...refused.run,
    lifecycleReason:
      "the commit check refused this change again after two fixes; send it back for a fix, commit anyway, or cancel this run",
  },
  card: {
    ...refusedCard,
    phase: "commit-check-decision",
    activity: "waiting",
    nextAction: "Decision required: your decision on the refused commit",
    commitCheckDecision: {
      blockers: refusalBlockers,
      allowedChoices: ["send-to-implementer", "commit-anyway"],
      autoFixSpent: true,
      ...(refusedCard.fixerSessionId
        ? { changedBySessionId: refusedCard.fixerSessionId }
        : {}),
    },
  },
};
const STAGES = [
  ...workflowReplayStages.flatMap((stage) =>
    stage.key === "blocked"
      ? [commitCheckFixStage, commitCheckDecisionStage]
      : [stage],
  ),
  cancelledStage,
];
const STAGE_KEYS = STAGES.map((stage) => stage.key);

function RunCard({
  stage,
  defaultCollapsed,
}: {
  stage: WorkflowReplayStage;
  defaultCollapsed?: boolean;
}) {
  const sessions = workflowReplaySessions.map((session) => ({
    ...session,
    isStreaming: session.id === stage.streamingSessionId,
  }));
  return (
    <WorkflowRunCard
      // A stage is a different moment of the run: start its card fresh.
      key={stage.key}
      run={stage.run}
      card={withAccounts(stage).card}
      sessions={sessions}
      accountNames={ACCOUNT_NAMES}
      onOpenSession={noop}
      onPause={noop}
      onResume={noop}
      onCancel={noop}
      onDelete={noop}
      onRetry={noop}
      onAnswerCeiling={noop}
      onAnswerCommitCheck={noop}
      onRebaseAndReview={noop}
      onMerge={noop}
      onCleanUp={noop}
      {...(defaultCollapsed ? { defaultCollapsed } : {})}
    />
  );
}

export interface WorkflowStoryProps {
  frameWidth: number;
  stage: string;
}

/** One real run, a stage at a time, with Previous/Next to walk through it. */
export function WorkflowJourneyStory({
  frameWidth,
  stage,
}: WorkflowStoryProps) {
  const [index, setIndex] = useState(() =>
    Math.max(0, STAGE_KEYS.indexOf(stage)),
  );
  const current = STAGES[index]!;
  return (
    <div
      className="flex flex-col gap-3 bg-background p-4"
      style={{ width: frameWidth }}
    >
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous stage"
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next stage"
          disabled={index === STAGES.length - 1}
          onClick={() => setIndex(index + 1)}
        >
          <ChevronRight />
        </Button>
        <span className="text-sm font-medium">
          {index + 1}/{STAGES.length} · {current.label}
        </span>
      </div>
      <RunCard stage={current} />
    </div>
  );
}

/** Every stage of the run, top to bottom. */
export function WorkflowAllStagesStory({ frameWidth }: WorkflowStoryProps) {
  return (
    <div
      className="flex flex-col gap-6 bg-background p-4"
      style={{ width: frameWidth }}
    >
      {STAGES.map((stage, index) => (
        <section key={stage.key} className="flex flex-col gap-1">
          <h2 className="text-sm font-medium text-muted-foreground">
            {index + 1}. {stage.label}
          </h2>
          <RunCard stage={stage} />
        </section>
      ))}
    </div>
  );
}

/**
 * The runs as a Task page lists them: the newest leads, an older finished one
 * starts as one line under it.
 */
export function WorkflowTaskPageStory({
  frameWidth,
  stage,
}: WorkflowStoryProps) {
  const current = STAGES.find((item) => item.key === stage) ?? STAGES[0]!;
  const earlier: WorkflowReplayStage = {
    ...cancelledStage,
    key: "earlier",
    run: {
      ...cancelledStage.run,
      id: "112",
      createdAt: cancelledStage.run.createdAt - 86_400_000,
    },
  };
  return (
    <div className="bg-background px-5 py-6" style={{ width: frameWidth }}>
      <h1 className="mb-4 text-xl font-semibold">
        Show queued peer messages in the composer queue
      </h1>
      <div className="mb-6 flex flex-col gap-3">
        <RunCard stage={current} />
        <RunCard stage={earlier} defaultCollapsed />
      </div>
      <p className="text-sm text-muted-foreground">
        The Task's description follows here.
      </p>
    </div>
  );
}

function WorkflowStory(props: WorkflowStoryProps) {
  // Keyed by the control, so picking a stage there jumps to it.
  return <WorkflowJourneyStory key={props.stage} {...props} />;
}

const meta = {
  excludeStories: /.*Story$/,
  id: "workflow-run",
  title: "App/Cards/Workflow run",
  component: WorkflowStory,
  parameters: { layout: "fullscreen" },
  args: { frameWidth: 720, stage: "planning" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 320, max: 960, step: 1 } },
    stage: { control: "select", options: STAGE_KEYS },
  },
} satisfies Meta<typeof WorkflowStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Journey: Story = {};
export const JourneyDark: Story = { globals: { theme: "dark" } };
export const JourneyPhone: Story = { args: { frameWidth: 375 } };
export const AllStages: Story = {
  render: (args) => <WorkflowAllStagesStory {...args} />,
};
export const AllStagesDark: Story = {
  render: (args) => <WorkflowAllStagesStory {...args} />,
  globals: { theme: "dark" },
};
export const OnTaskPage: Story = {
  args: { stage: "ceiling" },
  render: (args) => <WorkflowTaskPageStory {...args} />,
};
export const Start: Story = {
  render: () => (
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
  ),
};
