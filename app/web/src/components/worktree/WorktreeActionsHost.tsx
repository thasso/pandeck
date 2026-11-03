import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  SessionListItem,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import type { InspectorAction } from "../shell/Inspector.tsx";
import { worktreeInspectorActions } from "../objectInspectors.tsx";
import { useWorktreeDelivery } from "./WorktreeDelivery.tsx";
import { useWorktreeRetire } from "./useWorktreeRetire.tsx";

interface WorktreeActionsApi {
  /** Start building this worktree's actions: its menu is about to open. */
  prepare: (worktreeId: string) => void;
  /** The full list once built, else undefined (the row shows its own). */
  actionsFor: (worktreeId: string) => InspectorAction[] | undefined;
}

const WorktreeActionsContext = createContext<WorktreeActionsApi | null>(null);

export function useWorktreeActionsHost(): WorktreeActionsApi | null {
  return useContext(WorktreeActionsContext);
}

const NO_SESSIONS: SessionListItem[] = [];

/**
 * @component WorktreeActionsHostProvider
 * @purpose Give a sidebar worktree row the SAME action list as the worktree
 *   page's `…` menu (delivery, merge back, pull requests, retire, remove), with
 *   the dialogs those actions open.
 * @intent The delivery and retire hooks read hosting state and own their
 *   dialogs, so they cannot run per row: ONE host runs for the worktree whose
 *   menu is about to open (`prepare` on hover or press), and stays mounted so a
 *   dialog it opened outlives the menu that opened it.
 */
export function WorktreeActionsHostProvider({
  worktrees,
  statuses,
  sessions,
  sessionsFresh,
  onStartSession,
  onMerge,
  onRemove,
  children,
}: {
  worktrees: readonly WorktreeRecord[] | null | undefined;
  statuses: Record<string, WorktreeGitStatus>;
  sessions: readonly SessionListItem[] | undefined;
  sessionsFresh: boolean;
  onStartSession: (id: string) => void;
  onMerge: (id: string) => void;
  onRemove: (id: string) => void;
  children: ReactNode;
}) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [built, setBuilt] = useState<{
    id: string;
    actions: InspectorAction[];
  } | null>(null);
  const prepare = useCallback(
    (worktreeId: string) =>
      setTargetId((current) => (current === worktreeId ? current : worktreeId)),
    [],
  );
  const actionsFor = useCallback(
    (worktreeId: string) =>
      built?.id === worktreeId ? built.actions : undefined,
    [built],
  );
  const api = useMemo(() => ({ prepare, actionsFor }), [prepare, actionsFor]);
  const target = targetId
    ? worktrees?.find((worktree) => worktree.id === targetId)
    : undefined;
  return (
    <WorktreeActionsContext.Provider value={api}>
      {children}
      {target ? (
        <WorktreeActionsHost
          key={target.id}
          worktree={target}
          status={statuses[target.id]}
          sessions={sessions ?? NO_SESSIONS}
          sessionsFresh={sessionsFresh}
          onStartSession={onStartSession}
          onMerge={onMerge}
          onRemove={onRemove}
          onActions={setBuilt}
        />
      ) : null}
    </WorktreeActionsContext.Provider>
  );
}

function WorktreeActionsHost({
  worktree,
  status,
  sessions,
  sessionsFresh,
  onStartSession,
  onMerge,
  onRemove,
  onActions,
}: {
  worktree: WorktreeRecord;
  status: WorktreeGitStatus | undefined;
  sessions: readonly SessionListItem[];
  sessionsFresh: boolean;
  onStartSession: (id: string) => void;
  onMerge: (id: string) => void;
  onRemove: (id: string) => void;
  onActions: (built: { id: string; actions: InspectorAction[] }) => void;
}) {
  const delivery = useWorktreeDelivery({
    worktree,
    ...(status !== undefined ? { status } : {}),
  });
  const retire = useWorktreeRetire({
    worktree: worktree.isMain ? undefined : worktree,
    ...(delivery.status !== undefined ? { status: delivery.status } : {}),
    sessions: sessions as SessionListItem[],
    sessionsFresh,
    merged: delivery.hosting?.pr?.state === "merged",
  });
  const actions = useMemo(
    () =>
      worktreeInspectorActions(worktree, {
        onStartSession,
        onMerge,
        onRemove,
        onRetire: retire.open,
        retireBusy: retire.busy,
        deliveryActions: delivery.actions,
      }),
    [
      worktree,
      onStartSession,
      onMerge,
      onRemove,
      retire.open,
      retire.busy,
      delivery.actions,
    ],
  );
  // The delivery list is rebuilt every render, so publishing it as is would
  // re-render the provider, and so this host, without end. Publish only when
  // what a menu SHOWS changes; each item runs the latest handler by key.
  const latest = useRef(actions);
  latest.current = actions;
  const shown = actions
    .map(
      (action) =>
        `${action.key}|${action.label}|${action.disabled ? 1 : 0}|${action.busy ? 1 : 0}|${action.disabledReason ?? ""}|${action.hint ?? ""}`,
    )
    .join("\n");
  useEffect(() => {
    onActions({
      id: worktree.id,
      actions: latest.current.map((action) => ({
        ...action,
        onRun: () =>
          latest.current.find((item) => item.key === action.key)?.onRun(),
      })),
    });
  }, [shown, onActions, worktree.id]);
  return (
    <>
      {delivery.dialogs}
      {retire.dialog}
    </>
  );
}
