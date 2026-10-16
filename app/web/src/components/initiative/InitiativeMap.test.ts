/**
 * Where the Initiative map opens (`InitiativeMap.tsx`).
 *   pnpm --filter @assistant/web test src/components/initiative/InitiativeMap.test.ts
 */
import { describe, expect, it } from "vitest";
import type { InitiativeMember } from "../../lib/initiativeView.ts";
import {
  initialViewport,
  overviewColor,
  routeEdges,
} from "./InitiativeMap.tsx";
import { initiativeMembers, liveTaskIndex } from "../../lib/initiativeView.ts";
import type {
  InitiativeDetail,
  InitiativeLayout,
  InitiativeLayoutNode,
  TaskSummary,
} from "@assistant/shared";
import {
  HOSTED_LABS_DETAIL,
  HOSTED_LABS_LAYOUT,
  HOSTED_LABS_LAYOUT_COLLAPSED,
  HOSTED_LABS_TASK_IDS as T,
} from "../../../component-preview/fixtures/initiatives.ts";
import { memberBandClass } from "./InitiativeStateMarks.tsx";

describe("initialViewport", () => {
  it("shows a small map whole and centred", () => {
    const view = initialViewport(
      { width: 800, height: 400 },
      { width: 1200, height: 800 },
    );
    expect(view.zoom).toBe(1);
    expect(view.x).toBe(200);
    expect(view.y).toBe(200);
  });

  it("opens a Hosted Labs-sized map readable, from its left edge", () => {
    const view = initialViewport(
      { width: 3356, height: 1048 },
      { width: 1024, height: 860 },
    );
    expect(view.zoom).toBeGreaterThanOrEqual(0.6);
    expect(view.zoom).toBeCloseTo(828 / 1048, 5);
    expect(view.x).toBe(16);
  });

  it("never opens below the readable zoom, even for a very tall map", () => {
    const view = initialViewport(
      { width: 3000, height: 6000 },
      { width: 1024, height: 700 },
    );
    expect(view.zoom).toBe(0.6);
    expect(view.y).toBe(16);
  });
});

describe("state colours", () => {
  const member = (partial: Partial<InitiativeMember>): InitiativeMember => ({
    id: "1",
    title: "T",
    status: "todo",
    blocked: false,
    openBlockers: 0,
    archived: false,
    startable: false,
    running: false,
    milestone: false,
    ...partial,
  });

  it("colours the overview by the node's own states", () => {
    expect(overviewColor(member({ startable: true }))).toBe("var(--primary)");
    expect(overviewColor(member({ status: "doing" }))).toBe(
      "var(--foreground)",
    );
    expect(overviewColor(member({ status: "doing", blocked: true }))).toBe(
      "var(--warning)",
    );
    expect(overviewColor(member({ status: "done" }))).toBe("var(--success)");
    expect(overviewColor(member({ archived: true, startable: false }))).toBe(
      "var(--border)",
    );
  });

  it("never gives an archived member a working band", () => {
    expect(memberBandClass(member({ archived: true, status: "doing" }))).toBe(
      "bg-border",
    );
    expect(memberBandClass(member({ startable: true }))).toBe("bg-primary");
    expect(memberBandClass(member({ status: "doing" }))).toBe("bg-foreground");
  });
});

