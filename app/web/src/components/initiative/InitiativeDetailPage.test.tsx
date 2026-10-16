// @vitest-environment jsdom
/**
 * The Initiative page's five load states, its map fallback and its selection
 * (`docs/initiatives.md`, `app/web/docs/loading-states.md`).
 *   pnpm --filter @assistant/web test src/components/initiative/InitiativeDetailPage.test.tsx
 */
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TaskSummary } from "@assistant/shared";
import { mount } from "../../test/mount.tsx";
import {
  failed,
  idle,
  ready,
  refreshing,
  type LoadState,
} from "../../lib/loadState.ts";
import type { InitiativeRead } from "../../hooks/useAssistant.ts";
import {
  HOSTED_LABS_DETAIL,
  HOSTED_LABS_LAYOUT,
  HOSTED_LABS_TASK_IDS as T,
  hostedLabsSummary,
} from "../../../component-preview/fixtures/initiatives.ts";
import { InitiativeDetailPage } from "./InitiativeDetailPage.tsx";

beforeAll(() => {
  // React Flow measures its pane; jsdom has no layout.
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
});

afterEach(() => window.sessionStorage.clear());

const HELD: InitiativeRead = {
  item: HOSTED_LABS_DETAIL,
  layout: HOSTED_LABS_LAYOUT,
};

function renderPage(
  detailState: LoadState<InitiativeRead | null> | undefined,
  overrides: Partial<Parameters<typeof InitiativeDetailPage>[0]> = {},
) {
  const onLoadDetail = vi.fn();
  const onSelectTask = vi.fn();
  const props: Parameters<typeof InitiativeDetailPage>[0] = {
    initiativeId: HOSTED_LABS_DETAIL.id,
    mobile: false,
    connected: true,
    summary: hostedLabsSummary(),
    detailState,
    onLoadDetail,
    onOpenInitiative: vi.fn(),
    liveTasks: null,
    sessions: [],
    projectLabel: (id) => id ?? "No Project",
    selectedTaskId: null,
    onSelectTask,
    onOpenIndex: vi.fn(),
    ...overrides,
  };
  const view = mount(<InitiativeDetailPage {...props} />);
  return {
    ...view,
    onLoadDetail,
    onSelectTask,
    rerender: (next: Partial<typeof props>) =>
      view.render(<InitiativeDetailPage {...props} {...next} />),
  };
}

const text = (container: HTMLElement) => container.textContent ?? "";
const button = (container: HTMLElement, name: RegExp) =>
  [...container.querySelectorAll("button")].find((el) =>
    name.test(el.getAttribute("aria-label") ?? el.textContent ?? ""),
  );

/** The map is a lazy chunk: wait until its first node is drawn. */
async function flushLazy(container: HTMLElement) {
  for (let i = 0; i < 200; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (container.querySelector(".react-flow__node button")) return;
  }
  throw new Error("the map never drew a node");
}

describe("InitiativeDetailPage load states", () => {
  it("loads: reads the Initiative and shows the summary's title meanwhile", () => {
    const { container, onLoadDetail } = renderPage(idle());
    expect(onLoadDetail).toHaveBeenCalledWith(HOSTED_LABS_DETAIL.id, []);
    expect(text(container)).toContain("Loading the Initiative");
    expect(text(container)).toContain("Hosted Labs");
  });

  it("refreshes: a newer revision keeps the members on screen", () => {
    const { container, onLoadDetail } = renderPage(refreshing(HELD), {
      mobile: true,
    });
    expect(onLoadDetail).toHaveBeenCalledTimes(1);
    expect(text(container)).toContain("Refreshing the Initiative");
    expect(text(container)).toContain(
      HOSTED_LABS_DETAIL.nodes.find((n) => n.id === T.SDC5)!.title,
    );
  });

  it("fails with a retry, and never shows a spinner forever", () => {
    const { container, onLoadDetail } = renderPage(
      failed("Connection lost while loading this Initiative."),
    );
    expect(onLoadDetail).not.toHaveBeenCalled();
    expect(text(container)).toContain("Connection lost");
    act(() => button(container, /^Retry$/)!.click());
    expect(onLoadDetail).toHaveBeenCalledWith(HOSTED_LABS_DETAIL.id, []);
  });

  it("re-reads a lost read once the connection is back", () => {
    const page = renderPage(failed("Connection lost."), { connected: false });
    expect(page.onLoadDetail).not.toHaveBeenCalled();
    page.rerender({ connected: true });
    expect(page.onLoadDetail).toHaveBeenCalledTimes(1);
  });

  it("says an Initiative that does not exist does not, and offers the index", () => {
    const { container } = renderPage(ready(null));
    expect(text(container)).toContain("does not exist, or it was deleted");
    expect(button(container, /Show all Initiatives/)).toBeDefined();
  });

  it("is empty only once the read says it has no members", () => {
    const { container } = renderPage(
      ready({
        item: { ...HOSTED_LABS_DETAIL, nodes: [], rootIds: [], edges: [] },
      }),
    );
    expect(text(container)).toContain("This Initiative has no Tasks yet");
  });

  it("says the Initiative is archived and still draws it", () => {
    const { container } = renderPage(
      ready({ item: { ...HOSTED_LABS_DETAIL, archivedAt: 5 } }),
      { mobile: true, summary: undefined },
    );
    expect(text(container)).toContain("This Initiative is archived");
    expect(text(container)).toContain(HOSTED_LABS_DETAIL.nodes[0]!.title);
  });
});

