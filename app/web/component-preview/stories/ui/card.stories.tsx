import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/card.tsx";
import * as BadgeUI from "../../../src/components/ui/badge.tsx";
import * as ButtonUI from "../../../src/components/ui/button.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Card</h1>
      <UI.Card className="max-w-lg">
        <UI.CardHeader>
          <UI.CardTitle>Fix task sync</UI.CardTitle>
          <UI.CardDescription>
            Worktree task-sync · Claude Sonnet
          </UI.CardDescription>
          <UI.CardAction>
            <BadgeUI.Badge>Running</BadgeUI.Badge>
          </UI.CardAction>
        </UI.CardHeader>
        <UI.CardContent>
          The agent is running the focused regression suite.
        </UI.CardContent>
        <UI.CardFooter className="justify-between">
          <span>Started 12 minutes ago</span>
          <ButtonUI.Button size="sm">Open session</ButtonUI.Button>
        </UI.CardFooter>
      </UI.Card>
    </main>
  );
}

const meta = { title: "UI/Card", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
