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
  flattenTree,
  initiativeMembers,
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

  it("marks a Task running only through its linked streaming session", () => {
    const live = liveTaskIndex(
      [
        task({
          id: T.LAB2,
          status: "doing",
          sessionRefs: [{ sessionId: "s-run" }],
        }),
        task({ id: T.SRS4, sessionRefs: [{ sessionId: "s-idle" }] }),
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
