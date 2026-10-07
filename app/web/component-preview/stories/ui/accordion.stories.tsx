import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/accordion.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Accordion</h1>
      <UI.Accordion>
        <UI.AccordionItem value="session">
          <UI.AccordionTrigger>Session details</UI.AccordionTrigger>
          <UI.AccordionContent>
            Running task synchronization in ~/work/pandeck.
          </UI.AccordionContent>
        </UI.AccordionItem>
      </UI.Accordion>
    </main>
  );
}

const meta = { title: "UI/Accordion", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
