import { useCallback, useMemo, useRef } from "react";
import type { AssistantActions } from "./useAssistant.ts";

/** What a surface holding one object's comment threads calls. */
export interface CommentWatch {
  /** Hold this object's threads for as long as the surface is up. */
  list: (id: string) => void;
  /** Give that hold up; the last one to leave unwatches on the wire. */
  unwatch: (id: string) => void;
}

/**
 * Count the surfaces holding one object's comment threads, so the wire sees
 * the union rather than the last opinion.
 *
 * `unwatchComments` is NOT refcounted: it deletes the object's cached threads
 * and takes the subscription away from everyone. Two surfaces on one object is
 * the ordinary case now that the right panel reads the same objects the main
 * pane does — a KB entry open in both, a worktree whose diffs sit beside the
 * session that is writing them — and the panel closing would otherwise blank
 * the comments the reader is looking at in the main pane, with nothing to
 * refill them until that page remounts.
 *
 * Every list/unwatch pair a reading surface makes goes through this; calling
 * the actions directly re-opens the same hole.
 */
function useRefcountedCommentWatch(
  list: (id: string) => void,
  unwatch: (id: string) => void,
): CommentWatch {
  /** object id → how many mounted surfaces want its threads. */
  const holders = useRef(new Map<string, number>());
  /** Ids whose unwatch is queued for this microtask and may still be taken back. */
  const releasing = useRef(new Set<string>());
  // The callbacks keep a stable identity: a surface lists and unwatches from an
  // effect keyed on them, so a fresh identity each render would unsubscribe and
  // resubscribe the object on every App render.
  const transport = useRef({ list, unwatch });
  transport.current = { list, unwatch };

  const acquire = useCallback((id: string) => {
    const held = (holders.current.get(id) ?? 0) + 1;
    holders.current.set(id, held);
    if (held > 1) return;
    // A release queued in this same commit has not reached the wire yet, so the
    // subscription is still live: cancelling that unwatch IS the acquire, and
    // re-listing would only cost a round trip that blanks the threads meanwhile.
    if (releasing.current.delete(id)) return;
    transport.current.list(id);
  }, []);

  const release = useCallback((id: string) => {
    const held = (holders.current.get(id) ?? 0) - 1;
    if (held > 0) {
      holders.current.set(id, held);
      return;
    }
    holders.current.delete(id);
    // Deferred by one microtask, because React runs a commit's cleanups BEFORE
    // its setups: a handoff of one object from one surface to the other (and
    // every StrictMode remount in development) releases before it acquires, and
    // sending the unwatch straight away would drop the cached threads and the
    // server subscription between two surfaces that never both let go.
    releasing.current.add(id);
    queueMicrotask(() => {
      if (!releasing.current.delete(id)) return;
      transport.current.unwatch(id);
    });
  }, []);

  return useMemo(
    () => ({ list: acquire, unwatch: release }),
    [acquire, release],
  );
}

/** The two sends this needs — `AssistantActions`, narrowed to them. */
export type WorktreeCommentWatchTransport = Pick<
  AssistantActions,
  "listWorktreeComments" | "unwatchWorktreeComments"
>;

/**
 * Held by the worktree route and the right panel's Worktree tab, by worktree
 * id. The panel routinely shows the open session's worktree while that same
 * worktree is the routed page, so both hold the one subscription.
 */
export function useWorktreeCommentWatch(
  actions: WorktreeCommentWatchTransport,
): CommentWatch {
  return useRefcountedCommentWatch(
    actions.listWorktreeComments,
    actions.unwatchWorktreeComments,
  );
}
