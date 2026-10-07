/**
 * Wire-level fixtures for the chat cards (`stories/cards/`): approvals, git
 * results, tool cards, background work and workflow runs. Each is the payload
 * the server sends, never a value derived for a component.
 */
import type { BackgroundWorkPromptPresentation } from "@assistant/shared/session";
import type {
  AccountModelOption,
  AgentQuestionRequest,
  AnsweredAgentQuestion,
  ApprovalCard,
  BackgroundWorkItemSummary,
  CommitDisplay,
  DisplayBlock,
  KnowledgeEntryCard,
  PullRequestCard,
  PushDisplay,
  SessionBackgroundActivity,
  SessionListItem,
  TaskStatus,
  TaskSummary,
  TempoWorklogApprovalBody,
  ThinkingLevel,
  WorkflowRunCard,
  WorkflowRunSummary,
  WorktreeProvisionDisplay,
} from "@assistant/shared";

/**
 * The clock every fixture is relative to. Read once at load, because the
 * ledges and background rows tick on the real clock (`useElapsedNow`).
 */
const NOW = Date.now();

function task(
  id: string,
  title: string,
  status: TaskStatus = "todo",
): TaskSummary {
  return {
    id,
    title,
    status,
    source: { createdBy: "user" },
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
  };
}

function approval(
  id: string,
  rest: Omit<ApprovalCard, "renderKind" | "id" | "sessionId" | "createdAt">,
): ApprovalCard {
  return {
    renderKind: "approval",
    id,
    sessionId: "assistant-session",
    createdAt: NOW - 30_000,
    ...rest,
  };
}

export const commits: CommitDisplay[] = [
  {
    entryId: "entry-dry-run",
    status: "dry-run",
    dryRun: true,
    forced: false,
    stagedOnly: true,
    repoRoot: "~/projects/pandeck",
    commitMessage:
      "Add retry backoff to provider calls\n\nBack off exponentially between retries and cap the delay at 30s.",
    blockers: [],
    warnings: ["app/server/src/retry.ts has no test touching the new branch."],
    files: [
      {
        path: "app/server/src/retry.ts",
        status: "modified",
        additions: 42,
        deletions: 7,
        sessionTouched: true,
      },
      {
        path: "app/server/src/retry.test.ts",
        status: "added",
        additions: 88,
        deletions: 0,
        sessionTouched: true,
      },
    ],
    totals: { files: 2, additions: 130, deletions: 7 },
    addressedTasks: [task("742", "Back off between provider retries", "doing")],
    canAcceptDryRun: true,
  },
  {
    status: "committed",
    dryRun: false,
    forced: false,
    repoRoot: "~/projects/pandeck",
    commitHash: "4be1c2d9",
    commitMessage: "Add retry backoff to provider calls",
    blockers: [],
    warnings: [],
    files: Array.from({ length: 11 }, (_, index) => ({
      path: `app/web/src/components/cards/Card${String(index)}.tsx`,
      status: index === 3 ? ("deleted" as const) : ("modified" as const),
      additions: 12 + index,
      deletions: index === 3 ? 40 : 3,
    })),
    totals: { files: 11, additions: 187, deletions: 70 },
  },
  {
    status: "blocked",
    dryRun: false,
    forced: false,
    repoRoot: "~/projects/pandeck",
    blockers: [
      {
        kind: "secret",
        file: ".env.local",
        reason: "looks like it holds credentials",
      },
      { kind: "conflict", reason: "the index has unresolved merge conflicts" },
    ],
    warnings: [],
    files: [{ path: ".env.local", status: "untracked", additions: 3 }],
    totals: { files: 1, additions: 3, deletions: 0 },
  },
  {
    status: "failed",
    dryRun: false,
    forced: true,
    blockers: [],
    warnings: [],
    files: [],
    totals: { files: 0, additions: 0, deletions: 0 },
    error: "pre-commit hook exited with status 1: lint found 3 problems.",
  },
];

