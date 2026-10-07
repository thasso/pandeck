import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/spinner.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Spinner</h1>
      <div className="flex items-center gap-6">
        <UI.Spinner />
        <UI.Spinner className="size-6" />
        <span>Starting session…</span>
      </div>
    </main>
  );
}

const meta = { title: "UI/Spinner", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
