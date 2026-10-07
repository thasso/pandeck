import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/tabs.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Tabs</h1>
      <UI.Tabs defaultValue="activity" className="w-full max-w-xl">
        <UI.TabsList>
          <UI.TabsTrigger value="activity">Activity</UI.TabsTrigger>
          <UI.TabsTrigger value="tasks">Tasks</UI.TabsTrigger>
          <UI.TabsTrigger value="settings">Settings</UI.TabsTrigger>
        </UI.TabsList>
        <UI.TabsContent value="activity" className="rounded-md border p-4">
          Ari started a session in task-sync.
        </UI.TabsContent>
        <UI.TabsContent value="tasks" className="rounded-md border p-4">
          Task-42 · Fix task event ordering
        </UI.TabsContent>
        <UI.TabsContent value="settings" className="rounded-md border p-4">
          Notifications are enabled.
        </UI.TabsContent>
      </UI.Tabs>
    </main>
  );
}

const meta = { title: "UI/Tabs", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
