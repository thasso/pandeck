/**
 * The one seam through which every write that can change a session-list row
 * (`SessionListItem`) says WHICH rows (`docs/session-list.md`, "Touched
 * rows"). The writer calls it AT THE WRITE SITE, synchronously, inside its
 * transaction when one is open, before the writing function returns, and names
 * every session whose row the write may change, fan-out included: the
 * counterparts of a peer request, a coordinator's other waiting children, the
 * sessions on either end of an edge. Over-touching costs one row rebuild;
 * under-touching leaves a stale row, which the hub's test-mode audit throws on.
 *
 * Deferred reporting (`void import(…).then(…)`, a post-publish listener) is not
 * a touch: another flush could see the change first.
 *
 * In `db/` because stores here never import upward; the hub installs the sink.
 */

interface SessionListSink {
  /** `force` sends the rows even when they equal what was last published. */
  touch(ids: ReadonlySet<string>, force: boolean): void;
  /** A trigger with no bounded id set: every row is rebuilt. */
  touchAll(reason: string): void;
}

let sink: SessionListSink | undefined;

/**
 * Installed once by the hub. With none installed (a store test without a
 * hub) touches are dropped: there is nobody to publish them to. Returns the
 * sink it replaced, so a test recorder can forward to it and put it back.
 */
export function setSessionListSink(
  next: SessionListSink | undefined,
): SessionListSink | undefined {
  const previous = sink;
  sink = next;
  return previous;
}

/** Report the sessions whose list row this write may have changed. */
export function touchSessionRows(
  ids: Iterable<string | null | undefined>,
  opts: { force?: boolean } = {},
): void {
  if (!sink) return;
  const touched = new Set<string>();
  for (const id of ids) if (id) touched.add(id);
  if (touched.size === 0) return;
  sink.touch(touched, Boolean(opts.force));
}

/**
 * Report a change to an input every row reads (a setting, the model catalog).
 * Only for triggers with no bounded id set; a write that knows its sessions
 * names them.
 */
export function touchAllSessionRows(reason: string): void {
  sink?.touchAll(reason);
}
