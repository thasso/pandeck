import { useState, type ReactNode } from "react";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { ErrorNote } from "./load.tsx";
import { errorOf, isPending, type LoadState } from "../../lib/loadState.ts";

/**
 * @component PropertyList
 * @purpose An object's fields as a property list: one line per field, the
 *   label in a fixed column on the left and the value on the right — as its own
 *   quiet control (`PROPERTY_TRIGGER`) when it can be changed, as text when not.
 * @useWhen An inspector or detail section showing a handful of named fields:
 *   the Task inspector's Details, the Project page's Repository.
 * @intent One label column for every list, so labels and values line up the
 *   same wherever a list appears. Children alternate `PropertyLabel` and value.
 *   `align="start"` is for values that WRAP (a path, a remote): each label sits
 *   on its value's first line instead of floating at its middle.
 */
export function PropertyList({
  align = "center",
  children,
}: {
  align?: "center" | "start";
  children: ReactNode;
}) {
  return (
    <div
      className={`grid grid-cols-[5.5rem_minmax(0,1fr)] gap-y-0.5 px-1 ${align === "start" ? "items-start" : "items-center"}`}
    >
      {children}
    </div>
  );
}

/** A field's name in a `PropertyList`: one 28px line, the value's height. */
export function PropertyLabel({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-h-7 items-center text-sm text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * A value in a `PropertyList` that is read, not changed: inset like a
 * trigger's text, on the same 28px first line, wrapping below it.
 */
export function PropertyText({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={`min-w-0 px-2 py-1 text-sm leading-5 ${className}`}>
      {children}
    </span>
  );
}

/** A value control in the property list: borderless, filled on hover, the
 *  width of its column so every value starts at the same x. */
export const PROPERTY_TRIGGER =
  "h-7 w-full justify-between border-transparent bg-transparent px-2 font-normal shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted/50";

/**
 * @component TextProperty
 * @purpose A free-text field in a `PropertyList`: its value on the line as a
 *   quiet trigger, and an editor in a popover under it — the field, a one-line
 *   hint, Clear when it may be empty, and Save.
 * @useWhen A property whose value is typed (a key, a path), beside the pickers
 *   (`Select`, the date popovers) that edit the others the same way.
 * @intent Enter saves, Escape cancels; every opening starts from the current
 *   value. The trigger carries the save's spinner and its failure, so a
 *   refused edit stays visible after the popover closes.
 */
export function TextProperty({
  label,
  value,
  placeholder,
  hint,
  icon,
  mono = false,
  allowEmpty = false,
  normalize = (draft) => draft.trim(),
  submitState,
  onSave,
}: {
  /** The field's name, for the trigger's and the input's accessible label. */
  label: string;
  value: string;
  /** Shown muted when the value is empty — in the trigger and the input. */
  placeholder: string;
  hint?: string | undefined;
  icon?: ReactNode;
  mono?: boolean;
  /** Offer Clear, and allow saving an empty value. */
  allowEmpty?: boolean;
  normalize?: (draft: string) => string;
  submitState?: LoadState<true> | undefined;
  onSave: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const pending = submitState ? isPending(submitState) : false;
  const error = submitState ? errorOf(submitState) : undefined;
  const next = normalize(draft);
  const save = (nextValue: string) => {
    setOpen(false);
    if (nextValue !== value) onSave(nextValue);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) setDraft(value);
          setOpen(nextOpen);
        }}
      >
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${label}: ${value || placeholder}`}
              busy={pending}
              className={`${PROPERTY_TRIGGER} justify-start [&_svg]:text-muted-foreground`}
            />
          }
        >
          {icon}
          <span
            className={`min-w-0 truncate ${mono ? "font-mono text-xs" : ""} ${value ? "" : "text-muted-foreground"}`}
          >
            {value || placeholder}
          </span>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 gap-2">
          <Input
            autoFocus
            value={draft}
            aria-label={label}
            placeholder={placeholder}
            className={mono ? "font-mono" : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing)
                return;
              event.preventDefault();
              if (next || allowEmpty) save(next);
            }}
          />
          {hint ? (
            <p className="text-xs text-muted-foreground">{hint}</p>
          ) : null}
          <div className="flex items-center gap-1">
            {allowEmpty && value ? (
              <Button variant="ghost" size="xs" onClick={() => save("")}>
                Clear
              </Button>
            ) : null}
            <Button
              size="xs"
              className="ml-auto"
              disabled={!next && !allowEmpty}
              onClick={() => save(next)}
            >
              Save
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {error ? <ErrorNote message={error} /> : null}
    </div>
  );
}
