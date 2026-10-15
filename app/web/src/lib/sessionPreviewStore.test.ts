// @vitest-environment jsdom
import type { SessionState } from "@assistant/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Store = typeof import("./sessionPreviewStore.ts");

let store: Store;

beforeEach(async () => {
  window.localStorage.clear();
  // The stale-key sweep is once per module instance; each test gets its own.
  vi.resetModules();
  store = await import("./sessionPreviewStore.ts");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function preview(sessionId: string, savedAt: number, text = "hello") {
  return {
    sessionId,
    session: { sessionId } as unknown as SessionState,
    messages: [
      {
        id: `${sessionId}-m1`,
        role: "assistant" as const,
        blocks: [{ kind: "text" as const, text }],
      },
    ],
    contextInfo: null,
    savedAt,
  };
}

const path = (sessionId: string) => `/sessions/${sessionId}`;

it("stores each session under its own key and reads the boot one back", () => {
  store.saveSessionPreview(preview("a", 1));
  store.saveSessionPreview(preview("b", 2));

  expect(
    window.localStorage.getItem("assistant.sessionPreview.v2.a"),
  ).not.toBeNull();
  expect(store.loadBootSessionPreview(path("b"))).toMatchObject({
    sessionId: "b",
    savedAt: 2,
  });
});

it("does not write an unchanged transcript again", () => {
  store.saveSessionPreview(preview("a", 1));
  const setItem = vi.spyOn(Storage.prototype, "setItem");

  store.saveSessionPreview(preview("a", 5));

  expect(setItem).not.toHaveBeenCalled();
});

it("rewrites only the saved session, plus the small index", () => {
  store.saveSessionPreview(preview("a", 1));
  store.saveSessionPreview(preview("b", 2));
  const setItem = vi.spyOn(Storage.prototype, "setItem");

  store.saveSessionPreview(preview("a", 3, "changed"));

  expect(setItem.mock.calls.map(([key]) => key)).toEqual([
    "assistant.sessionPreview.v2.a",
    "assistant.sessionPreview.v2",
  ]);
});

it("keeps the eight most recent sessions", () => {
  for (let i = 0; i < 9; i += 1) store.saveSessionPreview(preview(`s${i}`, i));

  expect(store.loadBootSessionPreview(path("s0"))).toBeNull();
  expect(window.localStorage.getItem("assistant.sessionPreview.v2.s0")).toBe(
    null,
  );
  expect(store.loadBootSessionPreview(path("s8"))?.sessionId).toBe("s8");
});

it("sweeps records the index does not list", () => {
  window.localStorage.setItem("assistant.sessionPreview.v2.orphan", "{}");

  store.saveSessionPreview(preview("a", 1));

  expect(
    window.localStorage.getItem("assistant.sessionPreview.v2.orphan"),
  ).toBeNull();
  expect(store.loadBootSessionPreview(path("a"))?.sessionId).toBe("a");
});
