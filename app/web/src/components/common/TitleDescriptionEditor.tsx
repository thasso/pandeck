import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
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

/** What an edit changed: only the fields that differ are present. */
export type TitleDescriptionChanges = { title?: string; description?: string };

/**
 * @component TitleDescriptionEditor
 * @purpose An object's title and description in one editor, saved together.
 * @useWhen A detail page (Task, Project) edits its heading and body in place,
 *   opened from the action row under the description.
 * @intent Cmd/Ctrl+Enter saves from either field, Escape cancels; it stays open
 *   while the save runs and closes once it succeeds, keeping the draft (with a
 *   retry) when it is refused.
 */
export function TitleDescriptionEditor({
  title,
  description,
  titleLabel,
  descriptionLabel,
  titlePlaceholder = "Title",
  onSave,
  submitState,
  onClose,
}: {
  title: string;
  description: string;
  titleLabel: string;
  descriptionLabel: string;
  titlePlaceholder?: string;
  onSave: (changes: TitleDescriptionChanges) => void;
  submitState: LoadState<true> | undefined;
  onClose: () => void;
}) {
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftDescription, setDraftDescription] = useState(description);
  // What this session opened on: the live values may already be optimistic.
  const [baseline] = useState({ title, description });
  const [submitted, setSubmitted] = useState(false);
  const awaitingRef = useRef(false);
  const sawPendingRef = useRef(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const state = submitState ?? idle<true>();
  const pending = isPending(state);
  const error = submitted && !pending ? errorOf(state) : undefined;

  const cancel = () => {
    if (!pending) onClose();
  };
  const commit = () => {
    if (pending) return;
    const nextTitle = draftTitle.trim();
    const nextDescription = draftDescription.trimEnd();
    if (!nextTitle) return;
    const changes: TitleDescriptionChanges = {};
    if (submitted || nextTitle !== baseline.title) changes.title = nextTitle;
    if (submitted || nextDescription !== baseline.description)
      changes.description = nextDescription;
    if (changes.title === undefined && changes.description === undefined) {
      onClose();
      return;
    }
    onSave(changes);
    awaitingRef.current = true;
    sawPendingRef.current = false;
    setSubmitted(true);
  };

  useEffect(() => {
    if (!awaitingRef.current) return;
    if (pending) {
      sawPendingRef.current = true;
      return;
    }
    if (!sawPendingRef.current) return;
    awaitingRef.current = false;
    sawPendingRef.current = false;
    if (!errorOf(state)) onClose();
  }, [pending, state, onClose]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit();
    }
  };

  return (
    <div className="flex flex-col gap-2" onKeyDown={onKeyDown}>
      <Input
        autoFocus
        value={draftTitle}
        aria-label={titleLabel}
        placeholder={titlePlaceholder}
        readOnly={pending}
        onChange={(event) => setDraftTitle(event.target.value)}
        onKeyDown={(event) => {
          // Enter in the title moves on to the description rather than saving
          // half an edit.
          if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            descriptionRef.current?.focus();
          }
        }}
        className="h-auto py-1.5 text-lg font-semibold md:text-lg"
      />
      <Textarea
        ref={descriptionRef}
        value={draftDescription}
        aria-label={descriptionLabel}
        placeholder="Add a description…"
        readOnly={pending}
        onChange={(event) => setDraftDescription(event.target.value)}
        className="min-h-48 resize-y"
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" disabled={pending} onClick={cancel}>
          Cancel
        </Button>
        <Button busy={pending} disabled={!draftTitle.trim()} onClick={commit}>
          Save
        </Button>
      </div>
      {error ? <ErrorNote message={error} onRetry={commit} /> : null}
    </div>
  );
}
