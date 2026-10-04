// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import { useSessionRouting } from "./useSessionRouting.ts";
import { initHistoryNav, resetHistoryNavForTests } from "../lib/historyNav.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type RoutingArgs = Parameters<typeof useSessionRouting>[0];
let root: Root;
let container: HTMLDivElement;
let args: RoutingArgs;
let routing: ReturnType<typeof useSessionRouting>;

function Probe() {
  routing = useSessionRouting(args);
  return null;
}

function render(changes: Partial<RoutingArgs> = {}) {
  args = { ...args, ...changes };
  act(() => root.render(<Probe />));
}

beforeEach(() => {
  resetHistoryNavForTests();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/sessions/old");
  initHistoryNav();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  args = {
    connected: true,
    hydrated: true,
    sessions: [{ id: "old", messageCount: 2 }] as SessionListItem[],
    currentId: "old",
    hasMessages: true,
    loadSession: vi.fn(),
    openPermanentAssistant: vi.fn(),
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("a notification for an unlisted session does not revert to the previous chat", () => {
  render();
  act(() => routing.navigate("/sessions/not-in-cache"));
  expect(args.loadSession).toHaveBeenCalledExactlyOnceWith("not-in-cache");
  expect(location.pathname).toBe("/sessions/not-in-cache");
  expect(routing.route).toEqual({ name: "session", id: "not-in-cache" });

  // A late frame from the previously viewed chat is not a load result.
  render({ sessions: [] });
  expect(location.pathname).toBe("/sessions/not-in-cache");
  render({ currentId: "not-in-cache" });
  expect(routing.route).toEqual({ name: "session", id: "not-in-cache" });
  expect(args.loadSession).toHaveBeenCalledTimes(1);
});

test("a background tap survives reconnect before the session list is refreshed", () => {
  render({ connected: false });
  act(() => routing.navigate("/sessions/from-push"));
  expect(args.loadSession).not.toHaveBeenCalled();
  render({ connected: true, sessions: [] });
  expect(args.loadSession).toHaveBeenCalledExactlyOnceWith("from-push");
  expect(location.pathname).toBe("/sessions/from-push");
  render({ currentId: "from-push" });
  expect(location.pathname).toBe("/sessions/from-push");
});

test("only the latest tapped session can settle a pending navigation", () => {
  render();
  act(() => routing.navigate("/sessions/first"));
  act(() => routing.navigate("/sessions/latest"));
  render({ currentId: "first" });
  expect(location.pathname).toBe("/sessions/latest");
  render({ currentId: "latest" });
  expect(location.pathname).toBe("/sessions/latest");
});
