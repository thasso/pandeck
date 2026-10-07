import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/table.tsx";
import * as BadgeUI from "../../../src/components/ui/badge.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Table</h1>
      <div className="w-full max-w-3xl">
        <UI.Table>
          <UI.TableCaption>Active agent worktrees</UI.TableCaption>
          <UI.TableHeader>
            <UI.TableRow>
              <UI.TableHead>Worktree</UI.TableHead>
              <UI.TableHead>Branch</UI.TableHead>
              <UI.TableHead>Status</UI.TableHead>
              <UI.TableHead className="text-right">Changes</UI.TableHead>
            </UI.TableRow>
          </UI.TableHeader>
          <UI.TableBody>
            <UI.TableRow>
              <UI.TableCell>task-sync</UI.TableCell>
              <UI.TableCell>fix/task-events</UI.TableCell>
              <UI.TableCell>
                <BadgeUI.Badge>Running</BadgeUI.Badge>
              </UI.TableCell>
              <UI.TableCell className="text-right">+42 −8</UI.TableCell>
            </UI.TableRow>
            <UI.TableRow>
              <UI.TableCell>model-picker</UI.TableCell>
              <UI.TableCell>feat/model-picker</UI.TableCell>
              <UI.TableCell>
                <BadgeUI.Badge variant="secondary">Ready</BadgeUI.Badge>
              </UI.TableCell>
              <UI.TableCell className="text-right">+16 −3</UI.TableCell>
            </UI.TableRow>
          </UI.TableBody>
        </UI.Table>
      </div>
    </main>
  );
}

const meta = { title: "shadcn/Table", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
