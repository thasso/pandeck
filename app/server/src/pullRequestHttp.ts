/**
 * HTTP surface for the Pull Requests view: GET `/api/pull-requests`, the whole
 * inventory in one request, POST `/api/pull-requests/merge` and
 * `/api/pull-requests/checkout`, its two actions, and
 * POST `/api/pull-requests/check`, the state read that answers a client whose
 * action went unanswered.
 *
 * The GET is a local persisted-snapshot read. Provider calls belong to
 * `pullRequestInventorySync.ts`, which refreshes that cache independently of
 * whether a browser has this view open. The actions live beside it because they
 * address a pull request the same way the read does: by identity, not by card
 * or by worktree. Auth/CORS are applied centrally in `index.ts` before this
 * handler runs.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GIT_HOSTING_PROVIDER_KINDS,
  PULL_REQUEST_MERGE_METHODS,
  type GitHostingProviderKind,
  type PullRequestInventoryResponse,
  type PullRequestMergeMethod,
  type PullRequestViewCheckRequest,
  type PullRequestViewCheckoutRequest,
  type PullRequestViewMergeRequest,
} from "@assistant/shared";
import { BACKGROUND_PR_SYNC_ENABLED } from "./config.ts";
import { errorText } from "./errors.ts";
import {
  readJsonBody,
  sendJson as json,
  type HeaderFactory,
} from "./httpJson.ts";
import {
  pullRequestInventoryResponse,
  readPullRequestInventorySnapshot,
} from "./pullRequestInventorySnapshot.ts";
import { refreshPullRequestInventorySnapshot } from "./pullRequestInventorySync.ts";
import { checkoutPullRequestFromView } from "./pullRequestViewCheckout.ts";
import {
  checkPullRequestFromView,
  mergePullRequestFromView,
  PullRequestViewMergeError,
} from "./pullRequestViewMerge.ts";

const MAX_BODY_BYTES = 16 * 1024;

export async function handlePullRequestApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  headers: HeaderFactory,
): Promise<void> {
  if (url.pathname === "/api/pull-requests/merge") {
    await handleMerge(req, res, headers);
    return;
  }
  if (url.pathname === "/api/pull-requests/check") {
    await handleCheck(req, res, headers);
    return;
  }
  if (url.pathname === "/api/pull-requests/checkout") {
    await handleCheckout(req, res, headers);
    return;
  }
  if (url.pathname !== "/api/pull-requests") {
    json(req, res, headers, 404, { error: "Not found" });
    return;
  }
  if (req.method !== "GET") {
    json(req, res, headers, 405, { error: "Method not allowed" });
    return;
  }
  try {
    const snapshot = readPullRequestInventorySnapshot();
    if (!snapshot) {
      json(req, res, headers, 200, {
        status: "cold",
        items: [],
        fetchedAt: null,
      } satisfies PullRequestInventoryResponse);
      return;
    }
    json(
      req,
      res,
      headers,
      200,
      pullRequestInventoryResponse(
        snapshot,
      ) satisfies PullRequestInventoryResponse,
    );
  } catch (err) {
    json(req, res, headers, 500, { error: errorText(err) });
  }
}

async function handleMerge(
  req: IncomingMessage,
  res: ServerResponse,
  headers: HeaderFactory,
): Promise<void> {
  if (req.method !== "POST") {
    json(req, res, headers, 405, { error: "Method not allowed" });
    return;
  }
  let request: PullRequestViewMergeRequest;
  try {
    request = parseMergeRequest(await readJsonBody(req, MAX_BODY_BYTES));
  } catch (err) {
    json(req, res, headers, 400, { error: errorText(err) });
    return;
  }
  await answer(req, res, headers, () =>
    runThenRefreshInventory(() => mergePullRequestFromView(request)),
  );
}

/**
 * `POST /api/pull-requests/check` — what this pull request is, under its lock.
 * A POST because it takes that lock, not because it writes: it attempts
 * nothing, which is exactly why a client whose merge went unanswered can always
 * get an answer out of it.
 */
async function handleCheck(
  req: IncomingMessage,
  res: ServerResponse,
  headers: HeaderFactory,
): Promise<void> {
  if (req.method !== "POST") {
    json(req, res, headers, 405, { error: "Method not allowed" });
    return;
  }
  let request: PullRequestViewCheckRequest;
  try {
    request = parseIdentity(await readJsonBody(req, MAX_BODY_BYTES));
  } catch (err) {
    json(req, res, headers, 400, { error: errorText(err) });
    return;
  }
  await answer(req, res, headers, () => checkPullRequestFromView(request));
}

