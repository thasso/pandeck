// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  canGoBack,
  canGoForward,
  closeDocument,
  currentDocumentOrigin,
  currentDocumentScroll,
  flushDocumentScroll,
  goBack,
  goForward,
  initHistoryNav,
  pushDocumentEntry,
  pushEntry,
  replaceEntry,
  resetHistoryNavForTests,
  saveDocumentScroll,
} from "./historyNav.ts";

/**
 * The arrows are drawn from these two answers, so a wrong one is a control that
 * looks live and does nothing (or looks dead with somewhere to go). The cases
 * that matter are the ones a browser gets right for free and a counter does not:
 * a replace must not advance, and a push must drop whatever was ahead.
 */
describe("historyNav", () => {
  beforeEach(() => {
    resetHistoryNavForTests();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    initHistoryNav();
  });

  test("the entry the app loaded on has nowhere to go", () => {
    expect(canGoBack()).toBe(false);
    expect(canGoForward()).toBe(false);
  });

  test("a push makes back available and forward not", () => {
    pushEntry("/tasks");
    expect(canGoBack()).toBe(true);
    expect(canGoForward()).toBe(false);
  });

  test("a replace rewrites the entry without moving", () => {
    replaceEntry("/sessions/create");
    expect(canGoBack()).toBe(false);
    expect(window.location.pathname).toBe("/sessions/create");
  });

  test("stamps its index on every entry it creates", () => {
    pushEntry("/tasks");
    expect((window.history.state as { navIndex?: number }).navIndex).toBe(1);
    replaceEntry("/tasks/7");
    expect((window.history.state as { navIndex?: number }).navIndex).toBe(1);
  });

  test("a reload resumes from the entry it lands on", () => {
    pushEntry("/tasks");
    pushEntry("/tasks/7");
    // A reload re-runs the module against the history that survived it.
    resetHistoryNavForTests();
    initHistoryNav();
    expect(canGoBack()).toBe(true);
    expect(canGoForward()).toBe(false);
  });

  test("document navigation keeps the exact opening entry as its Close origin", () => {
    replaceEntry("/sessions/s1#m-42");
    pushDocumentEntry("/files/tmp/example/a.md#L2");
    pushDocumentEntry("/files/tmp/example/b.md#L8");
    expect(currentDocumentOrigin()).toEqual({
      index: 0,
      href: "/sessions/s1#m-42",
    });

    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    closeDocument("/sessions");
    expect(go).toHaveBeenCalledWith(-2);
  });

  test("coalesces high-frequency scroll writes and keeps the latest offset", () => {
    pushDocumentEntry("/files/a.md");
    const replace = vi.spyOn(window.history, "replaceState");
    for (let top = 1; top <= 100; top += 1) saveDocumentScroll(top, top / 2);
    expect(replace).not.toHaveBeenCalled();

    flushDocumentScroll();
    expect(replace).toHaveBeenCalledOnce();
    expect(currentDocumentScroll()).toEqual({ top: 100, left: 50 });
  });

  test("flushes independent viewer positions before Back and Forward", async () => {
    pushDocumentEntry("/files/a.md");
    saveDocumentScroll(240, 18);
    pushDocumentEntry("/files/b.md");
    saveDocumentScroll(80, 0);

    await goBack();
    expect(currentDocumentScroll()).toEqual({ top: 240, left: 18 });
    await new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
      goForward();
    });
    expect(currentDocumentScroll()).toEqual({ top: 80, left: 0 });
  });

  test("a deep-linked document closes to its deterministic fallback", () => {
    replaceEntry("/files/tmp/example/a.md");
    closeDocument("/sessions");
    expect(window.location.pathname).toBe("/sessions");
    expect(canGoBack()).toBe(true);
  });
});
