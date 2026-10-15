// @vitest-environment jsdom
import { act, useLayoutEffect, useMemo, useReducer, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { taskSummaryOf, type TaskItem } from "@assistant/shared";
import {
  createInitialState,
  reduceAssistantState,
  type AssistantActions,
} from "../hooks/useAssistant.ts";
import type { BacklogState } from "../hooks/useBacklog.ts";
import type { Prefs } from "../hooks/usePrefs.ts";
import { ALL_PROJECT_FILTER } from "../lib/backlogTreeModel.ts";
import { TaskManagementPage } from "./TaskManagementPage.tsx";

/**
 * An archived Task opened through a link on a live Task's page, end to end:
 * the real reducer, the real page, and this test standing in for the server.
 * An archived Task has no Backlog row, so this is the route that used to say
 * the Task was "not available"; it must open from its body, refresh when a
 * linked Task changes, and come back to the Backlog when restored.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
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
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const prefs = {
  backlogView: "backlog",
  backlogViewMode: "normal",
  backlogProjectFilter: ALL_PROJECT_FILTER,
  backlogStatusFilter: ["todo", "doing", "done"],
  backlogMasterWidth: 360,
} as Prefs;

function task(id: string, patch: Partial<TaskItem> = {}): TaskItem {
  return {
    id,
    title: `Task ${id}`,
    status: "todo",
    description: `Body of ${id}`,
    source: { createdBy: "user" },
    triagedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

type Dispatch = (action: Parameters<typeof reduceAssistantState>[1]) => void;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** Mount the page over the real reducer; the returned handle plays server. */
function mount() {
  const server = {
    dispatch: null as Dispatch | null,
    /** Every `getTask` the page sent, in order. */
    requested: [] as string[],
    /** Every `archiveTask` the page sent, as `[id, archived]`. */
    archived: [] as Array<[string, boolean]>,
  };
  // As the socket layer does: one read in flight per id.
  const inFlight = new Set<string>();

  function Harness() {
    const [state, dispatch] = useReducer(
      reduceAssistantState,
      undefined,
      createInitialState,
    );
    const [selectedId, setSelectedId] = useState<string | null>("1");
    // Hand the test the reducer's dispatch, to play the server with.
    useLayoutEffect(() => {
      server.dispatch = dispatch;
    }, []);
    // Stable, as the app's actions are: the page's effects depend on them.
    const actions = useMemo(
      () =>
        new Proxy(
          {
            requestTaskDetail: (id: string) => {
              if (inFlight.has(id)) return;
              inFlight.add(id);
              server.requested.push(id);
              dispatch({ kind: "taskDetailLoad", id });
            },
            setOpenTaskProjection: (id: string | null) =>
              dispatch({ kind: "setOpenTaskProjection", id }),
            archiveTask: (id: string, archived = true) =>
              server.archived.push([id, archived]),
          },
          {
            get: (target, name) =>
              target[name as keyof typeof target] ?? (() => {}),
          },
        ) as unknown as AssistantActions,
      [],
    );
    return (
      <TaskManagementPage
        backlogState={state as unknown as BacklogState}
        connected
        detailState={selectedId ? state.taskDetails[selectedId] : undefined}
        workflowRuns={[]}
        workflowCards={{}}
        sessions={[]}
        accountNames={{}}
        taskMutations={state.taskMutations}
        actions={actions}
        prefs={prefs}
        onUpdatePrefs={() => {}}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCloseDetail={() => {}}
        onClose={() => {}}
        onOpenSession={() => {}}
      />
    );
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<Harness />));
  return {
    ...server,
    send(action: Parameters<Dispatch>[0]) {
      act(() => server.dispatch!(action));
    },
    answer(item: TaskItem, revision: number) {
      inFlight.delete(item.id);
      act(() =>
        server.dispatch!({
          kind: "taskDetailResult",
          id: item.id,
          item,
          revision,
        }),
      );
    },
  };
}

