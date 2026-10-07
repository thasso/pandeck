import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/switch.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Switch</h1>
      <div className="grid gap-5">
        <label className="flex items-center gap-3">
          <UI.Switch defaultChecked />
          Enable session notifications
        </label>
        <label className="flex items-center gap-3">
          <UI.Switch />
          Automatically resume after restart
        </label>
        <label className="flex items-center gap-3">
          <UI.Switch disabled />
          Unavailable for this runtime
        </label>
      </div>
    </main>
  );
}

const meta = { title: "UI/Switch", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
