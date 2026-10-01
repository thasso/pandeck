// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecord, SessionListItem } from "@assistant/shared";
import type { Task } from "../lib/backlogTree.ts";
import type { BacklogDensity } from "../lib/backlogTreeModel.ts";
import type { WorktreeHostingMap } from "../lib/worktreeHosting.ts";
import type { DirtyWorktrees } from "../lib/worktreeDirty.ts";
import type { WorkflowIndicators } from "../lib/workflowIndicator.ts";
import { BacklogTreePane } from "./BacklogTreePane.tsx";

/**
 * What the list does around a swiped row LEAVING: `SwipeRow` owns the motion
 * (its own tests), and this owns the two things only the list can do — hold the
 * row through its exit, because the archive is answered faster than the row can
 * leave, and let a collapsed subtree out first, because archiving promotes it.
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

const TASK_COLLAPSE_KEY = "backlog.collapsedTasks";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

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

const TODAY = "2026-08-06";

function render(
  tasks: Task[],
  onArchive: (ids: string[]) => string[] | null,
  options: {
    density?: BacklogDensity;
    sessions?: SessionListItem[];
    projects?: ProjectRecord[];
    onOpen?: (id: string) => void;
    onOpenSession?: (sessionId: string) => void;
    onStartSession?: (task: Task) => void;
    onNavigate?: (path: string) => void;
    hosting?: WorktreeHostingMap;
    dirtyWorktrees?: DirtyWorktrees;
    workflowIndicators?: WorkflowIndicators;
    onDelete?: (ids: string[]) => void;
  } = {},
) {
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  act(() => {
    root!.render(
      <BacklogTreePane
        tasks={tasks}
        viewMode="normal"
        statuses={new Set(["todo", "doing", "done"])}
        projectFilter={{ kind: "all" }}
        projectFilterActive={false}
        projectsById={
          new Map((options.projects ?? []).map((item) => [item.id, item]))
        }
        activeProjects={options.projects ?? []}
        sessionById={
          new Map((options.sessions ?? []).map((item) => [item.id, item]))
        }
        hosting={options.hosting}
        dirtyWorktrees={options.dirtyWorktrees}
        workflowIndicators={options.workflowIndicators}
        today={TODAY}
        selectedId={null}
        onOpen={options.onOpen ?? (() => {})}
        onCycle={() => {}}
        onReorder={() => {}}
        onAssignProjectsForRoots={() => {}}
        onArchive={onArchive}
        onDelete={options.onDelete}
        canQuickArchive={(item) => item.status === "done"}
        onOpenSession={options.onOpenSession}
        onStartSession={options.onStartSession}
        onNavigate={options.onNavigate}
        onClearFilters={() => {}}
        density={options.density ?? "comfortable"}
      />,
    );
  });
}

/** The row ids the tree is currently drawing, in order. */
function rowIds(): string[] {
  return [
    ...container!.querySelectorAll<HTMLElement>("[data-list-row-id]"),
  ].map((row) => row.dataset.listRowId!);
}

/** The swipe surface of a row: the wrapper the finger drags. */
function swipeHost(id: string): HTMLElement {
  const row = container!.querySelector<HTMLElement>(
    `[data-list-row-id="${id}"]`,
  );
  if (!row) throw new Error(`no row ${id}`);
  return row.firstElementChild as HTMLElement;
}

function pointer(type: string, x: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: 1,
    pointerType: "touch",
    clientX: x,
    clientY: 40,
  });
  return event;
}

/**
 * An ARCHIVE swipe past the commit threshold, on the row with this id:
 * rightward, which is the side archive lives on. The other side deletes, and
 * asks before it does anything, so it animates nothing and is not this.
 */
function swipeAway(id: string) {
  const host = swipeHost(id);
  act(() => {
    host.dispatchEvent(pointer("pointerdown", 300));
    host.dispatchEvent(pointer("pointermove", 440));
    host.dispatchEvent(pointer("pointerup", 440));
  });
}

