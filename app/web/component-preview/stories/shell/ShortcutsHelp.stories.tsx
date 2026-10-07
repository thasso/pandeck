import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  useShortcuts,
  type ShortcutGroup,
} from "../../../src/components/common/shortcuts.tsx";

const noop = () => {};

const GROUPS: ShortcutGroup[] = [
  {
    title: "Sessions",
    shortcuts: [
      { keys: ["j", "ArrowDown"], label: "Next session", run: noop },
      { keys: ["k", "ArrowUp"], label: "Previous session", run: noop },
      { keys: ["s"], label: "Settle the focused session", run: noop },
      { keys: ["e"], label: "Archive the focused session", run: noop },
      {
        keys: ["#", "Delete"],
        label: "Delete the focused session",
        run: noop,
        enabled: false,
      },
    ],
  },
  {
    title: "App",
    shortcuts: [
      { keys: ["mod+k"], label: "Search everything", run: noop },
      { keys: ["mod+shift+p"], label: "Toggle the perf overlay", run: noop },
    ],
  },
];

function Registered({ group, order }: { group: ShortcutGroup; order: number }) {
  useShortcuts(group, order);
  return null;
}

/**
 * The `?` help dialog of the app's shortcut registry (`PaPreviewRoot` mounts
 * the provider), opened the way a reader opens it: by pressing `?`.
 */
function ShortcutsHelpStory({ empty }: { empty: boolean }) {
  useEffect(() => {
    const timer = window.setTimeout(() =>
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "?", bubbles: true }),
      ),
    );
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="h-screen bg-background p-4 text-sm text-muted-foreground">
      Press ? to toggle the list.
      {empty
        ? null
        : GROUPS.map((group, index) => (
            <Registered key={group.title} group={group} order={index + 1} />
          ))}
    </div>
  );
}

const meta = {
  title: "App/Shell/Shortcuts help",
  component: ShortcutsHelpStory,
  parameters: { layout: "fullscreen" },
  args: { empty: false },
} satisfies Meta<typeof ShortcutsHelpStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const OpenDark: Story = { globals: { theme: "dark" } };

export const NothingRegistered: Story = { args: { empty: true } };
