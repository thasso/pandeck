import { useLayoutEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { GitBranch, MessageSquare } from "lucide-react";
import { RightPanelTabs } from "../../../src/components/shell/RightPanelTabs.tsx";
import {
  Inspector,
  InspectorChromeProvider,
} from "../../../src/components/shell/Inspector.tsx";
import { EmptyBox } from "../../../src/components/common/load.tsx";

const noop = () => {};
const TAB_STORAGE_KEY = "assistant.right-panel-tabs.v1";

type PanelId = "inspector" | "personal-assistant" | "knowledge" | "worktree";

/**
 * The desktop right panel's tab host. Its open tabs are `sessionStorage` state,
 * so each story seeds them before the host reads them.
 */
function RightPanelTabsStory({
  openTabs,
  activeTab,
}: {
  openTabs: PanelId[];
  activeTab: PanelId | null;
}) {
  const [seeded, setSeeded] = useState(false);
  useLayoutEffect(() => {
    sessionStorage.setItem(
      TAB_STORAGE_KEY,
      JSON.stringify({ openTabs, activeTab }),
    );
    setSeeded(true);
  }, [openTabs, activeTab]);
  if (!seeded) return null;
  return (
    <div className="h-screen w-96">
      <RightPanelTabs
        key={`${openTabs.join()}:${activeTab}`}
        inspector={
          <InspectorChromeProvider header={false} desktopTabs>
            <Inspector
              sectionStorageScope="story:tabs"
              actions={[]}
              relations={[
                {
                  id: "sessions",
                  label: "Sessions",
                  icon: <MessageSquare />,
                  items: [
                    {
                      key: "s1",
                      icon: <MessageSquare />,
                      title: "Refine attention list rows",
                      subtitle: "Working",
                      onOpen: noop,
                    },
                  ],
                },
                {
                  id: "worktrees",
                  label: "Worktrees",
                  icon: <GitBranch />,
                  items: [
                    {
                      key: "wt",
                      icon: <GitBranch />,
                      title: "pa-attention-rows",
                      counters: { additions: 128, deletions: 35 },
                      onOpen: noop,
                    },
                  ],
                },
              ]}
            />
          </InspectorChromeProvider>
        }
        knowledge={<EmptyBox>The Knowledge Base panel.</EmptyBox>}
        worktree={<EmptyBox>The worktree panel.</EmptyBox>}
      />
    </div>
  );
}

const meta = {
  title: "Shell/Right panel tabs",
  component: RightPanelTabsStory,
  parameters: { layout: "fullscreen" },
  args: {
    openTabs: ["inspector", "knowledge", "worktree"],
    activeTab: "inspector",
  },
} satisfies Meta<typeof RightPanelTabsStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InspectorTab: Story = {};

export const InspectorTabDark: Story = { globals: { theme: "dark" } };

export const WorktreeTab: Story = { args: { activeTab: "worktree" } };

/** Every tab closed: the chooser of panels the app offers. */
export const PanelHome: Story = { args: { openTabs: [], activeTab: null } };

export const PanelHomeDark: Story = {
  args: { openTabs: [], activeTab: null },
  globals: { theme: "dark" },
};
