// @vitest-environment jsdom
/**
 * The Schedules nav count (`app/web/docs/ui-shell.md`, the one count
 * exception): a badge over the icon that takes no slot width, hidden at zero,
 * and spoken through the slot's accessible name in the bar and the overflow.
 *   cd app/web && pnpm exec vitest run src/components/shell/navCount.test.tsx
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CalendarClock, Inbox } from "lucide-react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CountIcon } from "../UnreadDot.tsx";
import { PrimaryNav, type PrimaryNavSection } from "./PrimaryNav.tsx";
import { OverflowList } from "./SectionOverflow.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function sections(
  count: number,
): Array<PrimaryNavSection<"tasks" | "schedules">> {
  return [
    { id: "tasks", label: "Tasks", icon: <Inbox size={17} /> },
    {
      id: "schedules",
      label: "Schedules",
      icon: <CountIcon icon={<CalendarClock size={17} />} count={count} />,
      ...(count > 0
        ? { accessibleLabel: `Schedules, ${count} need attention` }
        : {}),
    },
  ];
}

it("renders the count over the icon, hidden from the accessible tree, and nothing at zero", () => {
  act(() => root.render(<CountIcon icon={<CalendarClock />} count={3} />));
  const badge = container.querySelector("[data-nav-count]")!;
  expect(badge.textContent).toBe("3");
  expect(badge.getAttribute("aria-hidden")).toBe("true");
  // Absolute, so the 36px slot `navOverflow.ts` assumes is unchanged.
  expect(badge.className).toContain("absolute");
  act(() => root.render(<CountIcon icon={<CalendarClock />} count={0} />));
  expect(container.querySelector("[data-nav-count]")).toBeNull();
});

it("names the count on the bar's slot, active or not", () => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 1000,
  } as DOMRect);
  act(() =>
    root.render(
      <PrimaryNav
        sections={sections(2)}
        activeId="tasks"
        onSelect={() => {}}
        mobile={false}
      />,
    ),
  );
  expect(
    container.querySelector('[aria-label="Schedules, 2 need attention"]'),
  ).not.toBeNull();
  act(() =>
    root.render(
      <PrimaryNav
        sections={sections(2)}
        activeId="schedules"
        onSelect={() => {}}
        mobile={false}
      />,
    ),
  );
  const active = container.querySelector('[aria-current="true"]')!;
  expect(active.getAttribute("aria-label")).toBe("Schedules, 2 need attention");
  act(() =>
    root.render(
      <PrimaryNav
        sections={sections(0)}
        activeId="tasks"
        onSelect={() => {}}
        mobile={false}
      />,
    ),
  );
  expect(container.querySelector('[aria-label="Schedules"]')).not.toBeNull();
  expect(container.querySelector("[data-nav-count]")).toBeNull();
});

it("keeps the count and its name when the slot folds into the overflow", () => {
  act(() =>
    root.render(
      <OverflowList
        items={sections(4)}
        activeId="tasks"
        onSelect={() => {}}
        close={() => {}}
      />,
    ),
  );
  const row = container.querySelector(
    '[aria-label="Schedules, 4 need attention"]',
  )!;
  expect(row.querySelector("[data-nav-count]")?.textContent).toBe("4");
});
