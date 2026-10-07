import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/radio-group.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">RadioGroup</h1>
      <div className="grid gap-3">
        <p>Default model</p>
        <UI.RadioGroup defaultValue="sonnet">
          <label className="flex gap-2">
            <UI.RadioGroupItem value="sonnet" id="sonnet" />
            Claude Sonnet
          </label>
          <label className="flex gap-2">
            <UI.RadioGroupItem value="opus" id="opus" />
            Claude Opus
          </label>
          <label className="flex gap-2">
            <UI.RadioGroupItem value="haiku" id="haiku" />
            Claude Haiku
          </label>
        </UI.RadioGroup>
      </div>
    </main>
  );
}

const meta = { title: "UI/RadioGroup", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
