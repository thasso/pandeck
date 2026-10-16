/**
 * The critical path (`docs/initiatives.md`, The Initiative page): the longest
 * chain of open Tasks along `blocks` ending at the next open milestone,
 * computed from the read's links and the live statuses.
 *   pnpm --filter @assistant/web test src/lib/initiativePath.test.ts
 */
import { describe, expect, it } from "vitest";
import type {
  InitiativeDetail,
  InitiativeGraphNode,
  TaskStatus,
  TaskSummary,
} from "@assistant/shared";
import {
  HOSTED_LABS_DETAIL,
  HOSTED_LABS_LAYOUT,
  HOSTED_LABS_LAYOUT_COLLAPSED,
  HOSTED_LABS_TASK_IDS as T,
} from "../../component-preview/fixtures/initiatives.ts";
import { initiativeMembers } from "./initiativeView.ts";
import {
  criticalPath,
  pathOnLayout,
  type CriticalPath,
} from "./initiativePath.ts";

type Spec = {
  /** id → status, `!` suffix archived. */
  tasks: Record<string, TaskStatus | `${TaskStatus}!`>;
  /** `from>to`: from blocks to. */
  links: string[];
  milestones: string[];
  outside?: Record<string, TaskStatus>;
};

function graph(spec: Spec): InitiativeDetail {
  const nodes: InitiativeGraphNode[] = Object.entries(spec.tasks).map(
    ([id, raw]) => ({
      id,
      title: `Task ${id}`,
      status: raw.replace("!", "") as TaskStatus,
      ...(raw.endsWith("!") ? { archived: true as const } : {}),
      ...(spec.milestones.includes(id) ? { milestone: true as const } : {}),
    }),
  );
  return {
    ...HOSTED_LABS_DETAIL,
    rootIds: nodes.map((node) => node.id),
    nodes,
    externalBlockers: Object.entries(spec.outside ?? {}).map(
      ([id, status]) => ({ id, title: `Outside ${id}`, status }),
    ),
    edges: spec.links.map((link) => {
      const [from, to] = link.split(">");
      return { from: from!, to: to! };
    }),
    milestoneIds: spec.milestones,
  };
}

function pathOf(detail: InitiativeDetail, live: TaskSummary[] | null = null) {
  return criticalPath(
    detail,
    initiativeMembers(
      detail,
      live ? new Map(live.map((task) => [task.id, task])) : null,
      new Set(),
    ),
  );
}

const chain = (path: CriticalPath) =>
  path.kind === "path"
    ? { length: path.length, tasks: [...path.taskIds].sort(), tied: path.tied }
    : path;

