import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { FolderKanban, GitBranch, MessageSquare } from "lucide-react";
import {
  SessionInspector,
  TaskInspector,
  WorktreeInspector,
  type ObjectOpeners,
} from "../../../src/components/objectInspectors.tsx";
import {
  Inspector,
  InspectorFacts,
  InspectorSection,
} from "../../../src/components/shell/Inspector.tsx";
import type { SessionRuntimeControl } from "../../../src/components/SessionRuntimeSection.tsx";
import { failed, loading, ready } from "../../../src/lib/loadState.ts";
import { chatModels } from "../../fixtures/chat.ts";
import { attentionFixture } from "../../fixtures/shell.ts";

const noop = () => {};
const openers: ObjectOpeners = {
  onOpenTask: noop,
  onOpenProject: noop,
  onOpenSession: noop,
  onOpenWorktree: noop,
  onOpenKnowledge: noop,
};

/** The right panel's column, at the shell's default panel width. */
function Panel({ children }: { children: ReactNode }) {
  return <div className="flex h-screen w-80 bg-card">{children}</div>;
}

type InspectedObject = "session" | "task" | "worktree";

type RuntimeState =
  | "none"
  | "current"
  | "pending"
  | "coordinator"
  | "accountsLoading"
  | "accountsFailed"
  | "fixedAccount";

/** The Runtime section's control in each state it shows. */
function runtimeControl(
  state: RuntimeState,
): SessionRuntimeControl | undefined {
  if (state === "none") return undefined;
  const accounts: SessionRuntimeControl["accounts"] = {
    targets:
      state === "accountsLoading"
        ? loading()
        : state === "accountsFailed"
          ? failed("The accounts could not be read.")
          : ready([
              { id: "cp-work", name: "Work", enterprise: true },
              { id: "cp-team", name: "Team", enterprise: false },
            ]),
    onOpen: noop,
    nameOf: (id: string) => ({ "cp-work": "Work", "cp-team": "Team" })[id],
  };
  return {
    current: {
      model: chatModels[0],
      thinkingLevel: "medium",
      accountName: "Personal",
    },
    pending:
      state === "pending" || state === "coordinator"
        ? {
            model: { provider: "claude-sdk", id: "opus" },
            thinkingLevel: "high",
            account: { kind: "account", id: "cp-work" },
            setBy: state === "coordinator" ? "coordinator" : "user",
          }
        : undefined,
    models: chatModels,
    modelRefusal: (model) =>
      model.provider === "claude-sdk"
        ? undefined
        : "Another harness: not available yet",
    accounts: state === "fixedAccount" ? undefined : accounts,
    busy: false,
    onChange: noop,
    onReset: noop,
  };
}

/**
 * The production per-object inspectors (`objectInspectors.tsx`) over one
 * wire-level fixture: a coordinator session, its Task and its worktree.
 */
function ObjectInspectorStory({
  object,
  runtime = "none",
}: {
  object: InspectedObject;
  runtime?: RuntimeState;
}) {
  const [fixture] = useState(() => attentionFixture(Date.now()));
  const worktree = fixture.worktrees[0]!;
  // What the coordinator's spawn tree made beyond the checkout it runs in: one
  // it created and handed over, now merged, and one a peer runs in whose pull
  // request has red checks. The inspector lists those two.
  const [treeWorktrees] = useState(() => [
    ...fixture.worktrees,
    {
      ...worktree,
      id: "pa-row-density",
      path: "/work/pa-row-density",
      branch: "pa-row-density",
      sessionIds: [],
      createdBySessionId: "coordinator",
      treeSessionIds: ["coordinator"],
      pullRequest: { status: "merged" as const, number: 312 },
    },
    {
      ...worktree,
      id: "pa-row-spacing",
      path: "/work/pa-row-spacing",
      branch: "pa-row-spacing",
      sessionIds: ["implementer"],
      createdBySessionId: "coordinator",
      treeSessionIds: ["coordinator", "implementer"],
      pullRequest: {
        status: "open" as const,
        number: 315,
        ci: { state: "failure" as const, total: 6 },
      },
    },
  ]);
  const task = fixture.tasks[0]!;
  const session = fixture.sessions[0]!;
  return (
    <Panel>
      {object === "session" ? (
        <SessionInspector
          sessionId={session.id}
          relatedTasks={fixture.tasks}
          model={{
            id: "claude-opus-5-5",
            name: "Opus 5.5",
            provider: "claude",
          }}
          thinkingLevel="medium"
          sessions={fixture.sessions}
          projects={fixture.projects}
          worktree={worktree}
          worktreeStatus={fixture.worktreeStatuses[worktree.id]}
          worktrees={treeWorktrees}
          openers={openers}
          runtime={runtimeControl(runtime)}
        />
      ) : object === "task" ? (
        <TaskInspector
          task={task}
          sessions={fixture.sessions}
          openers={openers}
          onStartSession={noop}
          onArchive={noop}
          onDelete={noop}
        />
      ) : (
        <WorktreeInspector
          worktree={worktree}
          status={fixture.worktreeStatuses[worktree.id]}
          projects={fixture.projects}
          sessions={fixture.sessions}
          openers={openers}
        />
      )}
    </Panel>
  );
}

