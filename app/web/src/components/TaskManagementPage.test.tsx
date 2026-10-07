// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskItem } from "@assistant/shared";
import type { AssistantActions, UIState } from "../hooks/useAssistant.ts";
import type { Prefs } from "../hooks/usePrefs.ts";
import { ALL_PROJECT_FILTER } from "../lib/backlogTreeModel.ts";
import { TaskManagementPage } from "./TaskManagementPage.tsx";
import { failed, loading, ready, type LoadState } from "../lib/loadState.ts";

/**
 * The Task page's two R1 gates (`app/web/docs/loading-states.md`): the detail
 * pane must not answer a Task route with "select a task" while the list that
 * carries it is still cold, and the description must not print the word
 * "Loading" where the body will be.
 */

if (!window.matchMedia)
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

beforeEach(() => window.localStorage.clear());

const prefs = {
  backlogView: "backlog",
  backlogViewMode: "normal",
  backlogProjectFilter: ALL_PROJECT_FILTER,
  backlogStatusFilter: ["todo", "doing", "done"],
  backlogMasterWidth: 360,
} as Prefs;

function task(patch: Partial<TaskItem> = {}): TaskItem {
  return {
    id: "7",
    title: "Ship the thing",
    status: "todo",
    source: { createdBy: "user" },
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as TaskItem;
}

interface PageOptions {
  items: TaskItem[] | null;
  selectedId: string | null;
  taskDetails?: Record<string, TaskItem>;
  taskMutations?: Record<string, LoadState<true>>;
  saveTask?: AssistantActions["saveTask"];
}

function render(options: PageOptions): string {
  return renderToStaticMarkup(page(options));
}

function page(options: PageOptions) {
  const state = {
    connected: true,
    taskList: options.items ? { items: options.items, updatedAt: 1 } : null,
    projectList: null,
    sessions: [],
    worktreeMerge: {},
    workflowRuns: [],
    workflowCards: {},
    taskMutations: {},
    taskProjectsAssignedSeq: 0,
  } as unknown as UIState;
  return (
    <TaskManagementPage
      backlogState={state}
      connected
      detailState={
        options.selectedId && options.taskDetails?.[options.selectedId]
          ? ready(options.taskDetails[options.selectedId]!)
          : undefined
      }
      commentsState={ready([])}
      workflowRuns={[]}
      workflowCards={{}}
      sessions={[]}
      taskMutations={options.taskMutations ?? {}}
      actions={
        // Every other action is a no-op; a live mount calls several on open.
        new Proxy(
          { saveTask: options.saveTask },
          {
            get: (target, name) =>
              target[name as keyof typeof target] ?? (() => {}),
          },
        ) as unknown as AssistantActions
      }
      prefs={prefs}
      onUpdatePrefs={() => {}}
      selectedId={options.selectedId}
      onSelect={() => {}}
      onCloseDetail={() => {}}
      onClose={() => {}}
      onOpenSession={() => {}}
    />
  );
}

describe("TaskManagementPage detail pane", () => {
  it("holds the pane for a selected Task while the list is still cold", () => {
    const html = render({ items: null, selectedId: "7" });
    expect(html).not.toContain("Select a task to see its details.");
    expect(html).toContain("Loading Task…");
  });

  it("keeps 'select a task' for the genuinely unselected pane", () => {
    // No id in the route is IDLE, not loading: nothing was asked for.
    expect(render({ items: null, selectedId: null })).toContain(
      "Select a task to see its details.",
    );
    expect(render({ items: [], selectedId: null })).toContain(
      "Select a task to see its details.",
    );
  });
});

describe("TaskManagementPage description", () => {
  it("reserves the body's lines when there is no preview to stand in", () => {
    const html = render({ items: [task()], selectedId: "7" });
    expect(html).not.toContain("Loading…");
    expect(html).not.toContain("No description yet.");
    expect(html).toContain('aria-label="Loading description"');
  });

  it("prefers the summary's preview over a placeholder", () => {
    const html = render({
      items: [task({ descriptionPreview: "the first line of the body" })],
      selectedId: "7",
    });
    expect(html).toContain("the first line of the body");
    expect(html).toContain('aria-label="Loading description"');
  });

  it("says there is no description only once the body has arrived", () => {
    const html = render({
      items: [task()],
      selectedId: "7",
      taskDetails: { "7": task({ description: "" }) },
    });
    expect(html).toContain("No description yet.");
    expect(html).not.toContain('aria-label="Loading description"');
  });
});

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(el: Element, init: KeyboardEventInit) {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

function buttonNamed(container: HTMLElement, name: string) {
  return [...container.querySelectorAll("button")].find(
    (el) =>
      el.getAttribute("aria-label") === name || el.textContent?.trim() === name,
  );
}

/**
 * The editors keep the draft until the correlated `saveTask` succeeds: pending
 * busies Save and refuses a second save, a refusal shows its error with a
 * retry, and only a success closes.
 */
describe("TaskManagementPage edits", () => {
  async function mount(base: PageOptions) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const rerender = (taskMutations: Record<string, LoadState<true>>) =>
      act(async () => root.render(page({ ...base, taskMutations })));
    await rerender({});
    return {
      container,
      rerender,
      async unmount() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  it("keeps a failed rename open with its draft and error, closing on success", async () => {
    const saveTask = vi.fn();
    const view = await mount({ items: [task()], selectedId: "7", saveTask });
    try {
      await act(async () =>
        buttonNamed(view.container, "Rename task")!.click(),
      );
      const input = view.container.querySelector<HTMLInputElement>(
        'input[aria-label="Task title"]',
      )!;
      expect(document.activeElement).toBe(input);
      await type(input, "Ship it  ");
      await key(input, { key: "Enter" });
      expect(saveTask).toHaveBeenCalledTimes(1);
      expect(saveTask).toHaveBeenLastCalledWith(
        { id: "7", title: "Ship it", status: "todo" },
        "rename",
      );

      await view.rerender({ "7:rename": loading() });
      const save = buttonNamed(view.container, "Save")!;
      expect(save.getAttribute("aria-busy")).toBe("true");
      await key(input, { key: "Enter" });
      expect(saveTask).toHaveBeenCalledTimes(1);

      await view.rerender({ "7:rename": failed("Title refused") });
      expect(input.isConnected).toBe(true);
      expect(input.value).toBe("Ship it  ");
      expect(view.container.textContent).toContain("Title refused");
      await act(async () => buttonNamed(view.container, "Retry")!.click());
      expect(saveTask).toHaveBeenCalledTimes(2);

      await view.rerender({ "7:rename": loading() });
      await view.rerender({ "7:rename": ready(true) });
      expect(
        view.container.querySelector('input[aria-label="Task title"]'),
      ).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it("edits the description with Escape and Cmd/Ctrl+Enter, holding it while pending", async () => {
    const saveTask = vi.fn();
    const view = await mount({
      items: [task()],
      selectedId: "7",
      taskDetails: { "7": task({ description: "Body" }) },
      saveTask,
    });
    const textarea = () =>
      view.container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Task description"]',
      );
    try {
      const edit = buttonNamed(view.container, "Edit description")!;
      await act(async () => edit.click());
      expect(document.activeElement).toBe(textarea());
      await type(textarea()!, "Discarded");
      await key(textarea()!, { key: "Escape" });
      expect(textarea()).toBeNull();
      expect(saveTask).not.toHaveBeenCalled();

      await act(async () => edit.click());
      expect(textarea()!.value).toBe("Body");
      await type(textarea()!, "New body\n\n");
      await key(textarea()!, { key: "Enter", ctrlKey: true });
      expect(saveTask).toHaveBeenLastCalledWith(
        { id: "7", status: "todo", description: "New body" },
        "description",
      );

      await view.rerender({ "7:description": loading() });
      expect(textarea()).not.toBeNull();
      expect(buttonNamed(view.container, "Save")!.disabled).toBe(true);

      await view.rerender({ "7:description": failed("Too long") });
      expect(textarea()!.value).toBe("New body\n\n");
      expect(view.container.textContent).toContain("Too long");

      await act(async () => buttonNamed(view.container, "Retry")!.click());
      await view.rerender({ "7:description": loading() });
      await view.rerender({ "7:description": ready(true) });
      expect(textarea()).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
