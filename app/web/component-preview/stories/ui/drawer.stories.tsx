import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/drawer.tsx";
import * as ButtonUI from "../../../src/components/ui/button.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Drawer</h1>
      <UI.Drawer defaultOpen>
        <UI.DrawerContent>
          <UI.DrawerHeader>
            <UI.DrawerTitle>Session options</UI.DrawerTitle>
            <UI.DrawerDescription>
              Manage this agent session.
            </UI.DrawerDescription>
          </UI.DrawerHeader>
          <div className="grid gap-3 px-4">
            <ButtonUI.Button variant="outline">Rename</ButtonUI.Button>
            <ButtonUI.Button variant="outline">Move to project</ButtonUI.Button>
          </div>
          <UI.DrawerFooter>
            <ButtonUI.Button variant="destructive">
              Archive session
            </ButtonUI.Button>
          </UI.DrawerFooter>
        </UI.DrawerContent>
      </UI.Drawer>
    </main>
  );
}

const meta = { title: "UI/Drawer", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
