// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectRecord, SessionListItem } from "@assistant/shared";
import type { Task } from "../lib/backlogTree.ts";
import { BacklogFocusList } from "./BacklogFocusList.tsx";

/**
 * What a Focus ROW does with a click, now that it is a plain click surface with
 * an anchor title, links on line 2 and two buttons of its own rather than one
 * `<button>` around the whole body. Every failure here is silent: a control that
 * forgets to stop the click still does its own job, and ALSO opens the Task
 * behind it — which on a phone means the list you were triaging is gone.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const TODAY = "2026-08-06";

function task(patch: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${patch.id}`,
    status: "todo",
    source: { createdBy: "user" },
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as Task;
}

function session(patch: Partial<SessionListItem> & { id: string }) {
  return {
    title: "Session",
    agentType: "claude",
    updatedAt: 0,
    messageCount: 1,
    ...patch,
  } as SessionListItem;
}

interface Recorded {
  opened: string[];
  cycled: string[];
  navigated: string[];
  accepted: string[];
  dismissed: string[];
}

function render(
  tasks: Task[],
  options: {
    sessions?: SessionListItem[];
    projects?: ProjectRecord[];
    navigate?: boolean;
  } = {},
): Recorded {
  const recorded: Recorded = {
    opened: [],
    cycled: [],
    navigated: [],
    accepted: [],
    dismissed: [],
  };
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  act(() => {
    root!.render(
      <BacklogFocusList
        tasks={tasks}
        today={TODAY}
        projectsById={
          new Map((options.projects ?? []).map((item) => [item.id, item]))
        }
        sessionById={
          new Map((options.sessions ?? []).map((item) => [item.id, item]))
        }
        showProjectBadge
        selectedId={null}
        onOpen={(id) => recorded.opened.push(id)}
        onCycle={(item) => recorded.cycled.push(item.id)}
        onAcceptSuggestion={(item) => recorded.accepted.push(item.id)}
        onDismissSuggestion={(item) => recorded.dismissed.push(item.id)}
        onNavigate={
          options.navigate === false
            ? undefined
            : (path) => recorded.navigated.push(path)
        }
        density="comfortable"
      />,
    );
  });
  return recorded;
}

function clickOn(element: Element): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function link(href: string): HTMLAnchorElement {
  const found = container!.querySelector<HTMLAnchorElement>(
    `a[href="${href}"]`,
  );
  if (!found) throw new Error(`no link to ${href}`);
  return found;
}

describe("BacklogFocusList rows", () => {
  it("follows a line-2 link without also opening the Task", () => {
    const recorded = render(
      [
        task({
          id: "1",
          projectId: "p1",
          sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
        }),
      ],
      {
        sessions: [session({ id: "s1", worktreeId: "wt1" })],
        projects: [{ id: "p1", key: "PA", name: "Pandeck" } as ProjectRecord],
      },
    );

    const event = clickOn(link("/sessions/s1"));
    expect(recorded.navigated).toEqual(["/sessions/s1"]);
    expect(event.defaultPrevented).toBe(true);
    // The row is a click surface: without the link's `stopPropagation` this
    // would have opened the Task behind the session it just went to.
    expect(recorded.opened).toEqual([]);

    clickOn(link("/worktrees/wt1"));
    clickOn(link("/projects/p1"));
    expect(recorded.navigated).toEqual([
      "/sessions/s1",
      "/worktrees/wt1",
      "/projects/p1",
    ]);
    expect(recorded.opened).toEqual([]);
  });

  it("makes the title the anchor that opens the Task", () => {
    // The row carries links, so it may not be a `role="button"` (that would make
    // every one of them presentational). The title is the named target instead —
    // and it opens in-app rather than reloading the page.
    const recorded = render([task({ id: "1" })]);
    const title = link("/tasks/1");
    expect(title.textContent).toBe("Task 1");
    expect(container!.querySelector('[role="button"]')).toBeNull();

    const event = clickOn(title);
    expect(recorded.opened).toEqual(["1"]);
    expect(event.defaultPrevented).toBe(true);
    // The id badge leads to the same place, and is its own link.
    expect(container!.querySelectorAll('a[href="/tasks/1"]').length).toBe(2);
  });

  it("opens the Task from anywhere else on the row", () => {
    const recorded = render([task({ id: "1" })]);
    const row = container!.querySelector<HTMLElement>(
      "[data-list-row-id] > div",
    )!;
    clickOn(row);
    expect(recorded.opened).toEqual(["1"]);
  });

  it("cycles the status without opening the Task", () => {
    const recorded = render([task({ id: "1" })]);
    const status = container!.querySelector<HTMLElement>(
      'button[aria-label^="Status:"]',
    )!;
    clickOn(status);
    expect(recorded.cycled).toEqual(["1"]);
    expect(recorded.opened).toEqual([]);
  });

  it("answers a suggestion without opening the Task", () => {
    // The whole point of answering it ON the row is not making it a trip into
    // the detail — which is exactly what a click that also opened would be.
    const recorded = render([
      task({ id: "1", statusSuggestion: { to: "done", at: 0 } }),
    ]);
    const claim = (prefix: string) =>
      [...container!.querySelectorAll<HTMLElement>("button")].find((button) =>
        button.getAttribute("aria-label")?.startsWith(prefix),
      )!;
    clickOn(claim("Confirm"));
    clickOn(claim("Disagree"));
    expect(recorded.accepted).toEqual(["1"]);
    expect(recorded.dismissed).toEqual(["1"]);
    expect(recorded.opened).toEqual([]);
  });

  it("states line 2 as text where the host cannot navigate", () => {
    const recorded = render([task({ id: "1", projectId: "p1" })], {
      navigate: false,
      projects: [{ id: "p1", key: "PA", name: "Pandeck" } as ProjectRecord],
    });
    // The TITLE is still an anchor — it opens the Task through the list's own
    // `onOpen` and needs no navigator — but nothing on line 2 is.
    expect(
      [...container!.querySelectorAll("a")].map((a) => a.textContent),
    ).toEqual(["Task 1"]);
    expect(container!.textContent).toContain("#1");
    expect(container!.textContent).toContain("PA");
    expect(recorded.navigated).toEqual([]);
  });
});
