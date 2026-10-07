// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { ReactElement } from "react";
import { Button } from "./Button.tsx";
import {
  EmptyBox,
  ErrorNote,
  PaneLoading,
  RefreshIndicator,
  Skeleton,
  Spinner,
} from "./load.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(element));
  return container;
}

it("hides the spinner glyph from assistive tech and animates motion-safely", () => {
  const host = render(<Spinner size="lg" className="text-faint" />);
  const svg = host.querySelector("svg")!;
  expect(svg.getAttribute("aria-hidden")).toBe("true");
  expect(svg.getAttribute("width")).toBe("22");
  expect(svg.getAttribute("class")).toContain("motion-safe:animate-spin");
});

// The transcript's ring: one element, no icon module, the same size tokens as
// the glyph — the reason Task-390 folded it in instead of exempting the two
// blocks that used to hand-build it.
it("draws the ring variant as a single decorative element at the token size", () => {
  const host = render(<Spinner size="sm" variant="ring" />);
  const ring = host.firstElementChild as HTMLElement;
  expect(host.childElementCount).toBe(1);
  expect(ring.tagName).toBe("SPAN");
  expect(ring.querySelector("svg")).toBeNull();
  expect(ring.getAttribute("aria-hidden")).toBe("true");
  expect(ring.style.width).toBe("13px");
  expect(ring.className).toContain("border-t-primary");
  expect(ring.className).toContain("motion-safe:animate-spin");
});

it("announces a pane load and a refresh, and keeps the refresh label sr-only", () => {
  const pane = render(<PaneLoading label="Loading entry…" />);
  const region = pane.querySelector("[role='status']")!;
  expect(region.textContent).toBe("Loading entry…");
  // NEITHER indicator is `aria-busy`, and that is the contract, not an
  // omission: `aria-busy` on a live region lets assistive tech defer the
  // region's output until busy clears, and both of these clear by UNMOUNTING
  // when the data lands — so the announcement they exist for could be dropped.
  // The busy flag goes on the persistent container being swapped
  // (`Inspector`'s body, `QuickRow`'s `busy`). `loadingStateAudit.test.ts`
  // enforces this across the app; R6 in `docs/loading-states.md` states it.
  expect(region.getAttribute("aria-busy")).toBeNull();

  const refresh = render(<RefreshIndicator />);
  const marker = refresh.querySelector("[role='status']")!;
  expect(marker.textContent).toBe("Refreshing");
  expect(marker.querySelector(".sr-only")).not.toBeNull();
  expect(marker.getAttribute("aria-busy")).toBeNull();
});

it("draws a decorative skeleton at the size the caller reserves", () => {
  const host = render(<Skeleton className="h-10 w-full" />);
  const block = host.firstElementChild!;
  expect(block.getAttribute("aria-hidden")).toBe("true");
  expect(block.className).toContain("h-10");
  expect(block.className).toContain("motion-safe:animate-pulse");
});

// A skeleton standing in phrasing content — a meter track inside a card's
// button — has to be a `span` there, at the same geometry.
it("renders as a span on request, keeping the pulse", () => {
  const host = render(<Skeleton as="span" className="block h-full w-full" />);
  const block = host.firstElementChild!;
  expect(block.tagName).toBe("SPAN");
  expect(block.className).toContain("motion-safe:animate-pulse");
});

it("busies only the button, keeping its label and reporting aria-busy", () => {
  const host = render(<Button busy>Save</Button>);
  const button = host.querySelector("button")!;
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.textContent).toBe("Save");
  expect(button.querySelector("svg")).not.toBeNull();
});

it("swaps an icon-only button's icon for the spinner", () => {
  const host = render(
    <Button busy iconOnly aria-label="Refresh">
      <span data-testid="icon" />
    </Button>,
  );
  const button = host.querySelector("button")!;
  expect(button.querySelector("[data-testid='icon']")).toBeNull();
  expect(button.querySelector("svg")).not.toBeNull();
});

it("leaves a button untouched without busy", () => {
  const host = render(<Button>Save</Button>);
  const button = host.querySelector("button")!;
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-busy")).toBeNull();
  expect(button.querySelector("svg")).toBeNull();
});

it("renders the empty state's optional action", () => {
  const host = render(
    <EmptyBox action={<Button size="sm">New task</Button>}>
      No tasks yet.
    </EmptyBox>,
  );
  expect(host.textContent).toBe("No tasks yet.New task");

  const plain = render(<EmptyBox>No tasks yet.</EmptyBox>);
  expect(plain.querySelector("button")).toBeNull();
});

// The variants exist so an empty state can stand where its content would have:
// `box` in place of a pane, `inline` inside a panel section, `item` as a row in
// a horizontal scroller — where a `box`'s height would resize the whole row.
// All three are the same dashed edge, which is the point of having them here
// rather than as three hand-built boxes.
it("gives every empty-state variant the dashed edge and its own geometry", () => {
  const box = render(<EmptyBox>No tasks yet.</EmptyBox>)
    .firstElementChild as HTMLElement;
  expect(box.className).toContain("border-dashed");
  expect(box.className).toContain("text-center");
  expect(box.className).toContain("py-6");

  const inline = render(<EmptyBox variant="inline">No children.</EmptyBox>)
    .firstElementChild as HTMLElement;
  expect(inline.className).toContain("border-dashed");
  expect(inline.className).not.toContain("text-center");
  expect(inline.className).toContain("py-2");

  const item = render(<EmptyBox variant="item">No worktrees</EmptyBox>)
    .firstElementChild as HTMLElement;
  expect(item.className).toContain("border-dashed");
  // A scroller row: it snaps and it does not shrink, like the cards beside it.
  expect(item.className).toContain("snap-start");
  expect(item.className).toContain("shrink-0");
});

// The `item` body stacks its lines; the other two do not need a layout of their
// own, so the wrapper carries no classes and cannot fight the caller's.
it("stacks the item variant's lines and leaves the other bodies bare", () => {
  const item = render(
    <EmptyBox variant="item">
      <span>No worktrees</span>
      <span>in Pandeck</span>
    </EmptyBox>,
  );
  const itemBody = item.firstElementChild!.firstElementChild as HTMLElement;
  expect(itemBody.className).toContain("flex-col");
  expect(itemBody.childElementCount).toBe(2);

  const box = render(<EmptyBox>No tasks yet.</EmptyBox>);
  const boxBody = box.firstElementChild!.firstElementChild as HTMLElement;
  expect(boxBody.getAttribute("class")).toBeNull();
});

it("offers a retry on an error note only when there is something to retry", () => {
  let retries = 0;
  const host = render(
    <ErrorNote message="Refresh failed" onRetry={() => (retries += 1)} />,
  );
  const note = host.querySelector("[role='alert']")!;
  expect(note.textContent).toContain("Refresh failed");
  act(() => {
    note.querySelector("button")!.click();
  });
  expect(retries).toBe(1);

  const plain = render(<ErrorNote message="Refresh failed" />);
  expect(plain.querySelector("button")).toBeNull();
});
