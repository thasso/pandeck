// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type {
  ApprovalCard as ApprovalCardData,
  SettingsInputApprovalBody,
} from "@assistant/shared";
import { ApprovalCard } from "./ApprovalCard.tsx";

/**
 * Settings-input cards (Task-729): the user types a secret or connects an
 * account; the value leaves only inside the approving decision.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

function buttonLabels(): string[] {
  return [...container!.querySelectorAll("button")].map((element) =>
    (element.textContent ?? "").trim(),
  );
}

function click(label: string): void {
  const match = [...container!.querySelectorAll("button")].find(
    (element) => (element.textContent ?? "").trim() === label,
  );
  expect(match, `no button labelled ${label}`).toBeDefined();
  act(() => {
    match!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Type into a controlled input the way a browser does. */
function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

function card(body: Partial<SettingsInputApprovalBody>): ApprovalCardData {
  return {
    renderKind: "approval",
    id: "ap_settings",
    sessionId: "session-1",
    kind: "settingsInput",
    status: "pending",
    title: "Enter Personal access token",
    createdAt: 0,
    body: {
      kind: "settingsInput",
      path: "github.token",
      label: "Personal access token",
      section: "github",
      mode: "secret",
      wasConfigured: false,
      ...body,
    },
  };
}

test("a secret is sent only with the decision and leaves the field", () => {
  const onResolve = vi.fn();
  render(
    <ApprovalCard
      approval={card({ reason: "To read your pull requests." })}
      onResolve={onResolve}
    />,
  );
  expect(container!.textContent).toContain("To read your pull requests.");
  // Its own controls replace the generic footer, and nothing grants it.
  expect(buttonLabels()).toEqual(["Dismiss", "Save"]);

  const input = container!.querySelector<HTMLInputElement>(
    'input[type="password"]',
  )!;
  expect(input.getAttribute("autocomplete")).toBe("off");
  type(input, "  typed-fixture  ");
  click("Save");

  expect(onResolve).toHaveBeenCalledWith("ap_settings", "approved", {
    kind: "settingsInput",
    value: "typed-fixture",
  });
  expect(input.value).toBe("");
});

test("Save waits for a value", () => {
  const onResolve = vi.fn();
  render(<ApprovalCard approval={card({})} onResolve={onResolve} />);
  click("Save");
  expect(onResolve).not.toHaveBeenCalled();
});

test("Dismiss rejects the card", () => {
  const onResolve = vi.fn();
  render(<ApprovalCard approval={card({})} onResolve={onResolve} />);
  click("Dismiss");
  expect(onResolve).toHaveBeenCalledWith("ap_settings", "rejected");
});

test("a connection opens the server's sign-in route", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  render(
    <ApprovalCard
      approval={card({
        path: "google.connection",
        label: "Google account connection",
        section: "google",
        mode: "connect",
      })}
      onResolve={vi.fn()}
    />,
  );
  expect(container!.querySelector("input")).toBeNull();
  click("Connect");
  expect(open).toHaveBeenCalledOnce();
  expect(String(open.mock.calls[0]![0])).toMatch(
    /\/api\/google\/oauth\/start$/,
  );
  expect(buttonLabels()).toContain("Open again");
});

test("a resolved card shows its outcome and no controls", () => {
  render(
    <ApprovalCard
      approval={{
        ...card({}),
        status: "executed",
        resultSummary: "Personal access token saved.",
      }}
    />,
  );
  expect(container!.textContent).toContain("Personal access token saved.");
  expect(container!.querySelector("input")).toBeNull();
  expect(buttonLabels()).toEqual([]);
});
