import { useState } from "react";
import { EdgeSheet } from "../ui/EdgeSheet.tsx";
import { useMobileLayout } from "../shell/useMobileLayout.ts";

/** Where a bundle of review comments is being sent. */
export type SendCommentsTarget =
  | { kind: "new" }
  /** `additionalPrompt` is the caller's opt-in extra instruction for that session. */
  | { kind: "existing"; sessionId: string; additionalPrompt?: string };

export interface SendCommentsSession {
  id: string;
  title: string;
  /** Already working on this object — offered first. */
  linked?: boolean;
}

/**
 * @component SendCommentsSheet
 * @purpose SUBMIT a review: hand a bundle of comments to a fresh agent session or
 *   to one already running, with an optional message covering the batch.
 * @useWhen Submitting from `CommentBar` (everything pending) or a hand-picked
 *   `ReviewCommentList` selection (a worktree review).
 * @avoidWhen Sending a single thread from inside the content; that keeps its own
 *   inline affordance.
 * @intent Domain-neutral: the caller resolves which sessions exist and which are
 *   already linked, and owns what "submit" does with the target. A bottom SHEET on
 *   a phone (the app's one transient surface at that edge) and a centered card on
 *   a wide layout, rather than a modal that ignores where the thumb is. The
 *   message is offered for an EXISTING session because that send is immediate;
 *   a new session stages an editable draft where the prompt is written anyway.
 */
export function SendCommentsSheet({
  count,
  sessions,
  onClose,
  onSend,
  newLabel = "New session",
  newDetail = "Starts an agent on these comments",
  newSubmitLabel,
  startWithout,
  initialTarget = { kind: "new" },
  intro,
  linkedDetail = "Already on this object",
  withMessage = true,
  verb = "Submit",
  submitLabel = "Submit review",
}: {
  count: number;
  sessions: SendCommentsSession[];
  onClose: () => void;
  onSend: (target: SendCommentsTarget) => void;
  /** What a fresh session means here — the worktree flow stages a draft first. */
  newLabel?: string;
  newDetail?: string;
  /** Submit label while the new-session target is selected. */
  newSubmitLabel?: string;
  /**
   * The way out that is not a review. The primary slot that opened this sheet
   * carries the object's own "start a session" action when nothing is pending,
   * so while comments ARE pending that action has to stay reachable — a review
   * waiting to go must not be the only thing you can start.
   */
  startWithout?: { label: string; onRun: () => void };
  /** The row selected when the sheet opens. */
  initialTarget?: SendCommentsTarget;
  /** What sending means here; the review wording by default. */
  intro?: string;
  /** Row detail for a `linked` session. */
  linkedDetail?: string;
  /** Offer a message for an existing session (a review sends immediately). */
  withMessage?: boolean;
  /** The title's verb: "Submit 3 comments". */
  verb?: string;
  /** Submit label for an existing-session target. */
  submitLabel?: string;
}) {
  const mobile = useMobileLayout();
  const [target, setTarget] = useState<SendCommentsTarget>(initialTarget);
  const [additionalPrompt, setAdditionalPrompt] = useState("");
  const send = () => {
    const trimmed = additionalPrompt.trim();
    onSend(
      target.kind === "existing" && trimmed
        ? { ...target, additionalPrompt: trimmed }
        : target,
    );
    onClose();
  };
  const label = `${count} comment${count === 1 ? "" : "s"}`;
  const body = (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-faint">
        {intro ??
          `The session is linked to this object and can reply, edit and resolve the ${count === 1 ? "thread" : "threads"} you send.`}
      </p>
      <div className="flex max-h-64 flex-col overflow-y-auto">
        <TargetRow
          label={newLabel}
          detail={newDetail}
          selected={target.kind === "new"}
          onSelect={() => setTarget({ kind: "new" })}
        />
        {sessions.map((session) => (
          <TargetRow
            key={session.id}
            label={session.title || session.id}
            detail={session.linked ? linkedDetail : undefined}
            selected={
              target.kind === "existing" && target.sessionId === session.id
            }
            onSelect={() =>
              setTarget({ kind: "existing", sessionId: session.id })
            }
          />
        ))}
      </div>
      {withMessage && target.kind === "existing" ? (
        <textarea
          rows={2}
          value={additionalPrompt}
          onChange={(event) => setAdditionalPrompt(event.target.value)}
          placeholder="Anything to say about this review? (optional)"
          aria-label="Message for this session"
          className="field-sizing-content min-h-16 w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-2 text-prose text-fg outline-none focus:border-line-strong"
        />
      ) : null}
      <div className="flex items-center justify-end gap-2">
        {startWithout ? (
          <button
            type="button"
            onClick={() => {
              startWithout.onRun();
              onClose();
            }}
            className="mr-auto rounded-lg px-3 py-1.5 text-left text-caption text-muted-foreground transition-colors hover:bg-raised hover:text-fg"
          >
            {startWithout.label}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-1.5 text-caption text-muted-foreground transition-colors hover:bg-raised hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={send}
          className="rounded-lg bg-primary px-3 py-1.5 text-caption font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {target.kind === "new" && newSubmitLabel
            ? newSubmitLabel
            : submitLabel}
        </button>
      </div>
    </div>
  );

  if (mobile) {
    return (
      <EdgeSheet open title={`${verb} ${label}`} onClose={onClose}>
        {body}
      </EdgeSheet>
    );
  }
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-line bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="mb-2 text-body font-semibold text-fg">
          {verb} {label}
        </p>
        {body}
      </div>
    </div>
  );
}

function TargetRow({
  label,
  detail,
  selected,
  onSelect,
}: {
  label: string;
  detail?: string | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${selected ? "bg-accent text-primary" : "text-muted-foreground hover:bg-raised hover:text-fg"}`}
    >
      <span
        className={`size-2 shrink-0 rounded-full ${selected ? "bg-primary" : "bg-line"}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-caption">{label}</span>
        {detail ? (
          <span className="block truncate text-micro text-faint">{detail}</span>
        ) : null}
      </span>
    </button>
  );
}
