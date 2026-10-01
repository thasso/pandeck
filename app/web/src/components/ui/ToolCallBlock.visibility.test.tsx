// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThinkingBlock } from "../ThinkingBlock.tsx";
import { ToolCallBlock } from "./ToolCallBlock.tsx";

/**
 * What drives live-body demand: a body is VISIBLE when it is expanded and the
 * block is currently near the viewport, and the block says so — once when it
 * becomes visible, once when it stops (scrolled away, collapsed, unmounted).
 * A body given as a function is built only after it has been near.
 */

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let observe!: (entries: Array<{ isIntersecting: boolean }>) => void;
let observed = 0;

beforeEach(() => {
  observed = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof observe) {
        observe = callback;
      }
      observe() {
        observed += 1;
      }
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

it("reports a tool body visible only while expanded AND near, and builds it once near", () => {
  const visibility = vi.fn();
  const body = vi.fn(() => <div>BODY</div>);
  act(() =>
    root!.render(
      <ToolCallBlock
        name="bash"
        status="success"
        defaultOpen
        onBodyVisibilityChange={visibility}
      >
        {body}
      </ToolCallBlock>,
    ),
  );
  expect(observed).toBe(1);
  expect(visibility).not.toHaveBeenCalled();
  expect(body).not.toHaveBeenCalled();
  expect(container!.textContent).not.toContain("BODY");

  act(() => observe([{ isIntersecting: true }]));
  expect(visibility).toHaveBeenLastCalledWith(true);
  expect(body).toHaveBeenCalledTimes(1);
  expect(container!.textContent).toContain("BODY");

  // Scrolled far away: delivery stops, the built body stays mounted.
  act(() => observe([{ isIntersecting: false }]));
  expect(visibility).toHaveBeenLastCalledWith(false);
  expect(container!.textContent).toContain("BODY");

  act(() => observe([{ isIntersecting: true }]));
  expect(visibility).toHaveBeenLastCalledWith(true);
  expect(visibility).toHaveBeenCalledTimes(3);

  // Collapsing is the reader's explicit stop.
  act(() => container!.querySelector("button")!.click());
  expect(visibility).toHaveBeenLastCalledWith(false);
  expect(container!.textContent).not.toContain("BODY");
});

it("a collapsed block never reports visibility, even when near", () => {
  const visibility = vi.fn();
  act(() =>
    root!.render(
      <ToolCallBlock
        name="bash"
        status="running"
        onBodyVisibilityChange={visibility}
      >
        {() => <div>BODY</div>}
      </ToolCallBlock>,
    ),
  );
  act(() => observe([{ isIntersecting: true }]));
  expect(visibility).not.toHaveBeenCalled();
});

it("a live thinking block opens itself, stops on collapse, and shows its header with no text", () => {
  const visibility = vi.fn();
  act(() =>
    root!.render(
      <ThinkingBlock
        streaming
        bodyAvailable
        onBodyVisibilityChange={visibility}
      >
        {""}
      </ThinkingBlock>,
    ),
  );
  expect(container!.textContent).toContain("Thinking…");
  expect(
    container!.querySelector("button")?.getAttribute("aria-expanded"),
  ).toBe("true");
  act(() => observe([{ isIntersecting: true }]));
  expect(visibility).toHaveBeenLastCalledWith(true);
  // Expanded before its text arrived: the body region waits, marked busy.
  expect(container!.querySelector("[aria-busy='true']")).not.toBeNull();

  act(() => container!.querySelector("button")!.click());
  expect(visibility).toHaveBeenLastCalledWith(false);
  expect(
    container!.querySelector("button")?.getAttribute("aria-expanded"),
  ).toBe("false");
  // Still streaming: the reader's collapse holds.
  act(() =>
    root!.render(
      <ThinkingBlock
        streaming
        bodyAvailable
        onBodyVisibilityChange={visibility}
      >
        {"now some text"}
      </ThinkingBlock>,
    ),
  );
  expect(
    container!.querySelector("button")?.getAttribute("aria-expanded"),
  ).toBe("false");
});

it("a thinking block with neither text nor a withheld body renders nothing once settled", () => {
  act(() => root!.render(<ThinkingBlock>{""}</ThinkingBlock>));
  expect(container!.textContent).toBe("");
});
