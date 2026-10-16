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
import {
  HOSTED_LABS_DETAIL,
  HOSTED_LABS_LAYOUT,
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
    const edges = routeEdges(HOSTED_LABS_LAYOUT, members(), null);
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
    const before = states(routeEdges(HOSTED_LABS_LAYOUT, members(), null));
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
