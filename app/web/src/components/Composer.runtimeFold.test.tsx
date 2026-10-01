// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ModelOption, SessionState } from "@assistant/shared";
import type { AssistantActions } from "../hooks/useAssistant.ts";
import { Composer } from "./Composer.tsx";

/**
 * The bottom row folds its runtime pickers by MEASUREMENT, and jsdom measures
 * everything as 0. These stubs give the four marked boxes
 * (`data-composer-fit`) a width, so the fold can be exercised the way a
 * squeezed desktop composer exercises it: same DOM, different budget.
 */
const widths = { row: 900, lead: 32, trail: 160, runtime: 320 };

function markedWidth(element: HTMLElement): number | null {
  const mark = element.dataset.composerFit;
  if (!mark || !(mark in widths)) return null;
  return widths[mark as keyof typeof widths];
}

/**
 * The pills draw narrower below Tailwind's `sm` (a tighter model cap, the short
 * thinking label), so the media query is a width input like any other. jsdom
 * has no media-query engine: this stub is one the test can flip and notify.
 */
const WIDE_LABEL_MEDIA = "(min-width: 40rem)";
let wideLabels = true;
const mediaListeners = new Set<() => void>();

function setLabelPresentation(wide: boolean, stripWidth: number) {
  wideLabels = wide;
  widths.runtime = stripWidth;
  act(() => {
    for (const listener of [...mediaListeners]) listener();
  });
}

beforeAll(() => {
  for (const property of ["clientWidth", "offsetWidth"] as const) {
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      get(this: HTMLElement) {
        return markedWidth(this) ?? 0;
      },
    });
  }
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === WIDE_LABEL_MEDIA ? wideLabels : false;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => {
      if (query === WIDE_LABEL_MEDIA) mediaListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      mediaListeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

const model: ModelOption = {
  provider: "anthropic",
  id: "claude-opus-5",
  name: "Opus 5",
} as ModelOption;

const session = {
  id: "s-1",
  harness: "pi",
  agentType: "developer",
  model,
  thinkingLevel: "high",
  mode: "build",
} as unknown as SessionState;

const actions = {
  setModel: () => {},
  setThinkingLevel: () => {},
  setSessionMode: () => {},
} as unknown as AssistantActions;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  widths.row = 900;
  widths.runtime = 320;
  wideLabels = true;
  mediaListeners.clear();
  window.localStorage.clear();
});

function render() {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() =>
    root!.render(
      <Composer
        onSend={() => {}}
        onAbort={() => {}}
        streaming={false}
        disabled={false}
        contextInfo={null}
        session={session}
        models={[model]}
        slashCommands={[]}
        actions={actions}
      />,
    ),
  );
}

/** Re-render the mounted composer so it re-measures against the new widths. */
const relayout = render;

const strip = () =>
  container?.querySelector('[data-composer-fit="runtime"]') ?? null;
const sheetTrigger = () =>
  container?.querySelector<HTMLButtonElement>(
    'button[aria-label^="Runtime settings"]',
  ) ?? null;

describe("Composer runtime fold", () => {
  it("keeps the pickers inline while the row can hold them", () => {
    render();

    expect(strip()).not.toBeNull();
    expect(strip()?.textContent).toContain("Build");
    expect(strip()?.textContent).toContain("Opus 5");
    expect(sheetTrigger()).toBeNull();
  });

  it("folds them into the Runtime trigger once the row cannot", () => {
    widths.row = 400;
    render();

    expect(strip()).toBeNull();
    expect(sheetTrigger()?.textContent).toContain("Opus 5");
  });

  it("brings them back inline when the room returns", () => {
    widths.row = 400;
    render();
    expect(strip()).toBeNull();

    widths.row = 900;
    relayout();

    expect(strip()).not.toBeNull();
    expect(sheetTrigger()).toBeNull();
  });

  it("re-measures when the pills change presentation while folded", () => {
    // Folded at the wide presentation: 32 + 4 + 320 + 8 + 160 is past 420.
    widths.row = 420;
    render();
    expect(strip()).toBeNull();

    // Below `sm` the same pickers draw narrower and now fit — but the strip is
    // gone, so nothing can re-measure it unless the mode invalidates the width
    // the fold remembered.
    setLabelPresentation(false, 200);

    expect(strip()).not.toBeNull();
    expect(sheetTrigger()).toBeNull();
  });

  it("folds again when the pills widen back while inline", () => {
    widths.row = 420;
    widths.runtime = 200;
    wideLabels = false;
    render();
    expect(strip()).not.toBeNull();

    setLabelPresentation(true, 320);

    expect(strip()).toBeNull();
    expect(sheetTrigger()).not.toBeNull();
  });
});