const meta = {
  title: "App/Shell/Inspector",
  component: ObjectInspectorStory,
  parameters: { layout: "fullscreen" },
  args: { object: "session" },
  argTypes: {
    object: {
      control: "inline-radio",
      options: ["session", "task", "worktree"],
    },
    runtime: {
      control: "select",
      options: [
        "none",
        "current",
        "pending",
        "coordinator",
        "accountsLoading",
        "accountsFailed",
        "fixedAccount",
      ],
    },
  },
} satisfies Meta<typeof ObjectInspectorStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Session: Story = {};

export const SessionDark: Story = { globals: { theme: "dark" } };

/** A started session's Runtime section: what its next turn starts on. */
export const SessionRuntime: Story = { args: { runtime: "current" } };

/** A change pending for the next turn, with Reset. */
export const SessionRuntimePending: Story = { args: { runtime: "pending" } };

export const SessionRuntimePendingDark: Story = {
  args: { runtime: "pending" },
  globals: { theme: "dark" },
};

/** The coordinating session chose the change (`session_control`). */
export const SessionRuntimeByCoordinator: Story = {
  args: { runtime: "coordinator" },
};

export const SessionRuntimeAccountsLoading: Story = {
  args: { runtime: "accountsLoading" },
};

export const SessionRuntimeAccountsFailed: Story = {
  args: { runtime: "accountsFailed" },
};

/** An account that cannot move (an endpoint) shows as text. */
export const SessionRuntimeFixedAccount: Story = {
  args: { runtime: "fixedAccount" },
};

export const Task: Story = { args: { object: "task" } };

export const Worktree: Story = { args: { object: "worktree" } };

export const WorktreeDark: Story = {
  args: { object: "worktree" },
  globals: { theme: "dark" },
};

/** The frame itself: relation groups, a bounded group, facts and actions. */
export const Frame: Story = {
  render: () => (
    <Panel>
      <Inspector
        sectionStorageScope="story:frame"
        actions={[
          {
            key: "start",
            icon: <MessageSquare />,
            label: "Start a new session",
            onRun: noop,
            primary: true,
          },
          {
            key: "busy",
            label: "Refreshing the checkout",
            busy: true,
            onRun: noop,
          },
          {
            key: "blocked",
            label: "Merge into main",
            disabled: true,
            disabledReason: "Checks are still running",
            onRun: noop,
          },
        ]}
        relations={[
          {
            id: "projects",
            label: "Projects",
            icon: <FolderKanban />,
            items: [
              {
                key: "pd",
                icon: <FolderKanban />,
                title: "Pandeck",
                subtitle: "PD · 4 worktrees",
                onOpen: noop,
                children: [
                  {
                    key: "wt",
                    icon: <GitBranch />,
                    title: "shadcn-ui-port",
                    subtitle: "3 ahead",
                    counters: { additions: 412, deletions: 977 },
                    onOpen: noop,
                  },
                ],
              },
            ],
          },
          {
            id: "sessions",
            label: "Sessions",
            icon: <MessageSquare />,
            summary: "6 sessions",
            maxVisibleItems: 2,
            items: ["Coordinator", "Implementer", "Reviewer", "Shell port"].map(
              (title) => ({
                key: title,
                icon: <MessageSquare />,
                title,
                subtitle: "Updated 2 minutes ago",
                onOpen: noop,
              }),
            ),
          },
        ]}
      >
        <InspectorSection
          id="checkout"
          storageScope="story:frame"
          title="Checkout"
          icon={<GitBranch />}
        >
          <InspectorFacts
            facts={[
              { label: "Branch", value: "shadcn-ui-port", mono: true },
              {
                label: "Path",
                value: "/home/thasso/worktrees/pandeck-shadcn-ui-port",
                mono: true,
                truncate: "start",
              },
              { label: "Base", value: "main" },
            ]}
          />
        </InspectorSection>
      </Inspector>
    </Panel>
  ),
};

export const FrameDark: Story = {
  ...Frame,
  globals: { theme: "dark" },
};

export const Loading: Story = {
  render: () => (
    <Panel>
      <Inspector loading relations={[]} actions={[]} />
    </Panel>
  ),
};

export const Empty: Story = {
  render: () => (
    <Panel>
      <Inspector relations={[]} actions={[]} />
    </Panel>
  ),
};
