// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EdgeSheet } from "./common/EdgeSheet.tsx";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Sheet, SheetContent } from "@/components/ui/sheet";

/**
 * Layer regression (see `app/web/docs/ui-shell.md`, "Layers").
 *
 * A `Popover` opened from inside a modal is portaled to the body as a SIBLING
 * of that modal, so its z-index alone decides the paint order. When the panel
 * sat below the modal band it opened behind the dialog's own backdrop:
 * invisible, and swallowing the click that should have picked an option — a
 * failure nothing else catches, because the popover's open/close state is
 * exactly right throughout. These assertions compare the two bands as numbers,
 * on the real components: the panel against every modal surface a picker can be
 * opened from.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** The numeric z-index of a Tailwind `z-50` / `z-[70]` utility on an element. */
function layerOf(element: Element | null | undefined): number {
  const match = /(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/.exec(
    element?.className ?? "",
  );
  expect(match, `no z-index utility on ${element?.className}`).not.toBeNull();
  return Number(match?.[1] ?? match?.[2]);
}

/** The band a portaled `Popover` panel actually paints in, opened for real. */
function openedPopoverLayer(): number {
  act(() =>
    root?.render(
      <Popover defaultOpen>
        <PopoverTrigger>Pick</PopoverTrigger>
        <PopoverContent>An option</PopoverContent>
      </Popover>,
    ),
  );
  const panel = document.querySelector('[data-slot="popover-content"]');
  expect(panel, "popover did not open").toBeTruthy();
  expect(panel?.textContent).toContain("An option");
  return layerOf(panel);
}

// The workflow start flow is a ui/dialog on wide layouts and a bottom ui/sheet
// on phones (`WorkflowRunStartSheet`).
for (const mobile of [false, true]) {
  const layout = mobile ? "full-screen sheet" : "centered dialog";

  it(`paints popover panels above the workflow start surface (${layout})`, () => {
    const panelLayer = openedPopoverLayer();
    act(() =>
      root?.render(
        mobile ? (
          <Sheet open>
            <SheetContent side="bottom">Run workflow</SheetContent>
          </Sheet>
        ) : (
          <Dialog open>
            <DialogContent>Run workflow</DialogContent>
          </Dialog>
        ),
      ),
    );
    const surface = document.querySelector(
      mobile ? '[data-slot="sheet-content"]' : '[data-slot="dialog-content"]',
    );
    expect(surface?.textContent).toContain("Run workflow");
    expect(panelLayer).toBeGreaterThan(layerOf(surface));
  });
}

it("paints popover panels above a modal Sheet", () => {
  const panelLayer = openedPopoverLayer();
  act(() =>
    root?.render(
      <EdgeSheet open title="Chat options" onClose={() => undefined}>
        <div>Sheet body</div>
      </EdgeSheet>,
    ),
  );
  // The sheet's popup carries the modal band.
  const overlay = document.querySelector('[data-slot="sheet-content"]');
  expect(overlay?.textContent).toContain("Sheet body");
  expect(panelLayer).toBeGreaterThan(layerOf(overlay));
});
