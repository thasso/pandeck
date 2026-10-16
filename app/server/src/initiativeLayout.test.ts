/**
 * The Initiative map layout (docs/initiatives.md, Layout and placement) on a
 * fixture shaped like Hosted Labs: three Projects, three epics, about thirty
 * Tasks, cross-Project `blocks` links, done prerequisites, outside blockers and
 * a milestone. Fake Tasks only. The geometry must be valid (nothing overlaps,
 * every node in its lane, every arrow orthogonal from border to border), the
 * same input must give the same drawing, and only structure may move it.
 */
import assert from "node:assert/strict";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import type {
  InitiativeDetail,
  InitiativeGraphNode,
  InitiativeLayout,
  InitiativeLayoutBox,
  InitiativeLayoutNode,
  InitiativeLayoutPoint,
} from "@assistant/shared";
import {
  addInitiativeMembers,
  createInitiative,
  deleteInitiative,
  removeInitiativeMembers,
  setInitiativeMilestones,
  subscribeInitiativeChanges,
} from "./initiatives.ts";
import {
  initiativeLayoutCacheState,
  planInitiativeLayoutForTests,
  readInitiativeMap,
} from "./initiativeLayout.ts";
import {
  runElkLayout,
  stopInitiativeLayoutWorker,
} from "./initiativeLayoutRunner.ts";
import { withDbTransaction } from "./db/index.ts";
import { taskStore } from "./db/taskStore.ts";
import {
  archiveTask,
  createTask,
  notifyTaskChange,
  updateTask,
} from "./tasks.ts";

/** The unmocked runner, for a test that wraps one call in a fault. */
const real = vi.hoisted(() => ({
  run: undefined as unknown as typeof import("./initiativeLayoutRunner.ts").runElkLayout,
}));

vi.mock("./initiativeLayoutRunner.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./initiativeLayoutRunner.ts")>();
  real.run = actual.runElkLayout;
  return { ...actual, runElkLayout: vi.fn(actual.runElkLayout) };
});

const elkRuns = vi.mocked(runElkLayout);

/** Moves the server's clock forward, as the cache and the runner read it. */
let skew = 0;
const realNow = Date.now.bind(Date);
vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);

beforeEach(() => {
  elkRuns.mockClear();
  skew = 0;
});
afterAll(() => stopInitiativeLayoutWorker());

/* -------------------------------- fixture -------------------------------- */

interface Fixture {
  initiativeId: string;
  /** Fixture name → Task id. */
  ids: Record<string, string>;
  /** Task id → fixture name. */
  names: Map<string, string>;
}

const EPICS = [
  { name: "SDC", projectId: "fixture-sdc", tasks: 9 },
  { name: "LAB", projectId: "fixture-stardust", tasks: 9 },
  { name: "SRS", projectId: "fixture-srs", tasks: 8 },
] as const;

/** `from` blocks `to`. */
const BLOCKS: Array<[string, string]> = [
  ["SDC1", "SDC2"],
  ["SDC2", "SDC3"],
  ["SDC3", "SDC5"],
  ["SDC5", "SDC6"],
  ["SDC6", "SDC9"],
  ["SDC4a", "SDC4b"],
  ["SDC4b", "SDC4"],
  ["SDC7", "SDC8"],
  ["SDC8", "SDC9"],
  ["LAB1", "LAB2"],
  ["LAB2", "LAB3"],
  ["LAB3", "LAB4"],
  ["LAB4", "LAB8"],
  ["LAB5", "LAB6"],
  ["LAB6", "LAB7"],
  ["LAB7", "LAB8"],
  ["SRS1", "SRS2"],
  ["SRS2", "SRS3"],
  ["SRS3", "SRS5"],
  ["SRS4", "SRS5"],
  ["SRS5", "SRS7"],
  ["SRS6", "SRS8"],
  // Across Projects.
  ["SDC3", "LAB5"],
  ["LAB2", "SRS4"],
  ["SRS6", "SDC7"],
  // Into the milestone.
  ["SDC9", "RELEASE"],
  ["LAB8", "RELEASE"],
  // From outside the Initiative.
  ["OUT-REVIEW", "SDC2"],
  ["OUT-REVIEW", "SRS3"],
  ["OUT-LEGAL", "RELEASE"],
];

const DONE = ["SDC1", "LAB1", "SRS1", "OUT-REVIEW"];

function hostedLabs(title = "Hosted Labs (fixture)"): Fixture {
  const ids: Record<string, string> = {};
  const make = (
    name: string,
    extra: { parentId?: string; projectId?: string },
  ) => {
    ids[name] = createTask({
      title: `${name} task`,
      source: { createdBy: "user" },
      ...extra,
    }).id;
  };
  for (const epic of EPICS) {
    make(epic.name, { projectId: epic.projectId });
    for (let n = 1; n <= epic.tasks; n += 1)
      make(`${epic.name}${n}`, { parentId: ids[epic.name]! });
  }
  make("SDC4a", { parentId: ids.SDC4! });
  make("SDC4b", { parentId: ids.SDC4! });
  make("RELEASE", { projectId: "fixture-sdc" });
  make("OUT-REVIEW", {});
  make("OUT-LEGAL", {});
  for (const [from, to] of BLOCKS)
    updateTask(ids[to]!, {
      addLinks: [{ type: "blocked-by", taskId: ids[from]! }],
    });
  for (const name of DONE)
    updateTask(ids[name]!, { status: "done", actor: { kind: "user" } });
  const initiativeId = String(
    createInitiative({
      title,
      taskIds: [ids.SDC!, ids.LAB!, ids.SRS!, ids.RELEASE!],
    }).initiative.id,
  );
  setInitiativeMilestones(initiativeId, [ids.RELEASE!], true);
  return {
    initiativeId,
    ids,
    names: new Map(Object.entries(ids).map(([name, id]) => [id, name])),
  };
}

