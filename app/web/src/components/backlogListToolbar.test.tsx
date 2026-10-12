// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BacklogState } from "../hooks/useBacklog.ts";
import type { Prefs } from "../hooks/usePrefs.ts";
import { ALL_PROJECT_FILTER } from "../lib/backlogTreeModel.ts";
import { mount, type Mounted } from "../test/mount.tsx";
import type { BacklogToolbar } from "./BacklogToolbar.tsx";
import { BacklogListToolbar } from "./BacklogListToolbar.tsx";

type ToolbarProps = Parameters<typeof BacklogToolbar>[0];

/** Every render of the real toolbar, by the props it was handed. */
const drawn: ToolbarProps[] = [];
vi.mock("./BacklogToolbar.tsx", () => ({
  BacklogToolbar: (props: ToolbarProps) => {
    drawn.push(props);
    return null;
  },
}));

/**
 * The Sidebar draws the Backlog's toolbar above its scroll container, from the
 * same prefs and `BacklogState` slice it hands the list. It is one more child
 * of a host whose props are held stable, so it must not redraw unless what it
 * states changed.
 */
describe("BacklogListToolbar", () => {
  let view: Mounted | null = null;
  afterEach(() => {
    view = null;
    drawn.length = 0;
  });

  const prefs = {
    backlogView: "backlog",
    backlogViewMode: "normal",
    backlogProjectFilter: ALL_PROJECT_FILTER,
    backlogStatusFilter: ["todo", "doing", "done"],
  } as Prefs;

  const state = {
    connected: true,
    taskList: {
      items: [
        {
          id: "1",
          title: "Waiting",
          status: "todo",
          projectId: "p1",
          source: { createdBy: "agent" },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      updatedAt: 1,
    },
    taskListError: null,
    projectList: {
      projects: [{ id: "p1", key: "PA", name: "Pandeck" }],
    },
    taskMutations: {},
    taskProjectsAssignedSeq: 0,
    sessions: [],
    worktreeMerge: {},
  } as unknown as BacklogState;

  function render(over: { prefs?: Prefs } = {}, onUpdatePrefs = () => {}) {
    view ??= mount();
    act(() =>
      view!.root.render(
        <BacklogListToolbar
          state={state}
          prefs={over.prefs ?? prefs}
          onUpdatePrefs={onUpdatePrefs}
          density="tight"
          bar
        />,
      ),
    );
  }

  it("does not redraw for a host render that changed nothing it states", () => {
    const onUpdatePrefs = vi.fn();
    render({}, onUpdatePrefs);
    render({}, onUpdatePrefs);
    expect(drawn).toHaveLength(1);

    // A changed pref is what it states, so it does redraw.
    render({ prefs: { ...prefs, backlogView: "focus" } }, onUpdatePrefs);
    expect(drawn).toHaveLength(2);
    expect(drawn[1]!.view).toBe("focus");
  });

  it("states the list's projects and Inbox, and writes its choices to prefs", () => {
    const onUpdatePrefs = vi.fn();
    render({}, onUpdatePrefs);
    const props = drawn[0]!;
    expect(props.bar).toBe(true);
    expect(props.projectsLoaded).toBe(true);
    expect(props.projectFilterOptions).toContainEqual(
      expect.objectContaining({ projectId: "p1", label: "Pandeck" }),
    );
    // The one Task is untriaged, so the Inbox chip carries its dot.
    expect(props.inboxWaiting).toBe(true);

    act(() => props.onViewChange("inbox"));
    act(() => props.onStatusFilterChange(["todo"]));
    expect(onUpdatePrefs.mock.calls).toEqual([
      [{ backlogView: "inbox" }],
      [{ backlogStatusFilter: ["todo"] }],
    ]);
  });
});