describe("BacklogTreePane swipe archive", () => {
  it("holds the swiped row through its exit, then drops it", () => {
    vi.useFakeTimers();
    const archived: string[][] = [];
    const tasks = [
      task({ id: "1", status: "done" }),
      task({ id: "2", status: "todo" }),
    ];
    render(tasks, (ids) => {
      archived.push(ids);
      return ids;
    });
    swipeAway("1");
    expect(archived).toEqual([["1"]]);

    // The server answers within a frame: the Task list comes back without the
    // row while it is still leaving, and the row has to stay put.
    render([tasks[1]!], (ids) => ids);
    expect(rowIds()).toEqual(["1", "2"]);

    act(() => {
      vi.advanceTimersByTime(160);
    });
    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(rowIds()).toEqual(["2"]);
  });

  it("takes the archived subtree out on the one exit, collapse state untouched", () => {
    vi.useFakeTimers();
    // The archive carries the finished subtask (`docs/tasks.md`), so the pane
    // holds BOTH rows until the swipe's exit finishes: the subtask may not blink
    // out a frame ahead of the parent still sliding. The user's collapse state
    // is theirs — there is nothing to open, since the subtree is leaving too.
    window.localStorage.setItem(TASK_COLLAPSE_KEY, JSON.stringify(["1"]));
    const tasks = [
      task({ id: "1", status: "done" }),
      task({ id: "2", parentId: "1", status: "done" }),
    ];
    render(tasks, (ids) => [...ids, "2"]);
    expect(rowIds()).toEqual(["1"]);

    swipeAway("1");
    expect(window.localStorage.getItem(TASK_COLLAPSE_KEY)).toBe('["1"]');

    // The Task list comes back without either row while the epic is still
    // leaving; both stay held, and the collapsed child stays out of sight.
    render([], (ids) => ids);
    expect(rowIds()).toEqual(["1"]);
    act(() => {
      vi.advanceTimersByTime(160);
    });
    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(rowIds()).toEqual([]);
  });

  it("keeps a visible subtask on screen while the epic slides out", () => {
    vi.useFakeTimers();
    const tasks = [
      task({ id: "1", status: "done" }),
      task({ id: "2", parentId: "1", status: "done" }),
    ];
    render(tasks, (ids) => [...ids, "2"]);
    expect(rowIds()).toEqual(["1", "2"]);

    swipeAway("1");
    // Both rows were archived, so the Task list comes back without either — and
    // both are held: the subtask blinking out under a parent still sliding is
    // the tear this hold exists to prevent.
    render([], (ids) => ids);
    expect(rowIds()).toEqual(["1", "2"]);

    act(() => {
      vi.advanceTimersByTime(160);
    });
    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(rowIds()).toEqual([]);
  });

  it("keeps a refused row where it is, collapse state included", () => {
    vi.useFakeTimers();
    // `runTaskArchive` says no out loud; the row springs back and stays in the
    // list rather than leaving on an archive that did not happen — and the
    // subtree the user collapsed stays collapsed.
    window.localStorage.setItem(TASK_COLLAPSE_KEY, JSON.stringify(["1"]));
    const tasks = [
      task({ id: "1", status: "done" }),
      task({ id: "2", parentId: "1", status: "done" }),
    ];
    render(tasks, () => null);
    swipeAway("1");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(rowIds()).toEqual(["1"]);
    expect(swipeHost("1").dataset.swipeExit).toBeUndefined();
    expect(window.localStorage.getItem(TASK_COLLAPSE_KEY)).toBe('["1"]');
  });

  it("releases a held row even when its exit never finishes", () => {
    vi.useFakeTimers();
    // A filter change or a view switch can unmount the row mid-flight, and then
    // nothing reports the exit: the backstop timer must still drop it, or an
    // archived Task stays on screen.
    const tasks = [
      task({ id: "1", status: "done" }),
      task({ id: "2", status: "todo" }),
    ];
    render(tasks, (ids) => ids);
    swipeAway("1");
    render([tasks[1]!], (ids) => ids);
    expect(rowIds()).toEqual(["1", "2"]);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(rowIds()).toEqual(["2"]);
  });
});

/** A DELETE swipe: leftward, the side that asks before it acts. */
function swipeDelete(id: string) {
  const host = swipeHost(id);
  act(() => {
    host.dispatchEvent(pointer("pointerdown", 300));
    host.dispatchEvent(pointer("pointermove", 160));
    host.dispatchEvent(pointer("pointerup", 160));
  });
}

