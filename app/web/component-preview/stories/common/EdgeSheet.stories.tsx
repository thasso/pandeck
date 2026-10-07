import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "../../../src/components/ui/button.tsx";
import { EdgeSheet } from "../../../src/components/common/EdgeSheet.tsx";
function EdgeSheetStory({ side = "bottom" }: { side?: "bottom" | "top" }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="min-h-64 p-6">
      <Button onClick={() => setOpen(true)}>Open {side} sheet</Button>
      <EdgeSheet
        open={open}
        title={side === "bottom" ? "Session options" : "Quick actions"}
        side={side}
        offsetTop={side === "top" ? 56 : 0}
        onClose={() => setOpen(false)}
      >
        <div className="space-y-2 p-3">
          <p className="font-medium">Pandeck session</p>
          <p className="text-sm text-muted-foreground">
            Inspect logs, manage tools, or update the run.
          </p>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </EdgeSheet>
    </div>
  );
}
const meta = {
  title: "Common/EdgeSheet",
  component: EdgeSheetStory,
  excludeStories: /.*Story$/,
} satisfies Meta<typeof EdgeSheetStory>;
export default meta;
export const Bottom = {
  render: () => <EdgeSheetStory side="bottom" />,
} satisfies StoryObj<typeof meta>;
export const Top = {
  render: () => <EdgeSheetStory side="top" />,
} satisfies StoryObj<typeof meta>;
