import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type {
  CommentEventsMessage,
  CommentTarget,
  CommentThread,
  ServerMessage,
  WorktreeReviewSet,
} from "@assistant/shared";
import type { Viewer } from "../harness.ts";
import { broadcastCommentEventToViewers } from "../hub.ts";
import type { CommentStore } from "./commentStore.ts";
import {
  commentOwnership,
  commentsSnapshot,
  notifyCommentChanges,
  notifyCommentMetadataChanges,
  resetCommentEventsForTests,
  setCommentBroadcaster,
} from "./commentEvents.ts";

const taskTarget = { kind: "task", taskId: "42" } as const;

function thread(
  target: CommentTarget,
  body: string,
  id = "thread-1",
): CommentThread {
  return {
    id,
    target,
    status: "open",
    root: {
      id,
      author: { kind: "user", name: "User" },
      body,
      createdAt: 1,
    },
    replies: [
      {
        id: `${id}-reply`,
        parentId: id,
        author: { kind: "agent", name: "Agent", sessionId: "agent-1" },
        body: "reply",
        createdAt: 2,
      },
    ],
    handoffSessionIds: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

function fakeStore(list: CommentStore["list"]): CommentStore {
  const unsupported = async () => {
    throw new Error("unused");
  };
  return {
    list,
    add: unsupported,
    reply: unsupported,
    resolve: unsupported,
    edit: unsupported,
    delete: unsupported,
    attach: unsupported,
  };
}

describe("comment state sync", () => {
  test("subscribing returns a snapshot and indexes roots and replies", async () => {
    const row = thread(taskTarget, "snapshot");
    resetCommentEventsForTests(() => fakeStore(async () => [row]));

    const snapshot = await commentsSnapshot(taskTarget, "request-1");

    assert.equal(snapshot.type, "commentsSnapshot");
    assert.equal(snapshot.requestId, "request-1");
    assert.deepEqual(snapshot.threads, [row]);
    assert.deepEqual(snapshot.revisions, [{ id: row.id, revision: 1 }]);
    assert.deepEqual(commentOwnership(row.id), {
      target: taskTarget,
      threadId: row.id,
    });
    assert.deepEqual(commentOwnership(`${row.id}-reply`), {
      target: taskTarget,
      threadId: row.id,
    });
  });

  test("keeps snapshot content and revisions atomic against a mutation", async () => {
    let current = thread(taskTarget, "before snapshot");
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    let reads = 0;
    resetCommentEventsForTests(() =>
      fakeStore(async () => {
        const captured = structuredClone(current);
        reads += 1;
        if (reads === 1) {
          markSnapshotStarted();
          await snapshotGate;
        }
        return [captured];
      }),
    );
    const messages: CommentEventsMessage[] = [];
    setCommentBroadcaster({
      broadcast: (_target, message) => messages.push(message),
    });

    const snapshotPromise = commentsSnapshot(taskTarget);
    await snapshotStarted;
    current = thread(taskTarget, "after snapshot");
    const mutation = notifyCommentChanges(taskTarget, [current.id]);
    releaseSnapshot();
    const snapshot = await snapshotPromise;
    await mutation;

    assert.equal(snapshot.threads[0]!.root.body, "before snapshot");
    assert.deepEqual(snapshot.revisions, [{ id: current.id, revision: 1 }]);
    assert.equal(messages[0]!.events[0]!.revision, 2);
    assert.equal(
      messages[0]!.events[0]!.kind === "upsert"
        ? messages[0]!.events[0]!.item.root.body
        : "deleted",
      "after snapshot",
    );
  });

  test("broadcasts only touched thread ids, including deletes", async () => {
    const first = thread(taskTarget, "first", "thread-1");
    const second = thread(taskTarget, "second", "thread-2");
    let rows = [first, second];
    resetCommentEventsForTests(() =>
      fakeStore(async () => structuredClone(rows)),
    );
    const messages: CommentEventsMessage[] = [];
    setCommentBroadcaster({
      broadcast: (_target, message) => messages.push(message),
    });

    await notifyCommentChanges(taskTarget, [first.id]);
    rows = [second];
    await notifyCommentChanges(taskTarget, [first.id]);

    assert.deepEqual(
      messages.map((message) =>
        message.events.map((event) => ({ id: event.id, kind: event.kind })),
      ),
      [[{ id: first.id, kind: "upsert" }], [{ id: first.id, kind: "delete" }]],
    );
  });

  test("snapshots review sets and broadcasts only revisioned touched sets", async () => {
    const target = {
      kind: "worktree",
      worktreeId: "wt-review",
      path: "",
      side: "new",
      revision: "",
    } as const;
    let sets: WorktreeReviewSet[] = [
      {
        id: "set-1",
        worktreeId: target.worktreeId,
        authorSessionId: "reviewer",
        blind: false,
        openCount: 1,
        addressedCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "set-2",
        worktreeId: target.worktreeId,
        authorSessionId: "reviewer",
        blind: false,
        openCount: 0,
        addressedCount: 0,
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    resetCommentEventsForTests(
      () => fakeStore(async () => []),
      () => structuredClone(sets),
    );
    const snapshot = await commentsSnapshot(target);
    assert.deepEqual(snapshot.reviewSets, sets);
    assert.deepEqual(snapshot.reviewSetRevisions, [
      { id: "set-1", revision: 1 },
      { id: "set-2", revision: 1 },
    ]);

    const messages: CommentEventsMessage[] = [];
    setCommentBroadcaster({
      broadcast: (_target, message) => messages.push(message),
    });
    sets = [{ ...sets[0]!, openCount: 0, addressedCount: 1 }];
    await notifyCommentMetadataChanges(target, ["set-1"]);
    await notifyCommentMetadataChanges(target, ["set-2"]);

    assert.deepEqual(messages[0]?.events, []);
    assert.deepEqual(messages[0]?.reviewSetEvents, [
      {
        kind: "upsert",
        id: "set-1",
        revision: 2,
        item: sets[0],
      },
    ]);
    assert.deepEqual(messages[1]?.reviewSetEvents, [
      { kind: "delete", id: "set-2", revision: 2 },
    ]);
    assert.equal("reviewSets" in messages[0]!, false);
  });

  test("serializes projection reads and revision stamps per target", async () => {
    let current = thread(taskTarget, "first");
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let reads = 0;
    const store = fakeStore(async () => {
      const captured = structuredClone(current);
      reads += 1;
      if (reads === 1) {
        markFirstStarted();
        await firstRead;
      }
      return [captured];
    });
    resetCommentEventsForTests(() => store);
    const messages: CommentEventsMessage[] = [];
    setCommentBroadcaster({
      broadcast: (_target, message) => messages.push(message),
    });

    const first = notifyCommentChanges(taskTarget, [current.id]);
    await firstStarted;
    current = thread(taskTarget, "second");
    const second = notifyCommentChanges(taskTarget, [current.id]);
    releaseFirst();
    await Promise.all([first, second]);

    assert.deepEqual(
      messages.map((message) => ({
        revision: message.events[0]!.revision,
        body:
          message.events[0]!.kind === "upsert"
            ? message.events[0]!.item.root.body
            : "deleted",
      })),
      [
        { revision: 1, body: "first" },
        { revision: 2, body: "second" },
      ],
    );
  });

  test("round-trips every target kind through snapshots", async () => {
    const targets: CommentTarget[] = [
      {
        kind: "worktree",
        worktreeId: "wt",
        path: "src/a.ts",
        side: "new",
        revision: "head",
      },
      { kind: "task", taskId: "42" },
      { kind: "session", sessionId: "s", entryId: "e", blockIndex: 3 },
    ];
    resetCommentEventsForTests((target) =>
      fakeStore(async () => [thread(target, target.kind)]),
    );

    for (const target of targets) {
      const snapshot = await commentsSnapshot(target);
      assert.deepEqual(snapshot.target, target);
      assert.deepEqual(snapshot.threads[0]?.target, target);
    }
  });
});

describe("comment broadcast isolation", () => {
  for (const target of [
    { kind: "task", taskId: "task-a" } as const,
    {
      kind: "worktree",
      worktreeId: "wt-a",
      path: "src/a.ts",
      side: "new",
      revision: "head",
    } as const,
  ]) {
    test(`a ${target.kind} event reaches only viewers holding that object`, () => {
      const delivered: string[] = [];
      const viewer = (name: string, held: CommentTarget): Viewer => ({
        send: (_message: ServerMessage) => delivered.push(name),
        wantsComments: (candidate) =>
          candidate.kind === held.kind &&
          (candidate.kind === "task"
            ? held.kind === "task" && candidate.taskId === held.taskId
            : candidate.kind === "worktree" &&
              held.kind === "worktree" &&
              candidate.worktreeId === held.worktreeId),
      });
      const other: CommentTarget =
        target.kind === "task"
          ? { kind: "task", taskId: "task-b" }
          : {
              kind: "worktree",
              worktreeId: "wt-b",
              path: "",
              side: "new",
              revision: "",
            };
      const message: CommentEventsMessage = {
        type: "commentEvents",
        target,
        seq: 1,
        events: [],
      };

      broadcastCommentEventToViewers(
        [viewer("holder", target), viewer("other", other)],
        target,
        message,
      );

      assert.deepEqual(delivered, ["holder"]);
    });
  }
});
