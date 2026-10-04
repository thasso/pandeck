import { describe, expect, test } from "vitest";
import {
  isShelvedSession,
  spawnClusterDescendantIds,
  spawnClusterForest,
  spawnClusterMembers,
  spawnClusterSettleBlockedReason,
  type SessionListItem,
  type WorkflowRunCard,
  type WorkflowRunSummary,
} from "./protocol.ts";

/**
 * The spawn forest is the ONE membership answer for a coordinator's cluster:
 * the browser folds its cards along it, and the server settles a
 * coordinator's descendants along it. Every rule that decides membership is
 * pinned here, since a divergence would have the two sides settle different
 * sessions on one click.
 */
function row(
  partial: Partial<SessionListItem> & { id: string },
): SessionListItem {
  return {
    harness: "pi",
    agentType: "assistant",
    title: partial.id,
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
    ...partial,
  };
}

function child(
  id: string,
  parent: string,
  extra: Partial<SessionListItem> = {},
): SessionListItem {
  return row({
    id,
    spawnedBySessionId: parent,
    spawnOwnership: "coordinator",
    ...extra,
  });
}

function descendants(rootId: string, rows: SessionListItem[]): string[] {
  return spawnClusterDescendantIds(rootId, spawnClusterForest(rows));
}

function roots(rows: SessionListItem[]): string[] {
  const forest = spawnClusterForest(rows);
  return forest.order.filter((id) => !forest.parentOf.has(id));
}

describe("spawnClusterForest", () => {
  test("folds coordinator-owned edges at every depth, parents first", () => {
    const rows = [
      row({ id: "root" }),
      child("deep", "kid"),
      child("kid", "root"),
      child("other", "root"),
    ];
    expect(descendants("root", rows)).toEqual(["kid", "other", "deep"]);
    expect(descendants("kid", rows)).toEqual(["deep"]);
    expect(descendants("other", rows)).toEqual([]);
    expect(roots(rows)).toEqual(["root"]);
  });

  test("leaves out what the user owns, what is shelved and what has no spawner here", () => {
    const rows = [
      row({ id: "root" }),
      child("mine", "root", { spawnOwnership: "taken-over" }),
      child("unknown", "root", { spawnOwnership: "unknown" }),
      child("shelved", "root", { settledAt: 1 }),
      // A shelved peer whose own peers are shelved too has nothing live below
      // it, so the whole branch stays on the shelf.
      child("shelved-under-shelved", "shelved", { settledAt: 1 }),
      // A shelved peer that is asking is NOT on the shelf, so it folds —
      // exactly so that its question can refuse the coordinator's settle.
      child("asking", "root", { settledAt: 1, attention: "question" }),
      child("orphan", "gone"),
      child("kid", "root"),
    ];
    expect(descendants("root", rows)).toEqual(["asking", "kid"]);
    expect(descendants("shelved", rows)).toEqual([]);
    expect(roots(rows).sort()).toEqual([
      "mine",
      "orphan",
      "root",
      "shelved",
      "shelved-under-shelved",
      "unknown",
    ]);
  });

  test("keeps a shelved peer in the cluster while live work hangs below it", () => {
    // `mid` was put down, but a peer it spawned later is still live: the live
    // peer stays under its coordinator's coordinator, through `mid`, instead
    // of surfacing as a card of its own.
    const rows = [
      row({ id: "root" }),
      child("mid", "root", { settledAt: 1 }),
      child("low", "mid", { settledAt: 1 }),
      child("live", "low"),
      child("done", "mid", { settledAt: 1 }),
    ];
    expect(descendants("root", rows)).toEqual(["mid", "low", "live"]);
    expect(roots(rows).sort()).toEqual(["done", "root"]);
  });

  test("folds a chain of any depth into its one root", () => {
    const chain = Array.from({ length: 12 }, (_, i) =>
      i === 0 ? row({ id: "s0" }) : child(`s${i}`, `s${i - 1}`),
    );
    expect(descendants("s0", chain)).toEqual(
      Array.from({ length: 11 }, (_, i) => `s${i + 1}`),
    );
    expect(roots(chain)).toEqual(["s0"]);
  });

  test("breaks a cycle at its first id, and a Settle follows the same break", () => {
    // `a` and `b` spawned each other, and `a` also spawned `0`. Nothing is
    // reachable from a root, so the stranded ids are promoted in id order:
    // `0` first (a root of its own), then `a`, whose walk still owns `b`.
    // The descendants of `a` are then exactly what its card folds: `b`, and
    // NOT `0`, which the browser shows as a card of its own.
    const rows = [child("a", "b"), child("b", "a"), child("0", "a")];
    expect(roots(rows)).toEqual(["0", "a"]);
    expect(descendants("a", rows)).toEqual(["b"]);
    expect(descendants("0", rows)).toEqual([]);
    expect(descendants("self", [child("self", "self")])).toEqual([]);
  });
});

