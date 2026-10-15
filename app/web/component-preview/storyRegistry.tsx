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
} from "./stories/shell/SessionInbox.stories.tsx";
import {
  Comment as JiraComment,
  Create as JiraCreate,
  CreatePreview as JiraCreatePreview,
  Executed as JiraExecuted,
  JiraIssueApprovalStory,
  type JiraIssueApprovalStoryProps,
} from "./stories/cards/JiraIssueApproval.stories.tsx";
import {
  AllCards as GithubAllCards,
  GithubApprovalStory,
} from "./stories/cards/GithubApproval.stories.tsx";
import {
  ApprovalSessionGrantStory,
  Lifecycle as GrantLifecycle,
} from "./stories/cards/ApprovalSessionGrant.stories.tsx";
import {
  Paused as QueuePaused,
  Stopped as QueueStopped,
  Phone as QueuePhone,
  PromptQueueStory,
  Running as QueueRunning,
  type PromptQueueStoryProps,
} from "./stories/cards/PromptQueue.stories.tsx";
import {
  AllStates as RunProgressAllStates,
  Phone as RunProgressPhone,
  RunProgressStory,
} from "./stories/chat/RunProgress.stories.tsx";
import {
  ChatActivityStory,
  Desktop as ActivityDesktop,
  Expanded as ActivityExpanded,
  Phone as ActivityPhone,
  PhoneExpanded as ActivityPhoneExpanded,
} from "./stories/cards/ChatActivity.stories.tsx";
import {
  ChatActivityTranscript,
  Desktop as TranscriptDesktop,
  Expanded as TranscriptExpanded,
  Phone as TranscriptPhone,
  PhoneExpanded as TranscriptPhoneExpanded,
  NarrowLargeText as TranscriptNarrowLargeText,
} from "./stories/chat/ChatActivityTranscript.stories.tsx";
import {
  Frontmatter as MarkdownFrontmatter,
  FrontmatterDark as MarkdownFrontmatterDark,
  MarkdownFileStory,
} from "./stories/worktree/MarkdownFile.stories.tsx";
import {
  Browser as PullRequestsBrowser,
  BrowserPhone as PullRequestsBrowserPhone,
  BrowserReal as PullRequestsBrowserReal,
  Detail as PullRequestsDetail,
  DetailMerged as PullRequestsDetailMerged,
  DetailMergedPhone as PullRequestsDetailMergedPhone,
  DetailPhone as PullRequestsDetailPhone,
  DetailReal as PullRequestsDetailReal,
  DetailReview as PullRequestsDetailReview,
  PullRequestStory,
  type PullRequestStoryProps,
} from "./stories/worktree/PullRequests.stories.tsx";
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

const pullRequestStoryDefaults: PullRequestStoryProps = {
  frameWidth: 320,
  surface: "browser",
  browserState: "populated",
  detailState: "open",
};

function pullRequestArgsOf(story: {
  args?: Partial<PullRequestStoryProps>;
}): PullRequestStoryProps {
  return { ...pullRequestStoryDefaults, ...story.args };
}

const storyRenderers: Record<StoryPreviewId, () => ReactElement> = {
  "pull-requests--browser": () => (
    <PullRequestStory {...pullRequestArgsOf(PullRequestsBrowser)} />
  ),
  "pull-requests--browser-real": () => (
    <PullRequestStory {...pullRequestArgsOf(PullRequestsBrowserReal)} />
  ),
  "pull-requests--browser-phone": () => (
    <PullRequestStory {...pullRequestArgsOf(PullRequestsBrowserPhone)} />
  ),
  "pull-requests--detail": () => (
    <PullRequestStory {...pullRequestArgsOf(PullRequestsDetail)} />
  ),
  "pull-requests--detail-review": () => (
    <PullRequestStory {...pullRequestArgsOf(PullRequestsDetailReview)} />
  ),
  "pull-requests--detail-merged": () => (
    <PullRequestStory {...pullRequestArgsOf(PullRequestsDetailMerged)} />
  ),
  "pull-requests--detail-real": () => (
    <PullRequestStory {...pullRequestArgsOf(PullRequestsDetailReal)} />
  ),
  "pull-requests--detail-phone": () => (
    <PullRequestStory {...pullRequestArgsOf(PullRequestsDetailPhone)} />
  ),
  "pull-requests--detail-merged-phone": () => (
    <PullRequestStory {...pullRequestArgsOf(PullRequestsDetailMergedPhone)} />
  ),
  "chat-activity-transcript--narrow-large-text": () => (
    <ChatActivityTranscript {...TranscriptNarrowLargeText.args} />
  ),
  "chat-activity-transcript--desktop": () => (
    <ChatActivityTranscript {...TranscriptDesktop.args} />
  ),
  "chat-activity-transcript--expanded": () => (
    <ChatActivityTranscript {...TranscriptExpanded.args} />
  ),
  "chat-activity-transcript--phone": () => (
    <ChatActivityTranscript {...TranscriptPhone.args} />
  ),
  "chat-activity-transcript--phone-expanded": () => (
    <ChatActivityTranscript {...TranscriptPhoneExpanded.args} />
  ),
  "chat-activity--desktop": () => (
    <ChatActivityStory {...ActivityDesktop.args} />
  ),
  "chat-activity--expanded": () => (
    <ChatActivityStory {...ActivityExpanded.args} />
  ),
  "chat-activity--phone": () => <ChatActivityStory {...ActivityPhone.args} />,
  "chat-activity--phone-expanded": () => (
    <ChatActivityStory {...ActivityPhoneExpanded.args} />
  ),
  "markdown-file--frontmatter": () => (
    <MarkdownFileStory frameWidth={MarkdownFrontmatter.args.frameWidth} />
  ),
  "markdown-file--frontmatter-dark": () => (
    <MarkdownFileStory frameWidth={MarkdownFrontmatterDark.args.frameWidth} />
  ),
  "prompt-queue--running": () => (
    <PromptQueueStory {...queueArgsOf(QueueRunning)} />
  ),
  "prompt-queue--paused": () => (
    <PromptQueueStory {...queueArgsOf(QueuePaused)} />
  ),
  "prompt-queue--stopped": () => (
    <PromptQueueStory {...queueArgsOf(QueueStopped)} />
  ),
  "prompt-queue--phone": () => (
    <PromptQueueStory {...queueArgsOf(QueuePhone)} />
  ),
  "run-progress--all-states": () => (
    <RunProgressStory {...RunProgressAllStates.args} />
  ),
  "run-progress--phone": () => <RunProgressStory {...RunProgressPhone.args} />,
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