describe("routeEdges (F024)", () => {
  const none = new Set<string>();
  const members = (live: Parameters<typeof liveTaskIndex>[0] = []) =>
    initiativeMembers(
      HOSTED_LABS_DETAIL,
      liveTaskIndex(live, live.length > 0),
      none,
    );
  const states = (edges: ReturnType<typeof routeEdges>) =>
    edges.map((edge) => (edge.data?.open ? "open" : "done"));

  it("judges an arrow by its blocker, the source, and keeps the server's route", () => {
    const edges = routeEdges(HOSTED_LABS_LAYOUT, members(), null, {
      blocks: HOSTED_LABS_DETAIL.edges,
    });
    expect(edges).toHaveLength(HOSTED_LABS_LAYOUT.edges.length);
    edges.forEach((edge, index) =>
      expect(edge.data?.points).toBe(HOSTED_LABS_LAYOUT.edges[index]!.points),
    );
    // SDC1 is done: its arrow into SDC2 is released.
    const byPair = new Map(
      edges.map((edge) => [`${edge.source}>${edge.target}`, edge]),
    );
    expect(byPair.get(`${T.SDC1}>${T.SDC2}`)?.data?.open).toBe(false);
    // SDC3 is in progress: its arrow into SDC5 still holds.
    expect(byPair.get(`${T.SDC3}>${T.SDC5}`)?.data?.open).toBe(true);
    expect(states(edges)).toContain("done");
  });

  it("releases a finished blocker's arrows live, and accents the selection", () => {
    const before = states(
      routeEdges(HOSTED_LABS_LAYOUT, members(), null, {
        blocks: HOSTED_LABS_DETAIL.edges,
      }),
    );
    const after = routeEdges(
      HOSTED_LABS_LAYOUT,
      members([
        {
          id: T.SDC3,
          title: "Session API behind the gateway",
          status: "done",
          source: { createdBy: "user" },
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
      T.SDC5,
      { blocks: HOSTED_LABS_DETAIL.edges },
    );
    const openCount = (list: string[]) =>
      list.filter((state) => state === "open").length;
    // SDC3 blocks SDC5 and LAB5: both release at once.
    expect(openCount(states(after))).toBe(openCount(before) - 2);
    const selected = after.filter((edge) => edge.data?.selected);
    expect(selected.length).toBeGreaterThan(0);
    for (const edge of selected)
      expect([edge.source, edge.target]).toContain(T.SDC5);
  });
});

describe("routeEdges through collapsed epics (F047)", () => {
  const none = new Set<string>();
  const row = (id: string, status: TaskSummary["status"]): TaskSummary => ({
    id,
    title: `Task ${id}`,
    status,
    source: { createdBy: "user" },
    createdAt: 1,
    updatedAt: 1,
  });
  const states = (
    layout: InitiativeLayout,
    detail: InitiativeDetail,
    live: TaskSummary[],
  ) => {
    const members = initiativeMembers(detail, liveTaskIndex(live, true), none);
    return new Map(
      routeEdges(layout, members, null, { blocks: detail.edges }).map(
        (edge) => [
          `${edge.source}>${edge.target}`,
          edge.data?.open ? "open" : "done",
        ],
      ),
    );
  };
  const liveLabs = (status: Record<string, TaskSummary["status"]>) =>
    HOSTED_LABS_DETAIL.nodes
      .filter((node) => !node.archived)
      .map((node) => row(node.id, status[node.id] ?? node.status));

  it("judges an arrow out of a collapsed epic by the blockers it stands for, never by the epic", () => {
    // LAB is a todo epic. Its arrow into SRS4 stands for LAB2 alone.
    const todoEpic = states(
      HOSTED_LABS_LAYOUT_COLLAPSED,
      HOSTED_LABS_DETAIL,
      liveLabs({ [T.LAB2]: "done" }),
    );
    expect(todoEpic.get(`${T.LAB}>${T.SRS4}`)).toBe("done");
    expect(todoEpic.get(`${T.LAB}>${T.RELEASE}`)).toBe("open");
    // From a real Task into the epic: that Task's own state, as before.
    expect(todoEpic.get(`${T.SDC3}>${T.LAB}`)).toBe("open");

    // A done epic over an open blocker still holds work up.
    const doneEpic = states(
      HOSTED_LABS_LAYOUT_COLLAPSED,
      HOSTED_LABS_DETAIL,
      liveLabs({ [T.LAB]: "done" }),
    );
    expect(doneEpic.get(`${T.LAB}>${T.SRS4}`)).toBe("open");
    expect(doneEpic.get(`${T.LAB}>${T.RELEASE}`)).toBe("open");
  });

  /**
   * Epic E holds A and B, epic F holds C; X and Y stand alone. A and B both
   * block X and C, and Y blocks C. With E and F collapsed, A>X and B>X are one
   * arrow E>X, A>C and B>C one arrow E>F, and Y>C is Y>F.
   */
  const ids = { E: "1", A: "2", B: "3", F: "4", C: "5", X: "6", Y: "7" };
  const node = (id: string, parentId?: string) => ({
    id,
    title: `Task ${id}`,
    status: "todo" as const,
    ...(parentId ? { parentId } : {}),
  });
  const detail: InitiativeDetail = {
    ...HOSTED_LABS_DETAIL,
    rootIds: [ids.E, ids.F, ids.X, ids.Y],
    nodes: [
      node(ids.E),
      node(ids.A, ids.E),
      { ...node(ids.B, ids.E), archived: true },
      node(ids.F),
      node(ids.C, ids.F),
      node(ids.X),
      node(ids.Y),
    ],
    externalBlockers: [],
    edges: [
      { from: ids.A, to: ids.X },
      { from: ids.B, to: ids.X },
      { from: ids.A, to: ids.C },
      { from: ids.B, to: ids.C },
      { from: ids.Y, to: ids.C },
    ],
    milestoneIds: [],
  };
  const box = (
    id: string,
    kind: InitiativeLayoutNode["kind"],
    hiddenTaskIds?: string[],
  ): InitiativeLayoutNode => ({
    id,
    kind,
    taskId: id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...(hiddenTaskIds ? { hiddenTaskIds } : {}),
  });
  const points = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
  ];
  const layout: InitiativeLayout = {
    key: "synthetic",
    collapsed: [ids.E, ids.F],
    width: 100,
    height: 100,
    groups: [],
    lanes: [],
    nodes: [
      box(ids.E, "collapsed", [ids.A, ids.B]),
      box(ids.F, "collapsed", [ids.C]),
      box(ids.X, "task"),
      box(ids.Y, "task"),
    ],
    edges: [
      { from: ids.E, to: ids.X, points },
      { from: ids.E, to: ids.F, points },
      { from: ids.Y, to: ids.F, points },
    ],
  };
  // B is archived in the read and absent from the live list.
  const liveOf = (status: Record<string, TaskSummary["status"]>) =>
    [ids.E, ids.A, ids.F, ids.C, ids.X, ids.Y].map((id) =>
      row(id, status[id] ?? "todo"),
    );

  it("keeps a coalesced arrow open while ANY blocker it stands for is open, and releases it only when all are done or archived", () => {
    // A open (B archived): both arrows from E hold, the epic's own status
    // notwithstanding.
    const open = states(layout, detail, liveOf({ [ids.E]: "done" }));
    expect(open.get(`${ids.E}>${ids.X}`)).toBe("open");
    expect(open.get(`${ids.E}>${ids.F}`)).toBe("open");
    // A done and B archived: every blocker E stands for is met, although E
    // itself is still todo.
    const released = states(layout, detail, liveOf({ [ids.A]: "done" }));
    expect(released.get(`${ids.E}>${ids.X}`)).toBe("done");
    expect(released.get(`${ids.E}>${ids.F}`)).toBe("done");
    // B brought back and open again: released turns open.
    const restored = states(layout, detail, [
      ...liveOf({ [ids.A]: "done" }),
      row(ids.B, "doing"),
    ]);
    expect(restored.get(`${ids.E}>${ids.X}`)).toBe("open");
    expect(restored.get(`${ids.E}>${ids.F}`)).toBe("open");
  });

  it("judges an arrow into a collapsed epic by its real source alone", () => {
    expect(
      states(layout, detail, liveOf({ [ids.F]: "done", [ids.C]: "done" })).get(
        `${ids.Y}>${ids.F}`,
      ),
    ).toBe("open");
    expect(
      states(layout, detail, liveOf({ [ids.Y]: "done" })).get(
        `${ids.Y}>${ids.F}`,
      ),
    ).toBe("done");
  });
});
