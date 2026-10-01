import type {
  CommentEventsMessage,
  CommentTarget,
  CommentThread,
  CommentsSnapshotMessage,
  StateEvent,
  WorktreeReviewSet,
} from "@assistant/shared";
import { commentTargetKey } from "@assistant/shared";
import type { CommentStore } from "./commentStore.ts";
import { commentReviewSetsFor, commentStoreFor } from "./commentStores.ts";

export interface CommentBroadcaster {
  broadcast(target: CommentTarget, message: CommentEventsMessage): void;
}

export interface CommentOwnership {
  target: CommentTarget;
  threadId: string;
}

let broadcaster: CommentBroadcaster = { broadcast: () => undefined };
let resolveStore: (target: CommentTarget) => CommentStore = commentStoreFor;
let resolveReviewSets: (
  target: CommentTarget,
) => WorktreeReviewSet[] | undefined = commentReviewSetsFor;
const revisions = new Map<string, Map<string, number>>();
const reviewSetRevisions = new Map<string, Map<string, number>>();
const sequences = new Map<string, number>();
/** Serializes projection reads and revision stamps per object. */
const notificationTails = new Map<string, Promise<void>>();
/** Process-wide ownership learned from every snapshot/event, not one connection. */
const ownershipByCommentId = new Map<string, CommentOwnership>();

export function setCommentBroadcaster(next: CommentBroadcaster): void {
  broadcaster = next;
}

function revisionsFor(target: CommentTarget): Map<string, number> {
  const key = commentTargetKey(target);
  let current = revisions.get(key);
  if (!current) {
    current = new Map();
    revisions.set(key, current);
  }
  return current;
}

function reviewSetRevisionsFor(target: CommentTarget): Map<string, number> {
  const key = commentTargetKey(target);
  let current = reviewSetRevisions.get(key);
  if (!current) {
    current = new Map();
    reviewSetRevisions.set(key, current);
  }
  return current;
}

function indexThread(thread: CommentThread): void {
  const ownership = { target: thread.target, threadId: thread.id };
  ownershipByCommentId.set(thread.id, ownership);
  ownershipByCommentId.set(thread.root.id, ownership);
  for (const reply of thread.replies)
    ownershipByCommentId.set(reply.id, ownership);
}

function forgetThread(threadId: string): void {
  for (const [commentId, ownership] of ownershipByCommentId) {
    if (ownership.threadId === threadId) ownershipByCommentId.delete(commentId);
  }
}

/** Constant-time server-side ownership lookup for root and reply ids. */
export function commentOwnership(
  commentId: string,
): CommentOwnership | undefined {
  return ownershipByCommentId.get(commentId);
}

/** Seed ownership before an asynchronous add notification has projected it. */
export function rememberCommentOwnership(
  target: CommentTarget,
  threadId: string,
  commentId = threadId,
): void {
  const ownership = { target, threadId };
  ownershipByCommentId.set(threadId, ownership);
  ownershipByCommentId.set(commentId, ownership);
}

function enqueueCommentOperation<T>(
  target: CommentTarget,
  operation: () => Promise<T>,
): Promise<T> {
  const key = commentTargetKey(target);
  const previous = notificationTails.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  notificationTails.set(key, tail);
  const release = () => {
    if (notificationTails.get(key) === tail) notificationTails.delete(key);
  };
  void tail.then(release, release);
  return result;
}

export function commentsSnapshot(
  target: CommentTarget,
  requestId?: string,
): Promise<CommentsSnapshotMessage> {
  return enqueueCommentOperation(target, async () => {
    const store = resolveStore(target);
    const threads = await store.list(target);
    const reviewSets = resolveReviewSets(target);
    const current = revisionsFor(target);
    const currentReviewSets = reviewSetRevisionsFor(target);
    for (const thread of threads) {
      if (!current.has(thread.id)) current.set(thread.id, 1);
      indexThread(thread);
    }
    for (const set of reviewSets ?? []) {
      if (!currentReviewSets.has(set.id)) currentReviewSets.set(set.id, 1);
    }
    return {
      type: "commentsSnapshot",
      target,
      threads,
      ...(reviewSets
        ? {
            reviewSets,
            reviewSetRevisions: reviewSets.map((set) => ({
              id: set.id,
              revision: currentReviewSets.get(set.id)!,
            })),
          }
        : {}),
      revisions: threads.map((thread) => ({
        id: thread.id,
        revision: current.get(thread.id)!,
      })),
      ...(requestId ? { requestId } : {}),
    };
  });
}

async function flushCommentChanges(
  target: CommentTarget,
  ids: readonly string[],
): Promise<void> {
  const current = revisionsFor(target);
  const store = resolveStore(target);
  const threads = await store.list(target);
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const events: StateEvent<CommentThread>[] = ids.map((id) => {
    const revision = (current.get(id) ?? 0) + 1;
    current.set(id, revision);
    const item = byId.get(id);
    if (item) {
      indexThread(item);
      return { kind: "upsert", id, revision, item };
    }
    return { kind: "delete", id, revision };
  });
  const key = commentTargetKey(target);
  const seq = (sequences.get(key) ?? 0) + 1;
  sequences.set(key, seq);
  broadcaster.broadcast(target, {
    type: "commentEvents",
    target,
    seq,
    events,
  });
  for (const event of events) {
    if (event.kind === "delete") forgetThread(event.id);
  }
}

/** Notify-with-touched-ids is the revision bump and the only mutation push. */
export function notifyCommentChanges(
  target: CommentTarget,
  threadIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return Promise.resolve();
  return enqueueCommentOperation(target, () =>
    flushCommentChanges(target, ids),
  );
}

async function flushReviewSetChanges(
  target: CommentTarget,
  ids: readonly string[],
): Promise<void> {
  const current = reviewSetRevisionsFor(target);
  const byId = new Map(
    (resolveReviewSets(target) ?? []).map((set) => [set.id, set]),
  );
  const reviewSetEvents: StateEvent<WorktreeReviewSet>[] = ids.map((id) => {
    const revision = (current.get(id) ?? 0) + 1;
    current.set(id, revision);
    const item = byId.get(id);
    return item
      ? { kind: "upsert", id, revision, item }
      : { kind: "delete", id, revision };
  });
  const key = commentTargetKey(target);
  const seq = (sequences.get(key) ?? 0) + 1;
  sequences.set(key, seq);
  broadcaster.broadcast(target, {
    type: "commentEvents",
    target,
    seq,
    events: [],
    reviewSetEvents,
  });
}

/** Notify-with-touched-ids is also the review-set revision bump. */
export function notifyCommentMetadataChanges(
  target: CommentTarget,
  reviewSetIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(reviewSetIds)];
  if (ids.length === 0) return Promise.resolve();
  return enqueueCommentOperation(target, () =>
    flushReviewSetChanges(target, ids),
  );
}

/** Isolate the state engine in focused tests; production never calls this. */
export function resetCommentEventsForTests(
  storeResolver: (target: CommentTarget) => CommentStore = commentStoreFor,
  reviewSetResolver: (
    target: CommentTarget,
  ) => WorktreeReviewSet[] | undefined = commentReviewSetsFor,
): void {
  resolveStore = storeResolver;
  resolveReviewSets = reviewSetResolver;
  broadcaster = { broadcast: () => undefined };
  revisions.clear();
  reviewSetRevisions.clear();
  sequences.clear();
  notificationTails.clear();
  ownershipByCommentId.clear();
}