export const pushes: PushDisplay[] = [
  {
    status: "pushed",
    repoRoot: "~/projects/pandeck",
    remote: "origin",
    branch: "t742-retry-backoff",
    forced: false,
    setUpstream: true,
    localHead: "4be1c2d9aa01f3c2",
    output:
      "To github.com:acme/pandeck.git\n * [new branch]      t742-retry-backoff -> t742-retry-backoff",
  },
  {
    status: "up-to-date",
    remote: "origin",
    branch: "main",
    forced: false,
    setUpstream: false,
  },
  {
    status: "failed",
    remote: "origin",
    branch: "t742-retry-backoff",
    forced: true,
    setUpstream: false,
    localHead: "5d1e0a9c3b7f11aa",
    expectedRemoteHead: "0c7d5e1f2a3b44cc",
    error: "The remote moved since the lease was taken; nothing was pushed.",
    output: " ! [rejected]        t742-retry-backoff (stale info)",
  },
];

const prBase: PullRequestCard = {
  renderKind: "pullRequest",
  id: "pr_open",
  sessionId: "session-dev",
  status: "open",
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - 60_000,
  provider: "github",
  number: 42,
  url: "https://github.com/acme/pandeck/pull/42",
  title: "Back off between provider retries",
  headBranch: "t742-retry-backoff",
  baseBranch: "main",
  warnings: [],
  worktreeId: "wt-742",
  linkedTask: task("742", "Back off between provider retries", "doing"),
  repositoryCapabilities: {
    defaultBranch: "main",
    mergeMethods: ["squash", "merge", "rebase"],
    defaultMergeMethod: "squash",
    canClose: true,
  },
};

/** A card the provider has not numbered yet. */
const { number: _number, url: _url, ...prUnnumbered } = prBase;

export const pullRequests: PullRequestCard[] = [
  {
    ...prUnnumbered,
    id: "pr_choose",
    status: "choosing-task",
    taskCandidates: [
      task("742", "Back off between provider retries", "doing"),
      task("745", "Surface retry counts in the UI"),
    ],
  },
  { ...prBase, id: "pr_creating", status: "creating" },
  {
    ...prBase,
    ci: { state: "success", total: 6 },
    mergeable: true,
    body: [
      "## Summary\nRetries now back off exponentially, capped at 30s.",
      "## Test plan\n- `pnpm run test`",
    ],
  },
  {
    ...prBase,
    id: "pr_conflict",
    ci: { state: "failure", total: 6 },
    review: { changesRequested: true },
    conflicts: true,
    mergeable: false,
  },
  {
    ...prBase,
    id: "pr_merged",
    status: "merged",
    reused: true,
    warnings: [
      "Existing pull request #42 is merged; no new pull request was created.",
    ],
  },
  {
    ...prUnnumbered,
    id: "pr_failed",
    status: "failed",
    error: "GitHub refused the pull request: no commits between main and t742.",
  },
];

const tempoBody: TempoWorklogApprovalBody = {
  kind: "tempoWorklog",
  items: [
    {
      clientId: "w1",
      action: "create",
      issueKey: "PA-412",
      issueSummary: "Seek bar jumps back after a DRM license renewal",
      date: "2026-10-07",
      startTime: "09:00",
      timeSpentSeconds: 5400,
      duration: "1h 30m",
      activityKey: "development",
      description: "Reproduced and fixed the seek regression.",
    },
    {
      clientId: "w2",
      action: "create",
      issueKey: "PA-418",
      date: "2026-10-07",
      startTime: "11:00",
      timeSpentSeconds: 1800,
      duration: "30m",
      activityKey: "review",
      description: "Reviewed the label change.",
    },
  ],
};

/** One proposal in every lifecycle state, so the badges and footers compare side by side. */
const lifecycle: [ApprovalCard["status"], Partial<ApprovalCard>][] = [
  ["pending", {}],
  ["pending", { autoApproved: true }],
  ["executing", {}],
  ["executed", { resultSummary: "Logged 2 worklogs" }],
  [
    "executed",
    {
      resultSummary: "Logged 1 worklog; 1 failed",
      body: {
        ...tempoBody,
        items: [
          { ...tempoBody.items[0]!, resultWorklogId: "9001" },
          { ...tempoBody.items[1]!, error: "PA-418 is closed for time." },
        ],
      },
    },
  ],
  ["failed", { error: "Tempo rejected the request: token expired." }],
  ["rejected", {}],
  ["superseded", {}],
];

