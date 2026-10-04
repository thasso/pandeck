// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ArrowUpRight, Check, CircleX } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatActivityRow } from "./ChatActivityRow.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
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

function renderRow({ failed = false, onOpenSource = vi.fn() } = {}) {
  act(() =>
    root.render(
      <ChatActivityRow
        icon={ArrowUpRight}
        prefix="To"
        title="Sol"
        href="/sessions/sol"
        onOpenSource={onOpenSource}
        preview="Please review"
        status={{
          label: failed ? "Failed" : "Delivered",
          icon: failed ? CircleX : Check,
          attention: failed,
        }}
      >
        <p data-testid="body">Full message</p>
        {failed ? <p>Session unavailable</p> : null}
      </ChatActivityRow>,
    ),
  );
  return container.querySelector("button")!;
}

describe("ChatActivityRow", () => {
  it("starts collapsed and toggles the full body with a native button", () => {
    const button = renderRow();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="body"]')).toBeNull();
    act(() => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(
      document.getElementById(button.getAttribute("aria-controls")!),
    ).not.toBeNull();
    expect(container.textContent).toContain("Full message");
    act(() => button.click());
    expect(container.querySelector('[data-testid="body"]')).toBeNull();
  });

  it("keeps source navigation separate from expansion", () => {
    const onOpenSource = vi.fn();
    const button = renderRow({ onOpenSource });
    const link = container.querySelector("a")!;
    expect(button.contains(link)).toBe(false);
    expect(link.getAttribute("href")).toBe("/sessions/sol");
    // Transcript paint containment and truncation clip rings outside the box.
    expect(link.classList.contains("focus-visible:ring-inset")).toBe(true);
    expect(button.classList.contains("focus-visible:ring-inset")).toBe(true);
    act(() => link.click());
    expect(onOpenSource).toHaveBeenCalledOnce();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves modified source clicks to the browser", () => {
    const onOpenSource = vi.fn();
    renderRow({ onOpenSource });
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    let preventedByRow = true;
    document.body.addEventListener(
      "click",
      (received) => {
        preventedByRow = received.defaultPrevented;
        // Observe native navigation without asking jsdom to perform it.
        received.preventDefault();
      },
      { once: true },
    );
    act(() => {
      container.querySelector("a")!.dispatchEvent(event);
    });
    expect(onOpenSource).not.toHaveBeenCalled();
    expect(preventedByRow).toBe(false);
  });

  it("reports preview clipping only when the reader opens the row", () => {
    const onExpand = vi.fn();
    act(() =>
      root.render(
        <ChatActivityRow
          icon={ArrowUpRight}
          title="Background"
          preview="Long command"
          onExpand={onExpand}
        >
          <p>Details</p>
        </ChatActivityRow>,
      ),
    );
    const button = container.querySelector("button")!;
    const preview = button.querySelector("span.truncate")!;
    Object.defineProperty(preview, "scrollWidth", { value: 600 });
    Object.defineProperty(preview, "clientWidth", { value: 200 });
    expect(onExpand).not.toHaveBeenCalled();
    act(() => button.click());
    expect(onExpand).toHaveBeenCalledWith(true);
    act(() => button.click());
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("keeps failure visible while collapsed without forcing the row open", () => {
    const button = renderRow();
    renderRow({ failed: true });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).not.toContain("Session unavailable");
    expect(button.getAttribute("aria-label")).toContain("Failed");
  });

  it("does not reset the reader's expansion when status changes", () => {
    const button = renderRow();
    act(() => button.click());
    renderRow({ failed: true });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Session unavailable");
  });
});
