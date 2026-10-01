import type { ReactElement } from "react";
import {
  AllStates,
  AllStatesDark,
  AllStatesPhone,
  AttentionMix,
  Sessions,
  WorkflowRuns,
  DarkLargeText,
  MinimumRail,
  Phone,
  PhoneDarkLargeText,
  PhoneQuietList,
  SessionInboxStory,
  type SessionInboxStoryProps,
} from "./stories/SessionInbox.stories.tsx";
import {
  Comment as JiraComment,
  Create as JiraCreate,
  CreatePreview as JiraCreatePreview,
  Executed as JiraExecuted,
  JiraIssueApprovalStory,
  type JiraIssueApprovalStoryProps,
} from "./stories/JiraIssueApproval.stories.tsx";
import {
  AllCards as GithubAllCards,
  GithubApprovalStory,
} from "./stories/GithubApproval.stories.tsx";
import {
  ApprovalSessionGrantStory,
  Lifecycle as GrantLifecycle,
} from "./stories/ApprovalSessionGrant.stories.tsx";
import {
  Paused as QueuePaused,
  Phone as QueuePhone,
  PromptQueueStory,
  Running as QueueRunning,
  type PromptQueueStoryProps,
} from "./stories/PromptQueue.stories.tsx";
import type { StoryPreviewId } from "./storyCatalog.ts";

function argsOf(story: {
  args?: Partial<SessionInboxStoryProps>;
}): SessionInboxStoryProps {
  const frameWidth = story.args?.frameWidth;
  const density = story.args?.density;
  const scenario = story.args?.scenario;
  if (frameWidth === undefined || density === undefined || !scenario)
    throw new Error(
      "The chat story requires frameWidth, density and scenario args.",
    );
  return { frameWidth, density, scenario };
}

function jiraArgsOf(story: {
  args?: Partial<JiraIssueApprovalStoryProps>;
}): JiraIssueApprovalStoryProps {
  const { frameWidth, scenario, openPreview } = story.args ?? {};
  if (frameWidth === undefined || !scenario || openPreview === undefined)
    throw new Error(
      "The chat story requires frameWidth, scenario and openPreview args.",
    );
  return { frameWidth, scenario, openPreview };
}

function queueArgsOf(story: {
  args?: Partial<PromptQueueStoryProps>;
}): PromptQueueStoryProps {
  const { frameWidth, scenario } = story.args ?? {};
  if (frameWidth === undefined || !scenario)
    throw new Error("The chat story requires frameWidth and scenario args.");
  return { frameWidth, scenario };
}

const storyRenderers: Record<StoryPreviewId, () => ReactElement> = {
  "prompt-queue--running": () => (
    <PromptQueueStory {...queueArgsOf(QueueRunning)} />
  ),
  "prompt-queue--paused": () => (
    <PromptQueueStory {...queueArgsOf(QueuePaused)} />
  ),
  "prompt-queue--phone": () => (
    <PromptQueueStory {...queueArgsOf(QueuePhone)} />
  ),
  "session-inbox--attention-mix": () => (
    <SessionInboxStory {...argsOf(AttentionMix)} />
  ),
  "session-inbox--minimum-rail": () => (
    <SessionInboxStory {...argsOf(MinimumRail)} />
  ),
  "session-inbox--phone": () => <SessionInboxStory {...argsOf(Phone)} />,
  "session-inbox--dark-large-text": () => (
    <SessionInboxStory {...argsOf(DarkLargeText)} />
  ),
  "session-inbox--phone-dark-large-text": () => (
    <SessionInboxStory {...argsOf(PhoneDarkLargeText)} />
  ),
  "session-inbox--phone-quiet-list": () => (
    <SessionInboxStory {...argsOf(PhoneQuietList)} />
  ),
  "session-inbox--all-states": () => (
    <SessionInboxStory {...argsOf(AllStates)} />
  ),
  "session-inbox--sessions": () => <SessionInboxStory {...argsOf(Sessions)} />,
  "session-inbox--workflow-runs": () => (
    <SessionInboxStory {...argsOf(WorkflowRuns)} />
  ),
  "session-inbox--all-states-dark": () => (
    <SessionInboxStory {...argsOf(AllStatesDark)} />
  ),
  "session-inbox--all-states-phone": () => (
    <SessionInboxStory {...argsOf(AllStatesPhone)} />
  ),
  "jira-issue-approval--create": () => (
    <JiraIssueApprovalStory {...jiraArgsOf(JiraCreate)} />
  ),
  "jira-issue-approval--create-preview": () => (
    <JiraIssueApprovalStory {...jiraArgsOf(JiraCreatePreview)} />
  ),
  "jira-issue-approval--comment": () => (
    <JiraIssueApprovalStory {...jiraArgsOf(JiraComment)} />
  ),
  "jira-issue-approval--executed": () => (
    <JiraIssueApprovalStory {...jiraArgsOf(JiraExecuted)} />
  ),
  "github-approval--all-cards": () => (
    <GithubApprovalStory frameWidth={GithubAllCards.args.frameWidth} />
  ),
  "approval-session-grant--lifecycle": () => (
    <ApprovalSessionGrantStory frameWidth={GrantLifecycle.args.frameWidth} />
  ),
};

export function renderStory(storyId: StoryPreviewId): ReactElement {
  return storyRenderers[storyId]();
}
