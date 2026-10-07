import { useState } from "react";
import { Pencil } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { EditableText } from "../../../src/components/common/EditableText.tsx";
import { IconButton } from "../../../src/components/common/IconButton.tsx";
import {
  failed,
  idle,
  loading,
  ready,
  type LoadState,
} from "../../../src/lib/loadState.ts";

/** A save that runs for a second, then succeeds or is refused. */
function useFakeSave(outcome: "succeed" | "refuse") {
  const [state, setState] = useState<LoadState<true>>(idle());
  const save = () => {
    setState(loading());
    window.setTimeout(
      () =>
        setState(
          outcome === "succeed"
            ? ready(true)
            : failed("The server refused the change."),
        ),
      1000,
    );
  };
  return [state, save] as const;
}

function EditableTextStory({
  multiline = false,
  outcome = "succeed",
  startEditing = false,
}: {
  multiline?: boolean;
  outcome?: "succeed" | "refuse";
  startEditing?: boolean;
}) {
  const [value, setValue] = useState(
    multiline
      ? "Port the web client to shadcn/ui.\n\nKeep every audit green."
      : "Ship the shadcn port",
  );
  const [editing, setEditing] = useState(startEditing);
  const [state, save] = useFakeSave(outcome);
  return (
    <div className="flex max-w-xl flex-col gap-2 p-6">
      <EditableText
        value={value}
        onSubmit={(next) => {
          save();
          if (outcome === "succeed")
            window.setTimeout(() => setValue(next), 1000);
        }}
        submitState={state}
        editing={editing}
        onEditingChange={setEditing}
        multiline={multiline}
        allowEmpty={multiline}
        label={multiline ? "Description" : "Title"}
        placeholder={multiline ? "Add a description…" : undefined}
        className={multiline ? "min-h-32 resize-y" : undefined}
      >
        <div className="flex items-start gap-2">
          <p
            className={`min-w-0 flex-1 whitespace-pre-wrap ${multiline ? "text-sm" : "text-lg font-semibold"}`}
          >
            {value}
          </p>
          <IconButton label="Edit" onClick={() => setEditing(true)}>
            <Pencil />
          </IconButton>
        </div>
      </EditableText>
    </div>
  );
}

const meta = {
  title: "Common/EditableText",
  component: EditableTextStory,
  excludeStories: /.*Story$/,
} satisfies Meta<typeof EditableTextStory>;
export default meta;

type Story = StoryObj<typeof meta>;

/** Enter or blur saves, Escape cancels; the editor closes once the save lands. */
export const SingleLine = {
  args: { startEditing: true },
} satisfies Story;

/** Cmd/Ctrl+Enter saves; blur does not, so newlines are safe. */
export const Multiline = {
  args: { multiline: true, startEditing: true },
} satisfies Story;

/** A refused save keeps the draft open beside its error and a retry. */
export const Refused = {
  args: { outcome: "refuse", startEditing: true },
} satisfies Story;
