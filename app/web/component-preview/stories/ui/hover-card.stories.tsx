import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/hover-card.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Hover Card</h1>
      <UI.HoverCard defaultOpen>
        <UI.HoverCardTrigger className="underline underline-offset-4">
          @ari-kim
        </UI.HoverCardTrigger>
        <UI.HoverCardContent>
          <p className="font-medium">Ari Kim</p>
          <p className="text-sm text-muted-foreground">
            Maintainer · 3 active sessions
          </p>
        </UI.HoverCardContent>
      </UI.HoverCard>
    </main>
  );
}

const meta = {
  title: "shadcn/HoverCard",
  component: Gallery,
} satisfies Meta<typeof Gallery>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
