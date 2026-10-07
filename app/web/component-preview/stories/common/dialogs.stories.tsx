import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "../../../src/components/ui/button.tsx";
import {
  ConfirmDialog,
  useDialogs,
} from "../../../src/components/common/dialogs.tsx";
function DialogsStory() {
  const dialogs = useDialogs();
  const [kind, setKind] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap gap-2 p-8">
      <Button
        onClick={() =>
          void dialogs.confirm({
            title: "Archive session?",
            body: "The transcript remains searchable.",
            confirmLabel: "Archive",
          })
        }
      >
        Plain via useDialogs
      </Button>
      <Button variant="destructive" onClick={() => setKind("danger")}>
        Danger
      </Button>
      <Button variant="outline" onClick={() => setKind("prompt")}>
        Prompt
      </Button>
      <Button onClick={() => setKind("busy")}>Busy</Button>
      <Button variant="secondary" onClick={() => setKind("error")}>
        Error
      </Button>
      {kind && (
        <ConfirmDialog
          title={
            kind === "danger"
              ? "Remove worktree?"
              : kind === "prompt"
                ? "Rename task"
                : kind === "busy"
                  ? "Starting session…"
                  : "Could not archive session"
          }
          body="Changes in shadcn-ui-port will be affected."
          confirmLabel={kind === "danger" ? "Remove" : "Continue"}
          danger={kind === "danger"}
          {...(kind === "prompt"
            ? {
                input: {
                  label: "Task title",
                  defaultValue: "Improve session startup",
                },
              }
            : {})}
          busy={kind === "busy"}
          {...(kind === "error"
            ? { error: "The server did not respond. Try again." }
            : {})}
          onConfirm={() => setKind(null)}
          onCancel={() => setKind(null)}
        />
      )}
    </div>
  );
}
const meta = {
  title: "Common/dialogs",
  component: DialogsStory,
  excludeStories: /.*Story$/,
} satisfies Meta<typeof DialogsStory>;
export default meta;
export const Variants = {} satisfies StoryObj<typeof meta>;
