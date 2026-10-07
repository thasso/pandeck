import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/alert-dialog.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">AlertDialog</h1>
      <UI.AlertDialog defaultOpen>
        <UI.AlertDialogContent>
          <UI.AlertDialogHeader>
            <UI.AlertDialogTitle>Remove worktree?</UI.AlertDialogTitle>
            <UI.AlertDialogDescription>
              Uncommitted changes in task-sync will be lost.
            </UI.AlertDialogDescription>
          </UI.AlertDialogHeader>
          <UI.AlertDialogFooter>
            <UI.AlertDialogCancel>Keep it</UI.AlertDialogCancel>
            <UI.AlertDialogAction>Remove</UI.AlertDialogAction>
          </UI.AlertDialogFooter>
        </UI.AlertDialogContent>
      </UI.AlertDialog>
    </main>
  );
}

const meta = { title: "UI/AlertDialog", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
