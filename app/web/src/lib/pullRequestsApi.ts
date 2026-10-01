/**
 * The Pull Requests view's ONE read — `GET /api/pull-requests` — and its
 * writes: `POST /api/pull-requests/merge` and `POST /api/pull-requests/checkout`.
 *
 * Not worktree endpoints, so they do not live in `worktrees.ts`. The server
 * builds the whole inventory — selection, CI, review, mergeability and the
 * local join ids — in a persisted snapshot refreshed by the server in the
 * background (`docs/pull-requests.md`), so the client makes exactly this local
 * request and joins the ids against lists it already holds. The write addresses
 * a pull request the same way the read reports it:
 * by the four-component identity, with everything else re-derived server-side.
 */
import type {
  PullRequestInventoryResponse,
  PullRequestViewCheckRequest,
  PullRequestViewCheckResponse,
  PullRequestViewCheckoutRequest,
  PullRequestViewCheckoutResponse,
  PullRequestViewMergeRequest,
  PullRequestViewMergeResponse,
} from "@assistant/shared";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

export async function fetchPullRequestInventory(
  signal?: AbortSignal,
): Promise<PullRequestInventoryResponse> {
  return json(
    await fetch(`${serverHttpOrigin()}/api/pull-requests`, {
      headers: { ...authHeaders() },
      ...(signal ? { signal } : {}),
    }),
  );
}

/**
 * A request the SERVER answered, with a refusal. It is a different fact from a
 * request that never came back, and the difference decides what a surface may
 * say: the endpoint performs no side effect it cannot report, so an answered
 * refusal means nothing landed, while a dropped response means the action's
 * outcome is UNKNOWN and must not be re-offered as though it had not run.
 */
export class PullRequestApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PullRequestApiError";
  }
}

/**
 * Merge & clean up. A 200 reports what each PHASE did — a cleanup that refused
 * still answers here, beside a merge that landed — so an answered refusal of
 * the whole action throws `PullRequestApiError`, and anything else that throws
 * (no response, an aborted or failed connection) left the outcome unknown.
 */
export async function mergePullRequestFromView(
  request: PullRequestViewMergeRequest,
): Promise<PullRequestViewMergeResponse> {
  return json(
    await fetch(`${serverHttpOrigin()}/api/pull-requests/merge`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(request),
    }),
  );
}

/**
 * What this pull request IS, read under its own mutation lock. The answer a
 * client whose merge went unanswered needs: it attempts nothing, so unlike a
 * re-issued merge it cannot be refused by a guard that has since turned against
 * the merge (a draft, a conflict, a method the repository stopped allowing) —
 * and acquiring the lock proves the unanswered request has finished.
 */
export async function checkPullRequestFromView(
  request: PullRequestViewCheckRequest,
): Promise<PullRequestViewCheckResponse> {
  return json(
    await fetch(`${serverHttpOrigin()}/api/pull-requests/check`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(request),
    }),
  );
}

/**
 * The review workflow's local half: create or update the worktree that stands
 * on this pull request's head branch.
 *
 * A 200 always describes what happened, including "nothing, and here is why":
 * a dirty or diverged checkout, a head that is not on this remote, two
 * checkouts on the branch. Those are outcomes of the pull request, not failures
 * of the request, so they arrive as `outcome.status === "refused"` and are
 * rendered on the object. A throw is a request that was refused outright (a
 * busy pull request, an identity that resolves to nothing) or never answered.
 */
export async function checkoutPullRequestFromView(
  request: PullRequestViewCheckoutRequest,
): Promise<PullRequestViewCheckoutResponse> {
  return json(
    await fetch(`${serverHttpOrigin()}/api/pull-requests/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(request),
    }),
  );
}

async function json<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (body as { error?: unknown }).error;
    throw new PullRequestApiError(
      typeof error === "string" ? error : `Request failed (${res.status})`,
      res.status,
    );
  }
  return body as T;
}
