/**
 * Server-side PR observer for live `/pr` cards (Task 323, stage 2). Adaptive
 * poller over every `open` {@link import("./pullRequestCards.ts")} card: FAST
 * while CI is still running (or unknown), SLOW once CI has concluded and the
 * card is merely awaiting review/merge — but FAST again while a workflow run is
 * parked on a mergeability this poll is the only thing that can answer — and it
 * stops polling a card the moment it leaves `open` (`merged`/`closed`) or
 * crosses its hard lifetime cap.
 *
 * Runs WITHOUT a viewer — CI can conclude and web-push notifications must fire
 * whether or not a browser tab has the session open — reusing the same
 * `hostingProviderForRepo` + provider calls the interactive hosting status path
 * uses, so a repo a viewer is ALSO looking at shares the provider's own
 * request pattern rather than doubling it. It also outlives the card's
 * CHECKOUT, through `pullRequestHosting.ts`: a removed worktree is the ordinary
 * end of a delivery, and a card that stops being observed there stays `open`
 * forever and holds whatever waits on it awake.
 *
 * Reconciled on boot (`reconcilePullRequestCardsOnBoot`, mirrors
 * `reconcileWorktreeMergesOnBoot`): every still-open card is polled again once
 * the process comes back up, so a conclusion that happened while the server was
 * down is not missed.
 */
import type { PullRequestCard, PullRequestCardStatus } from "@assistant/shared";
import {
  hostingProviderForRepo,
  repositoryCapabilitiesFor,
  type GitHostingProvider,
} from "./gitHosting.ts";
import {
  beginPullRequestCardObservation,
  openPullRequestCards,
  patchPullRequestCardObservation,
  pullRequestCardRecord,
} from "./pullRequestCards.ts";
import { pullRequestCardRepoRoot } from "./pullRequestHosting.ts";
import {
  pullRequestMutationInProgress,
  suggestLinkedTaskDone,
} from "./pullRequestMerge.ts";
import {
  observePullRequestCardForWorkflows,
  workflowObservationArmedForCard,
} from "./workflow/pullRequestObservation.ts";
import { sessionIsDirectlyOwned } from "./sessionOutcomePolicy.ts";
import {
  deliverAppNotification,
  pullRequestCiConclusionNotification,
  type AppWebPushNotification,
} from "./webPush.ts";

/* --------------------------- injectable seams ------------------------------
 * Both default to the real implementations; tests swap them for a fake
 * provider / notification sink instead of touching the network. */

type ProviderResolver = (
  repoPath: string,
  remote?: string,
) => Promise<GitHostingProvider | null>;
let resolveProvider: ProviderResolver = hostingProviderForRepo;

/** Test seam: resolve the hosting provider without a real remote/git call. */
export function setPullRequestWatcherProviderResolverForTests(
  resolver: ProviderResolver | null,
): void {
  resolveProvider = resolver ?? hostingProviderForRepo;
}

type NotifySender = (notification: AppWebPushNotification) => Promise<void>;
let notify: NotifySender = deliverAppNotification;

/** Test seam: capture/skip the actual push send. */
export function setPullRequestWatcherNotifierForTests(
  sender: NotifySender | null,
): void {
  notify = sender ?? deliverAppNotification;
}

let isSessionDirectlyOwned = sessionIsDirectlyOwned;

/** Test seam: decide whether the card's session belongs directly to the user. */
export function setPullRequestWatcherSessionOwnershipForTests(
  predicate: ((sessionId: string) => boolean) | null,
): void {
  isSessionDirectlyOwned = predicate ?? sessionIsDirectlyOwned;
}

/** How often the sweeper looks for cards due a poll. */
const SWEEP_INTERVAL_MS = 15_000;
/** Cadence while CI is running (or its state is not yet known). */
const FAST_POLL_MS = 20_000;
/** Cadence once CI has concluded and the card is merely awaiting review/merge. */
const SLOW_POLL_MS = 5 * 60_000;
/**
 * A GitHub card's ONLY cadence, running CI and failed reads included: each
 * poll is four or five REST requests out of the 5,000/hour every agent tool
 * shares, and a 20 s poll per card spent up to 900 of them an hour.
 */
