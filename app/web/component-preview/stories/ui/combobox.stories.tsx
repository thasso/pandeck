import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/combobox.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Combobox</h1>
      <UI.Combobox>
        <UI.ComboboxInput placeholder="Choose a model…" />
        <UI.ComboboxContent>
          <UI.ComboboxList>
            <UI.ComboboxEmpty>No model found.</UI.ComboboxEmpty>
            <UI.ComboboxItem value="sonnet">Claude Sonnet</UI.ComboboxItem>
            <UI.ComboboxItem value="opus">Claude Opus</UI.ComboboxItem>
            <UI.ComboboxItem value="gpt">GPT-4.1</UI.ComboboxItem>
          </UI.ComboboxList>
        </UI.ComboboxContent>
      </UI.Combobox>
    </main>
  );
}

const meta = { title: "UI/Combobox", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
