import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowLeft, GitBranch, MessageSquarePlus, Mic } from "lucide-react";
import {
  DockAction,
  DockComposerFace,
  DockComposerField,
  ObjectDock,
} from "../../../src/components/shell/ObjectDock.tsx";
import { Inspector } from "../../../src/components/shell/Inspector.tsx";

const noop = () => {};

interface ObjectDockStoryProps {
  expanded: boolean;
  /** `actions`: an object screen's row; `composer`: a session's field. */
  row: "actions" | "composer";
}

/**
 * The phone's object dock over a stand-in screen: the action row at rest, the
 * Inspector body when dragged or tapped open. The card is anchored inside its
 * host's box, so the frame is the screen.
 */
function ObjectDockStory({ expanded, row }: ObjectDockStoryProps) {
  const [open, setOpen] = useState(expanded);
  return (
    <div className="relative h-screen w-full overflow-hidden bg-background">
      <div className="space-y-2 p-4 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Refine attention rows</p>
        <p>The screen behind the dock. Its content keeps scrolling at rest.</p>
      </div>
      <ObjectDock
        mode={open ? "expanded" : "peek"}
        onExpand={() => setOpen(true)}
        onCollapse={() => setOpen(false)}
        animate={false}
        peek={
          row === "composer"
            ? {
                back: (
                  <DockAction
                    icon={<ArrowLeft />}
                    label="Back to Sessions"
                    onRun={noop}
                  />
                ),
                fill: true,
                actions: (
                  <>
                    <DockComposerField>
                      <DockComposerFace
                        text={{
                          value: "Message the assistant…",
                          placeholder: true,
                        }}
                        label="Compose message"
                        onRun={noop}
                      />
                    </DockComposerField>
                    <DockAction icon={<Mic />} label="Dictate" onRun={noop} />
                  </>
                ),
              }
            : {
                back: (
                  <DockAction
                    icon={<ArrowLeft />}
                    label="Back to Tasks"
                    onRun={noop}
                  />
                ),
                actions: (
                  <>
                    <DockAction
                      icon={<GitBranch />}
                      label="Open worktree"
                      marked
                      onRun={noop}
                    />
                    <DockAction
                      icon={<MessageSquarePlus />}
                      label="Start session"
                      badge={2}
                      onRun={noop}
                    />
                  </>
                ),
              }
        }
      >
        <Inspector
          sectionStorageScope="story:dock"
          actions={[
            {
              key: "start",
              icon: <MessageSquarePlus />,
              label: "Start session for this task",
              onRun: noop,
            },
          ]}
          relations={[
            {
              id: "worktrees",
              label: "Worktrees",
              icon: <GitBranch />,
              items: [
                {
                  key: "wt",
                  icon: <GitBranch />,
                  title: "pa-attention-rows",
                  subtitle: "2 ahead",
                  counters: { additions: 128, deletions: 35 },
                  onOpen: noop,
                },
              ],
            },
          ]}
        />
      </ObjectDock>
    </div>
  );
}

const meta = {
  title: "Shell/Object dock",
  component: ObjectDockStory,
  parameters: { layout: "fullscreen" },
  args: { expanded: false, row: "actions" },
  globals: { viewport: { value: "paPhone", isRotated: false } },
} satisfies Meta<typeof ObjectDockStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {};

export const CollapsedDark: Story = { globals: { theme: "dark" } };

export const Expanded: Story = { args: { expanded: true } };

export const ExpandedDark: Story = {
  args: { expanded: true },
  globals: { theme: "dark" },
};

export const SessionComposer: Story = { args: { row: "composer" } };
