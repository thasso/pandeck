import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/breadcrumb.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Breadcrumb</h1>
      <UI.Breadcrumb>
        <UI.BreadcrumbList>
          <UI.BreadcrumbItem>
            <UI.BreadcrumbLink href="#">Workspaces</UI.BreadcrumbLink>
          </UI.BreadcrumbItem>
          <UI.BreadcrumbSeparator />
          <UI.BreadcrumbItem>
            <UI.BreadcrumbLink href="#">Pandeck</UI.BreadcrumbLink>
          </UI.BreadcrumbItem>
          <UI.BreadcrumbSeparator />
          <UI.BreadcrumbItem>
            <UI.BreadcrumbPage>Task sync</UI.BreadcrumbPage>
          </UI.BreadcrumbItem>
        </UI.BreadcrumbList>
      </UI.Breadcrumb>
    </main>
  );
}

const meta = { title: "shadcn/Breadcrumb", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
