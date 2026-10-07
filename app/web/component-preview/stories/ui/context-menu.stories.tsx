import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/context-menu.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">ContextMenu</h1>
      <UI.ContextMenu>
        <UI.ContextMenuTrigger className="grid h-36 w-full max-w-lg place-items-center rounded-lg border border-dashed">
          Right-click the task row
        </UI.ContextMenuTrigger>
        <UI.ContextMenuContent>
          <UI.ContextMenuItem>Open task</UI.ContextMenuItem>
          <UI.ContextMenuItem>Copy link</UI.ContextMenuItem>
          <UI.ContextMenuSeparator />
          <UI.ContextMenuItem variant="destructive">Archive</UI.ContextMenuItem>
        </UI.ContextMenuContent>
      </UI.ContextMenu>
    </main>
  );
}

const meta = { title: "UI/ContextMenu", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
