import type { ComponentType, ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentQuestionToolCard } from "../../../src/components/AgentQuestionToolCard.tsx";
import { ApprovalCard } from "../../../src/components/ApprovalCard.tsx";
import { BackgroundWorkPromptCard } from "../../../src/components/BackgroundWorkPromptCard.tsx";
import { CommitCard } from "../../../src/components/CommitCard.tsx";
import { KnowledgeEntryToolCard } from "../../../src/components/KnowledgeEntryToolCard.tsx";
import { KnowledgeOpenTargetsProvider } from "../../../src/components/KnowledgeOpenTargets.tsx";
import { Markdown } from "../../../src/components/Markdown.tsx";
import { PullRequestCard } from "../../../src/components/PullRequestCard.tsx";
import { PushCard } from "../../../src/components/PushCard.tsx";
import { ServedFileCard } from "../../../src/components/ServedFileCard.tsx";
import { TaskManageToolCard } from "../../../src/components/TaskManageToolCard.tsx";
import { WorkflowRunCard } from "../../../src/components/WorkflowRunCard.tsx";
import { WorktreeProvisionCard } from "../../../src/components/WorktreeProvisionCard.tsx";
import {
  approvalLifecycle,
  backgroundPrompt,
  commits,
  knowledgeEntry,
  pullRequests,
  pushes,
  questionBlock,
  questionRequest,
  taskManageBlock,
  workflowCard,
  workflowRun,
  workflowSessions,
  worktreeProvisions,
} from "../../fixtures/cards.ts";
import { BackgroundWorkStory } from "./BackgroundWork.stories.tsx";
import { MarkdownFileStory } from "../worktree/MarkdownFile.stories.tsx";
import * as SettingsStories from "../settings/SettingsPage.stories.tsx";
import * as UsageStories from "../settings/UsageAndBackground.stories.tsx";
import * as MemoryStories from "../settings/MemoryAndSkills.stories.tsx";
import * as PullRequestStories from "../worktree/PullRequests.stories.tsx";
import * as TaskPageStories from "../tasks/TaskManagementPage.stories.tsx";

/**
 * Every place a card shows up in the app, each in the frame it really sits in,
 * with real content around it — so a card's look can be judged where it lives,
 * not in a gallery of card types.
 */
type Location =
  | "transcript"
  | "document"
  | "inspector"
  | "settings"
  | "memory"
  | "usage"
  | "pull-request"
  | "task";

export interface CardLocationsStoryProps {
  location: Location;
  /** Storybook's globals (theme, text scale), for stories that read them. */
  globals?: Record<string, unknown>;
}

const noop = () => {};
const knowledgeTargets = { openInPanel: noop, openInMain: noop };

/** An assistant turn's prose, as the transcript renders it. */
function Prose({ children }: { children: string }) {
  return (
    <div data-role="assistant">
      <Markdown text={children} />
    </div>
  );
}

/** One user prompt, right-aligned like the transcript's own bubble. */
function UserPrompt({ children }: { children: ReactNode }) {
  return (
    <div data-role="user" className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2 text-sm">
        {children}
      </div>
    </div>
  );
}

/**
 * The chat column exactly as `MessageList` lays it out (same width, padding
 * and row rhythm), with the cards a developer session produces in one stretch
 * of work.
 */
