import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/slider.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Slider</h1>
      <div className="grid w-full max-w-md gap-5">
        <label>Parallel sessions · 3</label>
        <UI.Slider defaultValue={[3]} min={1} max={8} step={1} />
        <label>Context window · 72%</label>
        <UI.Slider defaultValue={[72]} min={0} max={100} />
      </div>
    </main>
  );
}

const meta = { title: "shadcn/Slider", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
