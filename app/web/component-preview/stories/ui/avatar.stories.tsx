import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/avatar.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Avatar</h1>
      <UI.AvatarGroup>
        <UI.Avatar>
          <UI.AvatarFallback>AK</UI.AvatarFallback>
        </UI.Avatar>
        <UI.Avatar>
          <UI.AvatarFallback>ML</UI.AvatarFallback>
        </UI.Avatar>
        <UI.Avatar>
          <UI.AvatarFallback>JT</UI.AvatarFallback>
        </UI.Avatar>
        <UI.AvatarGroupCount>+2</UI.AvatarGroupCount>
      </UI.AvatarGroup>
    </main>
  );
}

const meta = { title: "shadcn/Avatar", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