describe("BacklogTreePane swipe delete", () => {
  it("deletes on a leftward swipe and leaves the row where it is", () => {
    vi.useFakeTimers();
    // The row springs home rather than sliding out: the act has not happened
    // yet, only the question has been asked. Animating the removal here would
    // show the deletion while the confirmation is still on screen.
    const deleted: string[][] = [];
    const tasks = [task({ id: "1", status: "done" })];
    render(tasks, (ids) => ids, { onDelete: (ids) => void deleted.push(ids) });
    swipeDelete("1");
    expect(deleted).toEqual([["1"]]);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(rowIds()).toEqual(["1"]);
  });

  it("offers delete on a row the quick archive refuses", () => {
    // The two sides are gated separately: an unfinished Task cannot be quickly
    // archived, but it can always be deleted — the same rows the `#` key acts
    // on.
    const deleted: string[][] = [];
    const archived: string[][] = [];
    render(
      [task({ id: "1", status: "todo" })],
      (ids) => {
        archived.push(ids);
        return ids;
      },
      { onDelete: (ids) => void deleted.push(ids) },
    );

    swipeAway("1");
    expect(archived).toEqual([]);

    swipeDelete("1");
    expect(deleted).toEqual([["1"]]);
  });

  it("has no swipe at all where neither side applies", () => {
    // No delete handler and an unarchivable row: the row must not take touches
    // away from the list's scrolling to reveal nothing.
    const archived: string[][] = [];
    render([task({ id: "1", status: "todo" })], (ids) => {
      archived.push(ids);
      return ids;
    });
    swipeAway("1");
    swipeDelete("1");
    expect(archived).toEqual([]);
  });
});

/** The gutter action's button on a row, by the action it offers. */
function gutter(prefix: string): HTMLElement | null {
  return container!.querySelector<HTMLElement>(`[aria-label^="${prefix}"]`);
}

function session(patch: Partial<SessionListItem> & { id: string }) {
  return {
    harness: "pi",
    agentType: "developer",
    title: `Session ${patch.id}`,
    createdAt: 0,
    updatedAt: 0,
    messageCount: 1,
    ...patch,
  } as SessionListItem;
}