export const approvalLifecycle: ApprovalCard[] = lifecycle.map(
  ([status, patch], index) =>
    approval(`appr_tempo_${String(index)}`, {
      kind: "tempoWorklog",
      status,
      title: "Log 2 hours on Jira",
      summary: "PA-412, PA-418 · Tue 7 Oct",
      body: tempoBody,
      ...patch,
    }),
);

/** Every approval body the GitHub and Jira stories do not already show. */
export const approvalBodies: ApprovalCard[] = [
  approval("appr_pr_create", {
    kind: "githubPullRequest",
    status: "pending",
    title: "Open pull request in acme/pandeck",
    summary: "t742-retry-backoff → main",
    body: {
      kind: "githubPullRequest",
      operation: "create",
      repo: "acme/pandeck",
      title: "Back off between provider retries",
      head: "t742-retry-backoff",
      base: "main",
      draft: true,
      prBody:
        "Retries now back off exponentially, capped at 30s.\n\nCloses #741.",
    },
  }),
  approval("appr_pr_review", {
    kind: "githubPullRequest",
    status: "pending",
    title: "Review acme/pandeck#42",
    body: {
      kind: "githubPullRequest",
      operation: "review",
      repo: "acme/pandeck",
      pullNumber: 42,
      reviewEvent: "REQUEST_CHANGES",
      reviewSummary: "The backoff never resets after a success.",
      inlineComments: [
        {
          path: "app/server/src/retry.ts",
          line: 41,
          body: "Reset the attempt counter here.",
          suggestion: "attempt = 0;",
        },
      ],
    },
  }),
  approval("appr_commit", {
    kind: "commit",
    status: "pending",
    title: "Commit 3 files",
    body: {
      kind: "commit",
      message: "Add retry backoff to provider calls",
      files: ["retry.ts", "retry.test.ts", "config.ts"],
      branch: "t742-retry-backoff",
      insertions: 130,
      deletions: 7,
    },
  }),
  approval("appr_merge", {
    kind: "managedPullRequestMerge",
    status: "pending",
    title: "Merge #201 into main",
    body: {
      kind: "managedPullRequestMerge",
      provider: "forgejo",
      repo: "acme/pandeck",
      worktreeId: "wt-1",
      number: 201,
      url: "https://git.example.com/acme/pandeck/pulls/201",
      title: "Task-588: finish the delivery loop",
      headBranch: "t588-delivery-loop",
      baseBranch: "main",
      defaultBranch: "main",
      headSha: "abcdef1234567890",
      method: "squash",
      supportedMethods: ["squash", "merge"],
      deleteRemoteBranch: true,
      checks: { state: "success", total: 3, finished: true },
      review: { changesRequested: false },
      mergeable: true,
      draft: false,
      linkedTask: { id: "588", title: "Finish the delivery loop" },
    },
  }),
  approval("appr_spawn", {
    kind: "sessionSpawn",
    status: "pending",
    title: "Start 2 sessions",
    body: {
      kind: "sessionSpawn",
      items: [
        {
          rowId: "row_a",
          title: "Reviewer: auth",
          agentType: "assistant",
          prompt: "Review the auth refactor and report findings.",
          responseRequested: true,
          provider: "claude-sdk",
          modelId: "sonnet",
          modelName: "Claude Sonnet",
          credentialProfileId: "claude-default",
          accountName: "Work",
          thinkingLevel: "medium",
        },
        {
          rowId: "row_b",
          title: "Implementer: auth",
          agentType: "developer",
          prompt: "Implement the auth refactor.",
          responseRequested: false,
          provider: "claude-sdk",
          modelId: "opus",
          credentialProfileId: "claude-default",
          thinkingLevel: "high",
          modelWarning:
            "claude-sdk/opus-9 is not available on any enabled account.",
          worktreeId: "wt-1",
          worktreeName: "auth-refactor",
          taskId: "553",
          taskTitle: "Agent-spawned peer sessions",
        },
      ],
    },
  }),
  approval("appr_gmail", {
    kind: "gmailArchive",
    status: "pending",
    title: "Archive 3 emails",
    summary: "3 emails in 3 threads",
    body: {
      kind: "gmailArchive",
      items: [
        "Build failed on main",
        "Your invoice for September",
        "Weekly digest: 14 new issues",
      ].map((subject, index) => ({
        messageId: `m${String(index)}`,
        threadId: `t${String(index)}`,
        sender: ["CI <ci@example.com>", "Billing", "GitHub"][index]!,
        subject,
        gmailUrl: `https://mail.google.com/mail/u/0/#all/t${String(index)}`,
      })),
    },
  }),
  approval("appr_project", {
    kind: "projectCreate",
    status: "executed",
    title: "Create Project Player SDK",
    resultSummary: "Created Project Player SDK",
    body: {
      kind: "projectCreate",
      project: {
        id: "player-sdk",
        name: "Player SDK",
        key: "PSDK",
        description: "The web player SDK and its sample apps.",
        tags: ["sdk", "player"],
      },
      repository: {
        mode: "create",
        provider: "github",
        owner: "acme",
        name: "player-sdk",
        private: true,
      },
      cloneDir: "~/projects/player-sdk",
      resultRepoUrl: "git@github.com:acme/player-sdk.git",
      resultWebUrl: "https://github.com/acme/player-sdk",
    },
  }),
  approval("appr_confluence", {
    kind: "confluencePage",
    status: "pending",
    title: "Update 2 Confluence pages",
    body: {
      kind: "confluencePage",
      items: [
        {
          clientId: "c1",
          operation: "edit",
          pageId: "1001",
          title: "Release checklist",
          spaceKey: "ENG",
          spaceName: "Engineering",
          placement: "replace",
          lossyNodes: ["status macro", "expand"],
          body: "## Release checklist\n\n- [ ] Tag the release\n- [ ] Publish notes",
          labelsAdded: ["release"],
        },
        {
          clientId: "c2",
          operation: "delete",
          pageId: "1002",
          title: "Old onboarding notes",
          spaceKey: "ENG",
        },
      ],
    },
  }),
  approval("appr_secret", {
    kind: "settingsInput",
    status: "pending",
    title: "GitHub needs a personal access token",
    body: {
      kind: "settingsInput",
      path: "github.token",
      label: "Personal access token",
      section: "github",
      mode: "secret",
      wasConfigured: false,
      reason: "The token lets the assistant read pull requests for you.",
    },
  }),
];

