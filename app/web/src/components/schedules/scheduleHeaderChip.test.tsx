// @vitest-environment jsdom
/**
 * The session header's next scheduled prompt (AC12, U3): the approved label
 * naming the instant in the Schedule's zone and its name, the due label from
 * `md` up and the icon alone below, a link to the detail with no control
 * nested in it, and a memoized redraw only when its Schedule changes.
 *   cd app/web && pnpm exec vitest run src/components/schedules/scheduleHeaderChip.test.tsx
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatScheduleDue,
  formatScheduleInstant,
  type ScheduleSummary,
} from "@assistant/shared/schedules";
import { ScheduleHeaderChip } from "./ScheduleHeaderChip.tsx";

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
});

const NEXT = Date.UTC(2026, 11, 7, 10, 0);
const schedule: ScheduleSummary & { nextDueAtMs: number } = {
  id: "a",
  name: "Morning check",
  prompt: "Check the build",
  enabled: true,
  timing: {
    kind: "weekly",
    days: ["mon"],
    time: "11:00",
    timeZone: "Europe/Berlin",
  },
  target: { kind: "session", sessionId: "s1" },
  createdBy: { kind: "user" },
  controlledBy: { kind: "user" },
  cardless: false,
  createdAtMs: 1,
  updatedAtMs: 1,
  nextDueAtMs: NEXT,
};

describe("the header chip (AC12)", () => {
  it("names the next instant in the stored zone and the Schedule, and links its detail", () => {
    const onOpen = vi.fn();
    act(() =>
      root.render(<ScheduleHeaderChip schedule={schedule} onOpen={onOpen} />),
    );
    const link = container.querySelector("a")!;
    const label = `Next scheduled prompt: ${formatScheduleInstant(NEXT, "Europe/Berlin")} · Morning check`;
    expect(label).toContain("Europe/Berlin");
    expect(link.getAttribute("aria-label")).toBe(label);
    expect(link.getAttribute("title")).toBe(label);
    expect(link.getAttribute("href")).toBe("/schedules/a");
    // No link or control nested inside it.
    expect(link.querySelector("a, button")).toBeNull();
    act(() => {
      link.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    expect(onOpen).toHaveBeenCalledWith("/schedules/a");
  });

  it("shows the due label only from md up: icon-only on a phone, still named", () => {
    act(() =>
      root.render(<ScheduleHeaderChip schedule={schedule} onOpen={vi.fn()} />),
    );
    const due = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === formatScheduleDue(NEXT, "Europe/Berlin"),
    )!;
    expect(due.className.split(" ")).toEqual(
      expect.arrayContaining(["hidden", "md:inline"]),
    );
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("redraws only when its Schedule or handler changes", () => {
    const onOpen = vi.fn();
    // The chip reads the name once per render of its own body, so counting
    // reads counts its renders, not the parent's passes.
    let reads = 0;
    const counted = { ...schedule };
    Object.defineProperty(counted, "name", {
      get: () => {
        reads += 1;
        return schedule.name;
      },
    });
    const draw = (row: typeof schedule, tick: number) =>
      act(() =>
        root.render(
          <div data-tick={tick}>
            <ScheduleHeaderChip schedule={row} onOpen={onOpen} />
          </div>,
        ),
      );
    draw(counted, 0);
    const first = reads;
    expect(first).toBeGreaterThan(0);
    draw(counted, 1);
    draw(counted, 2);
    expect(reads).toBe(first);
    const node = container.querySelector("a");
    const later = NEXT + 7 * 86_400_000;
    draw({ ...schedule, nextDueAtMs: later }, 3);
    expect(container.querySelector("a")).toBe(node);
    expect(node?.getAttribute("aria-label")).toContain(
      formatScheduleInstant(later, "Europe/Berlin"),
    );
  });
});