describe("BacklogTreePane density", () => {
  it("gives a comfortable row a second line and a tight row one line", () => {
    const tasks = [task({ id: "1", title: "Two-line row" })];
    render(tasks, (ids) => ids, { density: "comfortable" });
    // Nothing to report, so the line states the facts a Task always has rather
    // than leaving a strip the eye reads as a missing value.
    expect(container!.textContent).toContain("To do");

    render(tasks, (ids) => ids, { density: "tight" });
    expect(container!.textContent).not.toContain("To do");
  });

  it("gives a two-line row's first line to the title alone", () => {
    // Line 1 may end only in fixed-width controls, so BOTH the id and the
    // project chip belong to line 2 — the id leading it, where a clipping line
    // cannot take it. A single-line row is the one shape that keeps them up
    // beside the title, having nowhere else to put them.
    const tasks = [task({ id: "1", projectId: "p1" })];
    const projects = [
      { id: "p1", key: "PA", name: "Pandeck" } as ProjectRecord,
    ];
    // The line the id sits on, and the one above it.
    const idLine = () =>
      container!.querySelector<HTMLElement>('[title="Task-1"]')!.parentElement!;
    const lineAbove = () => idLine().previousElementSibling;

    render(tasks, (ids) => ids, { density: "comfortable", projects });
    expect(idLine().textContent).toContain("#1");
    expect(idLine().textContent).toContain("PA");
    expect(lineAbove()!.textContent).toBe("Task 1");

    render(tasks, (ids) => ids, { density: "tight", projects });
    expect(idLine().textContent).toContain("PA");
    expect(lineAbove()).toBeNull();
  });

  it("offers the gutter action only where the host gave it one", () => {
    const tasks = [task({ id: "1" })];
    render(tasks, (ids) => ids, { density: "comfortable" });
    expect(gutter("Start a session")).toBeNull();

    render(tasks, (ids) => ids, {
      density: "comfortable",
      onOpenSession: () => {},
      onStartSession: () => {},
    });
    expect(gutter("Start a session")).not.toBeNull();

    // A single line has no room for a gutter beside it.
    render(tasks, (ids) => ids, {
      density: "tight",
      onOpenSession: () => {},
      onStartSession: () => {},
    });
    expect(gutter("Start a session")).toBeNull();
  });

  it("opens the session a Task's work already happens in, and starts one otherwise", () => {
    const opened: string[] = [];
    const started: string[] = [];
    const options = {
      density: "comfortable" as BacklogDensity,
      sessions: [session({ id: "s1" })],
      onOpenSession: (id: string) => opened.push(id),
      onStartSession: (item: Task) => started.push(item.id),
    };

    // A `reference` ref is a session that merely SAW the Task; only work
    // started from it counts, so this row still offers to start one.
    render(
      [
        task({
          id: "1",
          sessionRefs: [{ sessionId: "s1", origin: "reference" }],
        }),
      ],
      (ids) => ids,
      options,
    );
    act(() => gutter("Start a session")!.click());
    expect([opened, started]).toEqual([[], ["1"]]);

    render(
      [
        task({
          id: "1",
          sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
        }),
      ],
      (ids) => ids,
      options,
    );
    act(() => gutter("Open the session")!.click());
    expect([opened, started]).toEqual([["s1"], ["1"]]);
  });

  it("does not also spend line 2 saying the gutter's session exists", () => {
    // The gutter names it and leads to it. Line 2 clips from the right, so the
    // duplicate would be paid for by the project chip — and with nothing else to
    // report the line falls back to status + age rather than going blank.
    const tasks = [
      task({
        id: "1",
        sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
      }),
    ];
    const sessions = [session({ id: "s1" })];

    render(tasks, (ids) => ids, { density: "comfortable", sessions });
    expect(container!.textContent).toContain("Session");

    render(tasks, (ids) => ids, {
      density: "comfortable",
      sessions,
      onOpenSession: () => {},
      onStartSession: () => {},
    });
    expect(container!.textContent).not.toContain("Session");
    expect(container!.textContent).toContain("To do");
  });

  it("keeps the worktree glyph when the session chip goes", () => {
    // "There is code" is a different fact from "work was started", and the
    // gutter states only the second. Dropping the chip must not take the glyph
    // with it — an actively-worked row with no dates would then read "To do ·
    // 2d", which says less than it did before the chip was suppressed.
    const worktreeGlyph = () =>
      container!.querySelector('[aria-label="Has a worktree"]');
    render(
      [
        task({
          id: "1",
          sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
        }),
      ],
      (ids) => ids,
      {
        density: "comfortable",
        sessions: [session({ id: "s1", worktreeId: "wt1" })],
        onOpenSession: () => {},
        onStartSession: () => {},
      },
    );
    expect(container!.textContent).not.toContain("Session");
    expect(worktreeGlyph()).not.toBeNull();
    expect(container!.textContent).not.toContain("To do");
  });

  /**
   * PR/CI on a row. The Task itself knows none of this — it reaches the row
   * through the session's WORKTREE and the app's hosting projection — so the
   * failure this guards is a row that quietly says a branch is fine.
   */
  describe("delivery", () => {
    const withWorktree = () => [
      task({
        id: "1",
        sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
      }),
    ];
    const sessions = [session({ id: "s1", worktreeId: "wt1" })];
    const worktreeGlyph = () =>
      container!.querySelector('[aria-label="Has a worktree"]');

    it("states a red check where the branch glyph was", () => {
      render(withWorktree(), (ids) => ids, {
        density: "comfortable",
        sessions,
        hosting: {
          wt1: {
            worktreeId: "wt1",
            pr: {
              number: 91,
              url: "https://forge/pulls/91",
              title: "t",
              state: "open",
            },
            ci: { state: "failure", total: 5 },
          },
        },
      });
      expect(container!.textContent).toContain("CI failed");
      // A PR is a stronger statement of "there is code" than a branch, and the
      // line clips from the right: the chip REPLACES the glyph.
      expect(worktreeGlyph()).toBeNull();
      // Which PR and how many checks do not fit two words; the tooltip has them.
      expect(container!.innerHTML).toContain("PR #91");
      expect(container!.innerHTML).toContain("5 checks");
    });

    it("keeps the glyph when hosting says nothing, and when it is unknown", () => {
      // Green checks with no PR ask nothing, and a worktree the projection
      // OMITS is unknown rather than clean. Both keep the plain glyph.
      render(withWorktree(), (ids) => ids, {
        density: "comfortable",
        sessions,
        hosting: {
          wt1: {
            worktreeId: "wt1",
            ci: { state: "success", total: 3 },
          },
        },
      });
      expect(worktreeGlyph()).not.toBeNull();
      expect(container!.textContent).not.toContain("CI");

      render(withWorktree(), (ids) => ids, {
        density: "comfortable",
        sessions,
        hosting: {},
      });
      expect(worktreeGlyph()).not.toBeNull();
    });

    it("names an open pull request by its number", () => {
      render(withWorktree(), (ids) => ids, {
        density: "comfortable",
        sessions,
        hosting: {
          wt1: {
            worktreeId: "wt1",
            pr: {
              number: 91,
              url: "https://forge/pulls/91",
              title: "t",
              state: "open",
            },
          },
        },
      });
      expect(container!.textContent).toContain("PR #91");
    });

    it("marks uncommitted changes without displacing anything", () => {
      // The dot subsumes nothing: work on disk is true alongside whatever the
      // branch's PR says, so it joins the chip rather than replacing it.
      const dirtyDot = () =>
        container!.querySelector('[aria-label="Uncommitted changes"]');
      render(withWorktree(), (ids) => ids, {
        density: "comfortable",
        sessions,
        dirtyWorktrees: new Set(["wt1"]),
      });
      expect(dirtyDot()).not.toBeNull();
      expect(worktreeGlyph()).not.toBeNull();

      render(withWorktree(), (ids) => ids, {
        density: "comfortable",
        sessions,
        dirtyWorktrees: new Set(["wt1"]),
        hosting: {
          wt1: {
            worktreeId: "wt1",
            pr: {
              number: 91,
              url: "https://forge/pulls/91",
              title: "t",
              state: "open",
            },
          },
        },
      });
      expect(dirtyDot()).not.toBeNull();
      expect(container!.textContent).toContain("PR #91");
    });

    it("marks active and attention workflow runs without hover", () => {
      render([task({ id: "370" })], (ids) => ids, {
        workflowIndicators: new Map([
          ["370", { running: true, attention: false }],
        ]),
      });
      expect(
        container!.querySelector('[aria-label="Workflow run is active"]'),
      ).not.toBeNull();

      render([task({ id: "370" })], (ids) => ids, {
        workflowIndicators: new Map([
          ["370", { running: false, attention: true }],
        ]),
      });
      expect(
        container!.querySelector('[aria-label="Workflow run needs attention"]'),
      ).not.toBeNull();
    });

    it("says nothing about a working tree it was not told about", () => {
      // A worktree missing from the slice is unknown as readily as it is
      // committed, and a row that quietly calls it clean is the failure here.
      render(withWorktree(), (ids) => ids, {
        density: "comfortable",
        sessions,
        dirtyWorktrees: new Set(["wt-other"]),
      });
      expect(
        container!.querySelector('[aria-label="Uncommitted changes"]'),
      ).toBeNull();

      // And a `tight` row has no second line to mark at all — which is why the
      // sidebar does not even watch git status for that surface.
      render(withWorktree(), (ids) => ids, {
        density: "tight",
        sessions,
        dirtyWorktrees: new Set(["wt1"]),
      });
      expect(
        container!.querySelector('[aria-label="Uncommitted changes"]'),
      ).toBeNull();
    });

    it("says nothing about delivery on a one-line row", () => {
      // A `tight` row has no second line to state it on, and the rail's Backlog
      // is why the app does not poll hosting for that surface at all.
      render(withWorktree(), (ids) => ids, {
        density: "tight",
        sessions,
        hosting: {
          wt1: {
            worktreeId: "wt1",
            ci: { state: "failure", total: 1 },
          },
        },
      });
      expect(container!.textContent).not.toContain("CI failed");
    });
  });

  /**
   * Line 2 names objects, and every one of them is somewhere you can go. The
   * failure this guards is the one the old row had: a chip that states a fact and
   * leads nowhere, leaving the Task detail as the only way to the session, the
   * worktree or the pull request it just told you about.
   */
  describe("line 2 links", () => {
    const linked = (selector: string) =>
      container!.querySelector<HTMLAnchorElement>(`a[href="${selector}"]`);

    it("leads to the Task, its session, its worktree and its Project", () => {
      render(
        [
          task({
            id: "1",
            projectId: "p1",
            sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
          }),
        ],
        (ids) => ids,
        {
          density: "comfortable",
          sessions: [session({ id: "s1", worktreeId: "wt1" })],
          projects: [
            {
              id: "p1",
              key: "PA",
              name: "Pandeck",
            } as ProjectRecord,
          ],
          onNavigate: () => {},
        },
      );
      expect(linked("/tasks/1")).not.toBeNull();
      expect(linked("/sessions/s1")).not.toBeNull();
      expect(linked("/worktrees/wt1")).not.toBeNull();
      expect(linked("/projects/p1")).not.toBeNull();
    });

    it("opens the pull request itself, off-site, in a new tab", () => {
      render(
        [
          task({
            id: "1",
            sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
          }),
        ],
        (ids) => ids,
        {
          density: "comfortable",
          sessions: [session({ id: "s1", worktreeId: "wt1" })],
          hosting: {
            wt1: {
              worktreeId: "wt1",
              pr: {
                number: 91,
                url: "https://forge/pulls/91",
                title: "t",
                state: "open",
              },
            },
          },
          onNavigate: () => {},
        },
      );
      const pr = linked("https://forge/pulls/91");
      expect(pr?.target).toBe("_blank");
      // The chip REPLACED the worktree glyph, so its link went with it.
      expect(linked("/worktrees/wt1")).toBeNull();
    });

    it("sends the dirty dot to the changes it stands for", () => {
      // The one route to the worktree left on a row whose glyph the PR took.
      render(
        [
          task({
            id: "1",
            sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
          }),
        ],
        (ids) => ids,
        {
          density: "comfortable",
          sessions: [session({ id: "s1", worktreeId: "wt1" })],
          dirtyWorktrees: new Set(["wt1"]),
          hosting: {
            wt1: {
              worktreeId: "wt1",
              pr: {
                number: 91,
                url: "https://forge/pulls/91",
                title: "t",
                state: "open",
              },
            },
          },
          onNavigate: () => {},
        },
      );
      expect(linked("/worktrees/wt1/changes")).not.toBeNull();
    });

    it("navigates in-app instead of also selecting the row", () => {
      const navigated: string[] = [];
      const opened: string[] = [];
      render([task({ id: "1" })], (ids) => ids, {
        density: "comfortable",
        onOpen: (id) => opened.push(id),
        onNavigate: (path) => navigated.push(path),
      });
      const link = linked("/tasks/1")!;
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        link.dispatchEvent(event);
      });
      // The app navigated once, the browser was spared the page load, and the
      // row underneath did not also answer for the click.
      expect(navigated).toEqual(["/tasks/1"]);
      expect(event.defaultPrevented).toBe(true);
      expect(opened).toEqual([]);
    });

    it("states the same facts as text where the host has no navigation", () => {
      // A picker is the case: a chip that left the field would abandon whatever
      // was being picked.
      render(
        [
          task({
            id: "1",
            projectId: "p1",
            sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
          }),
        ],
        (ids) => ids,
        {
          density: "comfortable",
          sessions: [session({ id: "s1", worktreeId: "wt1" })],
        },
      );
      expect(container!.querySelector("a")).toBeNull();
      expect(container!.textContent).toContain("#1");
      expect(container!.textContent).toContain("Session");
    });
  });

  it("leaves Enter to the control it was pressed on", () => {
    // `Tree` cancels Enter to select the row, and a canceled keydown never
    // becomes the button's click — so the row's own primary action would open
    // the Task instead of the session. The row keeps Enter only for itself.
    const openedTask: string[] = [];
    const started: string[] = [];
    render([task({ id: "1" })], (ids) => ids, {
      density: "comfortable",
      onOpen: (id) => openedTask.push(id),
      onOpenSession: () => {},
      onStartSession: (item) => started.push(item.id),
    });
    const row = container!.querySelector<HTMLElement>(
      '[data-list-row-id="1"]',
    )!;
    const button = gutter("Start a session")!;

    const enter = (target: HTMLElement) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        target.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };

    // Pressed on the gutter: the row neither cancels it nor selects itself.
    // (jsdom performs no implicit button activation, so what is asserted here is
    // that the row leaves the event alone for the browser to turn into a click.)
    expect(enter(button)).toBe(false);
    expect(openedTask).toEqual([]);
    // Pressed on the row itself: the row still selects, which opens the Task.
    expect(enter(row)).toBe(true);
    expect(openedTask).toEqual(["1"]);
    expect(started).toEqual([]);
  });
});
