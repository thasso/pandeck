import type { ComponentType } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../../../src/components/ui/button.tsx";
import {
  ShortcutsProvider,
  useShortcuts,
} from "../../../src/components/common/shortcuts.tsx";
function ShortcutsHelpStory() {
  useShortcuts({
    title: "Session",
    shortcuts: [
      { keys: ["mod+k"], label: "Open command menu" },
      { keys: ["e"], label: "Edit session title" },
      { keys: ["?"], label: "Show keyboard shortcuts" },
    ],
  });
  return (
    <div className="p-8">
      <Button
        onClick={() =>
          window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "?", bubbles: true }),
          )
        }
      >
        Show shortcuts help (?)
      </Button>
    </div>
  );
}
const meta = {
  title: "Common/ShortcutsHelp",
  component: ShortcutsHelpStory,
  decorators: [
    (Story: ComponentType) => (
      <ShortcutsProvider>
        <Story />
      </ShortcutsProvider>
    ),
  ],
  excludeStories: /.*Story$/,
} satisfies Meta<typeof ShortcutsHelpStory>;
export default meta;
export const HelpOverlay = {} satisfies StoryObj<typeof meta>;
