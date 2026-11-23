/**
 * The hooks the shared mutation applies offer their caller (Task-1463 P6a,
 * PD-6a6): the gateway edge's effects ledger learns which item is running
 * and when a write request is about to be sent. Both are optional and do
 * nothing when absent, so the local tool's requests are unchanged.
 *
 * Every write request of the Jira and Confluence applies passes
 * `jiraWrite`/`confluenceWrite`, which call `beforeWrite` first; reads and
 * the JQL search POST do not.
 *
 * Boundary-clean: imports nothing (`workerBoundary.test.ts`).
 */

/** Where one write request runs. */
export interface WriteScope {
  /** Carried by the request; an abort is never wrapped. */
  signal?: AbortSignal | undefined;
  /** Called just before the request is sent, whether or not it then fails. */
  beforeWrite?(): void;
}

/** What an apply loop reports besides its writes. */
export interface ApplyHooks extends WriteScope {
  /** Called before each item, before its `stopBefore` check. */
  startItem?(index: number): void;
}
