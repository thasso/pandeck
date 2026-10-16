// @vitest-environment jsdom
/**
 * Where the map looks when the critical path is turned on (`docs/initiatives.md`,
 * The critical path): the viewport fits the path's drawn nodes, never below
 * the readable zoom the map opens at, and fits the whole map only when there
 * is no path to show. Measured on the real page and React Flow viewport, with
 * the pane given a size jsdom does not lay out.
 *   pnpm --filter @assistant/web test src/components/initiative/InitiativeMapViewport.test.tsx
 */
import { act } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { InitiativeLayout, TaskSummary } from "@assistant/shared";
import { mount } from "../../test/mount.tsx";
import { ready } from "../../lib/loadState.ts";
import type { InitiativeRead } from "../../hooks/useAssistant.ts";
import {
  HOSTED_LABS_DETAIL,
  HOSTED_LABS_LAYOUT,
  HOSTED_LABS_LAYOUT_COLLAPSED,
  HOSTED_LABS_TASK_IDS as T,
  hostedLabsSummary,
} from "../../../component-preview/fixtures/initiatives.ts";
import { InitiativeDetailPage } from "./InitiativeDetailPage.tsx";

const PANE = { width: 1200, height: 800 };
/** The zoom the map never opens below (`InitiativeMap.tsx`). */
const READABLE_ZOOM = 0.6;

const restore: Array<() => void> = [];
beforeAll(() => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  // jsdom lays nothing out; give every element the pane's size, which is what
  // React Flow and the opening viewport read.
  for (const [prop, value] of [
    ["offsetWidth", PANE.width],
    ["offsetHeight", PANE.height],
    ["clientWidth", PANE.width],
    ["clientHeight", PANE.height],
  ] as const) {
    const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => value,
    });
    restore.push(() => {
      if (before) Object.defineProperty(HTMLElement.prototype, prop, before);
    });
  }
});
afterAll(() => {
  for (const undo of restore) undo();
  vi.unstubAllGlobals();
});
afterEach(() => window.sessionStorage.clear());

function live(status: Record<string, TaskSummary["status"]> = {}) {
  return new Map<string, TaskSummary>(
    [...HOSTED_LABS_DETAIL.nodes, ...HOSTED_LABS_DETAIL.externalBlockers]
      .filter((node) => !("archived" in node && node.archived))
      .map((node) => [
        node.id,
        {
          id: node.id,
          title: node.title,
          status: status[node.id] ?? node.status,
          source: { createdBy: "user" },
          createdAt: 1,
          updatedAt: 1,
          ...("blocked" in node && node.blocked ? { openBlockerCount: 1 } : {}),
        },
      ]),
  );
}

function renderPage(
  read: InitiativeRead,
  liveTasks: ReadonlyMap<string, TaskSummary>,
) {
  const props: Parameters<typeof InitiativeDetailPage>[0] = {
    initiativeId: HOSTED_LABS_DETAIL.id,
    mobile: false,
    connected: true,
    summary: hostedLabsSummary(),
    detailState: ready(read),
    onLoadDetail: vi.fn(),
    onOpenInitiative: vi.fn(),
    liveTasks,
    sessions: [],
    projectLabel: (id) => id ?? "No Project",
    selectedTaskId: null,
    onSelectTask: vi.fn(),
    onOpenIndex: vi.fn(),
  };
  const view = mount(<InitiativeDetailPage {...props} />);
  return {
    ...view,
    rerender: (next: Partial<typeof props>) =>
      view.render(<InitiativeDetailPage {...props} {...next} />),
  };
}

