import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/sheet.tsx";
import * as ButtonUI from "../../../src/components/ui/button.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Sheet</h1>
      <UI.Sheet defaultOpen>
        <UI.SheetContent>
          <UI.SheetHeader>
            <UI.SheetTitle>Task details</UI.SheetTitle>
            <UI.SheetDescription>
              Task-42 · Fix task event ordering
            </UI.SheetDescription>
          </UI.SheetHeader>
          <div className="px-4">
            Assigned to Ari Kim. Linked session: Fix task sync.
          </div>
          <UI.SheetFooter>
            <ButtonUI.Button variant="outline">Close</ButtonUI.Button>
            <ButtonUI.Button>Open task</ButtonUI.Button>
          </UI.SheetFooter>
        </UI.SheetContent>
      </UI.Sheet>
    </main>
  );
}

const meta = { title: "shadcn/Sheet", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
