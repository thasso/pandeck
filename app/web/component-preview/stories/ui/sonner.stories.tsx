import type { Meta, StoryObj } from "@storybook/react-vite";
import { toast } from "sonner";
import { Button } from "../../../src/components/ui/button.tsx";
import * as UI from "../../../src/components/ui/sonner.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Sonner</h1>
      <div>
        <p className="text-sm text-muted-foreground">
          Toast viewport is mounted by the preview root.
        </p>
        <UI.Toaster />
      </div>
      <Button
        variant="outline"
        onClick={() => toast.loading("Merging pull request…")}
      >
        Show a loading toast
      </Button>
    </main>
  );
}

const meta = { title: "shadcn/Sonner", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