function text(): string {
  return container!.textContent ?? "";
}

function button(name: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll("button")].find((el) =>
    el.textContent?.includes(name),
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

describe("an archived Task opened from a link", () => {
  it("opens from its body, refreshes when a linked Task changes, and restores", () => {
    const live = task("1", {
      title: "Live Task",
      links: {
        blocks: [],
        blockedBy: [],
        relates: [
          { id: "2", title: "Shelved Task", status: "todo", archived: true },
        ],
      },
    });
    const shelved = (patch: Partial<TaskItem> = {}) =>
      task("2", {
        title: "Shelved Task",
        archivedAt: 5,
        links: {
          blocks: [],
          blockedBy: [
            {
              id: "3",
              title: "Old blocker name",
              status: "doing",
              archived: false,
            },
          ],
          relates: [
            { id: "1", title: "Live Task", status: "todo", archived: false },
          ],
        },
        openBlockerCount: 1,
        blocked: true,
        ...patch,
      });
    const server = mount();
    // The canonical live Backlog: Task 1 and its blocker, never Task 2.
    server.send({
      kind: "server",
      msg: {
        type: "taskList",
        list: {
          items: [taskSummaryOf(live), taskSummaryOf(task("3"))],
          updatedAt: 1,
          request: {},
        },
        seq: 1,
        revisions: [
          { id: "1", revision: 3 },
          { id: "3", revision: 3 },
        ],
      },
    });
    expect(server.requested).toEqual(["1"]);
    server.answer(live, 3);

    // Follow the archived link entry.
    act(() => button("Shelved Task").click());
    expect(server.requested).toEqual(["1", "2"]);
    expect(text()).toContain("Loading Task…");
    expect(text()).not.toContain("not available");

    server.answer(shelved(), 7);
    expect(text()).toContain("Archived");
    expect(text()).toContain("Restore to Backlog");
    expect(text()).toContain("Old blocker name");
    // The Backlog still has no row for it.
    expect(container!.querySelector('[data-list-row-id="2"]')).toBeNull();

    // Its blocker is renamed: the archived Task's only event is a `delete`
    // with a newer revision, and the open page re-reads its body.
    server.send({
      kind: "server",
      msg: {
        type: "stateEvents",
        topic: "tasks",
        seq: 2,
        events: [
          {
            kind: "upsert",
            id: "3",
            revision: 8,
            item: taskSummaryOf(task("3", { title: "New blocker name" })),
          },
          { kind: "delete", id: "2", revision: 8 },
        ],
      },
    });
    expect(server.requested).toEqual(["1", "2", "2"]);
    server.answer(
      shelved({
        links: {
          blocks: [],
          blockedBy: [
            {
              id: "3",
              title: "New blocker name",
              status: "doing",
              archived: false,
            },
          ],
          relates: [
            { id: "1", title: "Live Task", status: "todo", archived: false },
          ],
        },
      }),
      8,
    );
    expect(text()).toContain("New blocker name");
    expect(text()).not.toContain("Old blocker name");

    // Restore: the page asks, the server brings the row back as an upsert,
    // and the body is re-read without its archive.
    act(() => button("Restore to Backlog").click());
    expect(server.archived).toEqual([["2", false]]);
    const restored = task("2", {
      title: "Shelved Task",
      updatedAt: 9,
      openBlockerCount: 1,
    });
    server.send({
      kind: "server",
      msg: {
        type: "stateEvents",
        topic: "tasks",
        seq: 3,
        events: [
          {
            kind: "upsert",
            id: "2",
            revision: 9,
            item: taskSummaryOf(restored),
          },
        ],
      },
    });
    expect(server.requested).toEqual(["1", "2", "2", "2"]);
    server.answer({ ...restored, blocked: true }, 9);
    expect(text()).not.toContain("Restore to Backlog");
    expect(container!.querySelector('[data-list-row-id="2"]')).not.toBeNull();
  });
});
