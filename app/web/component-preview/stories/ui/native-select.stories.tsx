import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/native-select.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">NativeSelect</h1>
      <div className="grid w-full max-w-sm gap-2">
        <label htmlFor="runtime">Agent runtime</label>
        <UI.NativeSelect id="runtime" defaultValue="claude">
          <UI.NativeSelectOption value="claude">
            Claude Code
          </UI.NativeSelectOption>
          <UI.NativeSelectOption value="codex">Codex</UI.NativeSelectOption>
          <UI.NativeSelectOption value="opencode">
            OpenCode
          </UI.NativeSelectOption>
        </UI.NativeSelect>
      </div>
    </main>
  );
}

const meta = { title: "UI/NativeSelect", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
