import { describe, expect, test } from "vitest";
import {
  ownedBySessionTree,
  sessionTreeWorktrees,
} from "./sessionTreeWorktrees.ts";

describe("ownedBySessionTree", () => {
  test("reads the server's membership, and never owns the main checkout", () => {
    const worktree = {
      id: "w",
      sessionIds: ["peer"],
      treeSessionIds: ["peer", "coord", "root"],
    };
    expect(ownedBySessionTree(worktree, "root")).toBe(true);
    expect(ownedBySessionTree(worktree, "peer")).toBe(true);
    expect(ownedBySessionTree(worktree, "stranger")).toBe(false);
    expect(ownedBySessionTree({ id: "x", sessionIds: [] }, "root")).toBe(false);
    expect(
      ownedBySessionTree({ ...worktree, id: "main:p", isMain: true }, "root"),
    ).toBe(false);
  });
});

describe("sessionTreeWorktrees", () => {
  const tree = new Set(["coord", "peer"]);

  test("a tree owns what it created or runs in, creator first", () => {
    const worktrees = [
      { id: "created", sessionIds: [], createdBySessionId: "coord" },
      {
        id: "both",
        sessionIds: ["peer", "other"],
        createdBySessionId: "coord",
      },
      { id: "runs", sessionIds: ["other", "peer"] },
      { id: "foreign", sessionIds: ["other"], createdBySessionId: "other" },
    ];
    const owned = sessionTreeWorktrees(tree, worktrees);
    expect(owned.map(({ worktree }) => worktree.id)).toEqual([
      "created",
      "both",
      "runs",
    ]);
    expect(owned[1]?.owners).toEqual([
      { sessionId: "coord", role: "created" },
      { sessionId: "peer", role: "runs-in" },
    ]);
    expect(owned[2]?.owners).toEqual([{ sessionId: "peer", role: "runs-in" }]);
  });

  test("a session holding both roles is listed once per role, once each", () => {
    const owned = sessionTreeWorktrees(tree, [
      { id: "w", sessionIds: ["coord", "coord"], createdBySessionId: "coord" },
    ]);
    expect(owned[0]?.owners).toEqual([
      { sessionId: "coord", role: "created" },
      { sessionId: "coord", role: "runs-in" },
    ]);
  });

  test("the synthetic main checkout is never owned", () => {
    expect(
      sessionTreeWorktrees(tree, [
        { id: "main:p", isMain: true, sessionIds: ["coord"] },
      ]),
    ).toEqual([]);
  });
});
