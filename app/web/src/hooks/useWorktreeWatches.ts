import { useEffect, useState } from "react";
import type { AssistantActions } from "./useAssistant.ts";
import {
  worktreeWatchRegistry,
  type WorktreeWatchRegistry,
} from "../lib/worktreeWatchRegistry.ts";

/**
 * Hold live git-status watches for a set of worktrees while a surface that
 * shows their state is on screen.
 *
 * Every consumer says only what IT needs; the shared registry
 * (`lib/worktreeWatchRegistry.ts`) counts the demands and sends the union. That
 * is not an optimisation: the wire has no refcount, so two surfaces asking for
 * one worktree — a project page and the Projects browser, routinely — would
 * otherwise end with the first one to leave taking the other's watch with it.
 *
 * `connected` is part of the lifecycle rather than a guard on the first send.
 * A watch lives on the WebSocket: the server keeps the ids per connection,
 * drops them with it and replays nothing, so a hook keyed on the ids alone
 * establishes its watches once and goes quiet forever after a reconnect,
 * leaving every marker on screen frozen at whatever it last said. That failure
 * is invisible — the rows still render, they just stop being true.
 */
export function useWorktreeWatches({
  ids,
  connected,
  actions,
  registry = worktreeWatchRegistry,
}: {
  /** Worktree ids to watch. Sorted by the caller, so the key is content. */
  ids: readonly string[];
  connected: boolean;
  actions: AssistantActions;
  /** The app's registry; a test passes its own so the counts start empty. */
  registry?: WorktreeWatchRegistry;
}): void {
  const key = ids.join(",");
  const [lease] = useState(() => registry.lease());

  // Declared FIRST so the registry knows the socket before any demand lands on
  // it, and so a reconnect re-establishes the whole union rather than only the
  // consumers whose ids happened to change.
  useEffect(() => {
    registry.setConnection(connected, actions);
  }, [registry, connected, actions]);

  useEffect(() => {
    lease.set(key ? key.split(",") : []);
  }, [lease, key]);

  useEffect(() => () => lease.release(), [lease]);
}