async function frames(count = 3) {
  for (let i = 0; i < count; i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
}

async function untilMap(container: HTMLElement) {
  for (let i = 0; i < 200; i += 1) {
    await frames(1);
    if (container.querySelector(".react-flow__node button")) return;
  }
  throw new Error("the map never drew a node");
}

/** The React Flow viewport's transform: where the drawing is on the pane. */
function viewport(container: HTMLElement) {
  const transform =
    container.querySelector<HTMLElement>(".react-flow__viewport")?.style
      .transform ?? "";
  const match = transform.match(
    /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/,
  );
  if (!match) throw new Error(`no viewport transform: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

/** The pane point a drawing point lands on. */
function onPane(
  view: { x: number; y: number; zoom: number },
  point: { x: number; y: number },
) {
  return { x: view.x + point.x * view.zoom, y: view.y + point.y * view.zoom };
}

function centreOf(layout: InitiativeLayout, ids: readonly string[]) {
  const boxes = layout.nodes.filter((node) => ids.includes(node.id));
  expect(boxes).toHaveLength(ids.length);
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

const toggle = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === "Critical path",
  )!;

/** SDC3 → LAB5 … LAB8 → the release: Hosted Labs' longest open chain. */
const PATH = [T.SDC3, T.LAB5, T.LAB6, T.LAB7, T.LAB8, T.RELEASE];

describe("the critical path's viewport", () => {
  it("fits the path's drawn nodes when it is turned on, at no less than the readable zoom", async () => {
    const page = renderPage(
      { item: HOSTED_LABS_DETAIL, layout: HOSTED_LABS_LAYOUT },
      live(),
    );
    await untilMap(page.container);
    const opened = viewport(page.container);
    // The harness measures: the map opened at the readable zoom on its left.
    expect(opened.zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);

    await act(async () => toggle(page.container).click());
    await frames();
    const fitted = viewport(page.container);
    // The path spans more than the pane at the readable zoom, so it is held
    // there and centred, rather than shrunk until nothing reads.
    expect(fitted.zoom).toBeCloseTo(READABLE_ZOOM, 3);
    const centre = onPane(fitted, centreOf(HOSTED_LABS_LAYOUT, PATH));
    expect(centre.x).toBeCloseTo(PANE.width / 2, 0);
    expect(centre.y).toBeCloseTo(PANE.height / 2, 0);
    expect(fitted).not.toEqual(opened);

    // A live change of the path keeps the user's viewport, and so does
    // turning the path off.
    page.rerender({ liveTasks: live({ [T.SDC3]: "done", [T.LAB2]: "done" }) });
    await frames();
    expect(viewport(page.container)).toEqual(fitted);
    await act(async () => toggle(page.container).click());
    await frames();
    expect(viewport(page.container)).toEqual(fitted);
  });

  it("fits a tie's every chain, and a collapsed epic that carries the path", async () => {
    const tie = renderPage(
      { item: HOSTED_LABS_DETAIL, layout: HOSTED_LABS_LAYOUT },
      live({ [T.SDC3]: "done", [T.LAB2]: "done" }),
    );
    await untilMap(tie.container);
    await act(async () => toggle(tie.container).click());
    await frames();
    const tied = tie.container.querySelectorAll(
      ".react-flow__node [data-on-path]",
    );
    const tiedIds = [...tied].map((el) =>
      el.closest(".react-flow__node")!.getAttribute("data-id")!,
    );
    expect(tiedIds.length).toBeGreaterThan(PATH.length);
    const centre = onPane(
      viewport(tie.container),
      centreOf(HOSTED_LABS_LAYOUT, tiedIds),
    );
    expect(centre.x).toBeCloseTo(PANE.width / 2, 0);
    expect(centre.y).toBeCloseTo(PANE.height / 2, 0);
    act(() => tie.root.unmount());
    tie.container.remove();

    window.sessionStorage.setItem(
      `assistant.initiativeMap.v1:${HOSTED_LABS_DETAIL.id}`,
      JSON.stringify({ collapsed: [T.SDC4, T.LAB], criticalPath: false }),
    );
    const folded = renderPage(
      {
        item: HOSTED_LABS_DETAIL,
        layout: HOSTED_LABS_LAYOUT_COLLAPSED,
        requestedCollapsed: [T.SDC4, T.LAB],
      },
      live(),
    );
    await untilMap(folded.container);
    await act(async () => toggle(folded.container).click());
    await frames();
    const view = viewport(folded.container);
    expect(view.zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);
    const carried = onPane(
      view,
      centreOf(HOSTED_LABS_LAYOUT_COLLAPSED, [T.SDC3, T.LAB, T.RELEASE]),
    );
    expect(carried.x).toBeCloseTo(PANE.width / 2, 0);
    expect(carried.y).toBeCloseTo(PANE.height / 2, 0);
  });

  it("opens on the path when the map is shown with it already on", async () => {
    window.sessionStorage.setItem(
      `assistant.initiativeMap.v1:${HOSTED_LABS_DETAIL.id}`,
      JSON.stringify({ collapsed: [], criticalPath: true }),
    );
    const page = renderPage(
      { item: HOSTED_LABS_DETAIL, layout: HOSTED_LABS_LAYOUT },
      live(),
    );
    await untilMap(page.container);
    await frames();
    const view = viewport(page.container);
    expect(view.zoom).toBeCloseTo(READABLE_ZOOM, 3);
    const centre = onPane(view, centreOf(HOSTED_LABS_LAYOUT, PATH));
    expect(centre.x).toBeCloseTo(PANE.width / 2, 0);
    expect(centre.y).toBeCloseTo(PANE.height / 2, 0);
  });

  it("fits the whole map when there is no path to show", async () => {
    const page = renderPage(
      { item: HOSTED_LABS_DETAIL, layout: HOSTED_LABS_LAYOUT },
      live({ [T.RELEASE]: "done" }),
    );
    await untilMap(page.container);
    await act(async () => toggle(page.container).click());
    await frames();
    const view = viewport(page.container);
    // The whole drawing fits the pane, below the readable zoom for this map.
    expect(view.zoom).toBeLessThan(READABLE_ZOOM);
    const topLeft = onPane(view, { x: 0, y: 0 });
    const bottomRight = onPane(view, {
      x: HOSTED_LABS_LAYOUT.width,
      y: HOSTED_LABS_LAYOUT.height,
    });
    expect(topLeft.x).toBeGreaterThanOrEqual(-1);
    expect(topLeft.y).toBeGreaterThanOrEqual(-1);
    expect(bottomRight.x).toBeLessThanOrEqual(PANE.width + 1);
    expect(bottomRight.y).toBeLessThanOrEqual(PANE.height + 1);
  });
});

describe("the overview (F045)", () => {
  it("paints every Task box at least a screen pixel, and frames the view in screen pixels", async () => {
    const page = renderPage(
      { item: HOSTED_LABS_DETAIL, layout: HOSTED_LABS_LAYOUT },
      live(),
    );
    await untilMap(page.container);
    const overview = page.container.querySelector<HTMLElement>(
      ".react-flow__minimap",
    )!;
    const svg = overview.querySelector("svg")!;
    const marks = [
      ...svg.querySelectorAll<SVGRectElement>("rect.react-flow__minimap-node"),
    ].filter((rect) => rect.style.fill !== "transparent");
    // Lanes, groups and the milestone column are not marks; every Task is.
    expect(marks).toHaveLength(HOSTED_LABS_LAYOUT.nodes.length);
    for (const mark of marks) {
      // A box far under a pixel at the overview's scale (the 803-node map's
      // are a third of one) still paints: its outline is in screen pixels and
      // in its own colour, and it is not snapped away to nothing.
      expect(mark.getAttribute("vector-effect")).toBe("non-scaling-stroke");
      expect(mark.style.stroke).toBe(mark.style.fill);
      expect(Number.parseFloat(mark.style.strokeWidth)).toBeGreaterThanOrEqual(
        1.5,
      );
      expect(mark.getAttribute("shape-rendering")).toBe("geometricPrecision");
    }
    // The view's frame: React Flow scales a stroke given as a prop by the
    // overview's own scale, so it stays two screen pixels at any map size.
    const [, , viewBoxWidth] = svg.getAttribute("viewBox")!.split(" ");
    const unitsPerPixel =
      Number(viewBoxWidth) / (Number(svg.getAttribute("width")) + 10);
    const frame = Number(
      overview.style.getPropertyValue("--xy-minimap-mask-stroke-width-props"),
    );
    expect(frame / unitsPerPixel).toBeCloseTo(2, 3);
  });
});
