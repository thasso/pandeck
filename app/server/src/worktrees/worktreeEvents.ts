/**
 * Broadcaster seam so worktree modules never import `hub.ts` directly (the same
 * inversion as `piStore.setHost`). The hub injects its broadcast function at
 * construction; worktree domain code pushes {@link ServerMessage}s through it.
 */
import type { ServerMessage } from "@assistant/shared";

export interface WorktreeBroadcaster {
  /** Deliver to the connections currently showing worktrees (topic `worktrees`). */
  broadcast(msg: ServerMessage): void;
  /**
   * Deliver to the connections WATCHING one worktree (`watchWorktree`). Status
   * and change lists are per-worktree streams at watcher cadence — the working
   * tree tier pushes a full changed-file list every few hundred ms — so they go
   * to the browsers that asked for that worktree, never to the topic at large.
   */
  broadcastWorktree(worktreeId: string, msg: ServerMessage): void;
}

let broadcaster: WorktreeBroadcaster = {
  broadcast: () => {
    // No hub attached yet (e.g. unit tests); broadcasts are dropped.
  },
  broadcastWorktree: () => {
    // Same.
  },
};

export function setWorktreeBroadcaster(b: WorktreeBroadcaster): void {
  broadcaster = b;
}

export function worktreeBroadcaster(): WorktreeBroadcaster {
  return broadcaster;
}
