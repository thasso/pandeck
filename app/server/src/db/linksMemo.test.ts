/**
 * `memoizedOnLinks` hands the session list the same projection until an edge
 * leaving that node type may have changed. Every path that can change one has
 * to miss, and nothing else may.
 *   pnpm --filter @assistant/server test src/db/linksMemo.test.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDb, getDb, withDbTransaction } from "./index.ts";
import {
  addLink,
  memoizedOnLinks,
  outgoingByType,
  removeAllFor,
  removeLink,
  setOutgoing,
} from "./links.ts";

let n = 0;
const unique = (label: string) => `memo-${label}-${Date.now()}-${n++}`;

/** A memo over session `context` edges that counts its builds. */
function countingMemo() {
  let builds = 0;
  const read = memoizedOnLinks("session", () => {
    builds += 1;
    return outgoingByType("session", "context");
  });
  return { read, builds: () => builds };
}

test("a hit returns the same instance and builds nothing", () => {
  const memo = countingMemo();
  const first = memo.read();
  assert.equal(memo.read(), first);
  assert.equal(memo.builds(), 1);
});

test("every links write path invalidates the session projection", () => {
  const memo = countingMemo();
  const session = { type: "session" as const, id: unique("session") };
  const project = { type: "project" as const, id: unique("project") };
  const task = { type: "task" as const, id: unique("task") };

  const writes: Array<[string, () => void, (links: unknown) => boolean]> = [
    [
      "addLink",
      () => addLink(session, "context", task),
      () => memo.read().get(session.id)?.length === 1,
    ],
    [
      "addLink updating an existing edge",
      () => addLink(session, "context", task, { metadata: { source: "x" } }),
      () =>
        (memo.read().get(session.id)?.[0]?.metadata as { source?: string })
          ?.source === "x",
    ],
    [
      "removeLink",
      () => removeLink(session, "context", task),
      () => !memo.read().has(session.id),
    ],
    [
      "setOutgoing",
      () => setOutgoing(session, "context", [{ to: project }]),
      () => memo.read().get(session.id)?.[0]?.toId === project.id,
    ],
    [
      // Deleting a node removes the edges INTO it as well, whatever they leave
      // from: a removed project takes the session's edge with it.
      "removeAllFor the target",
      () => removeAllFor(project),
      () => !memo.read().has(session.id),
    ],
  ];
  for (const [label, write, reflected] of writes) {
    memo.read();
    const before = memo.builds();
    write();
    assert.ok(reflected(memo.read()), `${label}: the new state is read`);
    assert.equal(memo.builds(), before + 1, `${label}: rebuilt once`);
    memo.read();
    assert.equal(memo.builds(), before + 1, `${label}: then hits again`);
  }
});

test("an edge leaving another node type does not invalidate it", () => {
  const memo = countingMemo();
  memo.read();
  addLink({ type: "task", id: unique("task") }, "context", {
    type: "session",
    id: unique("session"),
  });
  memo.read();
  assert.equal(memo.builds(), 1);
});

test("a commit from another connection invalidates it", () => {
  const memo = countingMemo();
  const sessionId = unique("external");
  memo.read();
  const other = new DatabaseSync(join(DATA_DIR, "app.sqlite3"));
  try {
    other
      .prepare(
        `INSERT INTO links (from_type, from_id, relation, to_type, to_id, created_at_ms)
         VALUES ('session', ?, 'context', 'task', '1', ?)`,
      )
      .run(sessionId, Date.now());
  } finally {
    other.close();
  }
  assert.ok(memo.read().has(sessionId), "the other connection's edge is read");
  assert.equal(memo.builds(), 2);
});

test("a value built inside a transaction that rolls back is not kept", () => {
  const memo = countingMemo();
  const session = { type: "session" as const, id: unique("rollback") };
  memo.read();
  assert.throws(() =>
    withDbTransaction(() => {
      addLink(session, "context", { type: "task", id: "1" });
      assert.ok(memo.read().has(session.id), "visible inside the transaction");
      throw new Error("roll back");
    }),
  );
  assert.equal(
    memo.read().has(session.id),
    false,
    "the rolled-back edge is gone from the projection",
  );
});

test("a reopened database is a new connection and misses", () => {
  const memo = countingMemo();
  memo.read();
  closeDb();
  getDb();
  memo.read();
  assert.equal(memo.builds(), 2);
});
