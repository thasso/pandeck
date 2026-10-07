import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/empty.tsx";
import * as ButtonUI from "../../../src/components/ui/button.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Empty</h1>
      <div className="grid gap-6 md:grid-cols-2">
        <UI.Empty className="rounded-lg border">
          <UI.EmptyHeader>
            <UI.EmptyMedia variant="icon">⌕</UI.EmptyMedia>
            <UI.EmptyTitle>No sessions yet</UI.EmptyTitle>
            <UI.EmptyDescription>
              Start an agent session to see activity here.
            </UI.EmptyDescription>
          </UI.EmptyHeader>
          <UI.EmptyContent>
            <ButtonUI.Button>Start a session</ButtonUI.Button>
          </UI.EmptyContent>
        </UI.Empty>
        <UI.Empty className="rounded-lg border">
          <UI.EmptyHeader>
            <UI.EmptyTitle>No tasks match</UI.EmptyTitle>
            <UI.EmptyDescription>Try clearing a filter.</UI.EmptyDescription>
          </UI.EmptyHeader>
          <UI.EmptyContent>
            <ButtonUI.Button variant="outline">Clear filters</ButtonUI.Button>
          </UI.EmptyContent>
        </UI.Empty>
      </div>
    </main>
  );
}

const meta = { title: "shadcn/Empty", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
