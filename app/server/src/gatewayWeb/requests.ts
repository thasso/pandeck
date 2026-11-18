/**
 * What the gateway UI needs of the edge's request log (Task-1430 PR1),
 * defined here as `clients.ts` defines clients: the edge's composition adapts
 * the gateway's `RequestLog` to it.
 *
 * The user always comes from the session, never from the query: another
 * user's records are never read. The query holds only the cursor.
 */
import type { GatewayUiRequests } from "@assistant/shared/gatewayUi";

export interface GatewayWebRequests {
  /**
   * The user's records after `after` in `epoch` (from the oldest kept when
   * the epoch is absent or another), oldest first, at most 500.
   */
  since(
    userId: string,
    epoch: string | undefined,
    after: number,
  ): GatewayUiRequests;
}

const EPOCH_RE = /^[0-9a-f]{32}$/;
/** A seq: digits, no sign or leading zero, at most 15 of them. */
const SEQ_RE = /^(?:0|[1-9][0-9]{0,14})$/;

/**
 * `epoch` and `after` from the query, each optional and at most once, or
 * undefined when one is malformed. Any other parameter (a `userId`) is
 * ignored.
 */
export function decodeRequestsQuery(
  query: URLSearchParams,
): { epoch: string | undefined; after: number } | undefined {
  const epochs = query.getAll("epoch");
  const afters = query.getAll("after");
  if (epochs.length > 1 || afters.length > 1) return undefined;
  const epoch = epochs[0];
  const after = afters[0];
  if (epoch !== undefined && !EPOCH_RE.test(epoch)) return undefined;
  if (after !== undefined && !SEQ_RE.test(after)) return undefined;
  return { epoch, after: after === undefined ? 0 : Number(after) };
}
