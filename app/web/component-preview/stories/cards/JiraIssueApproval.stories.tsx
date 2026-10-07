import { useEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  ApprovalCard as ApprovalCardData,
  JiraIssueApprovalBody,
} from "@assistant/shared";
import { ApprovalCard } from "../../../src/components/ApprovalCard.tsx";

export interface JiraIssueApprovalStoryProps {
  frameWidth: number;
  scenario: "create" | "comment" | "rank" | "executed";
  /** Open the full-ticket dialog on mount, as a reader would after clicking. */
  openPreview: boolean;
}

const description = `## Goal

Let the user read a Jira ticket **before** it is created, the way Jira will render it.

### Acceptance

- [ ] The approval card renders the description as Markdown, not source text
- [ ] A long description is clipped in the card with a fade, never truncated on the wire
- [ ] "Read full ticket" opens the whole proposal at reading size
- [ ] Approve and Reject are available from the dialog too

### Notes

| Surface | Body | Fields |
| --- | --- | --- |
| Card | clipped Markdown | inline chips |
| Dialog | full Markdown | two-column list |

The server keeps converting the same CommonMark source to ADF on execution
(\`jiraMarkdown.ts\`), so what the dialog shows is what Jira stores. Raw HTML
and remote images are the two things Jira cannot take natively; they become a
code block and linked alt text respectively.

\`\`\`ts
const preview = markdownToJiraDocument(item.createDescription);
\`\`\`

> Approving here is the same act as approving on the card: one decision, one
> busy state, one server round trip.
`;

function fixture(scenario: JiraIssueApprovalStoryProps["scenario"]): {
  card: ApprovalCardData;
} {
  const create: JiraIssueApprovalBody["items"][number] = {
    clientId: "new-task",
    issueKey: "",
    operation: "create",
    createProjectKey: "PA",
    createIssueType: "Task",
    createSummary: "Preview Jira tickets in the approval card before creating",
    createDescription: description,
    createParentIssue: "PA-100",
    fieldChanges: [
      { fieldId: "labels", label: "Labels", to: "set ui, jira" },
      { fieldId: "priority", label: "Priority", to: "High" },
      { fieldId: "assignee", label: "Assignee", to: "Alice Example" },
    ],
    linkChanges: [
      {
        op: "add",
        type: "Blocks",
        direction: "outward",
        relationship: "blocks",
        targetIssueKey: "PA-99",
      },
    ],
  };
  const base: ApprovalCardData = {
    renderKind: "approval",
    id: "appr_jira",
    sessionId: "assistant-session",
    kind: "jiraIssue",
    status: "pending",
    title: "Create Jira issue",
    summary: "create PA Task",
    createdAt: Date.now() - 30_000,
    body: {
      kind: "jiraIssue",
      jiraHost: "acme.atlassian.net",
      items: [create],
    },
  };
  if (scenario === "comment")
    return {
      card: {
        ...base,
        title: "Comment on PA-7",
        summary: "comment PA-7",
        body: {
          kind: "jiraIssue",
          jiraHost: "acme.atlassian.net",
          items: [
            {
              clientId: "c1",
              issueKey: "PA-7",
              operation: "comment",
              issueUrl: "https://acme.atlassian.net/browse/PA-7",
              issueSummary: "Attention card layout",
              commentBody:
                "Fixed in `main` — see the *layout notes*.\n\n- badges realigned\n- cluster rows keyboard-reachable",
              fieldChanges: [],
            },
          ],
        },
      },
    };
  if (scenario === "rank")
    return {
      card: {
        ...base,
        status: "executed",
        title: "Rank 3 Jira issues",
        summary: "rank PA-12, PA-10, PA-11 top",
        resultSummary:
          "Applied 1 change(s); 1 failed; order now PA-12 → PA-10 → PA-9 → PA-11",
        body: {
          kind: "jiraIssue",
          jiraHost: "acme.atlassian.net",
          items: [
            {
              clientId: "r1",
              issueKey: "PA-12",
              operation: "rank",
              issueUrl: "https://acme.atlassian.net/browse/PA-12",
              fieldChanges: [],
              rankIssueKeys: ["PA-12", "PA-10", "PA-11"],
              rankPosition: "top",
              rankTargetIssueKey: "PA-9",
              rankScope: { kind: "parent", parentIssueKey: "PA-1" },
              rankSteps: [
                {
                  issueKey: "PA-12",
                  placement: "before",
                  relativeToIssueKey: "PA-9",
                  resultOk: true,
                },
                {
                  issueKey: "PA-10",
                  placement: "after",
                  relativeToIssueKey: "PA-12",
                  resultOk: true,
                },
                {
                  issueKey: "PA-11",
                  placement: "after",
                  relativeToIssueKey: "PA-10",
                  resultOk: false,
                  error: "Jira API returned HTTP 403 (SCHEDULE_ISSUES).",
                },
              ],
              rankResultOrder: ["PA-12", "PA-10", "PA-9", "PA-11"],
              error:
                "Ranking PA-11 after PA-10 failed: Jira API returned HTTP 403 (SCHEDULE_ISSUES). Applied: PA-12, PA-10.",
            },
          ],
        },
      },
    };
  if (scenario === "executed")
    return {
      card: {
        ...base,
        status: "executed",
        resultUrl: "https://acme.atlassian.net/browse/PA-123",
        resultSummary: "Created PA-123",
        body: {
          kind: "jiraIssue",
          jiraHost: "acme.atlassian.net",
          items: [
            {
              ...create,
              resultIssueKey: "PA-123",
              resultIssueUrl: "https://acme.atlassian.net/browse/PA-123",
              warning: "Link to PA-99 was not created: LINK_ISSUES denied.",
            },
          ],
        },
      },
    };
  return { card: base };
}

export function JiraIssueApprovalStory({
  frameWidth,
  scenario,
  openPreview,
}: JiraIssueApprovalStoryProps) {
  const { card } = fixture(scenario);
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openPreview) return;
    const button = [
      ...(hostRef.current?.querySelectorAll("button") ?? []),
    ].find((element) => element.textContent?.trim().startsWith("Read full"));
    button?.click();
  }, [openPreview, scenario]);
  return (
    <div
      ref={hostRef}
      className="bg-background p-4"
      style={{ width: frameWidth }}
    >
      <ApprovalCard approval={card} onResolve={() => {}} />
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "jira-issue-approval",
  title: "Cards/Jira issue approval",
  component: JiraIssueApprovalStory,
  parameters: { layout: "fullscreen" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 360, max: 960, step: 1 } },
    scenario: {
      control: "inline-radio",
      options: ["create", "comment", "rank", "executed"],
    },
    openPreview: { control: "boolean" },
  },
} satisfies Meta<typeof JiraIssueApprovalStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Create: Story = {
  args: { frameWidth: 720, scenario: "create", openPreview: false },
};

export const CreatePreview: Story = {
  args: { frameWidth: 720, scenario: "create", openPreview: true },
};

export const Comment: Story = {
  args: { frameWidth: 720, scenario: "comment", openPreview: false },
};

export const Rank: Story = {
  args: { frameWidth: 720, scenario: "rank", openPreview: false },
};

export const Executed: Story = {
  args: { frameWidth: 720, scenario: "executed", openPreview: false },
};
