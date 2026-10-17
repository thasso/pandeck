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
  onSelect?: (id: string) => void;
  onNavigate?: (path: string) => void;
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
      workflowRuns={[]}
      workflowCards={{}}
      sessions={[]}
      accountNames={{}}
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
      onSelect={options.onSelect ?? (() => {})}
      {...(options.onNavigate ? { onNavigate: options.onNavigate } : {})}
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

describe("TaskManagementPage status provenance", () => {
  const claim = {
    to: "done" as const,
    at: 5,
    sessionId: "sess-1",
    reason:
      "Verified with **full suite** and `pnpm test` — [results](https://example.test/run)",
  };

  it("says an agent set the current status, why, and links its session", () => {
    const done = task({ status: "done", statusSuggestion: claim });
    const html = render({
      items: [done],
      selectedId: "7",
      taskDetails: { "7": done },
    });
    expect(html).toContain("Set done by agent");
    expect(html).toContain("<strong>full suite</strong>");
    expect(html).toContain("<code>pnpm test</code>");
    expect(html).toContain('href="https://example.test/run"');
    expect(html).toContain('href="/sessions/sess-1"');
    // Answered: no suggestion card asking the user to decide.
    expect(html).not.toContain("Mark done");
  });

  it("shows a pending suggestion as a question, not as provenance", () => {
    const pending = task({ status: "todo", statusSuggestion: claim });
    const html = render({
      items: [pending],
      selectedId: "7",
      taskDetails: { "7": pending },
    });
    expect(html).not.toContain("by agent");
    expect(html).toContain("Mark done");
  });
});