describe("InitiativeDetailPage views", () => {
  it("defaults to the List on a phone, and a row opens its Task", () => {
    const { container, onSelectTask } = renderPage(ready(HELD), {
      mobile: true,
    });
    expect(container.querySelector("[aria-label='Initiative map']")).toBeNull();
    const row = button(container, /Per-customer session quotas/)!;
    expect(row.getAttribute("aria-label")).toContain("In progress, blocked");
    // Named by its title and the shared Task id badge, nothing parsed.
    expect(row.querySelector(`[title="Task-${T.SDC5}"]`)?.textContent).toBe(
      `#${T.SDC5}`,
    );
    act(() => row.click());
    expect(onSelectTask).toHaveBeenCalledWith(T.SDC5);
  });

  it("falls back to the List with the reason and a retry when no layout was drawn", () => {
    const { container, onLoadDetail } = renderPage(
      ready({
        item: HOSTED_LABS_DETAIL,
        layoutError: "Too many layouts are running; read again shortly.",
      }),
    );
    expect(text(container)).toContain("The map could not be drawn");
    expect(text(container)).toContain("Too many layouts are running");
    expect(button(container, /Per-customer session quotas/)).toBeDefined();
    onLoadDetail.mockClear();
    act(() => button(container, /^Retry$/)!.click());
    expect(onLoadDetail).toHaveBeenCalledWith(HOSTED_LABS_DETAIL.id, []);
  });

  it("draws the map on a wide screen and switches view on request", async () => {
    const { container } = renderPage(ready(HELD));
    await flushLazy(container);
    const map = container.querySelector("[aria-label='Initiative map']");
    expect(map).not.toBeNull();
    // Every laid-out box is a Task button; lanes and groups are not. An epic's
    // collapse button sits beside its Task button, never inside it.
    const nodes = map!.querySelectorAll(
      ".react-flow__node button:not([aria-expanded])",
    );
    expect(nodes).toHaveLength(HOSTED_LABS_LAYOUT.nodes.length);
    expect(map!.querySelectorAll("button button")).toHaveLength(0);
    expect(
      [...map!.querySelectorAll(".react-flow__node button[aria-expanded]")]
        .map((toggle) => toggle.getAttribute("aria-label"))
        .sort(),
    ).toEqual(
      [T.SDC, T.SDC4, T.LAB, T.SRS]
        .map(
          (id) =>
            `Collapse ${HOSTED_LABS_DETAIL.nodes.find((n) => n.id === id)!.title}`,
        )
        .sort(),
    );
    for (const node of HOSTED_LABS_LAYOUT.nodes)
      expect(
        map!.querySelector(
          `[data-id="${node.id}"] [title="Task-${node.taskId}"]`,
        ),
      ).not.toBeNull();
    // A pointer reaches every Task node and passes through every frame (a
    // jsdom `click()` alone would not notice either).
    const wrappers = [
      ...map!.querySelectorAll<HTMLElement>(".react-flow__node"),
    ];
    for (const wrapper of wrappers)
      expect(wrapper.style.pointerEvents).toBe(
        wrapper.querySelector("button") ? "all" : "none",
      );
    expect(
      wrappers.filter((wrapper) => wrapper.style.pointerEvents === "none"),
    ).toHaveLength(
      HOSTED_LABS_LAYOUT.groups.length +
        HOSTED_LABS_LAYOUT.lanes.length +
        (HOSTED_LABS_LAYOUT.milestoneColumn ? 1 : 0),
    );
    act(() => button(container, /^List$/)!.click());
    expect(container.querySelector("[aria-label='Initiative map']")).toBeNull();
    expect(window.sessionStorage.getItem("assistant.initiativeView.v1")).toBe(
      '"list"',
    );
  });

  it("recolours a node from the Tasks topic without reading or laying out again", async () => {
    const page = renderPage(ready(HELD));
    await flushLazy(page.container);
    const node = () =>
      button(page.container, /Per-customer session quotas, Task-/)!;
    expect(node().getAttribute("aria-label")).toContain("In progress, blocked");
    page.onLoadDetail.mockClear();
    const live = new Map<string, TaskSummary>([
      [
        T.SDC5,
        {
          id: T.SDC5,
          title: "Per-customer session quotas",
          status: "done",
          source: { createdBy: "user" },
          createdAt: 1,
          updatedAt: 2,
          sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
        },
      ],
    ]);
    page.rerender({ liveTasks: live });
    expect(node().getAttribute("aria-label")).toContain("Done");
    expect(node().getAttribute("aria-label")).not.toContain("blocked");
    expect(page.onLoadDetail).not.toHaveBeenCalled();
    // A session running on it marks the node without a read either.
    page.rerender({
      liveTasks: live,
      sessions: [
        {
          id: "s1",
          harness: "claude-sdk",
          agentType: "developer",
          title: "s1",
          createdAt: 1,
          updatedAt: 1,
          messageCount: 1,
          isStreaming: true,
        },
      ],
    });
    expect(node().getAttribute("aria-label")).toContain("a session is running");
    expect(page.onLoadDetail).not.toHaveBeenCalled();
  });

  it("opens an outside blocker's own Task, never a lane", async () => {
    const { container, onSelectTask } = renderPage(ready(HELD));
    await flushLazy(container);
    const stub = button(container, /Legal sign-off.*outside this Initiative/)!;
    act(() => stub.click());
    expect(onSelectTask).toHaveBeenCalledWith(T["OUT-LEGAL"]);
    const labels = [
      ...container.querySelectorAll(".react-flow__node button"),
    ].map((el) => el.getAttribute("aria-label") ?? "");
    expect(
      labels.some((label) => label.startsWith("Hosted SDC sessions, Task-")),
    ).toBe(true);
    expect(
      container.querySelectorAll("[aria-label='Milestones'] button"),
    ).toHaveLength(0);
  });

  it("shows Ready, Doing and Blocked as visible marks, outside stubs included (F023)", async () => {
    const { container } = renderPage(ready(HELD));
    await flushLazy(container);
    const node = (taskId: string) =>
      [...container.querySelectorAll<HTMLElement>(".react-flow__node")].find(
        (wrapper) => wrapper.querySelector(`[title="Task-${taskId}"]`) !== null,
      )!;
    const marks = (taskId: string) => node(taskId).textContent ?? "";
    // A startable Task carries the one filled "Ready" chip.
    expect(marks(T.SDC)).toContain("Ready");
    // Doing AND blocked both show, independently.
    expect(marks(T.SDC5)).toContain("Doing");
    expect(node(T.SDC5).querySelector(".lucide-ban")).not.toBeNull();
    expect(marks(T.SDC5)).not.toContain("Ready");
    // Done carries no chip; archived is neither Ready nor Blocked.
    expect(marks(T.SDC1)).not.toMatch(/Ready|Doing/);
    expect(marks(T.LAB9)).toContain("Archived");
    expect(marks(T.LAB9)).not.toContain("Ready");
    // An outside blocker shows its own state beside "Outside".
    expect(marks(T["OUT-LEGAL"])).toContain("Outside");
    expect(marks(T["OUT-LEGAL"])).toContain("Ready");
  });

  it("marks a blocked member with the app's blocked marker, counted from the read without a live row (F048)", async () => {
    const blockedMarker = (scope: Element) => {
      const marker = scope.querySelector<HTMLElement>(
        '[role="img"][aria-label^="Blocked by "]',
      );
      // The stock marker itself, never wrapped in a chip of its own.
      expect(marker?.closest('[data-slot="badge"]') ?? null).toBeNull();
      return marker?.getAttribute("aria-label");
    };
    const { container, rerender } = renderPage(ready(HELD));
    await flushLazy(container);
    const node = (taskId: string) =>
      [...container.querySelectorAll<HTMLElement>(".react-flow__node")].find(
        (wrapper) => wrapper.querySelector(`[title="Task-${taskId}"]`) !== null,
      )!;
    // No live Tasks list yet: the count is the read's own open blockers. The
    // release waits on SDC9, LAB8 and the outside legal sign-off.
    expect(blockedMarker(node(T.RELEASE))).toBe("Blocked by 3 open tasks");
    expect(
      button(container, /^First hosted release, Task-/)!.getAttribute(
        "aria-label",
      ),
    ).toContain("To do, blocked by 3 open tasks");
    // Doing and blocked stay two facts.
    expect(blockedMarker(node(T.SDC5))).toBe("Blocked by 1 open task");
    expect(node(T.SDC5).textContent).toContain("Doing");
    // A live row speaks for its own Task.
    rerender({
      liveTasks: new Map<string, TaskSummary>([
        [
          T.SDC5,
          {
            id: T.SDC5,
            title: "Per-customer session quotas",
            status: "doing",
            source: { createdBy: "user" },
            createdAt: 1,
            updatedAt: 2,
            openBlockerCount: 2,
          },
        ],
      ]),
    });
    expect(blockedMarker(node(T.SDC5))).toBe("Blocked by 2 open tasks");
    expect(node(T.SDC5).textContent).toContain("Doing");

    // The List's rows carry the same marker.
    act(() => button(container, /^List$/)!.click());
    const row = (title: RegExp) => button(container, title)!.closest("li")!;
    expect(blockedMarker(row(/^First hosted release, Task-/))).toBe(
      "Blocked by 3 open tasks",
    );
  });

  it("adds the overview map to the map (F025)", async () => {
    const { container } = renderPage(ready(HELD));
    await flushLazy(container);
    expect(container.querySelector(".react-flow__minimap")).not.toBeNull();
    expect(
      container.querySelector('.react-flow__minimap [tabindex="0"]'),
    ).toBeNull();
  });
});
