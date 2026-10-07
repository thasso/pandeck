import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/input-group.tsx";
import * as KbdUI from "../../../src/components/ui/kbd.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">InputGroup</h1>
      <div className="grid w-full max-w-xl gap-5">
        <UI.InputGroup>
          <UI.InputGroupAddon>
            <UI.InputGroupText>https://</UI.InputGroupText>
          </UI.InputGroupAddon>
          <UI.InputGroupInput
            defaultValue="git.example.com/team/pandeck"
            aria-label="Repository URL"
          />
          <UI.InputGroupAddon align="inline-end">
            <UI.InputGroupButton>Test</UI.InputGroupButton>
          </UI.InputGroupAddon>
        </UI.InputGroup>
        <UI.InputGroup>
          <UI.InputGroupAddon>
            <UI.InputGroupText>⌕</UI.InputGroupText>
          </UI.InputGroupAddon>
          <UI.InputGroupInput placeholder="Filter sessions…" />
          <UI.InputGroupAddon align="inline-end">
            <KbdUI.Kbd>⌘ K</KbdUI.Kbd>
          </UI.InputGroupAddon>
        </UI.InputGroup>
        <UI.InputGroup>
          <UI.InputGroupTextarea placeholder="Add a note to this task…" />
        </UI.InputGroup>
      </div>
    </main>
  );
}

const meta = { title: "UI/InputGroup", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
