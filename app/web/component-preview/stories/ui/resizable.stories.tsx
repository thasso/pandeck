import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/resizable.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Resizable</h1>
      <UI.ResizablePanelGroup
        orientation="horizontal"
        className="min-h-56 w-full max-w-3xl rounded-lg border"
      >
        <UI.ResizablePanel defaultSize={35}>
          <div className="p-4">
            Sessions
            <br />
            Fix task sync
            <br />
            Review model picker
          </div>
        </UI.ResizablePanel>
        <UI.ResizableHandle withHandle />
        <UI.ResizablePanel>
          <div className="p-4">
            Fix task sync
            <br />
            Agent output and conversation
          </div>
        </UI.ResizablePanel>
      </UI.ResizablePanelGroup>
    </main>
  );
}

const meta = { title: "shadcn/Resizable", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