function TranscriptLocation() {
  return (
    <KnowledgeOpenTargetsProvider targets={knowledgeTargets}>
      <div className="min-h-screen bg-background">
        <div className="mx-auto flex w-full max-w-3xl flex-col px-4 py-6 [&>*]:mt-5 [&>*:first-child]:mt-0 [&>[data-role=assistant]+[data-role=assistant]]:mt-3">
          <UserPrompt>
            The provider retries hammer the API when it is down. Add a backoff
            and open a PR for [Task-742](pa://task/742).
          </UserPrompt>
          <Prose>
            {
              "I'll work in a fresh worktree so `main` stays untouched, and track this on the Task."
            }
          </Prose>
          <div data-role="assistant">
            <WorktreeProvisionCard
              provision={worktreeProvisions.at(-1)!}
              onRetry={noop}
              onOpenWorktree={noop}
            />
          </div>
          <div data-role="assistant">
            <TaskManageToolCard
              block={taskManageBlock}
              onOpenTask={noop}
              onApplyTaskStatusSuggestion={noop}
            />
          </div>
          <Prose>
            {
              "The retry loop lives in `providerClient.ts`. Exponential backoff with jitter, capped at 30 s — and the existing tests now cover the cap."
            }
          </Prose>
          <div data-role="assistant">
            <CommitCard commit={commits[0]!} onAccept={noop} />
          </div>
          <div data-role="assistant">
            <PushCard push={pushes[0]!} />
          </div>
          <div data-role="assistant">
            <PullRequestCard
              pullRequest={pullRequests[0]!}
              sessionWorktreeId="wt-742"
              onChooseTask={noop}
              onAction={noop}
            />
          </div>
          <Prose>
            {
              "Before I merge I need your go-ahead, and one decision about the retry ceiling:"
            }
          </Prose>
          <div data-role="assistant">
            <ApprovalCard approval={approvalLifecycle[0]!} onResolve={noop} />
          </div>
          <div data-role="assistant">
            <AgentQuestionToolCard
              block={questionBlock}
              pendingQuestion={questionRequest}
              onRespond={noop}
            />
          </div>
          <Prose>
            {
              "I wrote down what I learned about the provider's rate limits, and left the load-test report next to it."
            }
          </Prose>
          <div data-role="assistant">
            <KnowledgeEntryToolCard card={knowledgeEntry} />
          </div>
          <div data-role="assistant">
            <ServedFileCard
              file={{
                url: "/api/files/tmp/example/load-test.md",
                label: "Load test report",
                size: 4096,
              }}
            />
          </div>
          <Prose>
            {
              "The review workflow is running on the PR, and the load test is still going in the background."
            }
          </Prose>
          <div data-role="assistant">
            <WorkflowRunCard
              run={workflowRun}
              card={workflowCard}
              sessions={workflowSessions}
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
            />
          </div>
          <div data-role="assistant">
            <BackgroundWorkPromptCard
              presentation={backgroundPrompt}
              onOpenBackgroundWork={noop}
            />
          </div>
        </div>
      </div>
    </KnowledgeOpenTargetsProvider>
  );
}

type StoryContextLike = { globals: Record<string, unknown> };
type RenderFn = (args: object, context: StoryContextLike) => ReactNode;
interface StoryModule {
  default: {
    title?: string;
    component?: unknown;
    args?: object;
    render?: unknown;
  };
  [story: string]: unknown;
}

/**
 * Another story, rendered here as Storybook would: its own `render` (or the
 * file's), else the file's component, with the file's args and its own.
 */
function FromStory({
  stories,
  story,
  globals,
}: {
  stories: StoryModule;
  story: string;
  globals: Record<string, unknown>;
}) {
  const entry = stories[story] as
    { args?: object; render?: unknown } | undefined;
  const args = { ...stories.default.args, ...entry?.args };
  const render = (entry?.render ?? stories.default.render) as
    RenderFn | undefined;
  if (render) return <>{render(args, { globals })}</>;
  const Component = stories.default.component as ComponentType<object>;
  return <Component {...args} />;
}

export function CardLocationsStory({
  location,
  globals = {},
}: CardLocationsStoryProps) {
  switch (location) {
    case "transcript":
      return <TranscriptLocation />;
    case "document":
      // The Markdown file viewer: the Metadata card above the document body.
      return (
        <div className="min-h-screen bg-background">
          <MarkdownFileStory frameWidth={760} />
        </div>
      );
    case "inspector":
      // The right panel's Background work section: one card per item.
      return (
        <div className="min-h-screen bg-background">
          <BackgroundWorkStory
            frameWidth={360}
            surface="inspector"
            open={false}
          />
        </div>
      );
    case "settings":
      return (
        <FromStory stories={SettingsStories} story="About" globals={globals} />
      );
    case "memory":
      return (
        <FromStory
          stories={MemoryStories}
          story="MemoryPopulated"
          globals={globals}
        />
      );
    case "usage":
      return (
        <FromStory
          stories={UsageStories}
          story="BackgroundProcesses"
          globals={globals}
        />
      );
    case "task":
      // The Task page: notice cards (suggestion, Inbox) above the details.
      return (
        <FromStory
          stories={TaskPageStories}
          story="TaskNotices"
          globals={globals}
        />
      );
    case "pull-request":
      return (
        <FromStory
          stories={PullRequestStories}
          story="Detail"
          globals={globals}
        />
      );
  }
}

const meta = {
  excludeStories: /.*Story$/,
  id: "card-locations",
  title: "App/Cards/Card locations",
  component: CardLocationsStory,
  parameters: { layout: "fullscreen" },
  args: { location: "transcript" },
  render: (args, context) => (
    <CardLocationsStory {...args} globals={context.globals} />
  ),
  argTypes: {
    location: {
      control: "inline-radio",
      options: [
        "transcript",
        "document",
        "inspector",
        "settings",
        "memory",
        "usage",
        "pull-request",
        "task",
      ],
    },
  },
} satisfies Meta<typeof CardLocationsStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Transcript: Story = {};
export const TranscriptDark: Story = { globals: { theme: "dark" } };
export const TranscriptPhone: Story = {
  globals: { viewport: { value: "paPhone", isRotated: false } },
};
export const Document: Story = { args: { location: "document" } };
export const DocumentDark: Story = {
  args: { location: "document" },
  globals: { theme: "dark" },
};
export const Inspector: Story = { args: { location: "inspector" } };
export const Settings: Story = { args: { location: "settings" } };
export const Memory: Story = { args: { location: "memory" } };
export const BackgroundProcesses: Story = { args: { location: "usage" } };
export const PullRequestPage: Story = { args: { location: "pull-request" } };
export const TaskPage: Story = { args: { location: "task" } };
export const TaskPageDark: Story = {
  args: { location: "task" },
  globals: { theme: "dark" },
};
