import { useState } from "react";
import { EdgeSheet } from "../common/EdgeSheet.tsx";
import { useMobileLayout } from "../shell/useMobileLayout.ts";
import { Button } from "../ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "../ui/field.tsx";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group.tsx";
import { Textarea } from "../ui/textarea.tsx";

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
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {intro ??
          `The session is linked to this object and can reply, edit and resolve the ${count === 1 ? "thread" : "threads"} you send.`}
      </p>
      <RadioGroup
        value={target.kind === "new" ? NEW_TARGET : target.sessionId}
        onValueChange={(value) =>
          setTarget(
            value === NEW_TARGET
              ? { kind: "new" }
              : { kind: "existing", sessionId: value as string },
          )
        }
        className="max-h-64 overflow-y-auto"
      >
        <TargetOption value={NEW_TARGET} label={newLabel} detail={newDetail} />
        {sessions.map((session) => (
          <TargetOption
            key={session.id}
            value={session.id}
            label={session.title || session.id}
            detail={session.linked ? linkedDetail : undefined}
          />
        ))}
      </RadioGroup>
      {withMessage && target.kind === "existing" ? (
        <Textarea
          rows={2}
          value={additionalPrompt}
          onChange={(event) => setAdditionalPrompt(event.target.value)}
          placeholder="Anything to say about this review? (optional)"
          aria-label="Message for this session"
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {startWithout ? (
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => {
              startWithout.onRun();
              onClose();
            }}
          >
            {startWithout.label}
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={send}>
          {target.kind === "new" && newSubmitLabel
            ? newSubmitLabel
            : submitLabel}
        </Button>
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
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {verb} {label}
          </DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

/** The new-session option's value; session ids never collide with it. */
const NEW_TARGET = "\u0000new";

function TargetOption({
  value,
  label,
  detail,
}: {
  value: string;
  label: string;
  detail?: string | undefined;
}) {
  return (
    <FieldLabel>
      <Field orientation="horizontal">
        <RadioGroupItem value={value} />
        <FieldContent className="min-w-0">
          <FieldTitle className="w-full truncate">{label}</FieldTitle>
          {detail ? <FieldDescription>{detail}</FieldDescription> : null}
        </FieldContent>
      </Field>
    </FieldLabel>
  );
}