/**
 * `POST /api/pull-requests/checkout` — create or update the local worktree for
 * this pull request, the local half of the review workflow. Same identity, same
 * lock, and its git refusals travel as DATA in the 200: a dirty or diverged
 * checkout is a fact about this pull request, not a failed request.
 */
async function handleCheckout(
  req: IncomingMessage,
  res: ServerResponse,
  headers: HeaderFactory,
): Promise<void> {
  if (req.method !== "POST") {
    json(req, res, headers, 405, { error: "Method not allowed" });
    return;
  }
  let request: PullRequestViewCheckoutRequest;
  try {
    request = parseIdentity(await readJsonBody(req, MAX_BODY_BYTES));
  } catch (err) {
    json(req, res, headers, 400, { error: errorText(err) });
    return;
  }
  await answer(req, res, headers, () =>
    runThenRefreshInventory(() => checkoutPullRequestFromView(request)),
  );
}

/**
 * Give a mutation's background refresh a short chance to land before the
 * client performs its following local GET. Never hold an already-completed
 * provider mutation open for a whole inventory fan-out, and never let cache
 * bookkeeping report that mutation as failed.
 */
async function runThenRefreshInventory<T>(run: () => Promise<T>): Promise<T> {
  const result = await run();
  if (!BACKGROUND_PR_SYNC_ENABLED) return result;

  const refresh = refreshPullRequestInventorySnapshot().catch((err) =>
    console.warn(
      "[pull-requests] post-action inventory refresh failed:",
      errorText(err),
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 2_000);
    timer.unref?.();
  });
  await Promise.race([refresh, deadline]);
  if (timer) clearTimeout(timer);
  return result;
}

/** One status classification for both, so they cannot disagree about a refusal. */
async function answer(
  req: IncomingMessage,
  res: ServerResponse,
  headers: HeaderFactory,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    json(req, res, headers, 200, await run());
  } catch (err) {
    const message = errorText(err);
    json(
      req,
      res,
      headers,
      err instanceof PullRequestViewMergeError
        ? err.status
        : // The mutation lock's refusal: another surface owns this pull request
          // right now, and the loser is refused rather than queued.
          /is busy:/i.test(message)
          ? 409
          : 500,
      { error: message },
    );
  }
}

/**
 * The whole identity, REQUIRED: a body missing one of its four components
 * addresses more than one pull request, which is the confusion
 * `pullRequestIdentity.ts` exists to prevent. Shared by both entry points,
 * because both address a pull request the same way.
 */
function parseIdentity(body: unknown): PullRequestViewCheckRequest {
  const value = (body ?? {}) as Record<string, unknown>;
  const text = (field: string): string => {
    const raw = value[field];
    if (typeof raw !== "string" || !raw.trim())
      throw new Error(`Invalid pull request identity: ${field} is required.`);
    return raw.trim();
  };
  const provider = text("provider");
  if (!GIT_HOSTING_PROVIDER_KINDS.some((kind) => kind === provider))
    throw new Error(`Unknown git hosting provider: ${provider}.`);
  const number = value["number"];
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0)
    throw new Error("Invalid pull request number.");
  return {
    projectId: text("projectId"),
    provider: provider as GitHostingProviderKind,
    repositoryKey: text("repositoryKey").toLowerCase(),
    number,
  };
}

/** The identity plus everything the merge decides; every field validated. */
function parseMergeRequest(body: unknown): PullRequestViewMergeRequest {
  const value = (body ?? {}) as Record<string, unknown>;
  const flag = (field: string): boolean | undefined => {
    const raw = value[field];
    if (raw === undefined) return undefined;
    if (typeof raw !== "boolean")
      throw new Error(`Invalid ${field}: expected a boolean.`);
    return raw;
  };
  const identity = parseIdentity(body);
  const method = value["method"];
  if (
    method !== undefined &&
    !PULL_REQUEST_MERGE_METHODS.some((known) => known === method)
  )
    throw new Error("Invalid merge method: choose squash, merge or rebase.");
  const deleteRemoteBranch = flag("deleteRemoteBranch");
  const removeWorktree = flag("removeWorktree");
  const forceRemoveWorktree = flag("forceRemoveWorktree");
  return {
    ...identity,
    ...(method ? { method: method as PullRequestMergeMethod } : {}),
    ...(deleteRemoteBranch !== undefined ? { deleteRemoteBranch } : {}),
    ...(removeWorktree !== undefined ? { removeWorktree } : {}),
    ...(forceRemoveWorktree !== undefined ? { forceRemoveWorktree } : {}),
  };
}
