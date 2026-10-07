import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { ErrorNote, Spinner } from "./ui/load.tsx";
import { errorOf, idle, isPending, type LoadState } from "../lib/loadState.ts";

/**
 * @component InlineEdit
 * @purpose Click-to-edit field used in place of separate edit buttons/dialogs. Renders a static display until the user activates it, then swaps in a text input (single-line) or textarea (multiline) editor in place.
 * @useWhen Editing a value directly where it is shown — task titles, descriptions, names, and similar inline edits. Prefer this over an "Edit" button + modal for low-risk text edits.
 * @avoidWhen The edit needs structured fields, validation beyond non-empty, or a destructive/expensive commit; use a dedicated form instead.
 * @intent Single-line commits on Enter (Escape cancels, blur commits). Multiline keeps explicit Save/Cancel buttons (Escape cancels, blur does NOT commit, Cmd/Ctrl+Enter saves) so typing newlines is safe. The component owns its own editing/draft state; the parent only supplies the value and an onSubmit. No-op edits (unchanged, or empty when not allowed) revert without calling onSubmit.
 * @related Markdown (render multiline display as prose), TaskManagementPage.
 */
interface InlineEditProps {
  value: string;
  onSubmit: (next: string) => void;
  /** Render the textarea editor with Save/Cancel buttons instead of a single-line input. */
  multiline?: boolean;
  /** Allow committing an empty value (e.g. clearing a description). Defaults to false. */
  allowEmpty?: boolean;
  disabled?: boolean;
  /** Correlated mutation state; when supplied, keep the draft until success. */
  submitState?: LoadState<true> | undefined;
  ariaLabel?: string;
  placeholder?: string;
  /** Classes for the input/textarea editor element. */
  editorClassName?: string;
  /** Rows for the multiline textarea. */
  rows?: number;
  /**
   * Custom static display. Receives a `begin` callback to enter edit mode.
   * When omitted a default text button is rendered using `displayClassName`.
   */
  renderDisplay?: (begin: () => void) => ReactNode;
  /** Classes for the default display button when `renderDisplay` is not provided. */
  displayClassName?: string;
}

export function InlineEdit({
  value,
  onSubmit,
  multiline = false,
  allowEmpty = false,
  disabled = false,
  submitState,
  ariaLabel,
  placeholder,
  editorClassName,
  rows = 6,
  renderDisplay,
  displayClassName,
}: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const awaitingRef = useRef(false);
  const sawPendingRef = useRef(false);
  const mutationState = submitState ?? idle<true>();
  const submitPending = isPending(mutationState);
  const submitError = errorOf(mutationState);

  const begin = () => {
    if (disabled) return;
    setDraft(value);
    setEditing(true);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  const commit = () => {
    if (submitPending) return;
    const next = multiline ? draft.replace(/\s+$/, "") : draft.trim();
    if (!allowEmpty && next === "") {
      cancel();
      return;
    }
    if (next !== value) {
      if (submitState) {
        awaitingRef.current = true;
        sawPendingRef.current = false;
      }
      onSubmit(next);
      if (submitState) return;
    }
    setEditing(false);
  };

  useEffect(() => {
    if (!editing) return;
    const el = multiline ? textareaRef.current : inputRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [editing, multiline]);

  useEffect(() => {
    if (!awaitingRef.current) return;
    if (submitPending) {
      sawPendingRef.current = true;
      return;
    }
    if (sawPendingRef.current && !submitError) {
      awaitingRef.current = false;
      sawPendingRef.current = false;
      setEditing(false);
    }
  }, [submitError, submitPending]);

  useLayoutEffect(() => {
    if (!editing || !multiline) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, editing, multiline]);

  if (!editing) {
    if (renderDisplay) return <>{renderDisplay(begin)}</>;
    const hasValue = value.trim() !== "";
    return (
      <button
        type="button"
        onClick={begin}
        disabled={disabled}
        aria-label={ariaLabel}
        className={
          displayClassName ??
          `text-left text-body ${hasValue ? "text-fg" : "text-faint"}`
        }
      >
        {hasValue ? value : (placeholder ?? "Add text…")}
      </button>
    );
  }

  if (multiline) {
    return (
      <div className="flex flex-col gap-2">
        <textarea
          ref={textareaRef}
          value={draft}
          rows={rows}
          aria-label={ariaLabel}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
          className={
            editorClassName ??
            "min-h-[8rem] w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-body text-fg outline-none focus:border-primary"
          }
        />
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            disabled={submitPending}
            className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-caption text-muted-foreground hover:bg-panel hover:text-fg disabled:opacity-50"
          >
            <X size={13} /> Cancel
          </button>
          <button
            type="button"
            onClick={commit}
            disabled={submitPending}
            aria-busy={submitPending || undefined}
            className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-caption font-medium text-white hover:bg-primary/90 disabled:opacity-50"
          >
            {submitPending ? <Spinner size="sm" /> : <Check size={13} />} Save
          </button>
        </div>
        {submitError ? <ErrorNote message={submitError} /> : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <input
        ref={inputRef}
        value={draft}
        aria-label={ariaLabel}
        aria-busy={submitPending || undefined}
        disabled={submitPending}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        className={
          editorClassName ??
          "min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-body text-fg outline-none focus:border-primary"
        }
      />
      {submitPending ? (
        <span
          role="status"
          className="inline-flex items-center gap-1 text-caption text-faint"
        >
          <Spinner size="xs" /> Saving…
        </span>
      ) : null}
      {submitError ? <ErrorNote message={submitError} /> : null}
    </div>
  );
}
