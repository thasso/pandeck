import { useEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, ReactNode } from "react";
import { cn } from "cn";

import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { ErrorNote } from "./load.tsx";
import {
  errorOf,
  idle,
  isPending,
  type LoadState,
} from "../../lib/loadState.ts";

const IDLE = idle<true>();

export interface EditableTextProps {
  value: string;
  onSubmit: (next: string) => void;
  /** Edit mode is the host's, so a trigger anywhere (a section header, a menu) can open it. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** A `Textarea` with Save/Cancel instead of a single-line `Input`. */
  multiline?: boolean;
  /** Allow committing an empty value (clearing a description). */
  allowEmpty?: boolean;
  /**
   * The save's correlated mutation (`undefined` until the first one starts).
   * The editor stays open until a save it started succeeds.
   */
  submitState: LoadState<true> | undefined;
  /** The field's accessible name. */
  label: string;
  placeholder?: string | undefined;
  /** Layout classes for the field. */
  className?: string | undefined;
  /** The static display, rendered while not editing. */
  children: ReactNode;
}

/**
 * @component EditableText
 * @purpose Edit a text value in place: renders `children` until the host sets
 * `editing`, then an `Input` (single-line) or `Textarea` (multiline) with Save
 * and Cancel.
 * @useWhen Renaming or rewriting a low-risk text field where it is shown —
 * Task titles and descriptions, Project names, descriptions and URLs.
 * @avoidWhen The edit needs structured fields or validation beyond non-empty;
 * use a form.
 * @intent Single-line saves on Enter and on blur; multiline saves on
 * Cmd/Ctrl+Enter only, so newlines are safe. Escape cancels both. A no-op
 * (unchanged, or empty when not allowed) closes without calling `onSubmit`.
 * The editor stays open while the save runs (Save busy, no repeat save) and
 * closes only once it succeeds; a refusal keeps the draft and shows the error
 * with a retry.
 */
export function EditableText({
  editing,
  children,
  ...props
}: EditableTextProps) {
  if (!editing) return <>{children}</>;
  return <EditableTextEditor {...props} />;
}

function EditableTextEditor({
  value,
  onSubmit,
  onEditingChange,
  multiline = false,
  allowEmpty = false,
  submitState,
  label,
  placeholder,
  className,
}: Omit<EditableTextProps, "editing" | "children">) {
  // Mounted only while editing, so every open starts from the current value.
  const [draft, setDraft] = useState(value);
  // The value this session opened on. The live `value` is no proof of a save:
  // hosts patch their lists optimistically, so it can already read as the
  // draft while that save is refused.
  const [baseline] = useState(value);
  // Whether THIS editing session saved: an error left over from an earlier
  // attempt is not shown on a fresh open.
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The submit must be seen pending before a settled state can close the
  // editor; the state it starts from may be a stale `ready`.
  const awaitingRef = useRef(false);
  const sawPendingRef = useRef(false);
  // Set once the editor closes: removing the focused field can fire a blur,
  // which must not commit a cancelled draft.
  const closedRef = useRef(false);
  const state = submitState ?? IDLE;
  const pending = isPending(state);
  const error = submitted && !pending ? errorOf(state) : undefined;

  const close = () => {
    closedRef.current = true;
    onEditingChange(false);
  };
  const cancel = () => {
    if (!pending) close();
  };
  const commit = () => {
    if (pending || closedRef.current) return;
    const next = multiline ? draft.trimEnd() : draft.trim();
    // After an attempt, a save always goes out: Retry must resend a refused
    // draft even when it matches the (optimistic) value.
    if ((!allowEmpty && next === "") || (!submitted && next === baseline)) {
      close();
      return;
    }
    onSubmit(next);
    awaitingRef.current = true;
    sawPendingRef.current = false;
    setSubmitted(true);
  };

  useEffect(() => {
    const el = multiline ? textareaRef.current : inputRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [multiline]);

  useEffect(() => {
    if (!awaitingRef.current) return;
    if (pending) {
      sawPendingRef.current = true;
      return;
    }
    if (!sawPendingRef.current) return;
    awaitingRef.current = false;
    sawPendingRef.current = false;
    if (errorOf(state)) return;
    closedRef.current = true;
    onEditingChange(false);
  }, [pending, state, onEditingChange]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    } else if (
      event.key === "Enter" &&
      (!multiline || event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      commit();
    }
  };
  // A single-line edit commits when focus leaves the editor, not when it moves
  // to its own Save/Cancel/Retry.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (multiline) return;
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    commit();
  };
  // Pressing an action must not blur the field first (Safari never focuses a
  // clicked button, so the blur would commit before Cancel runs).
  const keepFocus = (event: { preventDefault: () => void }) =>
    event.preventDefault();

  const actions = (
    <>
      <Button
        variant="outline"
        disabled={pending}
        onMouseDown={keepFocus}
        onClick={cancel}
      >
        Cancel
      </Button>
      <Button busy={pending} onMouseDown={keepFocus} onClick={commit}>
        Save
      </Button>
    </>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2" onBlur={onBlur}>
      {multiline ? (
        <>
          <Textarea
            ref={textareaRef}
            value={draft}
            aria-label={label}
            placeholder={placeholder}
            readOnly={pending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            className={className}
          />
          <div className="flex justify-end gap-2">{actions}</div>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            value={draft}
            aria-label={label}
            placeholder={placeholder}
            readOnly={pending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            className={cn("flex-1", className)}
          />
          {actions}
        </div>
      )}
      {error ? <ErrorNote message={error} onRetry={commit} /> : null}
    </div>
  );
}