describe("TaskManagementPage links", () => {
  const blockerLinks = {
    blockedBy: [
      {
        id: "3",
        title: "Open blocker",
        status: "doing" as const,
        archived: false,
      },
      {
        id: "4",
        title: "Done blocker",
        status: "done" as const,
        archived: false,
      },
    ],
    blocks: [],
    relates: [
      {
        id: "5",
        title: "Shelved sibling",
        status: "todo" as const,
        archived: true,
      },
    ],
  };

  it("lists the full Task's links and says it is blocked", () => {
    const html = render({
      items: [task({ openBlockerCount: 1 })],
      selectedId: "7",
      taskDetails: {
        "7": task({
          description: "Body",
          openBlockerCount: 1,
          blocked: true,
          links: blockerLinks,
        }),
      },
    });
    expect(html).toContain('aria-label="Links"');
    expect(html).toContain('aria-label="Blocked by"');
    expect(html).toContain('aria-label="Related"');
    // Nothing blocks on this Task, so there is no Blocks group.
    expect(html).not.toContain('aria-label="Blocks"');
    expect(html).toContain("Open blocker");
    expect(html).toContain("Shelved sibling");
    expect(html).toContain('aria-label="Blocked by 1 open task"');
    expect(html).toContain("Blocked · 1");
  });

  it("draws neither while the body is loading or when there is nothing to say", () => {
    const loadingHtml = render({ items: [task()], selectedId: "7" });
    expect(loadingHtml).not.toContain('aria-label="Links"');

    const html = render({
      items: [task()],
      selectedId: "7",
      taskDetails: { "7": task({ description: "Body" }) },
    });
    expect(html).not.toContain('aria-label="Links"');
    expect(html).not.toContain("Blocked");
  });

  it("opens a linked Task on its route", async () => {
    const onSelect = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          page({
            items: [task()],
            selectedId: "7",
            taskDetails: {
              "7": task({ description: "Body", links: blockerLinks }),
            },
            onSelect,
          }),
        ),
      );
      const row = [
        ...container.querySelectorAll('[aria-label="Links"] button'),
      ].find((button) => button.textContent?.includes("Done blocker"));
      await act(async () => (row as HTMLButtonElement).click());
      expect(onSelect).toHaveBeenCalledWith("4");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

/**
 * The Initiatives holding the Task come with its full read, like its links,
 * and an open page follows that read: a membership change bumps the Task's
 * revision, the body is read again, and the page shows the new list.
 */
describe("TaskManagementPage Initiatives", () => {
  const epic = task({ id: "5", title: "Renamed epic" });

  it("lists each Initiative as a link with its state and the ancestor it comes through", async () => {
    const onNavigate = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const show = (initiatives: TaskItem["initiatives"]) =>
      act(async () =>
        root.render(
          page({
            items: [task({ parentId: "5" }), epic],
            selectedId: "7",
            taskDetails: {
              "7": task({
                description: "Body",
                parentId: "5",
                ...(initiatives ? { initiatives } : {}),
              }),
            },
            onNavigate,
          }),
        ),
      );
    const rows = () =>
      [
        ...container.querySelectorAll<HTMLAnchorElement>(
          '[aria-label="Initiatives"] a',
        ),
      ].map((row) => [row.getAttribute("href"), row.textContent]);
    try {
      await show([{ id: "3", title: "Hosted Labs", state: "active" }]);
      expect(rows()).toEqual([["/initiatives/3", "Hosted LabsActive"]]);

      // The read after a membership change: another Initiative, through the
      // epic, whose live Backlog title wins over the one the read carried.
      await show([
        { id: "3", title: "Hosted Labs", state: "paused" },
        {
          id: "4",
          title: "Platform",
          state: "done",
          through: { id: "5", title: "Old epic title" },
        },
      ]);
      expect(rows()).toEqual([
        ["/initiatives/3", "Hosted LabsPaused"],
        ["/initiatives/4", "PlatformThrough #5 Renamed epicDone"],
      ]);

      const link = container.querySelector<HTMLAnchorElement>(
        'a[href="/initiatives/4"]',
      )!;
      await act(async () => link.click());
      expect(onNavigate).toHaveBeenCalledWith("/initiatives/4");

      await show(undefined);
      expect(container.querySelector('[aria-label="Initiatives"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
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
 * The title and description editor (one, opened by Edit) keeps the draft until
 * the correlated `saveTask` succeeds: pending busies Save and refuses a second
 * save, a refusal shows its error with a retry, and only a success closes.
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
    const view = await mount({
      items: [task()],
      selectedId: "7",
      taskDetails: { "7": task({ description: "Body" }) },
      saveTask,
    });
    try {
      await act(async () => buttonNamed(view.container, "Edit")!.click());
      const input = view.container.querySelector<HTMLInputElement>(
        'input[aria-label="Task title"]',
      )!;
      expect(document.activeElement).toBe(input);
      await type(input, "Ship it  ");
      await key(input, { key: "Enter", metaKey: true });
      expect(saveTask).toHaveBeenCalledTimes(1);
      // Only the field this edit changed travels; the status always does.
      expect(saveTask).toHaveBeenLastCalledWith(
        { id: "7", title: "Ship it", status: "todo" },
        "edit",
      );

      await view.rerender({ "7:edit": loading() });
      const save = buttonNamed(view.container, "Save")!;
      expect(save.getAttribute("aria-busy")).toBe("true");
      await key(input, { key: "Enter", metaKey: true });
      expect(saveTask).toHaveBeenCalledTimes(1);

      await view.rerender({ "7:edit": failed("Title refused") });
      expect(input.isConnected).toBe(true);
      expect(input.value).toBe("Ship it  ");
      expect(view.container.textContent).toContain("Title refused");
      await act(async () => buttonNamed(view.container, "Retry")!.click());
      expect(saveTask).toHaveBeenCalledTimes(2);

      await view.rerender({ "7:edit": loading() });
      await view.rerender({ "7:edit": ready(true) });
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
      // The editor replaces the description and its action row, so Edit is
      // a new button each time it comes back.
      const edit = () => buttonNamed(view.container, "Edit")!;
      await act(async () => edit().click());
      await type(textarea()!, "Discarded");
      await key(textarea()!, { key: "Escape" });
      expect(textarea()).toBeNull();
      expect(saveTask).not.toHaveBeenCalled();

      await act(async () => edit().click());
      expect(textarea()!.value).toBe("Body");
      await type(textarea()!, "New body\n\n");
      await key(textarea()!, { key: "Enter", ctrlKey: true });
      expect(saveTask).toHaveBeenLastCalledWith(
        { id: "7", status: "todo", description: "New body" },
        "edit",
      );

      await view.rerender({ "7:edit": loading() });
      expect(textarea()).not.toBeNull();
      expect(buttonNamed(view.container, "Save")!.disabled).toBe(true);

      await view.rerender({ "7:edit": failed("Too long") });
      expect(textarea()!.value).toBe("New body\n\n");
      expect(view.container.textContent).toContain("Too long");

      await act(async () => buttonNamed(view.container, "Retry")!.click());
      await view.rerender({ "7:edit": loading() });
      await view.rerender({ "7:edit": ready(true) });
      expect(textarea()).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
