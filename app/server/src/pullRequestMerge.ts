/**
 * The ONE server-side projection of a merged pull request (Task 324, stage 3).
 *
 * A pull request is shown in two places — the live `/pr` card in a session and
 * the worktree page's Delivery section — and merging is offered in both. Sharing
 * only `gitHosting.mergePullRequest` was NOT enough: each surface then updated
 * only its own store, so merging in chat left the worktree page offering Merge
 * from its cached open PR, and merging on the worktree page left the card open
 * until the watcher's slow (5-minute) poll — or forever, past its lifetime cap.
 *
 * So both surfaces call {@link mergePullRequestAndProject}, which merges ONCE
 * and then projects the outcome everywhere it is visible:
 *   1. the provider merge (branch deletion included unless the caller opted out,
 *      one call — see gitHosting),
 *   2. the managed local base branch, refreshed when it is safe,
 *   3. every matching live card → `merged`, with the outcome sentence,
 *   4. the linked Task's `done` SUGGESTION (never a status write),
 *   5. matching Workflow Runs record the merge choice and observed completion,
 *   6. the worktree hosting cache, invalidated so the page re-reads.
 *
 * Cards are matched by REPOSITORY IDENTITY (`repoLockKey`, the common git dir
 * shared by a repo's main checkout and all its worktrees) plus provider and
 * number — not by checkout path, which differs between the two surfaces for the
 * very same pull request.
 */
import type {
  GitHostingProviderKind,
  PullRequestCard,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestMergeResult,
  PullRequestRepositoryCapabilities,
  TaskSummary,
  WorktreeMergePrRequest,
  WorktreeMergePrResponse,
  WorkflowActor,
} from "@assistant/shared";
import { randomUUID } from "node:crypto";
import type { WorktreeRow } from "./db/worktreeStore.ts";
import { repoLockKey } from "./gitExec.ts";
import {
  hostingProviderForRepo,
  repositoryCapabilitiesFor,
  type GitHostingProvider,
} from "./gitHosting.ts";
import {
  beginPullRequestCardObservation,
  openPullRequestCards,
  patchPullRequestCard,
  patchPullRequestCardObservation,
  pullRequestCardRecord,
} from "./pullRequestCards.ts";
import { pullRequestCardRepoRoot } from "./pullRequestHosting.ts";
import { pullRequestIdentity } from "./pullRequestIdentity.ts";
import { invalidatePullRequestInventoryReads } from "./pullRequestInventory.ts";
import { readTask, taskSummaryOf, updateTask } from "./tasks.ts";
import {
  refreshBaseCheckoutAfterMerge,
  type BaseCheckoutRefreshInput,
} from "./worktrees/baseCheckoutRefresh.ts";
import { invalidatePullRequestInventorySnapshot } from "./pullRequestInventorySync.ts";
import {
  invalidateProjectPullRequests,
  invalidateWorktreeHosting,
} from "./worktrees/worktreeHosting.ts";
import { isMainWorktreeId } from "./worktrees/worktreeResolve.ts";
import {
  observePullRequestCardForWorkflows,
  recordPullRequestMergeForWorkflows,
  reviewedHeadForMergeDecision,
} from "./workflow/pullRequestObservation.ts";

export interface MergePullRequestInput {
  provider: GitHostingProvider;
  /** Any checkout of the repository; used for repo identity, never for display. */
  repoPath: string;
  number: number;
  headBranch: string;
  baseBranch: string;
  method: PullRequestMergeMethod;
  /** Exact head accepted by a caller that performed its own readiness check. */
  expectedHeadSha?: string;
  /** Default true; the remote branch is deleted as part of the merge call. */
  deleteBranch?: boolean;
  /** Worktree whose hosting cache must be dropped, when the caller knows it. */
  worktreeId?: string;
  /**
   * Attribution for Workflow events: the user who clicked, or the agent
   * session that merged its own managed pull request. Ordinary card clicks
   * omit it and are recorded as the user.
   */
  workflowActor?: WorkflowActor;
  /**
   * What a MANAGED caller decided, revalidated here against the authoritative
   * capability read. These are the facts that made the merge pre-authorized —
   * or that a human approved — so the seam, not the caller, is where they must
   * still hold at merge time. Ordinary human merges omit it and stay direct.
   */
  managedDecision?: ManagedMergeDecision;
}

