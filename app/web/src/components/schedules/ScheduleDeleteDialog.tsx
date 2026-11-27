import { useState } from "react";
import { ConfirmDialog } from "../common/dialogs.tsx";
import { ErrorNote } from "../common/load.tsx";
import { errorOf, isPending, type LoadState } from "../../lib/loadState.ts";
import { scheduleFailureReason } from "../../lib/schedules.ts";

/** The Schedule a delete dialog was opened for, captured at that moment. */
export interface ScheduleDeleteTarget {
  id: string;
  name: string;
}

/**
 * @component ScheduleDeleteDialog
 * @purpose The confirmation before a Schedule and its history are deleted.
 * @useWhen The Schedules page or a Schedule's detail asks to delete.
 * @intent The PAGE owns it, with the id and name captured when it opened, so
 *   the optimistic removal of the row does not unmount it: a refusal is shown
 *   here with Try again while recovery restores the row (`docs/schedules.md`,
 *   Web). Busy while the delete is in flight; Cancel then does nothing.
 */
export function ScheduleDeleteDialog({
  target,
  mutation,
  onConfirm,
  onCancel,
}: {
  target: ScheduleDeleteTarget;
  /** `scheduleMutations["<id>:delete"]`. */
  mutation: LoadState<true> | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Only this opening's own attempt: a refusal left from an earlier one was
  // shown then and is not this dialog's to repeat.
  const [attempted, setAttempted] = useState(false);
  const busy = mutation !== undefined && isPending(mutation);
  const error = attempted && mutation ? errorOf(mutation) : undefined;
  const confirm = () => {
    setAttempted(true);
    onConfirm();
  };
  return (
    <ConfirmDialog
      title={`Delete "${target.name}"?`}
      body="This deletes the Schedule and its history. To keep them, switch it off instead."
      confirmLabel="Delete"
      cancelLabel="Cancel"
      danger
      busy={busy}
      onConfirm={confirm}
      onCancel={onCancel}
    >
      {error && !busy ? (
        <ErrorNote
          className="mt-2"
          message={`Couldn't delete: ${scheduleFailureReason(error)}`}
          onRetry={confirm}
          retryLabel="Try again"
        />
      ) : null}
    </ConfirmDialog>
  );
}
