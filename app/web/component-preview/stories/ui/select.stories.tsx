import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/select.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Select</h1>
      <div className="grid gap-4">
        <UI.Select defaultValue="sonnet">
          <UI.SelectTrigger>
            <UI.SelectValue placeholder="Choose a model" />
          </UI.SelectTrigger>
          <UI.SelectContent>
            <UI.SelectGroup>
              <UI.SelectLabel>Anthropic</UI.SelectLabel>
              <UI.SelectItem value="sonnet">Claude Sonnet</UI.SelectItem>
              <UI.SelectItem value="opus">Claude Opus</UI.SelectItem>
            </UI.SelectGroup>
            <UI.SelectSeparator />
            <UI.SelectItem value="gpt">GPT-4.1</UI.SelectItem>
          </UI.SelectContent>
        </UI.Select>
        <UI.Select>
          <UI.SelectTrigger size="sm">
            <UI.SelectValue placeholder="Filter status" />
          </UI.SelectTrigger>
          <UI.SelectContent>
            <UI.SelectItem value="running">Running</UI.SelectItem>
            <UI.SelectItem value="queued">Queued</UI.SelectItem>
          </UI.SelectContent>
        </UI.Select>
      </div>
    </main>
  );
}

const meta = { title: "shadcn/Select", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