async function mapOf(
  id: string,
  collapsed: string[] = [],
): Promise<InitiativeLayout> {
  const read = await readInitiativeMap(id, collapsed);
  assert.equal(read.layoutError, undefined);
  assert.ok(read.layout, "the map read carries a layout");
  return read.layout;
}

/* ------------------------------- geometry -------------------------------- */

function inside(
  inner: InitiativeLayoutBox,
  outer: InitiativeLayoutBox,
): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function overlaps(a: InitiativeLayoutBox, b: InitiativeLayoutBox): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function onBorder(
  point: InitiativeLayoutPoint,
  box: InitiativeLayoutBox,
): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  const withinX = point.x >= box.x - 1 && point.x <= box.x + box.width + 1;
  const withinY = point.y >= box.y - 1 && point.y <= box.y + box.height + 1;
  return (
    (withinY && (near(point.x, box.x) || near(point.x, box.x + box.width))) ||
    (withinX && (near(point.y, box.y) || near(point.y, box.y + box.height)))
  );
}

/** A segment that runs through a node's interior, away from its own ends. */
function crossesInterior(
  a: InitiativeLayoutPoint,
  b: InitiativeLayoutPoint,
  box: InitiativeLayoutBox,
): boolean {
  const inset = 2;
  const left = box.x + inset;
  const right = box.x + box.width - inset;
  const top = box.y + inset;
  const bottom = box.y + box.height - inset;
  if (a.x === b.x)
    return (
      a.x > left &&
      a.x < right &&
      Math.max(a.y, b.y) > top &&
      Math.min(a.y, b.y) < bottom
    );
  return (
    a.y > top &&
    a.y < bottom &&
    Math.max(a.x, b.x) > left &&
    Math.min(a.x, b.x) < right
  );
}

/** Everything a drawable layout must satisfy, whatever its graph. */
function assertValidGeometry(layout: InitiativeLayout): void {
  const canvas = { x: 0, y: 0, width: layout.width, height: layout.height };
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  assert.equal(byId.size, layout.nodes.length, "node ids are unique");
  for (const box of [
    ...layout.nodes,
    ...layout.lanes,
    ...layout.groups,
    ...(layout.milestoneColumn ? [layout.milestoneColumn] : []),
  ]) {
    assert.ok(inside(box, canvas), `inside the canvas: ${JSON.stringify(box)}`);
    for (const value of [box.x, box.y, box.width, box.height])
      assert.ok(Number.isInteger(value), "whole pixels");
  }
  for (const [i, a] of layout.nodes.entries())
    for (const b of layout.nodes.slice(i + 1))
      assert.ok(!overlaps(a, b), `${a.id} and ${b.id} overlap`);
  for (const [i, a] of layout.lanes.entries())
    for (const b of layout.lanes.slice(i + 1))
      assert.ok(!overlaps(a, b), `lanes ${a.id} and ${b.id} overlap`);
  for (const [i, a] of layout.groups.entries())
    for (const b of layout.groups.slice(i + 1))
      assert.ok(!overlaps(a, b), "Project groups overlap");
  const lanes = new Map(layout.lanes.map((lane) => [lane.id, lane]));
  for (const group of layout.groups)
    for (const laneId of group.laneIds)
      assert.ok(
        inside(lanes.get(laneId)!, group),
        `lane ${laneId} in its group`,
      );
  for (const node of layout.nodes) {
    if (node.laneId === undefined) {
      assert.ok(layout.milestoneColumn, "a laneless node needs the column");
      assert.ok(
        inside(node, layout.milestoneColumn),
        `${node.id} in the column`,
      );
      for (const lane of layout.lanes)
        assert.ok(
          node.x >= lane.x + lane.width,
          `${node.id} right of every lane`,
        );
    } else {
      assert.ok(
        inside(node, lanes.get(node.laneId)!),
        `${node.id} in its lane`,
      );
    }
  }
  for (const edge of layout.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    assert.ok(from && to, `arrow ${edge.from}→${edge.to} joins drawn nodes`);
    assert.ok(edge.points.length >= 2, "an arrow has a route");
    assert.ok(
      onBorder(edge.points[0]!, from),
      `${edge.from}→${edge.to} starts on its blocker`,
    );
    assert.ok(
      onBorder(edge.points[edge.points.length - 1]!, to),
      `${edge.from}→${edge.to} ends on what it blocks`,
    );
    for (const [i, point] of edge.points.entries()) {
      assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y));
      assert.ok(inside({ ...point, width: 0, height: 0 }, canvas));
      if (i === 0) continue;
      const previous = edge.points[i - 1]!;
      assert.ok(
        point.x === previous.x || point.y === previous.y,
        `${edge.from}→${edge.to} is orthogonal`,
      );
      for (const node of layout.nodes)
        assert.ok(
          !crossesInterior(previous, point, node),
          `${edge.from}→${edge.to} runs through ${node.id}`,
        );
    }
  }
}