const GITHUB_POLL_MS = 5 * 60_000;
/** A card open longer than this stops being polled; it is not abandoned, just no longer live. */
const HARD_LIFETIME_MS = 30 * 24 * 60 * 60_000;
/** At most this many provider conversations at once. */
const CONCURRENCY = 3;
/** A base conflict is claimed only once a SECOND consecutive read reproduces it. */
const CONFLICT_CONFIRMING_READS = 2;

let sweeper: ReturnType<typeof setInterval> | undefined;
/** Next-due schedule, in-memory only — rebuilt by `reconcilePullRequestCardsOnBoot` on restart. */
const nextPollAt = new Map<string, number>();
const inFlight = new Set<string>();
/** Consecutive `mergeable: false` reads per card, with the head they concern. */
const unmergeableReads = new Map<string, { headSha: string; reads: number }>();

function ciConcluded(card: PullRequestCard): boolean {
  return Boolean(card.ci) && card.ci!.state !== "pending";
}

/** How soon a card whose read did not answer is asked again. */
function retryIntervalFor(card: PullRequestCard): number {
  return card.provider === "github" ? GITHUB_POLL_MS : FAST_POLL_MS;
}

function intervalFor(card: PullRequestCard): number {
  if (card.provider === "github") return GITHUB_POLL_MS;
  if (!ciConcluded(card)) return FAST_POLL_MS;
  // A workflow run parked on this card is blocked on exactly one field, and an
  // unresolved mergeability is the one thing no other event announces: a
  // conflict check settling, or the second read that confirms a conflict. Five
  // minutes of a blocked run per poll is the cost the slow cadence charges
  // there, so keep such a card fast until its mergeability is answered.
  return card.mergeable !== true && workflowObservationArmedForCard(card.id)
    ? FAST_POLL_MS
    : SLOW_POLL_MS;
}

/**
 * Does the provider's `mergeable: false` amount to a CONFLICT the card may
 * state? A single `false` does not: Forgejo answers it while a conflict check
 * is queued (and for a draft, which the provider seam already maps to `null`),
 * and reading that as terminal paused a workflow run on a phantom conflict
 * (Task 535). A second consecutive read of the same head is the confirmation.
 */
function conflictConfirmed(
  card: PullRequestCard,
  observedHeadSha: string | undefined,
  detail: { mergeable: boolean | null; headSha: string },
): boolean {
  if (detail.mergeable !== false) {
    unmergeableReads.delete(card.id);
    return false;
  }
  const previous = unmergeableReads.get(card.id);
  const reads = previous?.headSha === detail.headSha ? previous.reads + 1 : 1;
  unmergeableReads.set(card.id, { headSha: detail.headSha, reads });
  // A conflict the card already states IS the earlier read: after a restart
  // the in-memory count is gone, and un-saying a confirmed conflict only to
  // repeat it one poll later would flicker the card for no new information.
  return (
    reads >= CONFLICT_CONFIRMING_READS ||
    (card.conflicts === true && observedHeadSha === detail.headSha)
  );
}

function forgetCard(cardId: string): void {
  nextPollAt.delete(cardId);
  unmergeableReads.delete(cardId);
}

/** Poll this card on the next sweep instead of waiting out its current interval. */
export function scheduleImmediatePoll(cardId: string): void {
  nextPollAt.set(cardId, 0);
}