type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

/** A completed tool call carrying a card payload. */
function toolBlock(name: string, args: unknown, output: unknown): ToolBlock {
  return {
    kind: "tool",
    toolId: `toolu_${name}`,
    name,
    args,
    output: typeof output === "string" ? output : JSON.stringify(output),
    isError: false,
    done: true,
  };
}

export const knowledgeEntry: KnowledgeEntryCard = {
  path: "projects/pandeck/release-checklist.md",
  title: "Release checklist",
  note: "The steps the release script does not cover: notes, the tag announcement, and the Storybook deploy.",
};

export const taskManageBlock = toolBlock(
  "mcp__pa__task_manage",
  {
    operations: [
      { operation: "create", title: "Surface retry counts in the UI" },
      { operation: "update", id: "742", status: "done", comment: "shipped" },
    ],
  },
  {
    renderKind: "taskManage",
    version: 1,
    changedCount: 2,
    changed: [
      { id: "745", title: "Surface retry counts in the UI", status: "todo" },
      {
        id: "742",
        title: "Back off between provider retries",
        status: "doing",
        statusSuggestion: { to: "done", at: NOW, reason: "tests pass" },
        descriptionEditsApplied: 1,
      },
    ],
    deletedIds: ["700"],
    comments: [{ taskId: "742", body: "shipped", authorKind: "agent" }],
    warnings: ["Task-701 was already archived; nothing changed."],
  },
);