function nodeOf(
  layout: InitiativeLayout,
  taskId: string,
): InitiativeLayoutNode {
  const node = layout.nodes.find(
    (candidate) => candidate.taskId === taskId && candidate.kind !== "external",
  );
  assert.ok(node, `node for Task ${taskId}`);
  return node;
}

/** The drawing with fixture names for ids, so the pin does not hang on ids. */
function named(layout: InitiativeLayout, names: Map<string, string>) {
  const name = (id: string) =>
    id
      .split(":")
      .map((part) => names.get(part) ?? part)
      .join(":");
  return {
    width: layout.width,
    height: layout.height,
    collapsed: layout.collapsed.map(name),
    groups: layout.groups.map((group) => ({
      ...group,
      laneIds: group.laneIds.map(name),
    })),
    lanes: layout.lanes.map((lane) => ({ ...lane, id: name(lane.id) })),
    milestoneColumn: layout.milestoneColumn,
    nodes: layout.nodes.map((node) => ({
      ...node,
      id: name(node.id),
      taskId: name(node.taskId),
      ...(node.laneId ? { laneId: name(node.laneId) } : {}),
      ...(node.hiddenTaskIds
        ? { hiddenTaskIds: node.hiddenTaskIds.map(name) }
        : {}),
    })),
    edges: layout.edges.map((edge) => ({
      ...edge,
      from: name(edge.from),
      to: name(edge.to),
    })),
  };
}

/* --------------------------------- tests --------------------------------- */

test("lays Hosted Labs out in Project lanes, stubs at the lane edge, the milestone on the right", async () => {
  const fixture = hostedLabs();
  const { ids } = fixture;
  const layout = await mapOf(fixture.initiativeId);
  assertValidGeometry(layout);

  assert.deepEqual(
    layout.groups.map((group) => [group.projectId, group.laneIds]),
    [
      ["fixture-sdc", [ids.SDC]],
      ["fixture-stardust", [ids.LAB]],
      ["fixture-srs", [ids.SRS]],
    ],
  );
  assert.deepEqual(
    layout.lanes.map((lane) => lane.id),
    [ids.SDC, ids.LAB, ids.SRS],
  );
  // Stacked top to bottom in member order.
  for (const [i, lane] of layout.lanes.slice(1).entries())
    assert.ok(lane.y > layout.lanes[i]!.y);

  // Every member is drawn in the lane of its root epic, nested ones included.
  for (const epic of EPICS)
    for (let n = 1; n <= epic.tasks; n += 1)
      assert.equal(
        nodeOf(layout, ids[`${epic.name}${n}`]!).laneId,
        ids[epic.name],
      );
  assert.equal(nodeOf(layout, ids.SDC4a!).laneId, ids.SDC);
  assert.equal(layout.nodes.filter((node) => node.kind === "task").length, 32);

  // An outside blocker is a stub in each lane it blocks into, before every
  // member, and once for the milestone column.
  const stubs = layout.nodes.filter((node) => node.kind === "external");
  assert.deepEqual(
    stubs.map((stub) => [fixture.names.get(stub.taskId), stub.laneId]).sort(),
    [
      ["OUT-LEGAL", undefined],
      ["OUT-REVIEW", ids.SDC],
      ["OUT-REVIEW", ids.SRS],
    ].sort(),
  );
  const firstMember = Math.min(
    ...layout.nodes
      .filter((node) => node.kind !== "external" && node.laneId !== undefined)
      .map((node) => node.x),
  );
  for (const stub of stubs.filter((node) => node.laneId !== undefined))
    assert.ok(stub.x < firstMember, "a lane stub stands before every member");

  // The milestone stands alone on the right, level with what blocks it.
  const release = nodeOf(layout, ids.RELEASE!);
  assert.equal(release.milestone, true);
  assert.equal(release.laneId, undefined);
  assert.ok(inside(release, layout.milestoneColumn!));
  const legal = stubs.find((stub) => stub.laneId === undefined)!;
  assert.ok(legal.x < release.x, "the milestone's stub is left of it");

  // One arrow per `blocks` link, and along them the map reads left to right.
  assert.equal(layout.edges.length, BLOCKS.length);
  for (const edge of layout.edges) {
    const from = layout.nodes.find((node) => node.id === edge.from)!;
    const to = layout.nodes.find((node) => node.id === edge.to)!;
    assert.ok(from.x < to.x, `${edge.from}→${edge.to} points right`);
  }

  await expect(
    `${JSON.stringify(named(layout, fixture.names), null, 1)}\n`,
  ).toMatchFileSnapshot("__snapshots__/initiative-layout-hosted-labs.json");
});

test("the same structure lays out the same, computed afresh", async () => {
  const first = hostedLabs("Hosted Labs A");
  const second = hostedLabs("Hosted Labs B");
  const a = await mapOf(first.initiativeId);
  elkRuns.mockClear();
  const b = await mapOf(second.initiativeId);
  assert.equal(elkRuns.mock.calls.length, 2, "a cache miss: both passes ran");
  assert.deepEqual(named(b, second.names), named(a, first.names));
  // The key names the structure, not the Task ids: these ids differ.
  assert.notEqual(a.key, b.key);
});

