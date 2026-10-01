/**
 * One lazy mount point for the worktree lifecycle dialogs (create / merge /
 * remove), driven by the app-level overlay state. Renders nothing when no
 * dialog is open.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ProjectRecord, UIStateWorktreeSlice } from "./overlayTypes.ts";
import {
  CreateWorktreeDialog,
  MergeWorktreeDialog,
  RemoveWorktreeDialog,
} from "./WorktreeDialogs.tsx";
import type { AssistantActions } from "../../hooks/useAssistant.ts";

export interface WorktreeOverlayState {
  createForProjectId: string | null;
  mergeWorktreeId: string | null;
  removeWorktreeId: string | null;
}

interface Props {
  overlay: WorktreeOverlayState;
  onChange: (next: WorktreeOverlayState) => void;
  state: UIStateWorktreeSlice;
  projects: ProjectRecord[];
  actions: AssistantActions;
  onOpenSession: (sessionId: string) => void;
}

export function WorktreeOverlays({
  overlay,
  onChange,
  state,
  projects,
  actions,
  onOpenSession,
}: Props) {
  const close = () =>
    onChange({
      createForProjectId: null,
      mergeWorktreeId: null,
      removeWorktreeId: null,
    });

  /* -------- create: request a proposal when the dialog opens -------- */
  const requestIdRef = useRef<string>("");
  // `actions` is stable for the life of the app (`useAssistant`), so this asks
  // once per opened dialog and never re-asks under the user.
  const proposeName = useCallback(
    (projectId: string) => {
      requestIdRef.current = `wtname-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      actions.proposeWorktreeName({
        projectId,
        requestId: requestIdRef.current,
      });
    },
    [actions],
  );
  useEffect(() => {
    if (overlay.createForProjectId) proposeName(overlay.createForProjectId);
  }, [overlay.createForProjectId, proposeName]);

  const proposal = useMemo(() => {
    const current = state.worktreeNameProposal;
    return current && current.requestId === requestIdRef.current
      ? current.name
      : null;
  }, [state.worktreeNameProposal]);

  if (overlay.createForProjectId) {
    const project = projects.find(
      (item) => item.id === overlay.createForProjectId,
    );
    return (
      <CreateWorktreeDialog
        projectName={project?.name ?? overlay.createForProjectId}
        proposal={proposal}
        onPropose={() => proposeName(overlay.createForProjectId!)}
        onCreate={(name) => {
          actions.createWorktree({
            projectId: overlay.createForProjectId!,
            name,
          });
          close();
        }}
        onClose={close}
      />
    );
  }

  if (overlay.mergeWorktreeId) {
    const worktree = state.worktrees?.find(
      (item) => item.id === overlay.mergeWorktreeId,
    );
    if (!worktree) return null;
    return (
      <MergeWorktreeDialog
        worktree={worktree}
        status={state.worktreeStatuses[worktree.id]}
        defaultStrategy={state.settings.worktrees.defaultMergeStrategy}
        merge={state.worktreeMerge[worktree.id]}
        onMerge={(strategy) => actions.mergeWorktree(worktree.id, strategy)}
        onOpenSession={(sessionId) => {
          close();
          onOpenSession(sessionId);
        }}
        onClose={close}
      />
    );
  }

  if (overlay.removeWorktreeId) {
    const worktree = state.worktrees?.find(
      (item) => item.id === overlay.removeWorktreeId,
    );
    if (!worktree) return null;
    return (
      <RemoveWorktreeDialog
        worktree={worktree}
        status={state.worktreeStatuses[worktree.id]}
        onRemove={({ deleteBranch, force }) => {
          actions.removeWorktree({
            worktreeId: worktree.id,
            deleteBranch,
            force,
          });
          close();
        }}
        onClose={close}
      />
    );
  }

  return null;
}
