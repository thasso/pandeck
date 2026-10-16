/**
 * The Initiative page's view model (`docs/initiatives.md`, The Initiative
 * page): the live Task overlay, the member tree and the selection fragment.
 *   pnpm --filter @assistant/web test src/lib/initiativeView.test.ts
 */
import { describe, expect, it } from "vitest";
import type {
  InitiativeDetail,
  SessionListItem,
  TaskSummary,
} from "@assistant/shared";
import {
  HOSTED_LABS_DETAIL,
  HOSTED_LABS_TASK_IDS as T,
} from "../../component-preview/fixtures/initiatives.ts";
import {
  canonicalCollapsed,
  collapseRequest,
  collapsedAway,
  flattenTree,
  hiddenDoneIds,
  initiativeMembers,
  subtreeFacts,
  initiativeTaskFragment,
  liveTaskIndex,
  memberStateLabel,
  memberTree,
  milestoneMembers,
  runningTaskIds,
  selectedTaskFromHash,
} from "./initiativeView.ts";

function task(partial: Partial<TaskSummary> & { id: string }): TaskSummary {
  return {
    title: `Task ${partial.id}`,
    status: "todo",
    source: { createdBy: "user" },
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function session(id: string, isStreaming: boolean): SessionListItem {
  return {
    id,
    harness: "claude-sdk",
    agentType: "developer",
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    ...(isStreaming ? { isStreaming } : {}),
  };
}

const NO_RUNNING = new Set<string>();

describe("the live overlay", () => {
  it("takes the read alone until the Tasks topic is authoritative", () => {
    const tasks = [task({ id: T.SDC5, status: "done" })];
    expect(liveTaskIndex(tasks, false)).toBeNull();
    const members = initiativeMembers(HOSTED_LABS_DETAIL, null, NO_RUNNING);
    expect(members.get(T.SDC5)).toMatchObject({
      status: "doing",
      blocked: true,
    });
  });

  it("recolours a member from the Tasks topic without touching the read", () => {
    const before = structuredClone(HOSTED_LABS_DETAIL);
    const live = liveTaskIndex(
      [task({ id: T.SDC5, status: "done", title: "Renamed" })],
      true,
    );
    const members = initiativeMembers(HOSTED_LABS_DETAIL, live, NO_RUNNING);
    expect(members.get(T.SDC5)).toMatchObject({
      status: "done",
      title: "Renamed",
      blocked: false,
      startable: false,
    });
    // Members absent from the live list keep the read's facts.
    expect(members.get(T.SDC6)?.status).toBe("todo");
    expect(HOSTED_LABS_DETAIL).toEqual(before);
  });

  it("keeps doing and blocked apart, and counts open blockers live", () => {
    const live = liveTaskIndex(
      [task({ id: T.SDC5, status: "doing", openBlockerCount: 2 })],
      true,
    );
    const member = initiativeMembers(HOSTED_LABS_DETAIL, live, NO_RUNNING).get(
      T.SDC5,
    )!;
    expect(member).toMatchObject({
      status: "doing",
      blocked: true,
      openBlockers: 2,
      startable: false,
    });
    expect(memberStateLabel(member)).toBe(
      "In progress, blocked by 2 open tasks",
    );
  });

  it("never draws an archived open member as startable or blocked", () => {
    const member = initiativeMembers(HOSTED_LABS_DETAIL, null, NO_RUNNING).get(
      T.LAB9,
    )!;
    expect(member).toMatchObject({
      archived: true,
      status: "todo",
      startable: false,
      blocked: false,
    });
  });

  it("marks a Task running only through a streaming session started from it", () => {
    const live = liveTaskIndex(
      [
        task({
          id: T.LAB2,
          status: "doing",
          sessionRefs: [{ sessionId: "s-run", origin: "task-start" }],
        }),
        task({
          id: T.SRS4,
          sessionRefs: [{ sessionId: "s-idle", origin: "task-start" }],
        }),
        // A streaming session that only referenced the Task (a search, a scan)
        // or carries no origin at all is NOT working on it.
        task({
          id: T.SDC5,
          status: "doing",
          sessionRefs: [{ sessionId: "s-run", origin: "reference" }],
        }),
        task({ id: T.SDC6, sessionRefs: [{ sessionId: "s-run" }] }),
      ],
      true,
    );
    const running = runningTaskIds(live, [
      session("s-run", true),
      session("s-idle", false),
    ]);
    expect([...running]).toEqual([T.LAB2]);
    const members = initiativeMembers(HOSTED_LABS_DETAIL, live, running);
    expect(members.get(T.LAB2)?.running).toBe(true);
    expect(members.get(T.SRS4)?.running).toBe(false);
    // `doing` is the Task's status, a separate fact from a running session.
    expect(members.get(T.SDC5)).toMatchObject({
      status: "doing",
      running: false,
    });
    expect(members.get(T.SDC6)?.running).toBe(false);
  });

  it("includes outside blockers, which are real Tasks", () => {
    const members = initiativeMembers(HOSTED_LABS_DETAIL, null, NO_RUNNING);
    expect(members.get(T["OUT-LEGAL"])).toMatchObject({
      id: T["OUT-LEGAL"],
      milestone: false,
    });
  });
});

describe("the member tree", () => {
  it("draws every member once, a milestone where it stands", () => {
    const members = initiativeMembers(HOSTED_LABS_DETAIL, null, NO_RUNNING);
    const rows = flattenTree(memberTree(HOSTED_LABS_DETAIL, members));
    const ids = rows.map((row) => row.member.id);
    expect(ids).toHaveLength(HOSTED_LABS_DETAIL.nodes.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(HOSTED_LABS_DETAIL.nodes.map((node) => node.id));
    expect(rows.find((row) => row.member.id === T.SDC4b)?.depth).toBe(2);
  });

  it("gives each epic its descendants' progress, archived ones included", () => {
    const members = initiativeMembers(HOSTED_LABS_DETAIL, null, NO_RUNNING);
    const tree = memberTree(HOSTED_LABS_DETAIL, members);
    const byId = new Map(flattenTree(tree).map((row) => [row.member.id, row]));
    expect(byId.get(T.SDC)?.progress).toEqual({ total: 11, done: 2 });
    expect(byId.get(T.LAB)?.progress).toEqual({ total: 9, done: 1 });
    expect(byId.get(T.SDC4)?.progress).toEqual({ total: 2, done: 0 });
    expect(byId.get(T.SDC1)?.progress).toBeUndefined();
  });

  it("keeps a milestone under an epic in place, not duplicated", () => {
    const detail: InitiativeDetail = {
      ...HOSTED_LABS_DETAIL,
      nodes: HOSTED_LABS_DETAIL.nodes.map((node) =>
        node.id === T.SDC9 ? { ...node, milestone: true } : node,
      ),
      milestoneIds: [T.SDC9, T.RELEASE],
    };
    const members = initiativeMembers(detail, null, NO_RUNNING);
    const ids = flattenTree(memberTree(detail, members)).map(
      (row) => row.member.id,
    );
    expect(ids.filter((id) => id === T.SDC9)).toHaveLength(1);
    expect(milestoneMembers(detail, members).map((m) => m.id)).toEqual([
      T.SDC9,
      T.RELEASE,
    ]);
  });
});

describe("the selection fragment", () => {
  it("round-trips a Task id and ignores other fragments", () => {
    expect(selectedTaskFromHash(initiativeTaskFragment("817"))).toBe("817");
    expect(selectedTaskFromHash("#m-abc")).toBeNull();
    expect(selectedTaskFromHash("")).toBeNull();
    expect(selectedTaskFromHash("#task-%E0%A4%A")).toBeNull();
  });
});

describe("collapsing epics", () => {
  it("names the set as the server applies it: epics only, outermost, ascending", () => {
    expect(
      canonicalCollapsed(HOSTED_LABS_DETAIL, [
        T.SRS,
        T.LAB,
        T.LAB,
        T.LAB3, // under a collapsed epic, and no children
        T.SDC1, // no children
        "999999", // not a member
      ]),
    ).toEqual([T.LAB, T.SRS]);
    // A nested epic collapses on its own, and not under a collapsed ancestor.
    expect(canonicalCollapsed(HOSTED_LABS_DETAIL, [T.SDC4])).toEqual([T.SDC4]);
    expect(canonicalCollapsed(HOSTED_LABS_DETAIL, [T.SDC4, T.SDC])).toEqual([
      T.SDC,
    ]);
    expect(canonicalCollapsed(HOSTED_LABS_DETAIL, [])).toEqual([]);
    // Ids sort as numbers, then as text, and a request is capped.
    expect(collapseRequest(["10", "9", "9", "x"])).toEqual(["9", "10", "x"]);
    expect(
      collapseRequest(Array.from({ length: 600 }, (_, i) => String(i))),
    ).toHaveLength(500);
  });

  it("folds a collapsed epic's descendants away, its milestones aside", () => {
    const detail: InitiativeDetail = {
      ...HOSTED_LABS_DETAIL,
      nodes: HOSTED_LABS_DETAIL.nodes.map((node) =>
        node.id === T.SDC9 ? { ...node, milestone: true as const } : node,
      ),
    };
    const away = collapsedAway(detail, [T.SDC]);
    expect(away.get(T.SDC4a)).toBe(T.SDC);
    expect(away.get(T.SDC5)).toBe(T.SDC);
    expect(away.has(T.SDC9)).toBe(false);
    expect(away.has(T.SDC)).toBe(false);
  });
});

describe("subtree facts and Hide done", () => {
  it("counts an epic's descendants from the live statuses", () => {
    const members = initiativeMembers(HOSTED_LABS_DETAIL, null, NO_RUNNING);
    const facts = subtreeFacts(HOSTED_LABS_DETAIL, members);
    // LAB1 is done of nine; SDC4 holds two open subtasks.
    expect(facts.get(T.LAB)).toMatchObject({
      total: 9,
      done: 1,
      allDone: false,
    });
    expect(facts.get(T.SDC4)).toMatchObject({ total: 2, done: 0 });
    expect(facts.get(T.SDC1)).toMatchObject({
      total: 0,
      done: 0,
      allDone: true,
    });
    // The same counts move with the Tasks topic, no read.
    const live = liveTaskIndex(
      HOSTED_LABS_DETAIL.nodes
        .filter((node) => !node.archived)
        .map((node) =>
          task({
            id: node.id,
            status:
              node.parentId === T.LAB || node.id === T.LAB
                ? "done"
                : node.status,
          }),
        ),
      true,
    );
    const moved = subtreeFacts(
      HOSTED_LABS_DETAIL,
      initiativeMembers(HOSTED_LABS_DETAIL, live, NO_RUNNING),
    );
    // LAB9 is archived and open in the read, so it is not in the live list.
    expect(moved.get(T.LAB)).toMatchObject({
      total: 9,
      done: 8,
      allDone: false,
    });
  });

  it("hides done work with nothing open under it, and keeps a done epic over open work", () => {
    const live = liveTaskIndex(
      HOSTED_LABS_DETAIL.nodes
        .filter((node) => !node.archived)
        .map((node) =>
          task({
            id: node.id,
            status:
              node.id === T.SDC || node.id === T.SDC4 ? "done" : node.status,
          }),
        ),
      true,
    );
    const members = initiativeMembers(HOSTED_LABS_DETAIL, live, NO_RUNNING);
    const hidden = hiddenDoneIds(
      HOSTED_LABS_DETAIL,
      members,
      subtreeFacts(HOSTED_LABS_DETAIL, members),
    );
    // Done leaves and the done outside blocker go.
    for (const id of [T.SDC1, T.SDC2, T.LAB1, T.SRS1, T.SRS2, T["OUT-REVIEW"]])
      expect(hidden.has(id)).toBe(true);
    // SDC and SDC4 are done, but open work sits under them.
    expect(hidden.has(T.SDC)).toBe(false);
    expect(hidden.has(T.SDC4)).toBe(false);
    // Open, doing, archived-open and outside-open stay.
    for (const id of [T.SDC5, T.LAB9, T.RELEASE, T["OUT-LEGAL"]])
      expect(hidden.has(id)).toBe(false);
  });
});
