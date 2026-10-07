// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AccountModelOption } from "@assistant/shared";
import { Popover } from "./Popover.tsx";
import { EdgeSheet } from "./ui/EdgeSheet.tsx";
import { WorkflowRunStartLayer } from "./WorkflowRunStartSheet.tsx";

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

const models: AccountModelOption[] = [
  {
    provider: "claude-sdk",
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high"],
    contextWindow: 200_000,
    credentialProfileId: "acc-1",
    accountName: "Main",
  },
  {
    provider: "claude-sdk",
    id: "claude-haiku-4-5",
    name: "Claude Haiku",
    reasoning: false,
    supportedThinkingLevels: ["off"],
    contextWindow: 200_000,
    credentialProfileId: "acc-1",
    accountName: "Main",
  },
];

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
      <Popover title="Picker" button={<span>Pick</span>}>
        {() => <div>An option</div>}
      </Popover>,
    ),
  );
  const trigger = container?.querySelector<HTMLButtonElement>(
    'button[title="Picker"]',
  );
  expect(trigger, "no popover trigger").toBeTruthy();
  act(() => trigger?.click());
  const panel = document.querySelector<HTMLElement>("[data-popover-panel]");
  expect(panel, "popover did not open").toBeTruthy();
  expect(panel?.textContent).toContain("An option");
  return layerOf(panel);
}

function renderWorkflowStartLayer(mobile: boolean): void {
  const none = () => undefined;
  act(() =>
    root?.render(
      <WorkflowRunStartLayer
        mobile={mobile}
        task={{ id: "42", title: "Add the widget" }}
        models={models}
        roles={{
          coordinator: {
            model: models[0],
            thinkingLevel: "low",
            family: "claude",
            notes: "",
          },
          sets: {
            implementer: [
              {
                model: models[0],
                thinkingLevel: "medium",
                family: "claude",
                notes: "",
              },
            ],
            reviewer: [
              {
                model: models[0],
                thinkingLevel: "medium",
                family: "claude",
                notes: "",
              },
            ],
            fixer: [],
            verdict: [],
          },
        }}
        limits={{ maxIterations: 3, maxReviewPasses: 1 }}
        overrides={{ implementer: "", reviewer: "" }}
        pending={false}
        onChangeRole={none}
        onAddConfiguration={none}
        onRemoveConfiguration={none}
        onChangeLimits={none}
        onChangeOverride={none}
        onResetDefaults={none}
        onStart={none}
        onClose={none}
        onContinueInBackground={none}
      />,
    ),
  );
}

for (const mobile of [false, true]) {
  const layout = mobile ? "full-screen flow" : "centered dialog";

  it(`paints popover panels above the workflow start sheet (${layout})`, () => {
    const panelLayer = openedPopoverLayer();
    renderWorkflowStartLayer(mobile);
    expect(panelLayer).toBeGreaterThan(layerOf(container?.firstElementChild));
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
  // The sheet's own overlay is what carries the band; the dialog card sits in it.
  const overlay = document.querySelector('[role="dialog"]')?.parentElement;
  expect(overlay?.textContent).toContain("Sheet body");
  expect(panelLayer).toBeGreaterThan(layerOf(overlay));
});