export const worktreeProvisions: WorktreeProvisionDisplay[] = [
  { state: "creating", projectId: "pandeck", branch: "t742-retry-backoff" },
  {
    state: "created",
    projectId: "pandeck",
    branch: "t742-retry-backoff",
    baseBranch: "main",
    worktreeId: "wt-742",
  },
  {
    state: "failed",
    projectId: "pandeck",
    branch: "t742-retry-backoff",
    baseBranch: "main",
    error: "fatal: a branch named 't742-retry-backoff' already exists.",
  },
];

export const workshopHandoffBlock = toolBlock(
  "workshop_draft_handoff",
  {},
  {
    renderKind: "workshopDraftHandoff",
    version: 1,
    title: "Show retry counts on tool cards",
    category: "ui",
    proposalPath: "workshop/proposals/retry-counts.md",
    draftPrompt: "Show the retry count on every tool card that retried.",
    createdAt: "2026-10-07T09:00:00Z",
  },
);

export const questionRequest: AgentQuestionRequest = {
  requestId: "question-1",
  toolCallId: "toolu_ask",
  sessionId: "session-1",
  title: "Deployment check",
  intro: "Two things before I deploy the retry change.",
  questions: [
    {
      id: "runner",
      title: "Which runner should deploy it?",
      style: "single_choice",
      required: true,
      choices: [
        { id: "ci", label: "CI", description: "The release workflow." },
        { id: "local", label: "Local", description: "This machine." },
      ],
      allowTypedAnswer: true,
      defaultChoiceIds: [],
    },
    {
      id: "notes",
      title: "Anything to put in the release notes?",
      style: "textarea",
      required: false,
      allowTypedAnswer: true,
      defaultChoiceIds: [],
    },
  ],
  createdAt: NOW,
};

export const questionBlock = toolBlock(
  "mcp__pa__ask_questions",
  {
    title: questionRequest.title,
    questions: questionRequest.questions.map(({ id, title }) => ({
      id,
      title,
    })),
  },
  "Posted 2 questions to the user in the app's question panel.",
);

export const answeredQuestion: AnsweredAgentQuestion = {
  ...questionRequest,
  response: {
    requestId: questionRequest.requestId,
    status: "submitted",
    submittedAt: NOW,
    answers: [
      {
        questionId: "runner",
        choiceIds: ["ci"],
        text: "",
        disposition: "answered",
      },
      {
        questionId: "notes",
        choiceIds: [],
        text: "Mention the new 30s cap.",
        disposition: "discuss",
      },
    ],
  },
};

const jiraUser = (name: string, email: string) => ({
  accountId: `acc-${name.toLowerCase()}`,
  displayName: name,
  emailAddress: email,
  active: true,
  timeZone: "Europe/Berlin",
});

export const jiraSearchBlock = toolBlock(
  "jira_search_issues",
  { render: true },
  {
    jql: "project = PA AND status != Done ORDER BY updated DESC",
    jiraSearchUrl: "https://acme.atlassian.net/issues/?jql=project%3DPA",
    total: 37,
    returned: 3,
    renderColumns: [
      { id: "key", name: "Key" },
      { id: "summary", name: "Summary" },
      { id: "status", name: "Status" },
      { id: "assignee", name: "Assignee" },
      { id: "labels", name: "Labels" },
      { id: "updated", name: "Updated" },
    ],
    issues: [
      {
        key: "PA-412",
        issueUrl: "https://acme.atlassian.net/browse/PA-412",
        summary: "Seek bar jumps back after a DRM license renewal",
        status: { name: "In Progress", category: "indeterminate" },
        assignee: jiraUser("Alice", "alice@example.com"),
        labels: ["bug", "drm"],
        updated: "2026-10-06T15:20:00Z",
        descriptionMarkdown:
          "After the license renews mid-playback the seek bar snaps back.\n\n**Steps**\n1. Play a Widevine stream\n2. Seek after renewal",
        project: { key: "PA", name: "Player" },
        issueType: { name: "Bug" },
        priority: { name: "High" },
        fields: [
          { id: "customfield_1", name: "Sprint", valueText: "Sprint 42" },
        ],
      },
      {
        key: "PA-418",
        issueUrl: "https://acme.atlassian.net/browse/PA-418",
        summary: "Label the flaky DRM tests",
        status: { name: "To Do", category: "new", colorName: "blue-gray" },
        labels: [],
        updated: "2026-10-05T09:00:00Z",
      },
      {
        key: "PA-399",
        issueUrl: "https://acme.atlassian.net/browse/PA-399",
        summary: "Ship the retry backoff",
        status: { name: "Done", category: "done", colorName: "green" },
        assignee: jiraUser("Bob", "bob@example.com"),
        labels: ["release"],
        updated: "2026-10-01T12:00:00Z",
      },
    ],
  },
);

