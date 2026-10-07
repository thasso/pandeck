import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/button.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Button</h1>
      <div className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          {(
            [
              "default",
              "secondary",
              "outline",
              "ghost",
              "destructive",
              "link",
            ] as const
          ).map((v) => (
            <UI.Button key={v} variant={v}>
              {v}
            </UI.Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(["xs", "sm", "default", "lg"] as const).map((s) => (
            <UI.Button key={s} size={s}>
              Run task
            </UI.Button>
          ))}
          <UI.Button busy>Starting session</UI.Button>
          <UI.Button disabled>Unavailable</UI.Button>
        </div>
      </div>
    </main>
  );
}

const meta = { title: "UI/Button", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