test("status, title, blocked and archive changes keep the layout; the read stays fresh", async () => {
  const { initiativeId, ids } = hostedLabs();
  const before = await readInitiativeMap(initiativeId);
  elkRuns.mockClear();

  updateTask(ids.SDC5!, { status: "doing", actor: { kind: "user" } });
  updateTask(ids.LAB3!, { status: "done", actor: { kind: "user" } });
  updateTask(ids.SRS7!, { title: "A much longer title than before" });
  updateTask(ids.LAB2!, { status: "done", actor: { kind: "user" } });
  archiveTask(ids.LAB9!);

  const after = await readInitiativeMap(initiativeId);
  assert.equal(elkRuns.mock.calls.length, 0, "no new layout");
  assert.equal(after.layout, before.layout, "the cached layout itself");
  assert.ok(after.revision! > before.revision!, "the graph's revision moved");
  const node = (id: string) =>
    after.item!.nodes.find((entry) => entry.id === id)!;
  assert.equal(node(ids.SDC5!).status, "doing");
  assert.equal(node(ids.SRS7!).title, "A much longer title than before");
  assert.equal(node(ids.LAB9!).archived, true);
});

test("structural changes lay the map out again", async () => {
  const { initiativeId, ids } = hostedLabs();
  const keys = [(await mapOf(initiativeId)).key];
  const relaidOut = async (change: string, write: () => void) => {
    write();
    elkRuns.mockClear();
    const layout = await mapOf(initiativeId);
    assert.ok(elkRuns.mock.calls.length > 0, `${change}: laid out again`);
    assert.ok(!keys.includes(layout.key), `${change}: a new key`);
    keys.push(layout.key);
    assertValidGeometry(layout);
    return layout;
  };

  const linked = await relaidOut("a new blocks link", () =>
    updateTask(ids.SRS8!, {
      addLinks: [{ type: "blocked-by", taskId: ids.SDC9! }],
    }),
  );
  assert.ok(
    linked.edges.some((edge) => edge.from === ids.SDC9 && edge.to === ids.SRS8),
  );
  // Taking the link away again is the first structure, and its key.
  updateTask(ids.SRS8!, { removeLinks: [ids.SDC9!] });
  assert.equal((await mapOf(initiativeId)).key, keys[0]);
  let layout = await relaidOut("a new subtask", () => {
    createTask({
      title: "Late subtask",
      source: { createdBy: "user" },
      parentId: ids.LAB!,
    });
  });
  layout = await relaidOut("a reparent across epics", () =>
    updateTask(ids.SRS6!, { parentId: ids.LAB! }),
  );
  assert.equal(nodeOf(layout, ids.SRS6!).laneId, ids.LAB);
  layout = await relaidOut("the root epic's Project", () =>
    updateTask(ids.SRS!, { projectId: "fixture-sdc" }),
  );
  assert.deepEqual(
    layout.groups.map((group) => group.laneIds),
    [[ids.SDC, ids.SRS], [ids.LAB]],
  );
  layout = await relaidOut("a milestone mark", () =>
    setInitiativeMilestones(initiativeId, [ids.SDC9!], true),
  );
  assert.equal(nodeOf(layout, ids.SDC9!).laneId, undefined);
  layout = await relaidOut("a removed member", () =>
    removeInitiativeMembers(initiativeId, [ids.LAB!]),
  );
  assert.ok(!layout.lanes.some((lane) => lane.id === ids.LAB));
  await relaidOut("an added member", () =>
    addInitiativeMembers(initiativeId, [ids.LAB!]),
  );
});

test("a collapsed epic is one node: arrows end at it, milestones under it stay drawn", async () => {
  const { initiativeId, ids, names } = hostedLabs();
  const layout = await mapOf(initiativeId, [ids.LAB!]);
  assertValidGeometry(layout);
  assert.deepEqual(layout.collapsed, [ids.LAB]);
  const lab = nodeOf(layout, ids.LAB!);
  assert.equal(lab.kind, "collapsed");
  assert.equal(lab.laneId, ids.LAB);
  assert.equal(
    layout.nodes.filter((node) => node.laneId === ids.LAB).length,
    1,
    "the lane holds the epic alone",
  );
  assert.deepEqual(
    lab.hiddenTaskIds!.map((id) => names.get(id)).sort(),
    Array.from({ length: 9 }, (_, n) => `LAB${n + 1}`).sort(),
  );
  // LAB1 is done; LAB2 (blocked by nothing open) is startable, the rest wait.
  assert.equal(lab.progress?.total, 9);
  assert.equal(lab.progress?.done, 1);
  const arrows = layout.edges.map(
    (edge) =>
      `${names.get(edge.from) ?? edge.from}>${names.get(edge.to) ?? edge.to}`,
  );
  for (const arrow of ["SDC3>LAB", "LAB>SRS4", "LAB>RELEASE"])
    assert.ok(arrows.includes(arrow), `${arrow} ends at the collapsed epic`);
  assert.ok(!arrows.some((arrow) => arrow.startsWith("LAB>LAB")));

  // A milestone under a collapsed epic keeps its node and its arrows.
  setInitiativeMilestones(initiativeId, [ids.SDC9!], true);
  const withMilestone = await mapOf(initiativeId, [ids.SDC!]);
  assertValidGeometry(withMilestone);
  const sdc9 = nodeOf(withMilestone, ids.SDC9!);
  assert.equal(sdc9.milestone, true);
  assert.ok(
    !nodeOf(withMilestone, ids.SDC!).hiddenTaskIds!.includes(ids.SDC9!),
  );
  assert.ok(
    withMilestone.edges.some(
      (edge) => edge.from === ids.SDC && edge.to === ids.SDC9,
    ),
  );
});

