// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DocumentAnchorRegion } from "./DocumentAnchorRegion.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("scrolls to and visibly marks every line in an inclusive range", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  act(() => {
    root.render(
      <DocumentAnchorRegion anchor={{ start: 2, end: 3 }}>
        {[1, 2, 3, 4].map((line) => (
          <span
            key={line}
            data-source-line-start={line}
            data-source-line-end={line}
          >
            line {line}
          </span>
        ))}
      </DocumentAnchorRegion>,
    );
  });
  expect(container.querySelectorAll("[data-document-anchor]")).toHaveLength(2);
  expect(
    container.querySelector('[data-source-line-start="2"]')?.className,
  ).toContain("bg-accent-soft");
  expect(
    container.querySelector('[data-source-line-start="4"]')?.className,
  ).not.toContain("bg-accent-soft");
  expect(scrollIntoView).toHaveBeenCalledOnce();

  act(() => {
    root.render(
      <DocumentAnchorRegion anchor={{ start: 4 }}>
        {[1, 2, 3, 4].map((line) => (
          <span
            key={line}
            data-source-line-start={line}
            data-source-line-end={line}
          >
            line {line}
          </span>
        ))}
      </DocumentAnchorRegion>,
    );
  });
  expect(container.querySelectorAll("[data-document-anchor]")).toHaveLength(1);
  expect(
    container.querySelector('[data-source-line-start="2"]')?.className,
  ).not.toContain("bg-accent-soft");
  expect(
    container.querySelector('[data-source-line-start="4"]')?.className,
  ).toContain("bg-accent-soft");
  act(() => root.unmount());
  container.remove();
});

it("re-marks addressed lines a renderer replaces after the first paint", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  // One anchor object across both renders: a new identity is a new anchor and
  // legitimately scrolls again.
  const anchor = { start: 2 };
  const lines = (generation: number) =>
    [1, 2].map((line) => (
      <span
        key={`${generation}-${line}`}
        data-source-line-start={line}
        data-source-line-end={line}
      >
        line {line}
      </span>
    ));
  act(() => {
    root.render(
      <DocumentAnchorRegion anchor={anchor}>{lines(1)}</DocumentAnchorRegion>,
    );
  });
  expect(container.querySelectorAll("[data-document-anchor]")).toHaveLength(1);

  // New keys, so the addressed line is a NEW element — what a deferred syntax
  // highlight or late content does to a marked row.
  await act(async () => {
    root.render(
      <DocumentAnchorRegion anchor={anchor}>{lines(2)}</DocumentAnchorRegion>,
    );
    await Promise.resolve();
  });
  expect(container.querySelectorAll("[data-document-anchor]")).toHaveLength(1);
  expect(
    container.querySelector('[data-source-line-start="2"]')?.className,
  ).toContain("bg-accent-soft");
  // The reader is not thrown back to the line a second time.
  expect(scrollIntoView).toHaveBeenCalledOnce();
  act(() => root.unmount());
  container.remove();
});
