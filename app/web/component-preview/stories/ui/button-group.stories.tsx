import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/button-group.tsx";
import * as ButtonUI from "../../../src/components/ui/button.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">ButtonGroup</h1>
      <div className="grid justify-items-start gap-4">
        <UI.ButtonGroup>
          <ButtonUI.Button variant="outline">Today</ButtonUI.Button>
          <ButtonUI.Button variant="outline">Week</ButtonUI.Button>
          <ButtonUI.Button variant="outline">All sessions</ButtonUI.Button>
        </UI.ButtonGroup>
        <UI.ButtonGroup>
          <ButtonUI.Button variant="outline">main</ButtonUI.Button>
          <UI.ButtonGroupSeparator />
          <ButtonUI.Button>New worktree</ButtonUI.Button>
        </UI.ButtonGroup>
      </div>
    </main>
  );
}

const meta = { title: "shadcn/ButtonGroup", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