/** The classification a managed merge was authorized under. */
interface ManagedMergeDecision {
  /** Whether the base was the repository default branch when decided. */
  baseIsDefaultBranch: boolean;
  /** The default branch that judgement was made against. */
  defaultBranch: string;
  /** The supported set a human approval was answered with, when there was one. */
  approvedMethods?: PullRequestMergeMethod[];
}

export interface MergePullRequestOperations {
  refreshBaseCheckout(
    input: BaseCheckoutRefreshInput,
  ): Promise<string | undefined>;
  /** Invalidate every cache that can still describe this PR before the merge. */
  inventoryChanged?(input: MergePullRequestInput): void;
}

const defaultMergeOperations: MergePullRequestOperations = {
  refreshBaseCheckout: refreshBaseCheckoutAfterMerge,
  inventoryChanged(input) {
    invalidateProjectPullRequests();
    const identity = pullRequestIdentity(
      input.provider.kind,
      input.provider.repoWebUrl,
      input.number,
    );
    if (identity) invalidatePullRequestInventoryReads(identity.key);
    invalidatePullRequestInventorySnapshot();
  },
};

export interface MergePullRequestProjection {
  result: PullRequestMergeResult;
  /** What happened, in one sentence per surface — merge, then the branch. */
  message: string;
  /**
   * Cards this merge ACTUALLY moved to `merged` (a card surface may not exist
   * at all). Projecting onto a card is best-effort after the provider accepted,
   * so this is the cards whose write succeeded — never the ones that were
   * matched. A caller that patches what this missed depends on the difference.
   */
  cardIds: string[];
  /**
   * The Tasks this merge actually WROTE a `done` suggestion on, as they read
   * afterwards. Empty is the ordinary answer whenever no card carried a linked
   * Task, the Task was already done or missing, or the write failed — a caller
   * reporting a suggestion must state what happened, not what it hoped for.
   */
  taskSuggestions: TaskSummary[];
}

/* ---------------------------- the per-PR lock ------------------------------ */

/** Identity of one pull request, independent of which surface names it. */
export interface PullRequestIdentity {
  /** Any checkout of the repository. */
  repoPath: string;
  providerKind: GitHostingProviderKind;
  number: number;
}

const mutating = new Map<string, string>();

/**
 * Serialize every mutation of ONE pull request, across surfaces and across
 * cards. `busyAction` only ever locked a single card, which left real
 * schedules open: card A rebasing for `update-with-main` while the worktree
 * page (or a second card on the same pull request) merges it — A then tries to
 * force-push rewritten history onto a merged, deleted branch, and the merge's
 * projection clears A's `busyAction` underneath it.
 *
 * The loser is REFUSED rather than queued, and refused BEFORE any provider or
 * git side effect: waiting would run the second operation against a repository
 * the first has since changed, which is how you get exactly the mess above.
 */
export async function withPullRequestMutation<T>(
  identity: PullRequestIdentity,
  what: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = `${await repoLockKey(identity.repoPath)}#${identity.providerKind}#${identity.number}`;
  const holder = mutating.get(key);
  if (holder)
    throw new Error(
      `Pull request #${identity.number} is busy: ${holder} is running. Nothing was done — try again once it finishes.`,
    );
  mutating.set(key, what);
  try {
    return await run();
  } finally {
    mutating.delete(key);
  }
}

/** Whether a head-changing action currently owns this exact pull request. */
export async function pullRequestMutationInProgress(
  identity: PullRequestIdentity,
): Promise<boolean> {
  if (mutating.size === 0) return false;
  const key = `${await repoLockKey(identity.repoPath)}#${identity.providerKind}#${identity.number}`;
  return mutating.has(key);
}

/** Test seam: forget every in-flight mutation. */
export function resetPullRequestMutationsForTests(): void {
  mutating.clear();
}

/** Invalidate every older provider poll before an action changes the PR head. */
export async function reservePullRequestObservationGenerations(
  identity: PullRequestIdentity,
): Promise<void> {
  const candidates = openPullRequestCards().filter(
    (card) =>
      card.number === identity.number &&
      card.provider === identity.providerKind,
  );
  if (candidates.length === 0) return;
  const key = await repoLockKey(identity.repoPath);
  for (const card of candidates)
    if ((await cardRepoKey(card)) === key)
      beginPullRequestCardObservation(card.id);
}

