// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskInitiativeRef } from "@assistant/shared";
import { TaskInspector } from "./objectInspectors.tsx";

/**
 * The Task inspector names the Initiatives holding the Task, from its full
 * read, as links to their pages with their state; a Task none holds, or one
 * whose read has not answered, has no such section.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const openers = {
  onOpenTask: () => {},
  onOpenProject: () => {},
  onOpenSession: () => {},
  onOpenWorktree: () => {},
  onOpenKnowledge: () => {},
};

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

function show(
  initiatives: TaskInitiativeRef[] | undefined,
  onNavigate = vi.fn(),
): void {
  act(() => {
    root!.render(
      <TaskInspector
        task={{
          id: "7",
          title: "Ship the thing",
          status: "todo",
          source: { createdBy: "user" },
          createdAt: 0,
          updatedAt: 0,
        }}
        sessions={[]}
        openers={openers}
        onStartSession={() => {}}
        initiatives={initiatives}
        onNavigate={onNavigate}
        taskTitle={() => undefined}
      />,
    );
  });
}

it("lists the Initiatives as links with their state", () => {
  const onNavigate = vi.fn();
  show(
    [
      {
        id: "3",
        title: "Hosted Labs",
        state: "paused",
        through: { id: "5", title: "Labs epic" },
      },
    ],
    onNavigate,
  );
  const link = container!.querySelector<HTMLAnchorElement>(
    'a[href="/initiatives/3"]',
  );
  expect(link?.textContent).toBe("Hosted LabsThrough #5 Labs epicPaused");
  act(() => link!.click());
  expect(onNavigate).toHaveBeenCalledWith("/initiatives/3");
});

it("draws no section without Initiatives", () => {
  show(undefined);
  expect(container!.textContent).not.toContain("Initiatives");
  show([]);
  expect(container!.textContent).not.toContain("Initiatives");
});
