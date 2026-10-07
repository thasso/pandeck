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

/**
 * The production per-object inspectors (`objectInspectors.tsx`) over one
 * wire-level fixture: a coordinator session, its Task and its worktree.
 */
function ObjectInspectorStory({ object }: { object: InspectedObject }) {
  const [fixture] = useState(() => attentionFixture(Date.now()));
  const worktree = fixture.worktrees[0]!;
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
          openers={openers}
          onSettle={noop}
          onRename={noop}
          onArchive={noop}
          onDelete={noop}
        />
      ) : object === "task" ? (
        <TaskInspector
          task={task}
          tasks={fixture.tasks}
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
          sessionsFresh
          openers={openers}
          onStartSession={noop}
          onMerge={noop}
          onRemove={noop}
        />
      )}
    </Panel>
  );
}

const meta = {
  title: "Shell/Inspector",
  component: ObjectInspectorStory,
  parameters: { layout: "fullscreen" },
  args: { object: "session" },
  argTypes: {
    object: {
      control: "inline-radio",
      options: ["session", "task", "worktree"],
    },
  },
} satisfies Meta<typeof ObjectInspectorStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Session: Story = {};

export const SessionDark: Story = { globals: { theme: "dark" } };

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