/**
 * A card's repository identity, through the checkout it speaks for NOW
 * (`pullRequestHosting.ts`): a card whose worktree has been removed answers
 * from the main checkout, where a deleted path is only ever its own key and
 * would match no surface at all.
 */
async function cardRepoKey(card: PullRequestCard): Promise<string | undefined> {
  const record = pullRequestCardRecord(card.id);
  if (!record) return undefined;
  return repoLockKey(
    pullRequestCardRepoRoot({
      repoRoot: record.context.repoRoot,
      ...(card.worktreeId ? { worktreeId: card.worktreeId } : {}),
    }),
  );
}

type ReservedPullRequestObservation = {
  card: PullRequestCard;
  token: string;
};

function reserveCardObservations(
  cards: PullRequestCard[],
): ReservedPullRequestObservation[] {
  return cards.map((card) => ({
    card,
    token: beginPullRequestCardObservation(card.id),
  }));
}

/** Merge and project. The single entry point for BOTH merge surfaces. */
export async function mergePullRequestAndProject(
  input: MergePullRequestInput,
  operations: MergePullRequestOperations = defaultMergeOperations,
): Promise<MergePullRequestProjection> {
  return withPullRequestMutation(
    {
      repoPath: input.repoPath,
      providerKind: input.provider.kind,
      number: input.number,
    },
    "a merge",
    () => mergeAndProject(input, operations),
  );
}

/**
 * The SAME merge, for a caller that already holds this pull request's mutation
 * lock ({@link withPullRequestMutation}) because the merge is only the first
 * half of what it is serializing.
 *
 * The Pull Requests view's Merge & clean up is that caller: its local cleanup
 * must be inside the same critical section as the merge, and taking the lock
 * again from in here would refuse the operation against itself. It is an entry
 * point, not a second implementation — everything below this line is shared,
 * and a caller that does NOT hold the lock must use
 * {@link mergePullRequestAndProject} instead.
 */
export async function mergePullRequestAndProjectLocked(
  input: MergePullRequestInput,
  operations: MergePullRequestOperations = defaultMergeOperations,
): Promise<MergePullRequestProjection> {
  return mergeAndProject(input, operations);
}