async function pollCard(cardId: string): Promise<void> {
  const record = pullRequestCardRecord(cardId);
  if (!record || record.card.status !== "open") {
    // Gone, or already left `open` — `openPullRequestCards()` will not offer it
    // again, so there is nothing to reschedule.
    forgetCard(cardId);
    return;
  }
  // A merge or update owns the provider head. Polls already in flight are
  // invalidated by that action's observation generation; do not start a newer
  // read of the old head while the mutation is still running.
  if (
    record.card.busyAction === "merge" ||
    record.card.busyAction === "update-with-main"
  ) {
    nextPollAt.set(cardId, Date.now() + FAST_POLL_MS);
    return;
  }
  const number = record.card.number;
  if (number === undefined) {
    // `open` should always carry a number (only `finalizePullRequestCard` sets
    // it, together with `number`), but a malformed/corrupted record must not
    // spin: `openPullRequestCards()` keeps offering this id every sweep, so
    // deleting its schedule would poll it again in 15s forever. Retry slowly
    // instead — it can only be fixed out of band.
    nextPollAt.set(cardId, Date.now() + SLOW_POLL_MS);
    return;
  }
  const { card, context } = record;
  // Through the main checkout when this card's own worktree has been removed:
  // the pull request outlives its checkout, and a card that can no longer be
  // observed freezes in `open` forever (`pullRequestHosting.ts`).
  const repoRoot = pullRequestCardRepoRoot({
    repoRoot: context.repoRoot,
    ...(card.worktreeId ? { worktreeId: card.worktreeId } : {}),
  });
  const provider = await resolveProvider(repoRoot, context.remote);
  if (!provider) {
    // No provider (settings changed, repo moved) — retry slowly rather than spin.
    nextPollAt.set(cardId, Date.now() + SLOW_POLL_MS);
    return;
  }
  if (
    await pullRequestMutationInProgress({
      repoPath: repoRoot,
      providerKind: provider.kind,
      number,
    })
  ) {
    nextPollAt.set(cardId, Date.now() + FAST_POLL_MS);
    return;
  }
  const observationToken = beginPullRequestCardObservation(cardId);

  const detail = await provider.pullRequestDetail(number);
  if (!detail) {
    nextPollAt.set(cardId, Date.now() + retryIntervalFor(card));
    return;
  }

  const ci = await provider.ciStatus(detail.headSha);
  const review =
    detail.state === "open" ? await provider.pullRequestReview(number) : null;
  // What the repository allows decides which methods the card's merge picker
  // may offer, so it rides along with the poll (its own cache coalesces the
  // reads). Unknown stays unknown: the picker then offers nothing rather than
  // a method the backend would refuse.
  const repositoryCapabilities =
    detail.state === "open" && !detail.merged
      ? await repositoryCapabilitiesFor(provider)
      : undefined;

  // Dedup key is the (PR, headSha) pair, not a pending→concluded transition: a
  // rebase's new head can report an already-concluded CI on its very first
  // poll, and that must still notify once — `notifiedHeadSha` is what makes
  // "once per SHA" true regardless of how the old SHA's CI resolved.
  const nowConcluded = Boolean(ci) && ci!.state !== "pending";
  const shouldNotify =
    nowConcluded && context.notifiedHeadSha !== detail.headSha;

  const status: PullRequestCardStatus = detail.merged
    ? "merged"
    : detail.state === "closed"
      ? "closed"
      : "open";

  // The dedupe key is recorded BEFORE the send, not after: a transient push
  // failure then permanently forfeits that one SHA's notification rather than
  // retrying it every poll. That is the intended trade — never double-notify a
  // live SHA beats occasionally missing one, and the card itself still shows
  // the CI result regardless of whether the push arrived.
  const updated = patchPullRequestCardObservation(
    cardId,
    observationToken,
    {
      status,
      // Clear a draft that became ready outside this session too (provider UI
      // or a generic PR tool). Omission would leave the old draft flag stuck.
      draft: detail.draft ? true : undefined,
      mergeable: detail.mergeable,
      conflicts: conflictConfirmed(card, context.observedHeadSha, detail),
      // A head other than the one the agent inherited means the branch was
      // republished: the rebase it was handed is over (or someone else moved
      // it), so the card stops claiming the agent still holds it. With no
      // baseline recorded — nothing observed and no local read at handoff —
      // this poll cannot tell the inherited head from a rebased one, so it
      // hands the button back rather than disabling it on a guess.
      ...(card.rebaseHandedOff &&
      context.rebaseHandoffHeadSha !== detail.headSha
        ? { rebaseHandedOff: undefined }
        : {}),
      ...(ci ? { ci } : {}),
      ...(review ? { review } : {}),
      ...(repositoryCapabilities ? { repositoryCapabilities } : {}),
    },
    {
      observedHeadSha: detail.headSha,
      ...(shouldNotify ? { notifiedHeadSha: detail.headSha } : {}),
    },
  );
  if (!updated) return;

  const workflowObservation = await observePullRequestCardForWorkflows(
    updated,
    detail.headSha,
  ).catch(() => ({ settled: 0, suppressCiNotification: false }));

  if (
    shouldNotify &&
    ci &&
    !workflowObservation.suppressCiNotification &&
    isSessionDirectlyOwned(updated.sessionId)
  ) {
    await notify(pullRequestCiConclusionNotification(updated, ci)).catch(
      () => undefined,
    );
  }

  // A merge observed here is the SAME event as the card's own merge button —
  // it just happened on the provider's web UI — so it leaves the same `done`
  // suggestion on the linked Task rather than only the one path writing it.
  if (status === "merged" && card.status !== "merged")
    suggestLinkedTaskDone(updated);

  if (status !== "open") {
    forgetCard(cardId);
    return;
  }
  nextPollAt.set(cardId, Date.now() + intervalFor(updated));
}

