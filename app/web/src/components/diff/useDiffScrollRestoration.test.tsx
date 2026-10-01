// @vitest-environment jsdom
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useDiffScrollRestoration } from "./useDiffScrollRestoration.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function FakeDiffHost({ version }: { version: number }) {
  const setHost = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const shadow = element.attachShadow({ mode: "open" });
    for (const side of ["deletions", "additions"] as const) {
      const code = document.createElement("code");
      code.setAttribute("data-code", "");
      code.setAttribute(`data-${side}`, "");
      shadow.append(code);
    }
  }, []);
  return <div key={version} ref={setHost} className="app-diff-host" />;
}

function Surface({ version }: { version: number }) {
  const [surfaceRoot, setSurfaceRoot] = useState<HTMLDivElement | null>(null);
  useDiffScrollRestoration(surfaceRoot);
  return (
    <div data-viewport style={{ overflow: "auto" }}>
      <div ref={setSurfaceRoot}>
        <FakeDiffHost version={version} />
      </div>
    </div>
  );
}

function render(version: number) {
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  act(() => root!.render(<Surface version={version} />));
  const viewport = container.querySelector<HTMLElement>("[data-viewport]")!;
  const host = container.querySelector<HTMLElement>(".app-diff-host")!;
  const panes = () =>
    Array.from(host.shadowRoot!.querySelectorAll<HTMLElement>("[data-code]"));
  return { viewport, host, panes };
}

function userScroll(
  element: HTMLElement,
  left: number,
  top = element.scrollTop,
) {
  element.scrollLeft = left;
  element.scrollTop = top;
  element.dispatchEvent(new Event("scroll"));
}

describe("useDiffScrollRestoration", () => {
  it("preserves the outer viewport and each shadow-root horizontal pane across remounts", () => {
    let view = render(1);
    const [deletions, additions] = view.panes();

    act(() => {
      userScroll(view.viewport, 14, 180);
      userScroll(deletions!, 47);
      userScroll(additions!, 83);
    });

    view = render(2);
    const [nextDeletions, nextAdditions] = view.panes();
    expect(view.viewport.scrollLeft).toBe(14);
    expect(view.viewport.scrollTop).toBe(180);
    expect(nextDeletions!.scrollLeft).toBe(47);
    expect(nextAdditions!.scrollLeft).toBe(83);
  });

  it("restores a code pane replaced asynchronously during a pierre render", async () => {
    const view = render(1);
    const [, additions] = view.panes();
    act(() => userScroll(additions!, 72));

    const replacement = document.createElement("code");
    replacement.setAttribute("data-code", "");
    replacement.setAttribute("data-additions", "");
    await act(async () => {
      additions!.replaceWith(replacement);
      await Promise.resolve();
    });

    expect(replacement.scrollLeft).toBe(72);
  });
});
