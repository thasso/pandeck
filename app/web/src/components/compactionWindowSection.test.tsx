// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Harness, SessionCompactionWindow } from "@assistant/shared";
import type { CompactionWindowEdit } from "../hooks/useAssistant.ts";
import { CompactionWindowSection } from "./CompactionWindowSection.tsx";

/**
 * The inspector's compaction window: what is stored, the range, when it
 * applies, and a save that refuses an out-of-range value before sending.
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

function type(value: string) {
  const input = container!.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(label: string) {
  const button = [...container!.querySelectorAll("button")].find(
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

it("shows the stored value, the range and when it applies", () => {
  render(claude);
  expect(text()).toContain("150,000 tokens");
  expect(text()).toContain("100,000 – 1,000,000 tokens");
  expect(text()).toContain("Applies when the next turn starts");
  expect(text()).not.toContain("summaries");
});

it("says a running process keeps its window, and where it compacts", () => {
  render({
    ...claude,
    pendingReason: "process-restart",
    providerTrigger: 967_000,
  });
  expect(text()).toContain("Applies when this process restarts");
  expect(text()).toContain("about 967,000 tokens");
});

it("Save sends an integer and Clear sends null", () => {
  const saved: Array<number | null> = [];
  render(claude, { saved });
  type("200,000");
  click("Save");
  click("Clear");
  expect(saved).toEqual([200_000, null]);
});

it("refuses an out-of-range value in place without sending", () => {
  const saved: Array<number | null> = [];
  render(claude, { saved });
  type("50000");
  click("Save");
  expect(saved).toEqual([]);
  expect(text()).toContain(
    "The compaction window must be between 100,000 and 1,000,000 tokens.",
  );
});

it("shows the server's refusal and a failed apply in place", () => {
  render(
    { ...claude, applied: "unknown", applyError: "pi did not take it" },
    { edit: { requestId: "r1", busy: false, error: "Saving failed: disk" } },
  );
  expect(text()).toContain("Saving failed: disk");
  expect(text()).toContain("pi did not take it");
});

const inputValue = () => container!.querySelector("input")!.value;

it.each([true, false])(
  "restores exact raw input for its unknown receipt, rendered busy=%s",
  (renderBusy) => {
    render(claude, { requestId: "a" });
    type(" 200_000 ");
    click("Save");
    expect(inputValue()).toBe("");
    if (renderBusy) render(claude, { edit: { requestId: "a", busy: true } });
    render(claude, { edit: { requestId: "a", busy: false, unknown: true } });
    expect(inputValue()).toBe(" 200_000 ");
    expect(container!.querySelector("input")!.disabled).toBe(false);
  },
);

it.each([undefined, "Refused"])(
  "does not restore a known result %s and re-arms manual resubmission",
  (error) => {
    render(claude, { requestId: "a" });
    type("200000");
    click("Save");
    render(claude, {
      requestId: "b",
      edit: { requestId: "a", busy: false, ...(error ? { error } : {}) },
    });
    expect(inputValue()).toBe("");
    type("250,000");
    click("Save");
    render(claude, { edit: { requestId: "b", busy: false, unknown: true } });
    expect(inputValue()).toBe("250,000");
  },
);

it.each([
  "typing",
  "clear",
  "different request",
  "session",
  "unmount",
  "untracked",
])("does not revive a draft after %s", (interaction) => {
  render(claude, interaction === "untracked" ? {} : { requestId: "a" });
  type("200000");
  click("Save");
  if (interaction === "typing") type("300000");
  if (interaction === "clear") {
    type("300000");
    click("Clear");
  }
  if (interaction === "different request")
    render(claude, { edit: { requestId: "other", busy: true } });
  if (interaction === "session") {
    render(claude, { sessionId: "s2" });
    render(claude, { sessionId: "s1" });
  }
  if (interaction === "unmount") {
    act(() => root!.unmount());
    root = createRoot(container!);
  }
  render(claude, { edit: { requestId: "a", busy: false, unknown: true } });
  expect(inputValue()).toBe(
    interaction === "typing" || interaction === "clear" ? "300000" : "",
  );
});

it("a newer submission owns recovery and Clear leaves existing input alone", () => {
  render(claude, { requestId: "a" });
  type("200000");
  click("Save");
  render(claude, { requestId: "b" });
  type("300_000");
  click("Save");
  render(claude, { edit: { requestId: "b", busy: false, unknown: true } });
  expect(inputValue()).toBe("300_000");
  click("Clear");
  render(claude, { edit: { requestId: "clear", busy: false, unknown: true } });
  expect(inputValue()).toBe("300_000");
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
  expect(text()).toContain("Applied");
  expect(text()).toContain("compaction summaries");
});
