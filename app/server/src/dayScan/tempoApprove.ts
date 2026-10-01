import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import {
  beginExecuting,
  cancelProposal,
  declineProposal,
  finishExecuting,
  getProposal,
  requestApproval,
  type TempoProposalRow,
} from "../db/tempoPlanStore.ts";
import { submitDayTempoRow } from "../tools/tempo/tempoTools.ts";
import {
  readTempoProfile,
  upsertProfileMapping,
  writeTempoProfile,
} from "./tempoProfile.ts";

/**
 * Day-scan Tempo approval driver: turns a UI approve/cancel into the serialized
 * state-machine transitions and the real Tempo write, so exactly one outcome
 * wins per row (plan Decision #7). Approval-time validation happens inside
 * `submitDayTempoRow` (Jira issue key + activity), and the `pending-approval →
 * executing` CAS guarantees a racing cancel cannot double-submit.
 */

export interface TempoApproveResult {
  ok: boolean;
  row: TempoProposalRow | null;
  error?: string;
}

export async function approveAndSubmitTempoRow(
  store: KnowledgeBaseStore,
  rowId: string,
): Promise<TempoApproveResult> {
  const row = getProposal(rowId);
  if (!row) return { ok: false, row: null, error: "Tempo proposal not found." };

  // proposed/user-edited → pending-approval (idempotent if already pending).
  requestApproval(rowId, null);
  // The winning CAS. If a cancel/drop already moved the row, this returns false.
  if (!beginExecuting(rowId)) {
    return {
      ok: false,
      row: getProposal(rowId),
      error:
        "This Tempo row is no longer approvable (cancelled or already submitting).",
    };
  }

  try {
    const current = getProposal(rowId)!;
    const worklogId = await submitDayTempoRow(current);
    finishExecuting(rowId, "executed", worklogId);
    // Learn the meeting → issue mapping from a confirmed submission (best-effort).
    if (current.description) {
      try {
        const profile = await readTempoProfile(store);
        await writeTempoProfile(
          store,
          upsertProfileMapping(profile, {
            titleMatch: current.description,
            issueKey: current.issueKey,
            ...(current.activityKey != null
              ? { activityKey: current.activityKey }
              : {}),
          }),
        );
      } catch {
        /* profile learning is best-effort */
      }
    }
    return { ok: true, row: getProposal(rowId) };
  } catch (err) {
    // Once executing, cancellation is refused; a write failure lands as `failed`
    // (never silently "no write" — an external Tempo write may have partially applied).
    finishExecuting(rowId, "failed");
    return {
      ok: false,
      row: getProposal(rowId),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Cancel/drop a row. Wins only from a pre-execution state; refused once executing. */
export function cancelTempoRow(rowId: string): TempoApproveResult {
  const won = cancelProposal(rowId);
  return {
    ok: won,
    row: getProposal(rowId),
    ...(!won
      ? {
          error:
            "This Tempo row can no longer be cancelled (already submitting/submitted).",
        }
      : {}),
  };
}

/**
 * User-facing DECLINE (Task 144): the deliberate "don't log this" button on the
 * approval card. Terminal and distinct from a proactive cancel; refused once
 * executing. A declined row survives re-runs and is never re-proposed.
 */
export function declineTempoRow(rowId: string): TempoApproveResult {
  const won = declineProposal(rowId);
  return {
    ok: won,
    row: getProposal(rowId),
    ...(!won
      ? {
          error:
            "This Tempo row can no longer be declined (already submitting/submitted).",
        }
      : {}),
  };
}
