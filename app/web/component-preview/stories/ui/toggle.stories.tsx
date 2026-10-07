import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/toggle.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Toggle</h1>
      <div className="flex gap-2">
        <UI.Toggle aria-label="Pin session">Pin</UI.Toggle>
        <UI.Toggle variant="outline" aria-label="Show transcript">
          Transcript
        </UI.Toggle>
        <UI.Toggle disabled>Disabled</UI.Toggle>
      </div>
    </main>
  );
}

const meta = { title: "UI/Toggle", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