export const jiraProjectsBlock = toolBlock(
  "jira_lookup",
  { render: true },
  {
    kind: "projects",
    query: "pla",
    total: 2,
    projects: [
      {
        id: "10001",
        key: "PA",
        name: "Player",
        projectUrl: "https://acme.atlassian.net/browse/PA",
        projectTypeKey: "software",
        category: { name: "Streaming" },
        lead: jiraUser("Alice", "alice@example.com"),
        description: "The web player and its SDK.",
        issueTypes: [{ name: "Bug" }, { name: "Story" }, { name: "Task" }],
      },
      { id: "10002", key: "PL", name: "Platform", projectTypeKey: "business" },
    ],
  },
);

export const jiraUsersBlock = toolBlock(
  "jira_lookup",
  { render: true },
  {
    kind: "users",
    query: "a",
    users: [
      jiraUser("Alice", "alice@example.com"),
      { ...jiraUser("Carol", "carol@example.com"), active: false },
    ],
  },
);

export const calendarBlock = toolBlock(
  "google_calendar_list_events",
  { render: true },
  {
    calendarSummary: "Work",
    date: "Tue 7 Oct",
    events: [
      {
        title: "Release review",
        htmlLink: "https://calendar.google.com/event?eid=1",
        localStart: "2026-10-07, 10:00",
        localEnd: "2026-10-07, 10:30",
        duration: "30m",
        location: "Room 4 · https://meet.google.com/abc-defg-hij",
        description:
          "Walk the release checklist.\nhttps://example.com/checklist",
        selfAttendee: { responseStatus: "accepted" },
        meet: { meetingUri: "https://meet.google.com/abc-defg-hij" },
        meetRecords: [
          {
            name: "conferenceRecords/1",
            localStart: "2026-10-07, 10:01",
            localEnd: "2026-10-07, 10:29",
            meetingUri: "https://meet.google.com/abc-defg-hij",
            participants: [
              {
                displayName: "Alice",
                participantSessions: [
                  {
                    localStart: "2026-10-07, 10:01",
                    localEnd: "2026-10-07, 10:29",
                    duration: "28m",
                  },
                ],
              },
            ],
            artifacts: [
              {
                kind: "transcript",
                state: "FILE_GENERATED",
                localStart: "2026-10-07, 10:01",
                localEnd: "2026-10-07, 10:29",
                webViewLink: "https://docs.google.com/document/d/1",
                entryCount: 42,
              },
            ],
          },
        ],
      },
      {
        title: "Focus time",
        localStart: "2026-10-07, 13:00",
        localEnd: "2026-10-07, 15:00",
        selfAttendee: { responseStatus: "tentative" },
      },
    ],
  },
);

export const gmailSearchBlock = toolBlock(
  "google_gmail_read",
  { render: true },
  {
    mode: "search",
    query: "in:inbox newer_than:2d",
    resultSizeEstimate: 2,
    threads: [
      {
        id: "t1",
        subject: "Build failed on main",
        snippet: "The release workflow failed at the Storybook deploy step.",
        unread: true,
        important: true,
        messageCount: 2,
        localLatestDate: "Tue 7 Oct, 09:12",
        gmailUrl: "https://mail.google.com/mail/u/0/#all/t1",
        labels: ["CATEGORY_UPDATES"],
        messages: [{ id: "m1", fromName: "CI", snippet: "Build failed" }],
      },
      {
        id: "t2",
        subject: "Lunch on Thursday?",
        snippet: "Want to try the new place around the corner?",
        unread: false,
        messageCount: 1,
        localLatestDate: "Mon 6 Oct, 17:40",
        latestFrom: "Carol <carol@example.com>",
      },
    ],
  },
);