test("a collapsed drawing is pinned too: a lane folded whole, a nested epic folded in its lane", async () => {
  const fixture = hostedLabs();
  const { ids } = fixture;
  const layout = await mapOf(fixture.initiativeId, [ids.LAB!, ids.SDC4!]);
  assertValidGeometry(layout);
  assert.deepEqual(
    layout.collapsed,
    [ids.SDC4, ids.LAB].sort((a, b) => Number(a) - Number(b)),
  );
  // The web fixture draws this, so the stories show real server geometry.
  await expect(
    `${JSON.stringify(named(layout, fixture.names), null, 1)}\n`,
  ).toMatchFileSnapshot(
    "__snapshots__/initiative-layout-hosted-labs-collapsed.json",
  );
});

test("the collapsed set is canonical: order, repeats, leaves and nesting do not split it", async () => {
  const { initiativeId, ids } = hostedLabs();
  const first = await mapOf(initiativeId);
  const both = await mapOf(initiativeId, [ids.SRS!, ids.LAB!]);
  elkRuns.mockClear();
  const again = await mapOf(initiativeId, [
    ids.LAB!,
    ids.SRS!,
    ids.LAB!,
    ids.LAB3!, // under a collapsed epic
    ids.SDC1!, // has no children
    "999999", // not a member
  ]);
  assert.equal(elkRuns.mock.calls.length, 0);
  assert.equal(again.key, both.key);
  assert.deepEqual(
    both.collapsed,
    [ids.LAB, ids.SRS].sort((a, b) => Number(a) - Number(b)),
  );
  // A nested epic collapses on its own, and not under a collapsed ancestor.
  const nested = await mapOf(initiativeId, [ids.SDC4!]);
  assert.deepEqual(nested.collapsed, [ids.SDC4]);
  assert.deepEqual(
    (await mapOf(initiativeId, [ids.SDC!, ids.SDC4!])).collapsed,
    [ids.SDC],
  );
  // Expanding again is the first drawing, from the cache.
  elkRuns.mockClear();
  const expanded = await mapOf(initiativeId);
  assert.equal(elkRuns.mock.calls.length, 0);
  assert.equal(expanded, first);
});

test("concurrent reads of one drawing share one layout", async () => {
  const { initiativeId } = hostedLabs();
  const [a, b, c] = await Promise.all([
    readInitiativeMap(initiativeId),
    readInitiativeMap(initiativeId),
    readInitiativeMap(` ${initiativeId}`),
  ]);
  assert.equal(elkRuns.mock.calls.length, 2, "one layout, two passes");
  assert.equal(a.layout, b.layout);
  assert.equal(a.layout, c.layout);
});

test("a write during a layout is notified at once, and the answer draws the graph it carries", async () => {
  const { initiativeId, ids } = hostedLabs();
  const events: string[] = [];
  const stop = subscribeInitiativeChanges((touched) => {
    if (touched.includes(initiativeId)) events.push("notified");
  });
  const pending = readInitiativeMap(initiativeId).then((read) => {
    events.push("answered");
    return read;
  });
  updateTask(ids.SRS8!, {
    addLinks: [{ type: "blocked-by", taskId: ids.SDC9! }],
  });
  assert.deepEqual(
    events,
    ["notified"],
    "the write did not wait for the layout",
  );
  const read = await pending;
  stop();
  assert.deepEqual(events, ["notified", "answered"]);
  // Laid out twice: the structure moved while the first one ran.
  assert.equal(elkRuns.mock.calls.length, 4);
  assert.ok(
    read.item!.edges.some(
      (edge) => edge.from === ids.SDC9 && edge.to === ids.SRS8,
    ),
  );
  assert.ok(
    read.layout!.edges.some(
      (edge) => edge.from === ids.SDC9 && edge.to === ids.SRS8,
    ),
  );
  assertValidGeometry(read.layout!);
});

test("a status change during a layout keeps it and answers the newer status", async () => {
  const { initiativeId, ids } = hostedLabs();
  const pending = readInitiativeMap(initiativeId);
  updateTask(ids.SDC5!, { status: "doing", actor: { kind: "user" } });
  const read = await pending;
  assert.equal(elkRuns.mock.calls.length, 2);
  assert.equal(
    read.item!.nodes.find((node) => node.id === ids.SDC5)!.status,
    "doing",
  );
  assert.ok(read.layout);
});

test("an Initiative deleted during its layout answers null", async () => {
  const { initiativeId } = hostedLabs();
  const pending = readInitiativeMap(initiativeId);
  deleteInitiative(initiativeId);
  assert.deepEqual(await pending, { item: null });
  assert.deepEqual(await readInitiativeMap(initiativeId), { item: null });
});

