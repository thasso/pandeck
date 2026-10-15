// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastViewport } from "./ToastViewport.tsx";
import { dismissToast, getToasts, showToast } from "../lib/toast.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<ToastViewport />));
});

afterEach(async () => {
  act(() => {
    for (const toast of getToasts()) dismissToast(toast.id);
  });
  await act(async () => vi.runAllTimersAsync());
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function showError() {
  act(() => {
    showToast("Could not archive session", { tone: "error", durationMs: 0 });
  });
  act(() => {
    vi.runOnlyPendingTimers();
  });
}

it("places global notices at the top center with safe-area clearance on desktop and mobile", () => {
  showError();
  const viewport = container.querySelector<HTMLElement>(
    "[data-sonner-toaster]",
  )!;
  expect(viewport.dataset.yPosition).toBe("top");
  expect(viewport.dataset.xPosition).toBe("center");
  const inset = "calc(3.5rem + var(--app-safe-area-top, 0px))";
  expect(viewport.style.getPropertyValue("--offset-top")).toBe(inset);
  expect(viewport.style.getPropertyValue("--mobile-offset-top")).toBe(inset);
  expect(viewport.style.zIndex).toBe("60");
});

it("uses a warning glyph for errors and exactly one working close button", async () => {
  showError();
  const toast = container.querySelector("[data-sonner-toast]")!;
  expect(
    toast.querySelector("[data-icon] .lucide-triangle-alert"),
  ).not.toBeNull();
  expect(toast.querySelector(".lucide-octagon-x")).toBeNull();
  const buttons = toast.querySelectorAll("button");
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.getAttribute("aria-label")).toBe("Close toast");
  act(() => buttons[0]!.click());
  expect(getToasts()).toHaveLength(0);
  await act(async () => vi.runAllTimersAsync());
  expect(container.querySelector("[data-sonner-toast]")).toBeNull();
});

it("keeps the toast action separate from dismissal", () => {
  const onClick = vi.fn();
  act(() => {
    showToast("Moved Task-12 to Pandeck", {
      tone: "success",
      durationMs: 0,
      action: { label: "Undo", onClick },
    });
  });
  act(() => {
    vi.runOnlyPendingTimers();
  });
  const toast = container.querySelector("[data-sonner-toast]")!;
  expect(toast.querySelectorAll("[data-close-button]")).toHaveLength(1);
  const action = toast.querySelector<HTMLButtonElement>("[data-button]")!;
  expect(action.textContent).toBe("Undo");
  act(() => action.click());
  expect(onClick).toHaveBeenCalledOnce();
  expect(getToasts()).toHaveLength(0);
});
