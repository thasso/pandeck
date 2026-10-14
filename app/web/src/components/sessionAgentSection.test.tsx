// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionContextSections } from "./SessionContextSections.tsx";

/**
 * The inspector's Agent section: what the session froze at spawn, and a way to
 * the definition as the library holds it now.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
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

it("shows the frozen agent and opens its definition by name", () => {
  const opened: string[] = [];
  act(() =>
    root!.render(
      <SessionContextSections
        sessionId="agent-session"
        agent={{
          name: "test-reviewer",
          blob: "0123456789abcdef0123",
          model: "claude-sdk/opus (claude-opus-5-5)",
          effort: "high",
          denyTools: ["worktree_push"],
          skills: [],
        }}
        onOpenAgent={(name) => opened.push(name)}
      />,
    ),
  );
  const text = container!.textContent ?? "";
  expect(text).toContain("claude-sdk/opus (claude-opus-5-5), high effort");
  expect(text).toContain("worktree_push");
  expect(text).toContain("0123456789ab");
  const link = [...container!.querySelectorAll("button")].find(
    (button) => button.textContent === "test-reviewer",
  );
  expect(link).toBeDefined();
  act(() => link!.click());
  expect(opened).toEqual(["test-reviewer"]);
});

it("says an unreadable stored definition refuses to run", () => {
  act(() =>
    root!.render(
      <SessionContextSections
        sessionId="broken-session"
        agent={{ name: "unreadable", unreadable: true }}
      />,
    ),
  );
  expect(container!.textContent).toContain("refuses to run");
});