describe("criticalPath", () => {
  it("is the longest open chain into the next open milestone, links of no other kind", () => {
    const detail = graph({
      tasks: {
        1: "todo",
        2: "doing",
        3: "todo",
        4: "todo",
        5: "todo",
        9: "todo",
      },
      // 1→2→3→9 is longer than 4→9; 5 blocks nothing on the way.
      links: ["1>2", "2>3", "3>9", "4>9", "5>4"],
      milestones: ["9"],
    });
    expect(chain(pathOf(detail))).toEqual({
      length: 4,
      tasks: ["1", "2", "3", "9"],
      tied: false,
    });
    const path = pathOf(detail);
    expect(path.kind === "path" && [...path.links].sort()).toEqual([
      "1>2",
      "2>3",
      "3>9",
    ]);
  });

  it("marks every chain of the longest length when they tie", () => {
    const detail = graph({
      tasks: { 1: "todo", 2: "todo", 3: "todo", 4: "todo", 9: "todo" },
      links: ["1>2", "2>9", "3>4", "4>9"],
      milestones: ["9"],
    });
    expect(chain(pathOf(detail))).toEqual({
      length: 3,
      tasks: ["1", "2", "3", "4", "9"],
      tied: true,
    });
    // A diamond is two chains through the same ends.
    const diamond = graph({
      tasks: { 1: "todo", 2: "todo", 3: "todo", 9: "todo" },
      links: ["1>2", "1>3", "2>9", "3>9"],
      milestones: ["9"],
    });
    expect(chain(pathOf(diamond))).toMatchObject({ length: 3, tied: true });
  });

  it("stops at a done or archived Task: a met dependency holds nothing up", () => {
    const detail = graph({
      tasks: {
        1: "todo",
        2: "done",
        3: "todo",
        4: "todo!",
        5: "todo",
        9: "todo",
      },
      // 1 waits only on a done Task; 5 only on an archived one.
      links: ["1>2", "2>3", "3>9", "5>4", "4>9"],
      milestones: ["9"],
    });
    expect(chain(pathOf(detail))).toEqual({
      length: 2,
      tasks: ["3", "9"],
      tied: false,
    });
  });

  it("leads to the first open milestone in member order, live", () => {
    const detail = graph({
      tasks: { 1: "todo", 2: "todo", 8: "todo", 9: "todo" },
      links: ["1>8", "2>9"],
      milestones: ["8", "9"],
    });
    expect(pathOf(detail)).toMatchObject({ kind: "path", milestoneId: "8" });
    // Milestone 8 is done in the Tasks topic: the next one counts, no read.
    const live: TaskSummary[] = ["1", "2", "8", "9"].map((id) => ({
      id,
      title: `Task ${id}`,
      status: id === "8" ? "done" : "todo",
      source: { createdBy: "user" },
      createdAt: 1,
      updatedAt: 1,
    }));
    expect(chain(pathOf(detail, live))).toEqual({
      length: 2,
      tasks: ["2", "9"],
      tied: false,
    });
  });

  it("has no path without an open milestone, and the milestone alone when nothing open blocks it", () => {
    expect(
      pathOf(
        graph({
          tasks: { 1: "todo", 9: "done" },
          links: ["1>9"],
          milestones: ["9"],
        }),
      ),
    ).toEqual({ kind: "none" });
    expect(
      pathOf(graph({ tasks: { 1: "todo" }, links: [], milestones: [] })),
    ).toEqual({
      kind: "none",
    });
    expect(
      chain(
        pathOf(
          graph({
            tasks: { 1: "done", 9: "todo" },
            links: ["1>9"],
            milestones: ["9"],
          }),
        ),
      ),
    ).toEqual({ length: 1, tasks: ["9"], tied: false });
  });

  it("starts a chain at an open outside blocker", () => {
    const detail = graph({
      tasks: { 1: "todo", 9: "todo" },
      outside: { 50: "todo", 51: "done" },
      links: ["50>1", "51>9", "1>9"],
      milestones: ["9"],
    });
    expect(chain(pathOf(detail))).toEqual({
      length: 3,
      tasks: ["1", "50", "9"],
      tied: false,
    });
  });

  it("names a loop instead of drawing a chain through it", () => {
    // `blocks` is acyclic by contract; stored data that loops is invalid.
    const detail = graph({
      tasks: { 1: "todo", 2: "todo", 3: "todo", 4: "todo", 9: "todo" },
      links: ["1>2", "2>1", "2>9", "3>4", "4>9"],
      milestones: ["9"],
    });
    expect(pathOf(detail)).toEqual({
      kind: "loop",
      milestoneId: "9",
      taskIds: ["1", "2"],
    });
    // A loop through the milestone itself is caught the same way.
    expect(
      pathOf(
        graph({
          tasks: { 1: "todo", 9: "todo" },
          links: ["1>9", "9>1"],
          milestones: ["9"],
        }),
      ),
    ).toMatchObject({ kind: "loop" });
    // A loop that does not lead to the milestone does not matter.
    expect(
      pathOf(
        graph({
          tasks: { 1: "todo", 2: "todo", 3: "todo", 9: "todo" },
          links: ["1>2", "2>1", "3>9"],
          milestones: ["9"],
        }),
      ),
    ).toMatchObject({ kind: "path", length: 2 });
  });

  it("stays linear on a long chain and a wide fan of ties", () => {
    const tasks: Record<string, TaskStatus> = { 0: "todo" };
    const links: string[] = [];
    for (let i = 1; i <= 20_000; i += 1) {
      tasks[String(i)] = "todo";
      links.push(`${i}>${i - 1}`);
    }
    const started = performance.now();
    const long = pathOf(graph({ tasks, links, milestones: ["0"] }));
    expect(long).toMatchObject({ kind: "path", length: 20_001, tied: false });
    // A ladder of diamonds doubles the chains at every rung; counting them
    // saturates instead of growing.
    const ladder: Record<string, TaskStatus> = { m: "todo" };
    const rungs: string[] = [];
    let below = "m";
    for (let i = 0; i < 200; i += 1) {
      ladder[`a${i}`] = "todo";
      ladder[`b${i}`] = "todo";
      ladder[`c${i}`] = "todo";
      rungs.push(
        `a${i}>${below}`,
        `b${i}>${below}`,
        `c${i}>a${i}`,
        `c${i}>b${i}`,
      );
      below = `c${i}`;
    }
    expect(
      pathOf(graph({ tasks: ladder, links: rungs, milestones: ["m"] })),
    ).toMatchObject({ kind: "path", length: 401, tied: true });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("finds Hosted Labs' longest chain across Projects to the release", () => {
    const path = pathOf(HOSTED_LABS_DETAIL);
    expect(chain(path)).toEqual({
      length: 6,
      tasks: [T.SDC3, T.LAB5, T.LAB6, T.LAB7, T.LAB8, T.RELEASE].sort(),
      tied: false,
    });
  });
});

describe("pathOnLayout", () => {
  it("marks the drawn nodes and arrows of the path", () => {
    const path = pathOf(HOSTED_LABS_DETAIL);
    if (path.kind !== "path") throw new Error("no path");
    const drawn = pathOnLayout(HOSTED_LABS_LAYOUT, path);
    expect([...drawn.nodeIds].sort()).toEqual([...path.taskIds].sort());
    expect([...drawn.edgeKeys].sort()).toEqual([...path.links].sort());
  });

  it("carries a path through a collapsed epic onto the epic's node", () => {
    const path = pathOf(HOSTED_LABS_DETAIL);
    if (path.kind !== "path") throw new Error("no path");
    // Stardust Labs (912) is collapsed: LAB5..LAB8 are inside it.
    const drawn = pathOnLayout(HOSTED_LABS_LAYOUT_COLLAPSED, path);
    expect([...drawn.nodeIds].sort()).toEqual(
      [T.SDC3, T.LAB, T.RELEASE].sort(),
    );
    expect([...drawn.edgeKeys].sort()).toEqual(
      [`${T.SDC3}>${T.LAB}`, `${T.LAB}>${T.RELEASE}`].sort(),
    );
    // SDC3's other arrow, into SDC5, is not on the path.
    expect(drawn.edgeKeys.has(`${T.SDC3}>${T.SDC5}`)).toBe(false);
  });

  it("marks an outside blocker's stub through its arrow", () => {
    const detail: InitiativeDetail = {
      ...HOSTED_LABS_DETAIL,
      externalBlockers: HOSTED_LABS_DETAIL.externalBlockers,
    };
    // Everything blocking the release is done but the outside legal sign-off.
    const live = HOSTED_LABS_DETAIL.nodes
      .filter((node) => !node.archived)
      .map((node): TaskSummary => ({
        id: node.id,
        title: node.title,
        status: node.id === T.RELEASE ? "todo" : "done",
        source: { createdBy: "user" },
        createdAt: 1,
        updatedAt: 1,
      }));
    const path = pathOf(detail, live);
    expect(chain(path)).toEqual({
      length: 2,
      tasks: [T["OUT-LEGAL"], T.RELEASE].sort(),
      tied: false,
    });
    if (path.kind !== "path") throw new Error("no path");
    const drawn = pathOnLayout(HOSTED_LABS_LAYOUT, path);
    const stub = HOSTED_LABS_LAYOUT.nodes.find(
      (node) => node.kind === "external" && node.taskId === T["OUT-LEGAL"],
    )!;
    expect(drawn.nodeIds.has(stub.id)).toBe(true);
  });
});
