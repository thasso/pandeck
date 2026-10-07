import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/dialog.tsx";
import * as ButtonUI from "../../../src/components/ui/button.tsx";
import * as InputUI from "../../../src/components/ui/input.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Dialog</h1>
      <UI.Dialog defaultOpen>
        <UI.DialogContent>
          <UI.DialogHeader>
            <UI.DialogTitle>Rename worktree</UI.DialogTitle>
            <UI.DialogDescription>
              Choose a name that is easy to find.
            </UI.DialogDescription>
          </UI.DialogHeader>
          <InputUI.Input defaultValue="task-sync" />
          <UI.DialogFooter>
            <UI.DialogClose render={<ButtonUI.Button variant="outline" />}>
              Cancel
            </UI.DialogClose>
            <ButtonUI.Button>Save name</ButtonUI.Button>
          </UI.DialogFooter>
        </UI.DialogContent>
      </UI.Dialog>
    </main>
  );
}

const meta = { title: "shadcn/Dialog", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
