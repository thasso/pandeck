// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Harness, SessionCompactionWindow } from "@assistant/shared";
import type { CompactionWindowEdit } from "../hooks/useAssistant.ts";
import { CompactionWindowSection } from "./CompactionWindowSection.tsx";

/**
 * The inspector's compaction window: what is stored, when it applies, and an
 * editor whose slider stays inside the model's range.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

const claude: SessionCompactionWindow = {
  applied: "pending",
  pendingReason: "next-turn",
  tokens: 150_000,
  range: { min: 100_000, max: 1_000_000 },
  effectiveTokens: 150_000,
};

function render(
  window: SessionCompactionWindow,
  options: {
    harness?: Harness;
    edit?: CompactionWindowEdit;
    saved?: Array<number | null>;
    requestId?: string;
    sessionId?: string;
  } = {},
) {
  act(() =>
    root!.render(
      <CompactionWindowSection
        sessionId={options.sessionId ?? "s1"}
        harness={options.harness ?? "claude-sdk"}
        window={window}
        edit={options.edit}
        onSave={(tokens) => {
          options.saved?.push(tokens);
          return options.requestId;
        }}
      />,
    ),
  );
}

function text(): string {
  return container!.textContent ?? "";
}

/** Opens the Window editor; its popover portals into the document. */
function openEditor() {
  const trigger = container!.querySelector<HTMLButtonElement>(
    'button[aria-label^="Compaction window:"]',
  )!;
  act(() => trigger.click());
}

/** Steps the open editor's slider with the keyboard, as a user would. */
function step(key: "ArrowRight" | "ArrowLeft") {
  const thumb = document.querySelector<HTMLInputElement>(
    'input[aria-label="Compaction window"]',
  )!;
  act(() => {
    thumb.focus();
    thumb.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  )!;
  act(() => button.click());
}

it.each([
  "Set to 12,000 tokens: the estimate from pi's default reserve found no range for this model, and this session's pi settings allow it.",
  "Lowered from the 250,000 tokens shown to 200,000 by this session's pi settings.",
])("renders the persisted reconciliation note: %s", (note) => {
  render({ ...claude, note });
  expect(text()).toContain(note);
  render(claude);
  expect(text()).not.toContain(note);
});

it("shows the stored value and when it applies", () => {
  render(claude);
  expect(text()).toContain("150k tokens");
  expect(text()).toContain("Applies on the next turn");
  expect(text()).not.toContain("summaries");
});

it("says a running process keeps its window, and where it compacts", () => {
  render({
    ...claude,
    pendingReason: "process-restart",
    providerTrigger: 967_000,
  });
  expect(text()).toContain("Applies once the session is idle");
  expect(text()).toContain("at about 967k tokens");
});

it("Apply sends the slider's value and Provider default sends null", () => {
  const saved: Array<number | null> = [];
  render(claude, { saved });
  openEditor();
  step("ArrowRight");
  expect(document.body.textContent).toContain("175k tokens");
  click("Apply");
  openEditor();
  click("Provider default");
  expect(saved).toEqual([175_000, null]);
});

it("reopens on the stored value, not an unapplied drag", () => {
  const saved: Array<number | null> = [];
  render(claude, { saved });
  openEditor();
  step("ArrowLeft");
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  openEditor();
  expect(document.body.textContent).toContain("150k tokens");
  click("Apply");
  expect(saved).toEqual([]);
});

it("shows the server's refusal and a failed apply in place", () => {
  render(
    { ...claude, applied: "unknown", applyError: "pi did not take it" },
    { edit: { requestId: "r1", busy: false, error: "Saving failed: disk" } },
  );
  expect(text()).toContain("Saving failed: disk");
  expect(text()).toContain("pi did not take it");
});

it("pi shows the summary-cost note beside the control", () => {
  render(
    {
      applied: "confirmed",
      appliedTokens: null,
      range: { min: 1, max: 255_616 },
    },
    { harness: "pi" },
  );
  expect(text()).toContain("Provider default");
  // Status shows only while a value is not yet applied.
  expect(text()).not.toContain("Applied");
  expect(text()).toContain("compaction summaries");
});