export const gmailThreadBlock = toolBlock(
  "google_gmail_read",
  { render: true },
  {
    mode: "thread",
    subject: "Build failed on main",
    unread: true,
    messageCount: 2,
    localLatestDate: "Tue 7 Oct, 09:12",
    gmailUrl: "https://mail.google.com/mail/u/0/#all/t1",
    labels: ["INBOX", "CATEGORY_UPDATES", "release"],
    participants: [{ name: "CI" }, { name: "Alice" }],
    messages: [
      {
        id: "m1",
        fromName: "CI",
        localDate: "Tue 7 Oct, 09:02",
        to: "team@example.com",
        unread: true,
        text: "The release workflow failed at the Storybook deploy step.",
      },
      {
        id: "m2",
        fromName: "Alice",
        localDate: "Tue 7 Oct, 09:12",
        text: "Re-running it now.",
        attachments: [{ filename: "deploy.log" }],
      },
    ],
  },
);

export const driveBlock = toolBlock(
  "google_drive_get_file",
  { render: true },
  {
    file: {
      name: "Release checklist",
      webViewLink: "https://docs.google.com/document/d/2",
      localModified: "Mon 6 Oct, 16:00",
      owners: [{ displayName: "Alice" }],
    },
    exportMimeType: "text/plain",
    textCharCount: 180,
    text: "Release checklist\n\n1. Tag the release\n2. Publish the notes\n3. Deploy Storybook",
  },
);

export const backgroundItems: BackgroundWorkItemSummary[] = [
  {
    id: "bgw-build",
    ownerSessionId: "session-dev",
    backend: "host-process",
    kind: "shell",
    label: "pnpm run build",
    command: "cd app/web && pnpm run build",
    state: "running",
    stopState: "none",
    createdAt: NOW - 600_000,
    updatedAt: NOW - 60_000,
    startedAt: NOW - 600_000,
    deadlineAt: NOW + 1_800_000,
    settingsGeneration: 7,
  },
  {
    id: "bgw-watch",
    ownerSessionId: "session-dev",
    backend: "host-process",
    kind: "monitor-command",
    label: "Watch the deploy until every worker confirms the new release",
    command:
      "while true; do\n  curl -fsS https://deploy.example.com/status | jq '.workers[] | .version'\n  sleep 10\ndone",
    state: "running",
    stopState: "none",
    createdAt: NOW - 300_000,
    updatedAt: NOW - 30_000,
    startedAt: NOW - 300_000,
    deadlineAt: NOW + 900_000,
    settingsGeneration: 7,
  },
];

export const backgroundActivity: SessionBackgroundActivity = {
  activeCount: 2,
  shellCount: 1,
  monitorCommandCount: 1,
  monitorWebsocketCount: 0,
  startingCount: 0,
  stoppingCount: 0,
  oldestStartedAt: NOW - 600_000,
};

export const backgroundPrompt: BackgroundWorkPromptPresentation = {
  kind: "background-work",
  omittedCount: 2,
  updates: [
    {
      taskId: "bgw-build",
      label: "Build web bundle",
      description: "Build web bundle",
      command: "cd app/web && pnpm run build",
      status: "completed",
      humanLink: "/background-tasks?task=bgw-build",
    },
    {
      taskId: "bgw-test",
      label: "pnpm run test",
      command: "pnpm run test",
      status: "failed",
      exitCode: 1,
      humanLink: "/background-tasks?task=bgw-test",
    },
    {
      taskId: "bgw-watch",
      label: "Watch the deploy until every worker confirms the new release",
      command: "curl -fsS https://deploy.example.com/status",
      status: "activity",
      outcomeSummary: "3 of 5 workers report the new version.",
      humanLink: "/background-tasks?task=bgw-watch",
    },
    {
      taskId: "bgw-old",
      label: "Long benchmark",
      status: "stopped",
      humanLink: "/background-tasks?task=bgw-old",
    },
    {
      taskId: "bgw-lost",
      label: "Nightly export",
      status: "lost",
      humanLink: "/background-tasks?task=bgw-lost",
    },
  ],
};

