import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/checkbox.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Checkbox</h1>
      <div className="grid gap-4">
        <label className="flex gap-3">
          <UI.Checkbox defaultChecked />
          Notify me when sessions need attention
        </label>
        <label className="flex gap-3">
          <UI.Checkbox />
          Include archived sessions
        </label>
        <label className="flex gap-3">
          <UI.Checkbox disabled />
          Sync unavailable
        </label>
      </div>
    </main>
  );
}

const meta = { title: "shadcn/Checkbox", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
