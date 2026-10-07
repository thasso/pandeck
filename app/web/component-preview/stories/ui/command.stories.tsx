import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/command.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Command</h1>
      <UI.Command className="max-w-lg rounded-lg border">
        <UI.CommandInput placeholder="Search sessions and tasks…" />
        <UI.CommandList>
          <UI.CommandEmpty>No matching sessions.</UI.CommandEmpty>
          <UI.CommandGroup heading="Sessions">
            <UI.CommandItem>
              Fix task sync<UI.CommandShortcut>⌘1</UI.CommandShortcut>
            </UI.CommandItem>
            <UI.CommandItem>Review model picker</UI.CommandItem>
          </UI.CommandGroup>
          <UI.CommandSeparator />
          <UI.CommandGroup heading="Actions">
            <UI.CommandItem>New session</UI.CommandItem>
          </UI.CommandGroup>
        </UI.CommandList>
      </UI.Command>
    </main>
  );
}

const meta = { title: "shadcn/Command", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
