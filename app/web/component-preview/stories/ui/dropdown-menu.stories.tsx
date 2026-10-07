import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/dropdown-menu.tsx";
import * as ButtonUI from "../../../src/components/ui/button.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">DropdownMenu</h1>
      <UI.DropdownMenu defaultOpen>
        <UI.DropdownMenuTrigger render={<ButtonUI.Button variant="outline" />}>
          Task actions
        </UI.DropdownMenuTrigger>
        <UI.DropdownMenuContent>
          <UI.DropdownMenuLabel>Task-42</UI.DropdownMenuLabel>
          <UI.DropdownMenuItem>Open task</UI.DropdownMenuItem>
          <UI.DropdownMenuItem>Copy link</UI.DropdownMenuItem>
          <UI.DropdownMenuSeparator />
          <UI.DropdownMenuItem variant="destructive">
            Archive task
          </UI.DropdownMenuItem>
        </UI.DropdownMenuContent>
      </UI.DropdownMenu>
    </main>
  );
}

const meta = {
  title: "shadcn/DropdownMenu",
  component: Gallery,
} satisfies Meta<typeof Gallery>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