test("an Initiative without members has an empty map", async () => {
  const id = String(createInitiative({ title: "Empty" }).initiative.id);
  const layout = await mapOf(id);
  assert.deepEqual(
    { ...layout, key: "" },
    {
      key: "",
      collapsed: [],
      width: 48,
      height: 48,
      groups: [],
      lanes: [],
      nodes: [],
      edges: [],
    },
  );
  assert.equal(elkRuns.mock.calls.length, 0);
});

test("lone Tasks and Tasks without a Project get lanes of their own", async () => {
  const lone = createTask({ title: "Lone", source: { createdBy: "user" } }).id;
  const epic = createTask({
    title: "Epic",
    source: { createdBy: "user" },
    projectId: "fixture-one",
  }).id;
  const child = createTask({
    title: "Child",
    source: { createdBy: "user" },
    parentId: epic,
  }).id;
  updateTask(child, { addLinks: [{ type: "blocked-by", taskId: lone }] });
  const id = String(
    createInitiative({ title: "Mixed", taskIds: [lone, epic] }).initiative.id,
  );
  const layout = await mapOf(id);
  assertValidGeometry(layout);
  assert.deepEqual(
    layout.groups.map((group) => [group.projectId, group.laneIds]),
    [
      [undefined, [lone]],
      ["fixture-one", [epic]],
    ],
  );
  assert.equal(layout.milestoneColumn, undefined);
});

/** A small seeded generator, so a failing graph can be rebuilt by its seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random structures the fixture does not reach: nested epics, cycles across
// lanes, milestones blocking lane work and each other, marked subtasks, outside
// blockers of anything, and a collapsed epic. Each must still draw validly.
for (const seed of [3, 7, 11, 19, 23, 31, 42, 57, 64, 77, 88, 99])
  test(`random structure ${seed} lays out validly`, async () => {
    const random = seeded(seed);
    const pick = <T>(items: readonly T[]): T =>
      items[Math.floor(random() * items.length)]!;
    const make = (
      title: string,
      extra: { parentId?: string; projectId?: string } = {},
    ) => createTask({ title, source: { createdBy: "user" }, ...extra }).id;
    const roots: string[] = [];
    const members: string[] = [];
    const parents: string[] = [];
    for (let e = 0; e < 1 + Math.floor(random() * 5); e += 1) {
      const root = make(
        `Epic ${e}`,
        random() < 0.8 ? { projectId: `p${Math.floor(random() * 3)}` } : {},
      );
      roots.push(root);
      members.push(root);
      parents.push(root);
      for (let n = 0; n < Math.floor(random() * 14); n += 1) {
        const id = make(`Step ${n}`, { parentId: pick(parents) });
        members.push(id);
        if (random() < 0.2) parents.push(id);
      }
    }
    const milestones = Array.from(
      { length: Math.floor(random() * 3) },
      (_, n) => make(`Milestone ${n}`),
    );
    const outside = Array.from({ length: Math.floor(random() * 3) }, (_, n) =>
      make(`Outside ${n}`),
    );
    const drawn = [...members, ...milestones];
    for (let k = 0; k < Math.floor(random() * drawn.length * 1.5); k += 1) {
      const from =
        outside.length > 0 && random() < 0.15 ? pick(outside) : pick(drawn);
      const to = pick(drawn);
      if (from !== to)
        updateTask(to, { addLinks: [{ type: "blocked-by", taskId: from }] });
    }
    const id = String(
      createInitiative({
        title: `Random ${seed}`,
        taskIds: [...roots, ...milestones],
      }).initiative.id,
    );
    if (milestones.length > 0) setInitiativeMilestones(id, milestones, true);
    if (members.length > 3 && random() < 0.3)
      setInitiativeMilestones(id, [pick(members.slice(1))], true);
    const layout = await mapOf(id, random() < 0.4 ? [pick(parents)] : []);
    assertValidGeometry(layout);
  });

/* --------------------------- failure and capacity -------------------------- */

test("a transient failure is laid out again after a short wait, with no write", async () => {
  const { initiativeId, ids } = hostedLabs();
  // The worker is lost while the first pass runs.
  const pending = readInitiativeMap(initiativeId);
  stopInitiativeLayoutWorker();
  const failed = await pending;
  assert.ok(failed.item, "the graph still answers");
  assert.match(failed.layoutError ?? "", /stopped/);
  // A lost worker is a fault to retry, never the size outcome.
  assert.equal(failed.layoutTooLarge, undefined);

  // Rereads right after it answer the same, without piling up work.
  elkRuns.mockClear();
  assert.equal(
    (await readInitiativeMap(initiativeId)).layoutError,
    failed.layoutError,
  );
  assert.equal(elkRuns.mock.calls.length, 0);

  // A little later, a reread lays it out again: no structural write, no
  // restart; a status change in between does not get in the way.
  updateTask(ids.SDC5!, { status: "doing", actor: { kind: "user" } });
  skew += 6_000;
  const recovered = await readInitiativeMap(initiativeId);
  assert.equal(recovered.layoutError, undefined);
  assert.ok(recovered.layout);
  assert.ok(elkRuns.mock.calls.length > 0, "laid out afresh");
  elkRuns.mockClear();
  const kept = await readInitiativeMap(initiativeId);
  assert.equal(kept.layout, recovered.layout, "and kept like any layout");
  assert.equal(elkRuns.mock.calls.length, 0);
});

