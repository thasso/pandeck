// @vitest-environment jsdom
/**
 * The "Continue on <model>" failure note: the default model is the action,
 * the click spins only its own button while the answer is out, and nothing is
 * continued without a click (`docs/session-runtime-switching.md`).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionContinueChoice } from "@assistant/shared";
import { ContinueOnNote } from "./ContinueOnNote.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const SOL: SessionContinueChoice = {
  provider: "openai-codex",
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  thinkingLevel: "high",
};
const MINI: SessionContinueChoice = { ...SOL, id: "mini", name: "GPT Mini" };

function render(busy: boolean) {
  const onContinue = vi.fn();
  const onDismiss = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <ContinueOnNote
        message="You've hit your usage limit."
        choices={[SOL, MINI]}
        busy={busy}
        onContinue={onContinue}
        onDismiss={onDismiss}
      />,
    ),
  );
  return { container, onContinue, onDismiss };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (element) =>
      (element.textContent ?? "").trim() === label ||
      element.getAttribute("aria-label") === label,
  );
  expect(match, `no button labelled ${label}`).toBeDefined();
  return match as HTMLButtonElement;
}

it("shows the failure with the default model as its action, and continues only on a click", () => {
  const { container, onContinue, onDismiss } = render(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "You've hit your usage limit.",
  );
  expect(onContinue).not.toHaveBeenCalled();
  act(() => button(container, "Continue on GPT-5.6 Sol").click());
  expect(onContinue).toHaveBeenCalledWith(SOL);
  act(() => button(container, "Dismiss").click());
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("spins the pressed action while its answer is out and keeps the failure in view", () => {
  const { container } = render(true);
  const action = button(container, "Continue on GPT-5.6 Sol");
  expect(action.getAttribute("aria-busy")).toBe("true");
  expect(action.disabled).toBe(true);
  expect(button(container, "Continue on another model").disabled).toBe(true);
  expect(button(container, "Dismiss").disabled).toBe(true);
  expect(container.textContent).toContain("You've hit your usage limit.");
});
