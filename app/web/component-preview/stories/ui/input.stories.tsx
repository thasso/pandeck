import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/input.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Input</h1>
      <div className="grid w-full max-w-sm gap-4">
        <UI.Input placeholder="Search sessions…" />
        <UI.Input type="email" aria-invalid defaultValue="not-an-email" />
        <UI.Input disabled value="Repository is read-only" readOnly />
      </div>
    </main>
  );
}

const meta = { title: "UI/Input", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
