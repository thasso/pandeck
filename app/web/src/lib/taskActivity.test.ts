import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import type { Task } from "./backlogTree.ts";
import {
  isTaskWorking,
  isWorkingRef,
  taskStartSession,
  taskWorktreeIds,
} from "./taskActivity.ts";

function task(refs: Task["sessionRefs"]): Task {
  return {
    id: "1",
    title: "T",
    status: "todo",
    source: { createdBy: "user" },
    createdAt: 0,
    updatedAt: 0,
    sessionRefs: refs,
  } as Task;
}

function sessions(
  entries: Array<[string, boolean]>,
): Map<string, SessionListItem> {
  return new Map(
    entries.map(([id, isStreaming]) => [
      id,
      { id, isStreaming } as SessionListItem,
    ]),
  );
}

describe("isWorkingRef", () => {
  it("counts a session started from the Task", () => {
    expect(isWorkingRef({ sessionId: "a", origin: "task-start" })).toBe(true);
  });

  it("does not count a session that merely references the Task", () => {
    // This is the scanner/exploration case: something looked at the Task, which
    // says nothing about whether work is happening on it.
    expect(isWorkingRef({ sessionId: "c", origin: "reference" })).toBe(false);
    // `origin` defaults to `reference` when absent, so a bare ref is not work.
    expect(isWorkingRef({ sessionId: "d" })).toBe(false);
  });
});

describe("isTaskWorking", () => {
  it("is true while a task-start session streams", () => {
    expect(
      isTaskWorking(
        task([{ sessionId: "a", origin: "task-start" }]),
        sessions([["a", true]]),
      ),
    ).toBe(true);
  });

  it("is false once that session stops", () => {
    expect(
      isTaskWorking(
        task([{ sessionId: "a", origin: "task-start" }]),
        sessions([["a", false]]),
      ),
    ).toBe(false);
  });

  it("ignores a streaming session that only references the Task", () => {
    // A scanner running right now must not make an untouched Task look busy.
    expect(
      isTaskWorking(
        task([{ sessionId: "a", origin: "reference" }]),
        sessions([["a", true]]),
      ),
    ).toBe(false);
  });

  it("finds the working session among several references", () => {
    const item = task([
      { sessionId: "scanner", origin: "reference" },
      { sessionId: "worker", origin: "task-start" },
    ]);
    expect(
      isTaskWorking(
        item,
        sessions([
          ["scanner", false],
          ["worker", true],
        ]),
      ),
    ).toBe(true);
  });

  it("tolerates refs whose session is not loaded, and no refs at all", () => {
    expect(
      isTaskWorking(
        task([{ sessionId: "gone", origin: "task-start" }]),
        sessions([]),
      ),
    ).toBe(false);
    expect(isTaskWorking(task(undefined), sessions([["a", true]]))).toBe(false);
  });
});

describe("taskStartSession", () => {
  const at = (id: string, updatedAt: number, isStreaming = false) =>
    [id, { id, updatedAt, isStreaming } as SessionListItem] as const;

  it("prefers the streaming session, then the most recently touched", () => {
    const item = task([
      { sessionId: "old", origin: "task-start" },
      { sessionId: "recent", origin: "task-start" },
    ]);
    const idle = new Map([at("old", 10), at("recent", 20)]);
    expect(taskStartSession(item, idle)?.id).toBe("recent");
    // A run in progress outranks recency: it is the one thing happening now.
    const running = new Map([at("old", 10, true), at("recent", 20)]);
    expect(taskStartSession(item, running)?.id).toBe("old");
  });

  it("ignores a session that only referenced the Task", () => {
    const item = task([{ sessionId: "scanner", origin: "reference" }]);
    expect(taskStartSession(item, new Map([at("scanner", 10)]))).toBeNull();
  });

  it("skips an archived session", () => {
    // Archived is PUT AWAY, and a default broadcast omits those rows until the
    // user expands the archive — counting them would make the row offer "open"
    // or "start" depending on unrelated sidebar state.
    const item = task([{ sessionId: "old", origin: "task-start" }]);
    const map = new Map([
      ["old", { id: "old", updatedAt: 10, archived: true } as SessionListItem],
    ]);
    expect(taskStartSession(item, map)).toBeNull();
  });

  it("answers null for a ref the browser cannot open", () => {
    // Deleted, or archived out of the loaded list: a row action that leads
    // nowhere is worse than the row offering to start the work instead.
    const item = task([{ sessionId: "gone", origin: "task-start" }]);
    expect(taskStartSession(item, new Map())).toBeNull();
    expect(taskStartSession(task(undefined), new Map())).toBeNull();
  });
});

/**
 * The Backlog's whole reach into worktree state: what App holds a live
 * git-status watch for, and which worktrees' dirty flags may reach the memoized
 * list. Watched set and marked set are the same set by construction, so the
 * failures this guards are a marker nobody keeps current and a repaint nobody
 * can see.
 */
describe("taskWorktreeIds", () => {
  const withWorktrees = (
    entries: Array<[string, string | undefined, boolean?]>,
  ): Map<string, SessionListItem> =>
    new Map(
      entries.map(([id, worktreeId, archived]) => [
        id,
        { id, worktreeId, archived, updatedAt: 1 } as SessionListItem,
      ]),
    );
  const taskWith = (id: string, refs: Task["sessionRefs"]): Task =>
    ({ ...task(refs), id }) as Task;

  it("names each worktree the Tasks have work in exactly once", () => {
    const map = withWorktrees([
      ["s1", "wt-1"],
      ["s2", "wt-2"],
      ["s3", "wt-1"],
    ]);
    expect(
      taskWorktreeIds(
        [
          taskWith("a", [{ sessionId: "s1", origin: "task-start" }]),
          taskWith("b", [{ sessionId: "s2", origin: "task-start" }]),
          // The same worktree through a second session: one id, not two.
          taskWith("c", [{ sessionId: "s3", origin: "task-start" }]),
        ],
        map,
      ),
    ).toEqual(["wt-1", "wt-2"]);
  });

  it("leaves out everything a row would draw no glyph for", () => {
    const map = withWorktrees([
      ["ref", "wt-ref"],
      ["old", "wt-old", true],
      ["none", undefined],
    ]);
    expect(
      taskWorktreeIds(
        [
          // Merely REFERENCED: the row states nothing about it, so neither does
          // the scope — and nothing is watched for it.
          taskWith("a", [{ sessionId: "ref", origin: "reference" }]),
          // Archived, and a session with no worktree at all.
          taskWith("b", [{ sessionId: "old", origin: "task-start" }]),
          taskWith("c", [{ sessionId: "none", origin: "task-start" }]),
          taskWith("d", undefined),
        ],
        map,
      ),
    ).toEqual([]);
  });
});