describe("spawnClusterMembers", () => {
  const run = (id: string, lifecycle: WorkflowRunSummary["lifecycle"]) =>
    ({
      id,
      taskId: "1",
      recipeId: "code-delivery",
      recipeVersion: 1,
      lifecycle,
      limits: { maxIterations: 3, maxReviewPasses: 2 },
      createdAt: 0,
      updatedAt: 0,
    }) as WorkflowRunSummary;
  const card = (coordinatorSessionId: string) =>
    ({ coordinatorSessionId }) as WorkflowRunCard;

  test("takes a working-set run's roles out of the forest, and archived rows", () => {
    // A user session that spawned a run's coordinator: the coordinator and
    // what it spawned belong to the run while the run is an item, so a Settle
    // on the user's session must not reach them.
    const rows = [
      row({ id: "mine" }),
      child("run-coordinator", "mine"),
      child("implementer", "run-coordinator"),
      child("archived", "mine", { archived: true }),
      child("kid", "mine"),
    ];
    const members = spawnClusterMembers(rows, [run("7", "active")], {
      "7": card("run-coordinator"),
    });
    expect(members.map((s) => s.id)).toEqual(["mine", "implementer", "kid"]);
    // The implementer's spawner is gone from the forest, so it stands alone.
    expect(descendants("mine", members)).toEqual(["kid"]);
    expect(roots(members)).toEqual(["mine", "implementer"]);
  });

  test("a settled terminal run owns nothing, so its sessions fold again", () => {
    const rows = [row({ id: "mine" }), child("run-coordinator", "mine")];
    const members = spawnClusterMembers(rows, [run("7", "completed")], {
      "7": card("run-coordinator"),
    });
    expect(descendants("mine", members)).toEqual(["run-coordinator"]);
  });
});

describe("spawnClusterSettleBlockedReason", () => {
  const reason = (rootId: string, rows: SessionListItem[]) =>
    spawnClusterSettleBlockedReason(
      rootId,
      new Map(rows.map((session) => [session.id, session])),
      spawnClusterForest(rows),
    );

  test("answers the root's own reason first, then the first blocked descendant's", () => {
    expect(
      reason("root", [
        row({ id: "root", isStreaming: true }),
        child("kid", "root", { attention: "question" }),
      ]),
    ).toBe("it is still running.");
    // Descendants in forest order — the same order on both sides, so the
    // disabled button and the refusal name the same peer.
    expect(
      reason("root", [
        row({ id: "root" }),
        child("busy", "root", { isStreaming: true }),
        child("asks", "root", { attention: "question" }),
      ]),
    ).toBe("it is still running.");
    expect(
      reason("root", [
        row({ id: "root" }),
        child("quiet", "root"),
        child("deep", "quiet", { queuedWork: true }),
      ]),
    ).toBe("work is queued behind it.");
  });

  test("a peer's failure never blocks: the settle acknowledges it", () => {
    expect(
      reason("root", [
        row({ id: "root" }),
        child("kid", "root", { lastError: { at: 1, message: "boom" } }),
      ]),
    ).toBe(undefined);
  });

  test("a session with nothing folded answers its own reason alone", () => {
    expect(reason("kid", [row({ id: "kid", queuedWork: true })])).toBe(
      "work is queued behind it.",
    );
    expect(reason("kid", [row({ id: "kid" })])).toBe(undefined);
    expect(reason("missing", [])).toBe(undefined);
  });

  test("a row that is no member still answers its own reason", () => {
    // An archived coordinator, or a working-set run's role: the forest holds
    // nothing for it, but the row map does, and its own block still counts.
    const archived = row({ id: "gone", archived: true, isStreaming: true });
    expect(
      spawnClusterSettleBlockedReason(
        "gone",
        new Map([[archived.id, archived]]),
        spawnClusterForest([]),
      ),
    ).toBe("it is still running.");
  });
});

describe("isShelvedSession", () => {
  test("a settled row is shelved unless a human decision keeps it visible", () => {
    expect(isShelvedSession(row({ id: "a" }))).toBe(false);
    expect(isShelvedSession(row({ id: "a", settledAt: 1 }))).toBe(true);
    expect(
      isShelvedSession(row({ id: "a", settledAt: 1, isStreaming: true })),
    ).toBe(true);
    for (const attention of ["question", "approval", "task-choice"] as const)
      expect(isShelvedSession(row({ id: "a", settledAt: 1, attention }))).toBe(
        false,
      );
    expect(
      isShelvedSession(row({ id: "a", settledAt: 1, awaitingInput: true })),
    ).toBe(false);
  });
});