async function mergeAndProject(
  input: MergePullRequestInput,
  operations: MergePullRequestOperations,
): Promise<MergePullRequestProjection> {
  const cards = await cardsForMergedPullRequest(input);
  // Reserve BEFORE any provider read or merge call: every older poll describes
  // state from before this operation and may no longer drive a Workflow Run.
  const operationObservations = reserveCardObservations(cards);
  const expectedHeads = [
    input.expectedHeadSha,
    ...cards.map((card) => reviewedHeadForMergeDecision(card.id)),
  ].filter((head): head is string => Boolean(head));
  const distinctExpectedHeads = new Map(
    expectedHeads.map((head) => [head.toLowerCase(), head]),
  );
  if (distinctExpectedHeads.size > 1)
    throw new Error(
      `Pull request #${input.number} has decisions for different reviewed heads. Refresh before merging.`,
    );
  const expectedHeadCommit = distinctExpectedHeads.values().next().value as
    string | undefined;

  // The capability read comes FIRST, because it is a network round trip and
  // whatever it learns about the repository must not sit between the identity
  // check below and the provider merge: a retarget landing in that gap would
  // keep the accepted head, satisfy the provider's precondition, and merge onto
  // a base nobody classified. The pull request's own identity is therefore the
  // LAST thing read before merging.
  const capabilities = await requireMergeCapabilities(input);

  // The provider's CURRENT answer, read under the lock, is what may be merged.
  // A caller that accepted an exact head (managed delivery, a workflow merge
  // decision) demands that answer and refuses without it; an ordinary card
  // click still merges when the provider cannot be asked, but never against an
  // answer that CONTRADICTS what the click was for.
  const first = expectedHeadCommit
    ? await input.provider.pullRequestDetail(input.number)
    : await input.provider.pullRequestDetail(input.number).catch(() => null);
  // ONE conflicting read is not a conflict: Forgejo answers `false` while its
  // check is queued, and the projection below reaches an armed Workflow Run
  // as a terminal base conflict. Ask again, but keep the answers apart.
  const second =
    expectedHeadCommit && first?.mergeable === false
      ? await input.provider.pullRequestDetail(input.number).catch(() => null)
      : null;
  const detail = second ?? first;
  if (expectedHeadCommit && !detail)
    throw new Error(
      `Pull request #${input.number} could not be re-read before merging. Refresh and try again.`,
    );
  if (detail) {
    if (detail.state !== "open")
      throw new Error(
        `Pull request #${input.number} is no longer open. Refresh before merging.`,
      );
    if (
      expectedHeadCommit &&
      detail.headSha.toLowerCase() !== expectedHeadCommit.toLowerCase()
    ) {
      await projectFreshPullRequestSnapshot(operationObservations, detail);
      throw new Error(
        `Pull request #${input.number} head moved from reviewed ${expectedHeadCommit} to ${detail.headSha}; re-review before merging.`,
      );
    }
    // The head SHA alone does not identify what is being merged: a retarget
    // moves a pull request onto ANOTHER base while keeping that exact head, and
    // the provider's expected-head precondition would happily merge it there —
    // past the default-branch approval its caller classified it out of. So the
    // branches this merge was decided for are bound here too, against the
    // capabilities read a moment ago.
    requireUnchangedMergeTarget(input, detail, capabilities);
  }
  if (expectedHeadCommit && detail) {
    // Both reads must have answered `false` about the SAME head. A retry that
    // failed, answered nothing, or describes a different head confirms nothing:
    // that leaves the merge to the provider below, whose refusal is classified.
    if (
      first?.mergeable === false &&
      second?.mergeable === false &&
      first.headSha === second.headSha
    ) {
      await projectFreshPullRequestSnapshot(operationObservations, detail, {
        confirmedConflict: true,
        actionError: `The base moved; use Rebase and re-review before merging pull request #${input.number}.`,
      });
      throw new Error(
        `Pull request #${input.number} cannot merge because the base moved; use Rebase and re-review.`,
      );
    }
  }

  // What the merge is conditioned on, which is not the same question as what
  // was REVIEWED: `expectedHeadCommit` is the accepted/reviewed head and drives
  // the refusals above, while this is simply the newest head this run proved —
  // the two are equal whenever both exist, because the checks above just said
  // so.
  const mergedHeadCommit = expectedHeadCommit ?? detail?.headSha;

  let result: PullRequestMergeResult;
  try {
    result = await input.provider.mergePullRequest(input.number, {
      method: input.method,
      deleteBranch: input.deleteBranch !== false,
      // The head this merge is CONDITIONED on: the reviewed/accepted head when
      // a decision named one, otherwise the head this run just validated. An
      // ordinary click has no reviewed head, but it did read one — and without
      // passing it, a push landing between that read and the merge would be
      // merged silently. The provider turns this into its own atomic
      // precondition (`sha` / `head_commit_id`).
      ...(mergedHeadCommit ? { expectedHeadSha: mergedHeadCommit } : {}),
      // Hand the provider what the identity read above PROVED, so it needs no
      // read of its own between that check and the merge — GitHub otherwise
      // fetches the pull request here just to learn which ref to delete, and a
      // retarget inside that round trip keeps the expected head while moving
      // the merge onto another base. Only a `detail` this run actually
      // validated may speak for the branch; a degraded human merge that could
      // not read the pull request leaves the provider to look it up (and to
      // refuse what it then sees moved).
      ...(detail ? { headBranch: detail.headBranch } : {}),
      expectedBaseBranch: input.baseBranch,
    });
  } catch (err) {
    let classified = false;
    try {
      // The refusal itself starts a newer observation episode. Mint before its
      // detail fetch so an older poll cannot settle the merge decision while
      // this authoritative classification is in flight.
      const refusalObservations = reserveCardObservations(cards);
      classified = await classifyMergeRefusalAsBaseConflict(
        input,
        refusalObservations,
        mergedHeadCommit,
      );
    } catch (classificationError) {
      console.warn(
        `[pull-request] classifying merge refusal for #${input.number} failed:`,
        classificationError,
      );
    }
    if (classified)
      throw new Error(
        `Pull request #${input.number} cannot merge because the base moved; use Rebase and re-review.`,
      );
    throw err;
  }
  let baseRefreshMessage: string | undefined;
  if (input.worktreeId) {
    try {
      baseRefreshMessage = await operations.refreshBaseCheckout({
        worktreeId: input.worktreeId,
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
      });
    } catch (err) {
      // The provider already accepted the merge. Local refresh is best-effort
      // follow-up bookkeeping and must never turn that success into a failure.
      console.warn(
        `[pull-request] refreshing ${input.baseBranch} after merge of #${input.number} failed:`,
        err,
      );
    }
  }
  const message = [
    `Merged #${input.number} into ${input.baseBranch} (${input.method}).`,
    input.deleteBranch === false
      ? `The remote branch ${input.headBranch} was kept.`
      : result.branchDeleted
        ? `Deleted the remote branch ${input.headBranch}.`
        : `The remote branch ${input.headBranch} was NOT deleted${result.branchDeleteError ? `: ${result.branchDeleteError}` : "."}`,
    baseRefreshMessage,
  ]
    .filter((clause): clause is string => Boolean(clause))
    .join(" ");

  const invalidated = new Set<string>(
    input.worktreeId ? [input.worktreeId] : [],
  );
  const mergedCards: PullRequestCard[] = [];
  const taskSuggestions: TaskSummary[] = [];
  // One outcome per linked TASK, not per card: several cards can name the same
  // pull request and the same Task, and asking twice would write the same
  // suggestion twice and report one write as two.
  const suggestionByTask = new Map<string, LinkedTaskSuggestion>();
  for (const card of cards) {
    // EVERYTHING from here on is follow-up bookkeeping about a merge the
    // provider has already accepted, so it is best-effort per card — the same
    // rule the base refresh and the Workflow records below already follow. A
    // card that was deleted while the provider was answering (or a write that
    // failed) must not turn a landed merge into a failed action: the caller
    // would report an unmerged pull request, and a caller that continues into a
    // local cleanup would skip it. The watcher reconciles whatever was missed.
    try {
      const linkedTaskId = card.linkedTask?.id;
      let outcome = linkedTaskId
        ? suggestionByTask.get(linkedTaskId)
        : undefined;
      if (!outcome) {
        outcome = suggestLinkedTaskDoneOutcome(card);
        if (linkedTaskId) suggestionByTask.set(linkedTaskId, outcome);
        if (outcome.created) taskSuggestions.push(outcome.created);
      }
      const taskPatch = outcome.patch;
      mergedCards.push(
        patchPullRequestCard(
          card.id,
          {
            status: "merged",
            // Mergeability is a question about an OPEN pull request; carrying the old
            // answer into `merged` would keep rendering a conflict badge on a PR that
            // is already in the base branch.
            mergeable: undefined,
            conflicts: undefined,
            busyAction: undefined,
            actionError: undefined,
            actionMessage: message,
            ...taskPatch,
          },
          // A merge SUPERSEDES whatever action last spoke for this card: rotating
          // the token drops any outcome still in flight for it (a conflict handoff
          // waiting to be accepted, say) instead of letting it land on a merged
          // card later.
          {
            actionToken: randomUUID(),
            // Invalidate any watcher response that started before this merge.
            observationToken: randomUUID(),
            // The head that actually went in — the merge was conditioned on it.
            ...(mergedHeadCommit ? { observedHeadSha: mergedHeadCommit } : {}),
          },
        ),
      );
      if (card.worktreeId) invalidated.add(card.worktreeId);
    } catch (err) {
      console.warn(
        `[pull-request] projecting the merge of #${input.number} onto card ${card.id} failed:`,
        err,
      );
    }
  }
  // Workflow history is follow-up bookkeeping after the provider accepted the
  // merge. A damaged run must not make a successful external merge look failed.
  for (const card of mergedCards)
    await recordPullRequestMergeForWorkflows(card, {
      mergeMethod: input.method,
      deleteBranch: input.deleteBranch !== false,
      ...(expectedHeadCommit ? { expectedHeadCommit } : {}),
      ...(input.workflowActor ? { actor: input.workflowActor } : {}),
    }).catch((err) =>
      console.warn(
        `[workflow] could not record merge of pull request #${input.number}:`,
        err,
      ),
    );
  // The worktree page reads PR/CI through a 15s TTL cache; without this it can
  // keep offering Merge for a pull request that is already in.
  for (const worktreeId of invalidated) invalidateWorktreeHosting(worktreeId);
  operations.inventoryChanged?.(input);

  return {
    result,
    message,
    // The cards this projection WROTE, not the ones it matched: a card whose
    // patch failed above is still open, and reporting it as merged is how a
    // caller stops patching the one card it can still fix.
    cardIds: mergedCards.map((card) => card.id),
    taskSuggestions,
  };
}

