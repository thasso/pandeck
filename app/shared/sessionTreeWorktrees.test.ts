import { describe, expect, test } from "vitest";
import {
  sessionTreeWorktrees,
  spawnTreeSessionIds,
} from "./sessionTreeWorktrees.ts";

describe("spawnTreeSessionIds", () => {
  test("walks every depth below the root and nothing above or beside it", () => {
    const sessions = [
      { id: "top" },
      { id: "root", spawnedBySessionId: "top" },
      { id: "a", spawnedBySessionId: "root" },
      { id: "b", spawnedBySessionId: "root" },
      { id: "a1", spawnedBySessionId: "a" },
      { id: "sibling", spawnedBySessionId: "top" },
      { id: "loose" },
    ];
    expect([...spawnTreeSessionIds("root", sessions)].sort()).toEqual([
      "a",
      "a1",
      "b",
      "root",
    ]);
  });

  test("includes an unknown root and survives a cycle and a self edge", () => {
    expect([...spawnTreeSessionIds("ghost", [])]).toEqual(["ghost"]);
    const cyclic = [
      { id: "x", spawnedBySessionId: "y" },
      { id: "y", spawnedBySessionId: "x" },
      { id: "z", spawnedBySessionId: "z" },
    ];
    expect([...spawnTreeSessionIds("x", cyclic)].sort()).toEqual(["x", "y"]);
    expect([...spawnTreeSessionIds("z", cyclic)]).toEqual(["z"]);
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
