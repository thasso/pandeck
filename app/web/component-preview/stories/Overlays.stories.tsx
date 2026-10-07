import type { Meta, StoryObj } from "@storybook/react-vite";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Popover } from "../../src/components/Popover.tsx";
import { ToastViewport } from "../../src/components/ToastViewport.tsx";
import { Button } from "../../src/components/ui/button.tsx";
import {
  ConfirmDialog,
  useDialogs,
} from "../../src/components/common/dialogs.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../src/components/ui/dropdown-menu.tsx";
import { EdgeSheet } from "../../src/components/common/EdgeSheet.tsx";
import { GhostIconButton } from "../../src/components/common/GhostIconButton.tsx";
import { showToast } from "../../src/lib/toast.ts";

/** Every app overlay, now on shadcn: dialogs, menus, popovers, sheets, toasts. */
export function Overlays() {
  const dialogs = useDialogs();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  return (
    <div className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() =>
            void dialogs.confirm({
              title: "Archive this session?",
              body: "The transcript stays searchable. You can restore it later.",
              confirmLabel: "Archive",
            })
          }
        >
          Confirm
        </Button>
        <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
          Destructive confirm
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            void dialogs.promptText({
              title: "Rename session",
              label: "Title",
              defaultValue: "Fix session list flicker",
            })
          }
        >
          Prompt
        </Button>
        <Button variant="secondary" onClick={() => setSheetOpen(true)}>
          Sheet
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            showToast("Moved Task-12 to Pandeck", {
              tone: "success",
              action: { label: "Undo", onClick: () => {} },
              durationMs: 7000,
            })
          }
        >
          Toast
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="icon" aria-label="Menu" />}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem>
              <Pencil />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive">
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover
          button={<span className="px-2">Legacy Popover API</span>}
          className="h-8 rounded-lg border px-2 text-sm"
        >
          {(close) => (
            <button
              type="button"
              className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={close}
            >
              Close me
            </button>
          )}
        </Popover>
        <GhostIconButton
          icon={<Pencil size={13} />}
          label="Edit title"
          onClick={() => {}}
        />
      </div>
      {confirmOpen ? (
        <ConfirmDialog
          title="Remove worktree?"
          body="Uncommitted changes in shadcn-ui-port will be lost."
          confirmLabel="Remove"
          danger
          onConfirm={() => setConfirmOpen(false)}
          onCancel={() => setConfirmOpen(false)}
        />
      ) : null}
      <EdgeSheet
        open={sheetOpen}
        title="Chat options"
        onClose={() => setSheetOpen(false)}
      >
        <p className="p-2 text-sm text-muted-foreground">Sheet content</p>
      </EdgeSheet>
      <ToastViewport />
    </div>
  );
}

const meta = {
  id: "overlays",
  title: "Foundation/Overlays",
  component: Overlays,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Overlays>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