/**
 * The authoritative capability answer for THIS merge, plus everything it
 * decides — for every merge surface, under the mutation lock.
 *
 * A merge is an irreversible outward action, so it asks what the repository
 * allows NOW: a forced read that can neither be served from the cache nor adopt
 * a request that was already in flight. An unknown answer refuses (the
 * contract's fail-closed rule) and says why, instead of sending a guessed
 * method to the provider.
 *
 * A MANAGED caller also states what it decided — whether this base was the
 * default branch, which default branch that judgement was made against, and the
 * supported set an approval was answered with. Those facts are checked against
 * this same fresh answer, because they are what separates a pre-authorized
 * merge from one that needs a human: a repository whose default branch moved
 * could otherwise turn a direct merge into an unapproved default-branch merge,
 * or let an approval execute after its base stopped being the default.
 * Ordinary human merges state no decision and stay direct.
 */
async function requireMergeCapabilities(
  input: MergePullRequestInput,
): Promise<PullRequestRepositoryCapabilities> {
  const capabilities = await repositoryCapabilitiesFor(input.provider, {
    fresh: true,
  });
  if (!capabilities.mergeMethods)
    throw new Error(
      `The repository's supported merge methods could not be read${
        capabilities.unknownReason ? ` (${capabilities.unknownReason})` : ""
      }, so pull request #${input.number} was not merged.`,
    );
  if (!capabilities.mergeMethods.includes(input.method))
    throw new Error(
      `The repository does not allow the ${input.method} merge method for pull request #${input.number}. Supported: ${capabilities.mergeMethods.join(", ") || "none"}.`,
    );

  const decision = input.managedDecision;
  if (!decision) return capabilities;
  if (!capabilities.defaultBranch)
    throw new Error(
      `The repository's default branch could not be read${
        capabilities.unknownReason ? ` (${capabilities.unknownReason})` : ""
      }, so pull request #${input.number} could not be classified and was not merged.`,
    );
  if (capabilities.defaultBranch !== decision.defaultBranch)
    throw new Error(
      `The repository default branch changed from ${decision.defaultBranch} to ${capabilities.defaultBranch} while pull request #${input.number} was being merged; nothing was merged. Re-check it and decide again.`,
    );
  if (
    decision.approvedMethods &&
    (decision.approvedMethods.length !== capabilities.mergeMethods.length ||
      decision.approvedMethods.some(
        (method, index) => method !== capabilities.mergeMethods?.[index],
      ))
  )
    throw new Error(
      `The repository's supported merge methods changed from the approved ${decision.approvedMethods.join(", ") || "none"} to ${capabilities.mergeMethods.join(", ") || "none"}; nothing was merged. Decide again with the current set.`,
    );
  return capabilities;
}

