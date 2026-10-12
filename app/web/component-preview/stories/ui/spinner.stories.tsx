import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/spinner.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Spinner</h1>
      <div className="flex items-center gap-6">
        <UI.Spinner />
        <UI.Spinner className="size-6" />
        <span>Starting session…</span>
      </div>
      {/* WebKit (Safari, the Tauri shell) wobbled a spinner at a fractional
          offset; each row sits a fraction of a pixel further along. */}
      <div className="flex flex-col gap-2">
        {[0, 0.25, 0.5, 0.75].map((offset) => (
          <div
            key={offset}
            className="flex items-center gap-4"
            style={{ paddingLeft: offset, paddingTop: offset }}
          >
            <UI.Spinner className="size-3" />
            <UI.Spinner className="size-3.5" />
            <UI.Spinner />
            <UI.Spinner className="size-6" />
            <span className="text-xs text-muted-foreground">+{offset}px</span>
          </div>
        ))}
      </div>
    </main>
  );
}

const meta = { title: "shadcn/Spinner", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
