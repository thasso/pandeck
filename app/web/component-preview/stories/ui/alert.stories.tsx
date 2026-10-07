import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/alert.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Alert</h1>
      <div className="grid gap-3">
        <UI.Alert>
          <UI.AlertTitle>Session needs attention</UI.AlertTitle>
          <UI.AlertDescription>
            Waiting for approval to run pnpm test.
          </UI.AlertDescription>
        </UI.Alert>
        <UI.Alert variant="destructive">
          <UI.AlertTitle>Worktree unavailable</UI.AlertTitle>
          <UI.AlertDescription>
            Could not fetch origin/main.
          </UI.AlertDescription>
        </UI.Alert>
      </div>
    </main>
  );
}

const meta = { title: "shadcn/Alert", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