/**
 * Refuse a merge whose target is no longer the pull request its caller decided
 * about — the same identity the caller stated, re-read under the mutation lock
 * as the LAST provider read before merging.
 *
 * A RETARGET is the case this exists for: an external edit can move a ready
 * pull request from a topic base onto the repository's default branch without
 * touching its head, so every head-based precondition still passes while the
 * merge lands somewhere that required a human approval. Head branch, base
 * branch and draft state are therefore all bound here — and for a managed
 * caller, so is the base's DEFAULT-BRANCH standing, since "this base is not the
 * default" is the fact that made the merge pre-authorized in the first place.
 */
function requireUnchangedMergeTarget(
  input: MergePullRequestInput,
  detail: PullRequestDetail,
  capabilities: PullRequestRepositoryCapabilities,
): void {
  if (
    detail.headBranch !== input.headBranch ||
    detail.baseBranch !== input.baseBranch
  )
    throw new Error(
      `Pull request #${input.number} is now ${detail.headBranch} → ${detail.baseBranch}, not the ${input.headBranch} → ${input.baseBranch} this merge was decided for. Nothing was merged; re-check it and decide again.`,
    );
  if (detail.draft)
    throw new Error(
      `Pull request #${input.number} is a draft again; nothing was merged.`,
    );
  const decision = input.managedDecision;
  if (!decision) return;
  const isDefaultBranch = detail.baseBranch === capabilities.defaultBranch;
  if (isDefaultBranch !== decision.baseIsDefaultBranch)
    throw new Error(
      isDefaultBranch
        ? `Pull request #${input.number} now targets ${detail.baseBranch}, which IS the repository default branch; that merge needs a human approval and nothing was merged.`
        : `Pull request #${input.number} now targets ${detail.baseBranch}, which is no longer the repository default branch ${capabilities.defaultBranch ?? "(unknown)"}; the approval answered a different question and nothing was merged.`,
    );
}

