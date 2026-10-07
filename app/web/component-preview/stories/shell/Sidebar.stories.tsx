import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Sidebar } from "../../../src/components/Sidebar.tsx";
import type { SettingsSection } from "../../../src/hooks/useSessionRouting.ts";
import type { SidebarSection } from "../../../src/hooks/useSidebarSection.ts";
import { ready } from "../../../src/lib/loadState.ts";
import {
  attentionFixture,
  noopActions,
  quietListFixture,
  shellBacklogState,
  shellPrefs,
} from "../../fixtures/shell.ts";

interface SidebarStoryProps {
  scenario: "attention" | "quiet-list";
  section: SidebarSection;
  mobile: boolean;
  width: number;
}

const noop = () => {};

/**
 * The production `Sidebar`: the object browser for the chosen section above the
 * primary navigation bar, fed wire-level session, project and worktree rows.
 * Every handler that would leave the sidebar is a no-op; selection and section
 * changes stay live so the browser can be clicked through.
 */
function SidebarStory({ scenario, section, mobile, width }: SidebarStoryProps) {
  const [now] = useState(() => Date.now());
  const [fixture] = useState(() =>
    scenario === "quiet-list" ? quietListFixture(now) : attentionFixture(now),
  );
  const [currentId, setCurrentId] = useState<string | undefined>(
    fixture.sessions[0]?.id,
  );
  const [activeSection, setActiveSection] = useState(section);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection | null>("appearance");
  return (
    <div className="flex h-screen bg-background" style={{ width }}>
      <Sidebar
        sessions={fixture.sessions}
        archivedSessionCount={fixture.archivedSessionCount}
        archivedSessionsLoaded
        currentId={currentId}
        readCurrentId={currentId}
        onSelect={setCurrentId}
        onArchive={noop}
        onSettleSession={noop}
        onRenameSession={noop}
        onDeleteSession={noop}
        onLoadArchivedSessions={noop}
        section={activeSection}
        onSectionChange={setActiveSection}
        onNavAction={noop}
        onOpenBackgroundTasks={noop}
        assistantLabel="Personal Assistant"
        mobile={mobile}
        onOpenCalendarView={noop}
        onStartSessionForProject={noop}
        tasksFresh
        projectsFresh
        worktreesFresh
        onLoadBacklog={noop}
        onOpenTask={noop}
        onOpenSessionForTask={noop}
        onNavigate={noop}
        onStartSessionForTask={noop}
        onCycleTaskStatus={noop}
        onReorderTasks={noop}
        projects={fixture.projects}
        projectsLoaded
        onLoadProjects={noop}
        onReorderProjects={noop}
        onOpenProject={noop}
        worktrees={fixture.worktrees}
        worktreeStatuses={fixture.worktreeStatuses}
        worktreeHosting={{}}
        dirtyWorktrees={new Set()}
        workflowIndicators={new Map()}
        workflowRuns={fixture.workflowRuns ?? []}
        workflowCards={fixture.workflowCards ?? {}}
        onOpenWorkflowRun={noop}
        onSettleWorkflowRun={noop}
        pullRequestInventory={ready([])}
        onReloadPullRequests={noop}
        onOpenPullRequest={noop}
        knowledgeEnabled
        knowledgeView="files"
        knowledgeUncommitted={3}
        onOpenKnowledge={noop}
        onLoadWorktrees={noop}
        onOpenWorktree={noop}
        onStartSessionInWorktree={noop}
        activeSection={settingsSection}
        onOpenSection={setSettingsSection}
        state={shellBacklogState(fixture.sessions)}
        actions={noopActions}
        prefs={shellPrefs}
        onUpdatePrefs={noop}
      />
    </div>
  );
}

const meta = {
  title: "Shell/Sidebar",
  component: SidebarStory,
  parameters: { layout: "fullscreen" },
  args: {
    scenario: "attention",
    section: "sessions",
    mobile: false,
    width: 256,
  },
  argTypes: {
    scenario: { control: "inline-radio", options: ["attention", "quiet-list"] },
    section: {
      control: "select",
      options: ["sessions", "projects", "knowledge", "calendar", "settings"],
    },
    width: { control: { type: "range", min: 220, max: 480, step: 1 } },
  },
} satisfies Meta<typeof SidebarStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AttentionMix: Story = {};

export const AttentionMixDark: Story = { globals: { theme: "dark" } };

export const Quiet: Story = { args: { scenario: "quiet-list" } };

export const Phone: Story = {
  args: { mobile: true, width: 390 },
  globals: { viewport: { value: "paPhone", isRotated: false } },
};

export const PhoneDark: Story = {
  args: { mobile: true, width: 390 },
  globals: {
    theme: "dark",
    viewport: { value: "paPhone", isRotated: false },
  },
};

export const KnowledgeBrowser: Story = { args: { section: "knowledge" } };

export const SettingsBrowser: Story = { args: { section: "settings" } };

export const SettingsBrowserDark: Story = {
  args: { section: "settings" },
  globals: { theme: "dark" },
};