/** One sweep: poll every open card whose schedule is due, bounded concurrency. Awaitable for tests. */
function sweep(): Promise<void> {
  const now = Date.now();
  let open: PullRequestCard[];
  try {
    open = openPullRequestCards();
  } catch (err) {
    // An unavailable card store (its legacy import has not finished) retries
    // on its own; this timer must survive to poll once it has.
    console.warn(
      "[pull-requests] watcher sweep skipped:",
      err instanceof Error ? err.message : String(err),
    );
    return Promise.resolve();
  }
  const queue = open.filter((card) => {
    if (now - card.createdAt > HARD_LIFETIME_MS) {
      forgetCard(card.id);
      return false;
    }
    if (inFlight.has(card.id)) return false;
    return now >= (nextPollAt.get(card.id) ?? 0);
  });
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, queue.length) },
    async () => {
      for (let card = queue.shift(); card; card = queue.shift()) {
        inFlight.add(card.id);
        try {
          await pollCard(card.id);
        } catch {
          // A transient provider failure retries at the fast cadence rather than
          // getting stuck on whatever interval it last held — except on GitHub,
          // where a fast retry is what keeps an exhausted budget exhausted.
          nextPollAt.set(card.id, Date.now() + retryIntervalFor(card));
        } finally {
          inFlight.delete(card.id);
        }
      }
    },
  );
  return Promise.all(workers).then(() => undefined);
}

/** Start the sweeper. Idempotent. */
export function startPullRequestWatcher(): void {
  if (sweeper) return;
  sweeper = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

export function stopPullRequestWatcher(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = undefined;
}

/**
 * Restore polling for every card still open after a server restart. In
 * practice a no-op beyond documenting intent: a missing schedule entry
 * already reads as due (see `sweep`'s `?? 0`), and this runs against a fresh
 * `nextPollAt` map either way — but mirrors `reconcileWorktreeMergesOnBoot`'s
 * name/shape so the boot sequence reads the same way for both.
 */
export function reconcilePullRequestCardsOnBoot(): void {
  for (const card of openPullRequestCards()) scheduleImmediatePoll(card.id);
}

/** Test seam: forget every schedule, stop the timer, and drop injected fakes. */
export function resetPullRequestWatcherForTests(): void {
  stopPullRequestWatcher();
  nextPollAt.clear();
  inFlight.clear();
  unmergeableReads.clear();
  resolveProvider = hostingProviderForRepo;
  notify = deliverAppNotification;
  isSessionDirectlyOwned = sessionIsDirectlyOwned;
}

/** Test seam: run one sweep now and wait for it, instead of the interval. */
export function sweepPullRequestWatcherForTests(): Promise<void> {
  return sweep();
}
