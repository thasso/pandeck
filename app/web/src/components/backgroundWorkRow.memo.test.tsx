// @vitest-environment jsdom
/**
 * The registry row's memo and its reach ([Task-486](pa://task/486)).
 *
 * The `background` topic is rebroadcast as state events and the surfaces tick
 * once a second while anything runs, so a row that held on object identity would
 * re-render on every frame and one that ignored its rendered labels would freeze
 * at whatever it read first. Both failures are invisible on screen, so they are
 * asserted against the row's own DOM rather than eyeballed.
 *   pnpm --filter @assistant/web test src/components/backgroundWorkRow.memo.test.tsx
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { BackgroundWorkItemSummary } from "@assistant/shared";
import { BackgroundWorkRow } from "./BackgroundWorkRow.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function item(
  partial: Partial<BackgroundWorkItemSummary> = {},
): BackgroundWorkItemSummary {
  return {
    id: "bw_1",
    ownerSessionId: "owner-a",
    backend: "host-process",
    kind: "shell",
    label: "pnpm run build",
    state: "running",
    stopState: "none",
    createdAt: NOW - 615_000,
    updatedAt: NOW - 60_000,
    startedAt: NOW - 615_000,
    deadlineAt: NOW + 1_845_000,
    settingsGeneration: 7,
    ...partial,
  };
}

/** Draws the row and hands back the DOM node it owns, for redraw comparison. */
function render(props: {
  item: BackgroundWorkItemSummary;
  now: number;
  stopPending?: boolean;
}) {
  const stop = () => {};
  const draw = (next: {
    item: BackgroundWorkItemSummary;
    now: number;
    stopPending?: boolean;
  }) =>
    act(() => {
      root!.render(
        <ul>
          <BackgroundWorkRow
            item={next.item}
            now={next.now}
            stopPending={next.stopPending ?? false}
            onStop={stop}
          />
        </ul>,
      );
    });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  draw(props);
  return { draw, node: () => container!.querySelector("li")! };
}

describe("BackgroundWorkRow memoization", () => {
  it("holds still for a rebroadcast that changed no rendered fact", () => {
    const { draw, node } = render({ item: item(), now: NOW });
    const before = node().innerHTML;
    // A brand-new object with identical content, and half a second later: what
    // every `background` rebroadcast plus ticker frame looks like.
    draw({ item: item(), now: NOW + 500 });
    expect(node().innerHTML).toBe(before);
  });

  it("updates when a rendered fact moves", () => {
    const { draw, node } = render({ item: item(), now: NOW });
    expect(node().textContent).toContain("Running");
    draw({ item: item({ stopState: "requested" }), now: NOW });
    expect(node().textContent).toContain("Stopping");
    draw({
      item: item({ state: "stopped", terminalAt: NOW, stopState: "requested" }),
      now: NOW,
    });
    expect(node().textContent).toContain("Stopped");
  });

  it("shows the pending control without changing what the row says", () => {
    const { draw, node } = render({ item: item(), now: NOW });
    draw({ item: item(), now: NOW, stopPending: true });
    const button = node().querySelector("button[aria-busy]");
    expect(button?.getAttribute("aria-busy")).toBe("true");
    // The work is still running: a pressed Stop is not a state change.
    expect(node().textContent).toContain("Running");
  });
});

describe("BackgroundWorkRow access", () => {
  it("gives Stop a keyboard-reachable button with its own name", () => {
    const { node } = render({ item: item(), now: NOW });
    const button = node().querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Stop pnpm run build");
    expect(button?.hasAttribute("disabled")).toBe(false);
    // In the tab order; nothing here opts out of it.
    expect(
      Number(button?.getAttribute("tabindex") ?? 0),
    ).toBeGreaterThanOrEqual(0);
  });

  it("disables Stop with a reason once the work is terminal", () => {
    const { node } = render({
      item: item({ state: "completed", terminalAt: NOW }),
      now: NOW,
    });
    const button = node().querySelector("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
    expect(button?.getAttribute("title")).toBe(
      "This work has already finished.",
    );
  });

  it("keeps the tap target at the shared minimum height", () => {
    const { node } = render({ item: item(), now: NOW });
    // shadcn's default `Button` size is the app's control height; the row must
    // not shrink it.
    expect(node().querySelector("button")?.className).toContain("h-8");
  });
});
