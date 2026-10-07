import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/textarea.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Textarea</h1>
      <div className="grid w-full max-w-lg gap-2">
        <label htmlFor="prompt">Session prompt</label>
        <UI.Textarea
          id="prompt"
          defaultValue="Investigate the task event ordering regression. Run focused tests and report the root cause."
        />
        <UI.Textarea aria-invalid placeholder="Add a task description…" />
      </div>
    </main>
  );
}

const meta = { title: "UI/Textarea", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