/**
 * Re-fetch once after a refusal; provider state, never error text, classifies
 * it. A conflicting answer HERE may be stated as confirmed evidence — the
 * provider refused the merge itself, and this read reproduces why — but only
 * about the SAME head the merge was conditioned on.
 *
 * Every merge now carries an atomic head precondition, so one thing a refusal
 * routinely means is "that head is no longer the head". In that race the read
 * below describes the NEW head, and Forgejo in particular reports a
 * just-published head as not mergeable while it recomputes. Reading that as a
 * base conflict would tell the user to rebase — and hand an armed Workflow Run
 * a terminal conflict it cannot re-settle (Task 535) — when the truth is simply
 * that the branch moved and nothing merged. A head this classification cannot
 * tie to the refused one therefore projects as an ordinary moved-head
 * observation and leaves the provider's own refusal standing.
 */
async function classifyMergeRefusalAsBaseConflict(
  input: MergePullRequestInput,
  observations: ReservedPullRequestObservation[],
  conditionedHead: string | undefined,
): Promise<boolean> {
  const detail = await input.provider
    .pullRequestDetail(input.number)
    .catch(() => null);
  if (!detail) return false;
  // An unknown conditioned head is not a licence to claim one: the provider
  // derived its own precondition from a read this seam never saw, so nothing
  // here can attribute the refusal to the base rather than to that head.
  const describesRefusedHead =
    Boolean(conditionedHead) &&
    detail.headSha.toLowerCase() === conditionedHead!.toLowerCase();
  const conflict =
    describesRefusedHead &&
    detail.state === "open" &&
    detail.mergeable === false;
  await projectFreshPullRequestSnapshot(observations, detail, {
    confirmedConflict: conflict,
    ...(conflict
      ? {
          actionError: `The base moved; use Rebase and re-review before merging pull request #${input.number}.`,
        }
      : {}),
  });
  if (input.worktreeId) invalidateWorktreeHosting(input.worktreeId);
  return conflict;
}

/**
 * What a fresh read may say about `conflicts`, which is CONFIRMED evidence and
 * nothing less: an armed Workflow Run consumes it as a terminal base conflict
 * that pauses the run and cannot be re-settled (Task 535). `mergeable: true`
 * clears it and a confirmed conflict sets it; every other answer — unknown, or
 * one conflicting read nothing has reproduced — leaves the card's own answer
 * alone rather than inventing or erasing one.
 */
function conflictsPatch(
  detail: PullRequestDetail,
  confirmedConflict: boolean,
): Partial<PullRequestCard> {
  if (confirmedConflict) return { conflicts: true };
  return detail.mergeable === true ? { conflicts: false } : {};
}

async function projectFreshPullRequestSnapshot(
  observations: ReservedPullRequestObservation[],
  detail: PullRequestDetail,
  options: { actionError?: string; confirmedConflict?: boolean } = {},
): Promise<void> {
  const { actionError, confirmedConflict = false } = options;
  for (const { card, token } of observations) {
    const updated = patchPullRequestCardObservation(
      card.id,
      token,
      {
        status: detail.state,
        draft: detail.draft ? true : undefined,
        mergeable: detail.mergeable,
        ...conflictsPatch(detail, confirmedConflict),
        ...(actionError ? { actionMessage: undefined, actionError } : {}),
      },
      { observedHeadSha: detail.headSha },
    );
    if (updated)
      await observePullRequestCardForWorkflows(updated, detail.headSha).catch(
        () => undefined,
      );
  }
}

/**
 * Every OPEN live card for one pull request. Repo identity comes from
 * `repoLockKey` over the checkout each card speaks for now ({@link cardRepoKey})
 * so a card created inside a worktree matches an outward transition issued from
 * the worktree page (and vice versa), and keeps matching once that worktree is
 * retired, while a same-numbered pull request in a DIFFERENT repository never
 * does.
 *
 * Shared with `pullRequestClose.ts`: merging and closing must reach exactly the
 * same set of cards, or one of the two would leave a duplicate card open.
 */
