import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/item.tsx";
import * as BadgeUI from "../../../src/components/ui/badge.tsx";
import * as ButtonUI from "../../../src/components/ui/button.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Item</h1>
      <div className="w-full max-w-2xl">
        <UI.ItemGroup>
          <UI.Item variant="outline">
            <UI.ItemMedia variant="icon">◉</UI.ItemMedia>
            <UI.ItemContent>
              <UI.ItemTitle>Fix task event ordering</UI.ItemTitle>
              <UI.ItemDescription>
                Task-42 · Ari Kim · Updated 4 min ago
              </UI.ItemDescription>
            </UI.ItemContent>
            <UI.ItemActions>
              <BadgeUI.Badge>In progress</BadgeUI.Badge>
            </UI.ItemActions>
          </UI.Item>
          <UI.ItemSeparator />
          <UI.Item variant="outline">
            <UI.ItemMedia variant="icon">◷</UI.ItemMedia>
            <UI.ItemContent>
              <UI.ItemTitle>Review provider settings</UI.ItemTitle>
              <UI.ItemDescription>
                Task-39 · Waiting for review
              </UI.ItemDescription>
            </UI.ItemContent>
            <UI.ItemActions>
              <ButtonUI.Button size="sm" variant="outline">
                Open
              </ButtonUI.Button>
            </UI.ItemActions>
          </UI.Item>
        </UI.ItemGroup>
      </div>
    </main>
  );
}

const meta = { title: "UI/Item", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
