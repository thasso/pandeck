// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useInertOverflow } from "./useInertOverflow.ts";

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

function Row({ tick }: { tick: number }) {
  const ref = useInertOverflow<HTMLDivElement>();
  return (
    <div ref={ref} data-tick={tick}>
      <button type="button">first</button>
      <button type="button">second</button>
    </div>
  );
}

function render(tick: number) {
  container ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(container);
  act(() => root!.render(<Row tick={tick} />));
  return container.firstElementChild as HTMLElement;
}

/** jsdom has no layout, so the geometry a browser would compute is stubbed. */
function layout(row: HTMLElement, height: number, childTops: number[]) {
  Object.defineProperty(row, "clientHeight", {
    configurable: true,
    value: height,
  });
  row.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  Array.from(row.children).forEach((child, index) => {
    child.getBoundingClientRect = () =>
      ({ top: childTops[index] ?? 100 }) as DOMRect;
  });
}

/** A stand-in the test can fire, since jsdom has no ResizeObserver. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed = new Set<Element>();
  constructor(private readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.add(target);
  }
  disconnect() {
    this.observed.clear();
  }
  fire() {
    this.callback();
  }
}

describe("useInertOverflow", () => {
  it("makes only the children on the hidden second line inert", () => {
    const row = render(0);
    layout(row, 20, [100, 136]);
    render(1);
    const [first, second] = Array.from(row.children) as HTMLElement[];
    expect(first?.inert).toBe(false);
    expect(second?.inert).toBe(true);

    // Room again: the control comes back into the tab order.
    layout(row, 20, [100, 100]);
    render(2);
    expect(second?.inert).toBe(false);
  });

  it("leaves every child reachable while the row has no layout", () => {
    const row = render(0);
    layout(row, 0, [100, 136]);
    render(1);
    for (const child of Array.from(row.children) as HTMLElement[])
      expect(child.inert).toBeFalsy();
  });

  it("re-measures when a child grows while the row keeps its size", () => {
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver =
      FakeResizeObserver as unknown as typeof ResizeObserver;
    try {
      const row = render(0);
      const observer = FakeResizeObserver.instances.at(-1)!;
      const [, second] = Array.from(row.children) as HTMLElement[];
      // Children are observed, not only the row.
      expect(observer.observed.has(second!)).toBe(true);

      // A larger text scale: same row box, the second child wraps. No commit.
      layout(row, 20, [100, 136]);
      observer.fire();
      expect(second?.inert).toBe(true);

      // Back to the smaller scale: it fits and is reachable again.
      layout(row, 20, [100, 100]);
      observer.fire();
      expect(second?.inert).toBe(false);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});
