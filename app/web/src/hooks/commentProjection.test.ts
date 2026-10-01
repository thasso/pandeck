import { describe, expect, it } from "vitest";
import type { CommentThread, WorktreeReviewSet } from "@assistant/shared";
import { createInitialState, reduceAssistantState } from "./useAssistant.ts";

function reviewSet(patch: Partial<WorktreeReviewSet> = {}): WorktreeReviewSet {
  return {
    id: "set-1",
    worktreeId: "wt-1",
    authorSessionId: "reviewer-1",
    authorModel: "review-model",
    blind: false,
    openCount: 1,
    addressedCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function gutterThread(): CommentThread {
  return {
    id: "root-1",
    target: {
      kind: "worktree",
      worktreeId: "wt-1",
      path: "src/app.ts",
      side: "new",
      revision: "head-1",
    },
    status: "open",
    root: {
      id: "root-1",
      author: { kind: "user", name: "User" },
      body: "Gutter comment",
      createdAt: 1,
    },
    replies: [],
    anchorState: "anchored",
    original: { path: "src/app.ts", lineStart: 12, lineEnd: 12 },
    current: { path: "src/app.ts", lineStart: 12, lineEnd: 12 },
    handoffSessionIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("shared comment projection", () => {
  it("retains a worktree gutter anchor when no text selectors were supplied", () => {
    const thread = gutterThread();
    const state = reduceAssistantState(createInitialState(), {
      kind: "server",
      msg: {
        type: "commentsSnapshot",
        target: thread.target,
        threads: [thread],
        revisions: [{ id: thread.id, revision: 1 }],
      },
    });

    expect(state.worktreeComments["wt-1"]?.[0]?.anchor).toMatchObject({
      path: "src/app.ts",
      line: 12,
      commit: "head-1",
      selectors: {
        quote: { exact: "", prefix: "", suffix: "" },
        block: { id: "12", occurrence: 1 },
      },
    });
  });

  it("applies review-set events and rejects stale revisions", () => {
    const thread = gutterThread();
    let state = reduceAssistantState(createInitialState(), {
      kind: "server",
      msg: {
        type: "commentsSnapshot",
        target: thread.target,
        threads: [],
        revisions: [],
        reviewSets: [reviewSet()],
        reviewSetRevisions: [{ id: "set-1", revision: 1 }],
      },
    });

    state = reduceAssistantState(state, {
      kind: "server",
      msg: {
        type: "commentEvents",
        target: thread.target,
        seq: 1,
        events: [],
        reviewSetEvents: [
          {
            kind: "upsert",
            id: "set-1",
            revision: 2,
            item: reviewSet({
              verdict: "approve-with-fixes",
              openCount: 0,
              addressedCount: 1,
              updatedAt: 2,
            }),
          },
        ],
      },
    });
    expect(state.worktreeReviewSets["wt-1"]?.[0]).toMatchObject({
      verdict: "approve-with-fixes",
      openCount: 0,
      addressedCount: 1,
    });
    expect(state.worktreeReviewSetRevisions["wt-1"]?.["set-1"]).toBe(2);

    const afterFresh = state;
    state = reduceAssistantState(state, {
      kind: "server",
      msg: {
        type: "commentEvents",
        target: thread.target,
        seq: 2,
        events: [],
        reviewSetEvents: [
          {
            kind: "upsert",
            id: "set-1",
            revision: 1,
            item: reviewSet({ openCount: 99 }),
          },
        ],
      },
    });
    expect(state).toBe(afterFresh);

    state = reduceAssistantState(state, {
      kind: "server",
      msg: {
        type: "commentEvents",
        target: thread.target,
        seq: 3,
        events: [],
        reviewSetEvents: [{ kind: "delete", id: "set-1", revision: 3 }],
      },
    });
    expect(state.worktreeReviewSets["wt-1"]).toEqual([]);
    expect(state.worktreeReviewSetRevisions["wt-1"]?.["set-1"]).toBe(3);
  });

  it("drops the canonical projection and revisions when a surface unwatches", () => {
    const thread = gutterThread();
    const loaded = reduceAssistantState(createInitialState(), {
      kind: "server",
      msg: {
        type: "commentsSnapshot",
        target: thread.target,
        threads: [thread],
        revisions: [{ id: thread.id, revision: 1 }],
      },
    });

    const state = reduceAssistantState(loaded, {
      kind: "unwatchComments",
      target: {
        kind: "worktree",
        worktreeId: "wt-1",
        path: "",
        side: "new",
        revision: "",
      },
    });

    expect(state.comments["worktree:wt-1"]).toBeUndefined();
    expect(state.commentTargets["worktree:wt-1"]).toBeUndefined();
    expect(state.commentRevisions["worktree:wt-1"]).toBeUndefined();
    expect(state.worktreeComments["wt-1"]).toBeUndefined();
    expect(state.worktreeReviewSets["wt-1"]).toBeUndefined();
    expect(state.worktreeReviewSetRevisions["wt-1"]).toBeUndefined();
  });
});
