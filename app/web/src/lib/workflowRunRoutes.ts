/**
 * Addressing ONE Workflow Run: `/tasks/:taskId#workflow-run-:runId`.
 *
 * A run is not an object route of its own — it belongs to its Task, and the
 * Task page is where its evidence and its controls are — so the run is a
 * FRAGMENT, exactly as one message of a session is (`lib/sessionRoutes.ts`).
 * The route shape stays canonical, the address survives a reload and a share,
 * and the Sessions inbox has one place to send the user that is the run itself
 * rather than the list it is in.
 *
 * The fragment is an address, never the mechanism: the Task page's runs arrive
 * after two asynchronous loads, so nothing here relies on the browser's native
 * fragment scrolling, which resolves once and gives up.
 */

/** The DOM id the Task page's Workflow card carries for `runId`. */
export function workflowRunAnchorId(runId: string): string {
  return `workflow-run-${runId}`;
}

/** `/tasks/<taskId>#workflow-run-<runId>`. */
export function workflowRunPath(taskId: string, runId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}#workflow-run-${encodeURIComponent(runId)}`;
}

/** The run id a `#workflow-run-<id>` fragment addresses, or null for any other. */
export function runIdFromHash(hash: string): string | null {
  const match = hash.match(/^#workflow-run-(.+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