/** A coordinator session and the peers it spawned, as the session list carries them. */
export const spawnedSessions: SessionListItem[] = [
  {
    id: "root",
    harness: "claude-sdk",
    agentType: "developer",
    title: "Coordinator",
    createdAt: NOW - 7_200_000,
    updatedAt: NOW - 60_000,
    messageCount: 12,
  },
  ...(
    [
      ["impl", "Implementer: retry backoff", { isStreaming: true }],
      ["review", "Reviewer: retry backoff", { attention: "question" }],
      [
        "docs",
        "Docs: release notes",
        { lastError: { at: NOW - 1_000, message: "Provider overloaded" } },
      ],
    ] as const
  ).map(
    ([id, title, extra]) =>
      ({
        id,
        harness: "claude-sdk",
        agentType: "developer",
        title,
        createdAt: NOW - 3_600_000,
        updatedAt: NOW - 60_000,
        messageCount: 4,
        spawnedBySessionId: "root",
        spawnOwnership: "coordinator",
        ...extra,
      }) as SessionListItem,
  ),
];

export const pendingApprovals: ApprovalCard[] = [
  approval("appr_pending_merge", {
    kind: "managedPullRequestMerge",
    status: "pending",
    title: "Merge #201 into main",
    body: approvalBodies.find((card) => card.id === "appr_merge")!.body,
  }),
  approval("appr_pending_secret", {
    kind: "settingsInput",
    status: "pending",
    title: "GitHub needs a personal access token",
    body: approvalBodies.find((card) => card.id === "appr_secret")!.body,
  }),
];

export const workflowModels: AccountModelOption[] = [
  {
    provider: "claude-sdk",
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high"],
    contextWindow: 200_000,
    credentialProfileId: "acc-1",
    accountName: "Work",
  },
  {
    provider: "claude-sdk",
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    supportedThinkingLevels: ["off"],
    contextWindow: 200_000,
    credentialProfileId: "acc-1",
    accountName: "Work",
  },
];

export const workflowRun: WorkflowRunSummary = {
  id: "7",
  taskId: "742",
  recipeId: "code-delivery",
  recipeVersion: 4,
  branch: "t742-retry-backoff",
  lifecycle: "active",
  limits: { maxIterations: 3, maxReviewPasses: 2 },
  createdAt: NOW - 7_200_000,
  updatedAt: NOW - 60_000,
};

const runtime = (
  provider: string,
  modelId: string,
  thinkingLevel: ThinkingLevel,
  family: string,
) => ({ provider, modelId, thinkingLevel, family });

export const workflowCard: WorkflowRunCard = {
  runId: "7",
  phase: "review",
  activity: "running",
  iterationsUsed: 1,
  workPlan: {
    complexity: "medium",
    implementer: runtime("openai-codex", "gpt-5.6", "high", "gpt"),
    reviewer: runtime("claude-sdk", "sonnet", "medium", "claude"),
    rationale: "One protocol change and its UI; a cross-family review fits.",
  },
  latestAssessment: {
    verdict: "revise",
    headCommit: "abcdef123456",
    stale: false,
    summary: "Close, but the retry path is still unguarded.",
    findings: [
      {
        severity: "major",
        text: "guard the retry path",
        path: "src/retry.ts",
        line: 22,
      },
    ],
    observations: ["the helper name reads oddly"],
  },
  coordinatorSessionId: "coord",
  implementerSessionId: "impl",
  reviewerSessions: [{ sessionId: "review-1", pass: 1 }],
  nextAction: "The reviewer is on pass 2.",
  mergeDecisionReady: false,
  canRebaseAndReview: false,
  canRetry: false,
  canResume: false,
};

export const workflowSessions: SessionListItem[] = [
  ["coord", "Coordinator: retry backoff", false],
  ["impl", "Implementer: retry backoff", false],
  ["review-1", "Reviewer: retry backoff", true],
].map(
  ([id, title, isStreaming]) =>
    ({
      id,
      harness: "claude-sdk",
      agentType: "developer",
      title,
      createdAt: NOW - 3_600_000,
      updatedAt: NOW - 60_000,
      messageCount: 6,
      isStreaming,
    }) as SessionListItem,
);
