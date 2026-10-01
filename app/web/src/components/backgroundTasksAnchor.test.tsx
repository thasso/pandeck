// @vitest-environment jsdom
/**
 * The `/background-tasks?task=<id>` deep link ([Task-486](pa://task/486)).
 *
 * A link is a promise that the row it names is ON the page it opens. Two ways to
 * break that promise, and the second is worse than the first: not scrolling to
 * the row, and paging the row out entirely so nothing on screen says the link
 * worked. Both are asserted here against a list LARGER than one page, because
 * neither can happen at the 1-row sizes a render test naturally reaches for.
 *   pnpm --filter @assistant/web test src/components/backgroundTasksAnchor.test.tsx
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BackgroundWorkItemSummary } from "@assistant/shared";
import { BackgroundTasksPage } from "./BackgroundTasksPage.tsx";
import { BACKGROUND_WORK_PAGE_SIZE } from "../lib/backgroundWork.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;

beforeAll(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  // `useListScroll` observes its container; jsdom ships no ResizeObserver.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom has no layout, so record the call instead of a resulting position.
  Element.prototype.scrollIntoView = function scrollIntoViewStub(
    this: Element,
  ) {
    scrolled.push(this.getAttribute("data-background-item") ?? "");
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const scrolled: string[] = [];

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  scrolled.length = 0;
});

function item(
  partial: Partial<BackgroundWorkItemSummary> & { id: string },
): BackgroundWorkItemSummary {
  return {
    ownerSessionId: "owner-a",
    backend: "host-process",
    kind: "shell",
    label: `run ${partial.id}`,
    state: "running",
    stopState: "none",
    createdAt: NOW - 600_000,
    updatedAt: NOW - 60_000,
    startedAt: NOW - 600_000,
    deadlineAt: NOW + 1_800_000,
    settingsGeneration: 7,
    ...partial,
  };
}

/** One page's worth of active rows, plus the terminal row a link addresses. */
function crowdedRegistry(): BackgroundWorkItemSummary[] {
  return [
    ...Array.from({ length: BACKGROUND_WORK_PAGE_SIZE + 5 }, (_, i) =>
      item({ id: `i${i}`, updatedAt: NOW - i * 1_000 }),
    ),
    item({
      id: "linked",
      label: "the linked one",
      state: "completed",
      terminalAt: NOW - 900_000,
      updatedAt: NOW - 900_000,
    }),
  ];
}

function render(items: BackgroundWorkItemSummary[], anchoredId?: string) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const draw = (next: BackgroundWorkItemSummary[]) =>
    act(() => {
      root!.render(
        <BackgroundTasksPage
          items={next}
          sessions={[]}
          {...(anchoredId ? { anchoredId } : {})}
          stopPending={new Set<string>()}
          onStop={() => {}}
          onStopAllForOwner={() => {}}
          onOpenSession={() => {}}
        />,
      );
    });
  draw(items);
  return {
    draw,
    row: (id: string) =>
      container!.querySelector<HTMLElement>(`[data-background-item="${id}"]`),
    rows: () =>
      [...container!.querySelectorAll("[data-background-item]")].map((node) =>
        node.getAttribute("data-background-item"),
      ),
    text: () => container!.textContent ?? "",
  };
}

describe("a direct reload of a deep link", () => {
  it("renders the linked row past the page cutoff, without Show more", () => {
    const page = render(crowdedRegistry(), "linked");
    // The regression: 30 active rows sort ahead of it, so an unpinned page ends
    // at row 25 and the link lands on a screen that does not contain its target.
    expect(page.rows()).toContain("linked");
    expect(page.row("linked")).not.toBeNull();
    // It is shown, so the reveal control must not still be offering it.
    expect(page.text()).toContain("Show 5 more");
  });

  it("scrolls and focuses the linked row once the registry delivers it", () => {
    // The registry arrives on the topic AFTER the route mounts, which is the
    // ordering a direct reload really has.
    const page = render([], "linked");
    expect(scrolled).toEqual([]);
    page.draw(crowdedRegistry());
    expect(scrolled).toEqual(["linked"]);
    expect(document.activeElement).toBe(page.row("linked"));
    expect(page.row("linked")?.getAttribute("data-background-anchored")).toBe(
      "true",
    );
  });

  it("does not yank a reader back on a later rebroadcast", () => {
    const page = render(crowdedRegistry(), "linked");
    expect(scrolled).toEqual(["linked"]);
    // Same anchor, new row objects: exactly what a `background` rebroadcast is.
    page.draw(crowdedRegistry());
    page.draw(crowdedRegistry());
    expect(scrolled).toEqual(["linked"]);
  });

  it("scrolls nothing when the route carries no anchor", () => {
    const page = render(crowdedRegistry());
    expect(scrolled).toEqual([]);
    expect(page.rows()).not.toContain("linked");
    expect(page.rows()).toHaveLength(BACKGROUND_WORK_PAGE_SIZE);
  });
});