test("a pass past its time limit is transient too, and recovers", async () => {
  const { initiativeId } = hostedLabs();
  elkRuns.mockImplementationOnce((graph, options) =>
    real.run(graph, { ...options, passLimitMs: 1 }),
  );
  const failed = await readInitiativeMap(initiativeId);
  assert.match(
    failed.layoutError ?? "",
    /right now: The layout took longer than/,
  );
  skew += 6_000;
  assert.ok((await readInitiativeMap(initiativeId)).layout);
});

test("an ELK error is kept: the same graph would fail the same way", async () => {
  const { initiativeId } = hostedLabs();
  elkRuns.mockImplementationOnce(() =>
    Promise.reject(new Error("Referenced shape does not exist")),
  );
  const failed = await readInitiativeMap(initiativeId);
  assert.match(
    failed.layoutError ?? "",
    /could not be laid out: Referenced shape/,
  );
  skew += 600_000;
  elkRuns.mockClear();
  assert.equal(
    (await readInitiativeMap(initiativeId)).layoutError,
    failed.layoutError,
  );
  assert.equal(elkRuns.mock.calls.length, 0);
});

/** Collapsed sets of the fixture, each a different drawing. */
function drawings(ids: Record<string, string>): string[][] {
  return [
    [],
    [ids.SDC!],
    [ids.LAB!],
    [ids.SRS!],
    [ids.SDC!, ids.LAB!],
    [ids.LAB!, ids.SRS!],
  ];
}

test("a burst of one map's drawings is admitted up to its share; the rest are refused, recoverably", async () => {
  const { initiativeId, ids } = hostedLabs();
  const reads = await Promise.all(
    drawings(ids).map((collapsed) =>
      readInitiativeMap(initiativeId, collapsed),
    ),
  );
  const drawn = reads.filter((read) => read.layout);
  const refused = reads.filter((read) => read.layoutError);
  assert.equal(drawn.length, 3, "three drawings of one map at a time");
  assert.equal(refused.length, 3);
  for (const read of refused) {
    assert.match(read.layoutError!, /Too many drawings of this map/);
    assert.ok(read.item, "a refusal still answers the graph");
  }
  assert.equal(
    initiativeLayoutCacheState().pending,
    0,
    "nothing is left running",
  );
  // A refusal is not kept: the same drawing lays out on the next read.
  const again = await readInitiativeMap(initiativeId, drawings(ids)[5]!);
  assert.ok(again.layout);
});

test("all maps together are admitted up to the global limit", async () => {
  const maps = [
    hostedLabs("Burst A"),
    hostedLabs("Burst B"),
    hostedLabs("Burst C"),
  ];
  const reads = await Promise.all(
    maps.flatMap(({ initiativeId, ids }) =>
      drawings(ids)
        .slice(0, 3)
        .map((collapsed) => readInitiativeMap(initiativeId, collapsed)),
    ),
  );
  const refused = reads.filter((read) => read.layoutError);
  assert.equal(reads.length - refused.length, 8);
  assert.equal(refused.length, 1);
  assert.match(refused[0]!.layoutError!, /Too many maps are being laid out/);
  assert.equal(initiativeLayoutCacheState().pending, 0);
});

test("a drawing being laid out is shared, however many finished layouts push it out of the cache", async () => {
  const { initiativeId } = hostedLabs();
  let release!: () => void;
  elkRuns.mockImplementationOnce(
    (graph, options) =>
      new Promise((resolve, reject) => {
        release = () => void real.run(graph, options).then(resolve, reject);
      }),
  );
  const first = readInitiativeMap(initiativeId);
  for (let n = 0; n < 70; n += 1) {
    const task = createTask({
      title: `Filler ${n}`,
      source: { createdBy: "user" },
    });
    await mapOf(
      String(
        createInitiative({ title: `Filler ${n}`, taskIds: [task.id] })
          .initiative.id,
      ),
    );
  }
  assert.deepEqual(initiativeLayoutCacheState(), { pending: 1, settled: 64 });
  const second = readInitiativeMap(initiativeId);
  assert.equal(
    initiativeLayoutCacheState().pending,
    1,
    "no second computation",
  );
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.ok(a.layout);
  assert.equal(b.layout, a.layout, "one computation answered both");
});

test("superseded and deleted drawings are let go at once", async () => {
  const { initiativeId, ids } = hostedLabs();
  const before = readInitiativeMap(initiativeId);
  assert.equal(initiativeLayoutCacheState().pending, 1);
  updateTask(ids.SRS8!, {
    addLinks: [{ type: "blocked-by", taskId: ids.SDC9! }],
  });
  const after = readInitiativeMap(initiativeId);
  assert.equal(
    initiativeLayoutCacheState().pending,
    1,
    "the old structure is dropped",
  );
  const [a, b] = await Promise.all([before, after]);
  assert.ok(a.layout && a.layout === b.layout, "both answer the new structure");
  assert.ok(
    a.layout.edges.some(
      (edge) => edge.from === ids.SDC9 && edge.to === ids.SRS8,
    ),
  );

  const doomed = readInitiativeMap(initiativeId, [ids.LAB!]);
  assert.equal(initiativeLayoutCacheState().pending, 1);
  deleteInitiative(initiativeId);
  assert.deepEqual(await doomed, { item: null });
  assert.equal(initiativeLayoutCacheState().pending, 0);
});

