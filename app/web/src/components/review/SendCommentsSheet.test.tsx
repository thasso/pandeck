// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SendCommentsSheet } from "./SendCommentsSheet.tsx";

/**
 * The sheet the primary slot opens once comments are waiting. Because it took
 * that slot from the object's own action, it has to offer that action back:
 * having written a comment must not be the reason you cannot start a plain
 * session.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

if (!window.matchMedia)
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as typeof window.matchMedia;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function withText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
}

it("offers the object's own action as the way out that is not a review", () => {
  const onRun = vi.fn();
  const onClose = vi.fn();
  const onSend = vi.fn();
  act(() =>
    root.render(
      <SendCommentsSheet
        count={2}
        sessions={[]}
        onClose={onClose}
        onSend={onSend}
        startWithout={{ label: "Start session with this entry", onRun }}
      />,
    ),
  );

  act(() => withText("Start session with this entry")!.click());
  expect(onRun).toHaveBeenCalledOnce();
  // It leaves for another screen, so the sheet goes with it.
  expect(onClose).toHaveBeenCalledOnce();
  expect(onSend).not.toHaveBeenCalled();
});

it("omits it where the host has nothing to offer instead", () => {
  act(() =>
    root.render(
      <SendCommentsSheet
        count={1}
        sessions={[]}
        onClose={() => {}}
        onSend={() => {}}
      />,
    ),
  );

  expect(withText("Start session with this entry")).toBeUndefined();
  expect(withText("Submit review")).toBeTruthy();
});