export async function openCardsForPullRequest(
  identity: PullRequestIdentity,
): Promise<PullRequestCard[]> {
  const candidates = openPullRequestCards().filter(
    (card) =>
      card.number === identity.number &&
      card.provider === identity.providerKind,
  );
  if (candidates.length === 0) return [];
  const key = await repoLockKey(identity.repoPath);
  const matched: PullRequestCard[] = [];
  for (const card of candidates)
    if ((await cardRepoKey(card)) === key) matched.push(card);
  return matched;
}

async function cardsForMergedPullRequest(
  input: MergePullRequestInput,
): Promise<PullRequestCard[]> {
  return openCardsForPullRequest({
    repoPath: input.repoPath,
    providerKind: input.provider.kind,
    number: input.number,
  });
}

/* ------------------------------- linked Task ------------------------------- */

/**
 * What one card's linked Task answered: the card patch that refreshes its
 * summary, and — separately — the suggestion this call actually CREATED.
 *
 * The two are not the same fact. Repeating a `done` suggestion writes nothing
 * (`resolveStatusWrite` keeps the first one's timestamp, since how long it has
 * sat unanswered is the useful part), so a suggestion that already stood is a
 * summary worth showing but never a write worth claiming.
 */
interface LinkedTaskSuggestion {
  patch: { linkedTask?: TaskSummary };
  /** Present only when THIS call turned "no standing suggestion" into one. */
  created?: TaskSummary;
}

/**
 * A merged pull request is EVIDENCE about the Task, not authority over it: the
 * merge writes a `done` SUGGESTION with its reason and lets the user answer.
 * The card's Mark-done button is that answer.
 */
function suggestLinkedTaskDoneOutcome(
  card: PullRequestCard,
): LinkedTaskSuggestion {
  const linked = card.linkedTask;
  if (!linked) return { patch: {} };
  const task = readTask(linked.id);
  if (!task || task.status === "done") return { patch: {} };
  // A `done` suggestion already standing is the answer this merge would ask
  // for: refresh what the card shows, write nothing, and claim nothing.
  if (task.statusSuggestion?.to === "done")
    return { patch: { linkedTask: taskSummaryOf(task) } };
  try {
    const updated = updateTask(linked.id, {
      status: "done",
      actor: { kind: "agent", id: card.sessionId },
      statusReason: `PR #${card.number ?? "?"} merged`,
    });
    const summary = taskSummaryOf(updated);
    return { patch: { linkedTask: summary }, created: summary };
  } catch {
    // The suggestion is bookkeeping about a merge that already happened; it
    // must never turn a completed merge into a reported failure.
    return { patch: {} };
  }
}

/** Called by the watcher when it OBSERVES a merge that happened elsewhere. */
export function suggestLinkedTaskDone(card: PullRequestCard): PullRequestCard {
  const { patch } = suggestLinkedTaskDoneOutcome(card);
  return patch.linkedTask ? patchPullRequestCard(card.id, patch) : card;
}

/* --------------------------------- HTTP ------------------------------------ */

/**
 * `POST /api/worktrees/:id/merge-pr` — the worktree page's merge button, on the
 * shared projection above. The LOCAL consequences stay out of it: removing the
 * worktree and settling the session are their own decision, offered on the card
 * where the state that justifies them is visible.
 */
export async function mergeWorktreePullRequest(
  row: WorktreeRow,
  input: WorktreeMergePrRequest,
): Promise<WorktreeMergePrResponse> {
  if (isMainWorktreeId(row.id))
    throw new Error("The main checkout has no pull request to merge.");
  const provider = await hostingProviderForRepo(row.path);
  if (!provider)
    throw new Error(
      "No git hosting provider is configured for this repository.",
    );
  const pr = await provider.findPullRequestForBranch(row.branch);
  if (!pr) throw new Error(`No pull request found for ${row.branch}.`);
  if (pr.state !== "open")
    throw new Error(`Pull request #${pr.number} is already ${pr.state}.`);

  const { result } = await mergePullRequestAndProject({
    provider,
    repoPath: row.path,
    number: pr.number,
    headBranch: row.branch,
    baseBranch: row.baseBranch,
    method: input.method,
    ...(input.deleteBranch === false ? { deleteBranch: false } : {}),
    worktreeId: row.id,
  });
  return {
    worktreeId: row.id,
    pr: { ...pr, state: "merged" },
    method: result.method,
    branchDeleted: result.branchDeleted,
  };
}