/* ------------------------------ large maps -------------------------------- */

function synthetic(
  nodes: InitiativeGraphNode[],
  rootIds: string[],
  edges: Array<{ from: string; to: string }> = [],
): InitiativeDetail {
  return {
    id: "1",
    title: "Synthetic",
    state: "active",
    progress: {
      total: nodes.length,
      done: 0,
      doing: 0,
      startable: 0,
      blocked: 0,
    },
    sessionIds: [],
    sessionCount: 0,
    updatedAt: 0,
    description: "",
    createdAt: 0,
    rootIds,
    nodes,
    externalBlockers: [],
    edges,
    milestoneIds: [],
  };
}

function loneRoots(count: number): InitiativeDetail {
  const nodes = Array.from({ length: count }, (_, n): InitiativeGraphNode => ({
    id: String(n + 1),
    title: "Lone",
    status: "todo",
    projectId: `p${n % 7}`,
  }));
  const edges = nodes
    .slice(1)
    .map((node, n) => ({ from: String(n + 1), to: node.id }));
  return synthetic(
    nodes,
    nodes.map((node) => node.id),
    edges,
  );
}

/** One root, `width` children each with a chain of `depth` below. */
function tree(width: number, depth: number): InitiativeDetail {
  const nodes: InitiativeGraphNode[] = [
    { id: "1", title: "Epic", status: "todo" },
  ];
  let next = 2;
  for (let w = 0; w < width; w += 1) {
    let parent = "1";
    for (let d = 0; d < depth; d += 1) {
      const id = String(next++);
      nodes.push({ id, title: "Step", status: "todo", parentId: parent });
      parent = id;
    }
  }
  return synthetic(nodes, ["1"]);
}

test("an oversized map is refused after linear planning work", () => {
  const small = planInitiativeLayoutForTests(loneRoots(6_000));
  const large = planInitiativeLayoutForTests(loneRoots(24_000));
  assert.match(small.error ?? "", /6000 nodes, more than the 1000/);
  assert.match(large.error ?? "", /24000 nodes/);
  // Members plus links, a constant number of times over.
  assert.ok(
    small.steps <= 8 * (6_000 + 6_000),
    `${small.steps} steps for 6,000`,
  );
  assert.ok(
    large.steps / small.steps < 4.5,
    `four times the map took ${(large.steps / small.steps).toFixed(2)} times the work`,
  );
});

test("a huge tree collapsed into a few nodes plans linearly, however deep", () => {
  const wide = planInitiativeLayoutForTests(tree(20_000, 1), ["1"]);
  assert.deepEqual(
    [wide.nodes, wide.collapsed, wide.error],
    [1, ["1"], undefined],
  );
  const deep = planInitiativeLayoutForTests(tree(1, 20_000), ["1"]);
  assert.deepEqual(
    [deep.nodes, deep.collapsed, deep.error],
    [1, ["1"], undefined],
  );
  assert.ok(
    deep.steps <= 8 * 20_001,
    `${deep.steps} steps for a chain of 20,000`,
  );
  const open = planInitiativeLayoutForTests(tree(1, 20_000));
  assert.match(open.error ?? "", /20001 nodes/);
});

test("the node limit is exact: 1,000 drawn nodes are laid out, 1,001 are not", () => {
  const at = planInitiativeLayoutForTests(tree(999, 1));
  assert.deepEqual([at.nodes, at.error], [1_000, undefined]);
  const over = planInitiativeLayoutForTests(tree(1_000, 1));
  assert.equal(over.nodes, 1_001);
  assert.match(over.error ?? "", /1001 nodes, more than the 1000 it lays out/);
});

test("a map over the node limit answers its graph without any layout, and collapsing it draws it", async () => {
  const epic = createTask({
    title: "Huge epic",
    source: { createdBy: "user" },
  }).id;
  // Through `createTask` every child reads all its siblings, so a thousand of
  // them took most of a minute. The store writes the same rows and subtask
  // edges in one transaction, and the change seam announces them as any write
  // does.
  const steps = withDbTransaction(() =>
    Array.from({ length: 1_000 }, (_, n) => {
      const step = taskStore.create({ title: `Step ${n}`, createdBy: "user" });
      taskStore.setParent(step.id, Number(epic), n);
      taskStore.update(step.id, { sortOrder: n });
      return String(step.id);
    }),
  );
  notifyTaskChange(steps);
  const id = String(
    createInitiative({ title: "Huge", taskIds: [epic] }).initiative.id,
  );
  const open = await readInitiativeMap(id);
  assert.equal(open.item?.nodes.length, 1_001);
  assert.match(
    open.layoutError ?? "",
    /1001 nodes, more than the 1000 it lays out/,
  );
  // The size outcome is its own answer, not a failure to retry: the drawn
  // count for the asked-for collapsed set, and the limit.
  assert.deepEqual(open.layoutTooLarge, { nodes: 1_001, limit: 1_000 });
  assert.equal(elkRuns.mock.calls.length, 0);
  assert.equal(
    (await readInitiativeMap(id, [epic])).layoutTooLarge,
    undefined,
    "a drawn map carries no size outcome",
  );
  const folded = await mapOf(id, [epic]);
  assert.equal(folded.nodes.length, 1);
  assert.equal(folded.nodes[0]!.progress?.total, 1_000);
}, 120_000);
