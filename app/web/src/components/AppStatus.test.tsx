// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AppStatus, RECONNECT_GRACE_MS } from "./AppStatus.tsx";
import { resetAppStatusGrace, type AppReloadState } from "../lib/appStatus.ts";
import {
  MOBILE_LAYOUT_QUERY,
  useMobileLayout,
} from "./shell/useMobileLayout.ts";

/**
 * The app status slot (`docs/messaging.md`): the one surface allowed to announce
 * something globally. Each of its decisions fails silently if it regresses — a
 * slot that never appears, one that flashes on every cold start, one that
 * contradicts the restart it is caused by, or one that draws in both placements
 * at once — so each has a case here.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let mobile = true;
const mediaListeners = new Set<() => void>();

/** Move the viewport across the shell's one breakpoint, as a resize would. */
function setLayout(next: boolean) {
  mobile = next;
  act(() => {
    for (const listener of [...mediaListeners]) listener();
  });
}

beforeEach(() => {
  mobile = true;
  mediaListeners.clear();
  resetAppStatusGrace();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === MOBILE_LAYOUT_QUERY ? mobile : false;
    },
    addEventListener: (_: string, listener: () => void) =>
      mediaListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      mediaListeners.delete(listener),
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  resetAppStatusGrace();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Props {
  connected?: boolean;
  reloading?: AppReloadState | null;
  hydrationSource?: "empty" | "cache" | "live";
  placement?: "bar" | "floating";
}

function render(props: Props = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  update(props);
  return container;
}

function update({
  connected = false,
  reloading = null,
  hydrationSource = "live",
  placement = "floating",
}: Props = {}) {
  act(() =>
    root!.render(
      <AppStatus
        connected={connected}
        reloading={reloading}
        hydrationSource={hydrationSource}
        placement={placement}
      />,
    ),
  );
}

function slot(): HTMLElement | null {
  return container!.querySelector("[role='status']");
}

function elapse(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

it("says nothing while the connection is up", () => {
  vi.useFakeTimers();
  render({ connected: true });
  elapse(RECONNECT_GRACE_MS * 2);
  expect(slot()).toBeNull();
});

// The grace period is the whole reason this does not flash on every cold start:
// a cached shell is hydrated but not live until `ready` lands, and a dropped
// socket usually returns inside one retry.
it("waits out the grace period before drawing anything", () => {
  vi.useFakeTimers();
  render();
  elapse(RECONNECT_GRACE_MS - 1);
  expect(slot()).toBeNull();
  elapse(1);
  expect(slot()).not.toBeNull();
});

it("stands down again — and re-arms the grace period — when the socket returns", () => {
  vi.useFakeTimers();
  render();
  elapse(RECONNECT_GRACE_MS);
  expect(slot()).not.toBeNull();

  update({ connected: true });
  expect(slot()).toBeNull();

  // A second drop starts the wait over rather than reappearing instantly.
  update({ connected: false });
  expect(slot()).toBeNull();
  elapse(RECONNECT_GRACE_MS);
  expect(slot()).not.toBeNull();
});

// A restart owns the disconnect it causes, and it is announced the moment it is
// queued: the server has already taken the decision, so there is nothing to
// wait out.
it("announces a queued restart at once, and outranks the connection state", () => {
  vi.useFakeTimers();
  render({ reloading: { phase: "pending", runningCount: 3 } });
  expect(slot()!.textContent).toContain("Restart queued");
  expect(slot()!.textContent).toContain("3 sessions");
  expect(slot()!.textContent).not.toContain("Reconnecting");
});

it("counts one waiting session in the singular, and omits a count of none", () => {
  vi.useFakeTimers();
  render({ reloading: { phase: "pending", runningCount: 1 } });
  expect(slot()!.textContent).toContain("1 session");
  expect(slot()!.textContent).not.toContain("1 sessions");

  update({ reloading: { phase: "pending" } });
  expect(slot()!.textContent).toContain("Restart queued");
  expect(slot()!.textContent).not.toContain("waiting for");
});

// A shell restored from cache has never been live: that is a first connection,
// not a lost one, and calling it a reconnect would describe a drop that never
// happened.
it("names a first connection and a lost one differently", () => {
  vi.useFakeTimers();
  render({ hydrationSource: "cache" });
  elapse(RECONNECT_GRACE_MS);
  expect(slot()!.textContent).toContain("Connecting…");
  expect(slot()!.textContent).not.toContain("Reconnecting…");

  update({ hydrationSource: "live" });
  expect(slot()!.textContent).toContain("Reconnecting…");
});

// Two placements, one derivation: the floating pill belongs to the narrow shell
// only, because the wide one carries the same state inside its header bar and
// two copies of one announcement is exactly what the model forbids.
it("draws the floating placement only on narrow layouts", () => {
  vi.useFakeTimers();
  mobile = false;
  render({ reloading: { phase: "reloading" }, placement: "floating" });
  expect(slot()).toBeNull();

  act(() => root!.unmount());
  container!.remove();
  render({ reloading: { phase: "reloading" }, placement: "bar" });
  expect(slot()!.textContent).toContain("Restarting…");
});

// The two placements do NOT live and die together: the header bar exists only
// on wide layouts. A grace period owned by a component would restart at the
// breakpoint, so a rotate would blank an announcement that had been up for
// minutes — and the user would read that as the app recovering.
it("keeps the announcement across the breakpoint, without re-waiting", () => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // The shell's real composition: the floating placement always mounted, the
  // bar one only while the header bar itself exists.
  function Shell() {
    const narrow = useMobileLayout();
    return (
      <>
        <AppStatus
          connected={false}
          reloading={null}
          hydrationSource="live"
          placement="floating"
        />
        {!narrow && (
          <AppStatus
            connected={false}
            reloading={null}
            hydrationSource="live"
            placement="bar"
          />
        )}
      </>
    );
  }
  act(() => root!.render(<Shell />));
  elapse(RECONNECT_GRACE_MS);
  expect(slot()!.textContent).toContain("Reconnecting…");

  setLayout(false);
  // Exactly one, and immediately: the wait belongs to the connection, not to
  // whichever shell happens to be drawing it.
  expect(container!.querySelectorAll("[role='status']")).toHaveLength(1);
  expect(slot()!.textContent).toContain("Reconnecting…");

  setLayout(true);
  expect(container!.querySelectorAll("[role='status']")).toHaveLength(1);
  expect(slot()!.textContent).toContain("Reconnecting…");
});

// R6: the region announces, the spinner inside it does not.
it("announces once, through the region rather than the glyph", () => {
  vi.useFakeTimers();
  render();
  elapse(RECONNECT_GRACE_MS);
  const status = slot()!;
  expect(status.getAttribute("aria-busy")).toBeNull();
  expect(status.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
});
