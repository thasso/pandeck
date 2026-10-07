import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/kbd.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Kbd</h1>
      <div className="flex items-center gap-5">
        <span>Open command menu</span>
        <UI.KbdGroup>
          <UI.Kbd>⌘</UI.Kbd>
          <UI.Kbd>K</UI.Kbd>
        </UI.KbdGroup>
        <span>Navigate tasks</span>
        <UI.Kbd>↑ ↓</UI.Kbd>
      </div>
    </main>
  );
}

const meta = { title: "UI/Kbd", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
