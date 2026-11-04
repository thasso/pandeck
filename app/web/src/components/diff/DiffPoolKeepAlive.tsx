import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { POOL_OPTIONS, highlighterOptionsFor } from "./DiffWorkerProvider.tsx";

const OPTIONS = highlighterOptionsFor(false);

/**
 * Holds the shared Pierre worker pool for the life of the app. Mounted (lazily,
 * once the app is idle) by `App`, it does two things the diff surfaces cannot:
 *
 * - WARMS the pool before any diff or file opens. Until the pool's highlighter
 *   has loaded, Pierre draws nothing at all, not even the plain text, so a
 *   cold first open waited on Shiki before showing a single line.
 * - KEEPS it. Pierre terminates the pool when its last provider unmounts, so
 *   leaving a worktree page threw the warm highlighter away and the next one
 *   started cold again.
 *
 * The surfaces' own providers find this same singleton and sync their render
 * options onto it (`DiffWorkerProvider`).
 */
export default function DiffPoolKeepAlive() {
  return (
    <WorkerPoolContextProvider
      poolOptions={POOL_OPTIONS}
      highlighterOptions={OPTIONS}
    >
      {null}
    </WorkerPoolContextProvider>
  );
}
