// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionRouting, type Route } from "./useSessionRouting.ts";
import { initHistoryNav, resetHistoryNavForTests } from "../lib/historyNav.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let currentRoute: Route;
let navigateTo: (path: string) => void;

function Probe() {
  const routing = useSessionRouting({
    connected: false,
    hydrated: false,
    sessions: [],
    currentId: undefined,
    hasMessages: false,
    loadSession: vi.fn(),
    openPermanentAssistant: vi.fn(),
  });
  currentRoute = routing.route;
  navigateTo = routing.navigate;
  return null;
}

beforeEach(() => {
  resetHistoryNavForTests();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/files/tmp/first.md#L4-L6");
  initHistoryNav();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("keeps anchors through initial load, synthetic navigation, Back and Forward", async () => {
  act(() => root.render(<Probe />));
  expect(currentRoute).toMatchObject({
    name: "files",
    path: "/tmp/first.md",
    anchor: { start: 4, end: 6 },
  });

  act(() => navigateTo("/files/tmp/second.md#L9"));
  expect(currentRoute).toMatchObject({
    name: "files",
    path: "/tmp/second.md",
    anchor: { start: 9 },
  });

  await act(async () => {
    await new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
      window.history.back();
    });
  });
  expect(currentRoute).toMatchObject({
    path: "/tmp/first.md",
    anchor: { start: 4, end: 6 },
  });

  await act(async () => {
    await new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
      window.history.forward();
    });
  });
  expect(currentRoute).toMatchObject({
    path: "/tmp/second.md",
    anchor: { start: 9 },
  });
});

it("pushes navigation between valid anchors on the same document", async () => {
  act(() => root.render(<Probe />));
  act(() => navigateTo("/files/tmp/first.md#L9-L11"));
  expect(window.history.state).toMatchObject({ navIndex: 1 });
  expect(currentRoute).toMatchObject({
    path: "/tmp/first.md",
    anchor: { start: 9, end: 11 },
  });

  await act(async () => {
    await new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
      window.history.back();
    });
  });
  expect(currentRoute).toMatchObject({ anchor: { start: 4, end: 6 } });
});

it("does not push the same document for an unrelated message fragment", () => {
  act(() => root.render(<Probe />));
  act(() => navigateTo("/files/tmp/first.md#m-unrelated"));
  expect(window.history.state).toMatchObject({ navIndex: 0 });
  expect(currentRoute).toMatchObject({ anchor: { start: 4, end: 6 } });
});
