import { describe, expect, it } from "vitest";
import {
  backgroundInspectorSubscribes,
  topicsForSurface,
} from "./broadcastTopics.ts";

describe("topicsForSurface", () => {
  it("subscribes for a visible browser's section", () => {
    expect(
      topicsForSurface({
        sidebarVisible: true,
        sidebarSection: "tasks",
        routeName: "session",
      }).sort(),
    ).toEqual(["projects", "tasks", "workflow", "worktrees"]);
    expect(
      topicsForSurface({
        sidebarVisible: true,
        sidebarSection: "knowledge",
        routeName: "session",
      }),
    ).toEqual([]);
  });

  it("gives the Pull Requests surfaces the lists its joins resolve against", () => {
    // The inventory carries IDS: the worktree behind a pull request, the
    // sessions in it, the Tasks it implements. Without these three the rows
    // and the detail page render perfectly and resolve nothing.
    const expected = ["projects", "tasks", "workflow", "worktrees"];
    expect(
      topicsForSurface({
        sidebarVisible: true,
        sidebarSection: "pull-requests",
        routeName: "session",
      }).sort(),
    ).toEqual(expected);
    // The detail ROUTE counts on its own, with no sidebar at all (a phone).
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "pullRequests",
      }).sort(),
    ).toEqual(expected);
    // …and a selected-but-hidden browser does not, on the general rule.
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "pull-requests",
        routeName: "session",
      }),
    ).toEqual([]);
  });

  it("holds the background registry only for its route and its one section", () => {
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "backgroundTasks",
      }),
    ).toEqual(["background"]);
    // A conversation whose session owns background work, with the inspector
    // rendering the section — and the same conversation without it.
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
        backgroundInspectorVisible: true,
      }),
    ).toEqual(["background"]);
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
      }),
    ).toEqual([]);
    // The composer's ledge subscribes only while it is OPEN: its collapsed
    // line reads the session row's own projection.
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
        backgroundLedgeOpen: true,
      }),
    ).toEqual(["background"]);
    // The session LIST never subscribes: its per-session activity rides on the
    // session row, so a visible sidebar costs nothing here.
    expect(
      topicsForSurface({
        sidebarVisible: true,
        sidebarSection: "sessions",
        routeName: "session",
      }),
    ).not.toContain("background");
  });

  it("subscribes the inspector on session identity alone, never on activity", () => {
    // A COLD direct load of a session whose background work has all finished.
    // There is no `backgroundActivity` (that field exists only while something
    // is nonterminal) and this tab holds no rows yet, so a condition reading
    // either would never subscribe — and the inspector's Recent list could never
    // populate, however many terminal rows the server holds. The predicate
    // therefore takes NEITHER as an input.
    expect(
      backgroundInspectorSubscribes({
        routeName: "session",
        sessionId: "s1",
        sessionExists: true,
        inspectorVisible: true,
      }),
    ).toBe(true);
  });

  it("stays quiet unless all four conditions hold, one at a time", () => {
    const subscribing = {
      routeName: "session",
      sessionId: "s1",
      sessionExists: true,
      inspectorVisible: true,
    } as const;
    expect(backgroundInspectorSubscribes(subscribing)).toBe(true);

    // A hidden inspector renders nothing to fill.
    expect(
      backgroundInspectorSubscribes({
        ...subscribing,
        inspectorVisible: false,
      }),
    ).toBe(false);
    // Another object's route has no session inspector at all.
    expect(
      backgroundInspectorSubscribes({ ...subscribing, routeName: "tasks" }),
    ).toBe(false);
    // A draft: staged, not persisted, so it owns nothing yet.
    expect(
      backgroundInspectorSubscribes({
        routeName: "session",
        sessionExists: false,
        inspectorVisible: true,
      }),
    ).toBe(false);
    // The one that looks redundant and is not: the id is NONEMPTY and parses as
    // a session route, but names no session. `/sessions/does-not-exist` is an
    // arbitrary bad URL, and handing it the whole global registry snapshot is
    // the wrong failure mode — 6.4 MB raw at 10,000 rows.
    expect(
      backgroundInspectorSubscribes({
        routeName: "session",
        sessionId: "does-not-exist",
        sessionExists: false,
        inspectorVisible: true,
      }),
    ).toBe(false);
    // And it comes back the moment the real session resolves, which is what
    // keeps the terminal-history case above working on a cold load.
    expect(
      backgroundInspectorSubscribes({
        routeName: "session",
        sessionId: "does-not-exist",
        sessionExists: true,
        inspectorVisible: true,
      }),
    ).toBe(true);
  });

  it("ignores the selected section while no browser is on screen", () => {
    // The phone case: a Task was opened, the section stayed selected, and the
    // conversation must not keep paying for Task broadcasts.
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "tasks",
        routeName: "session",
      }),
    ).toEqual([]);
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "knowledge",
        routeName: "session",
      }),
    ).toEqual([]);
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "settings",
        routeName: "permanentAssistant",
      }),
    ).toEqual([]);
  });

  it("always subscribes for the main pane's own route", () => {
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "tasks",
      }).sort(),
    ).toEqual(["projects", "tasks", "workflow"]);
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "projects",
      }).sort(),
    ).toEqual(["projects", "worktrees"]);
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "projects",
        projectSelected: true,
      }).sort(),
    ).toEqual(["projects", "tasks", "workflow", "worktrees"]);
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "new",
      }).sort(),
    ).toEqual(["projects", "usage", "workflow", "worktrees"]);
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "knowledge",
      }),
    ).toEqual([]);
  });

  it("subscribes to Tasks only while either staged-session picker is open", () => {
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "new",
        taskPickerOpen: true,
      }).sort(),
    ).toEqual(["projects", "tasks", "usage", "workflow", "worktrees"]);
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "sessions",
        taskPickerOpen: true,
      }),
    ).toEqual(["tasks"]);
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "sessions",
        taskPickerOpen: false,
      }),
    ).toEqual([]);
    expect(
      topicsForSurface({
        sidebarVisible: true,
        sidebarSection: "tasks",
        routeName: "new",
        taskPickerOpen: false,
      }).sort(),
    ).toEqual(["projects", "tasks", "usage", "workflow", "worktrees"]);
  });

  it("carries usage only on the surfaces that meter accounts", () => {
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "usage",
      }),
    ).toEqual(["usage"]);
    expect(
      topicsForSurface({
        sidebarVisible: true,
        sidebarSection: "tasks",
        routeName: "session",
      }).sort(),
    ).not.toContain("usage");
  });

  it("adds usage and worktrees while the workflow start sheet is open", () => {
    // The sheet meters every account and offers active Project worktree branches
    // over whatever surface it was opened from.
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
        workflowStartOpen: true,
      }),
    ).toEqual(["worktrees", "usage"]);
    expect(
      topicsForSurface({
        sidebarVisible: true,
        sidebarSection: "tasks",
        routeName: "tasks",
        workflowStartOpen: true,
      }).sort(),
    ).toEqual(["projects", "tasks", "usage", "workflow", "worktrees"]);
    // Closed again, the surface stops paying for it.
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
        workflowStartOpen: false,
      }),
    ).toEqual([]);
  });

  it("subscribes to skills only while that settings section renders", () => {
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "settings",
        settingsSection: "skills",
      }),
    ).toEqual(["skills"]);
    // Another section, the settings index, and a settings browser listing the
    // entry all read nothing: a subscribe rescans the library on the server.
    expect(
      topicsForSurface({
        sidebarVisible: true,
        sidebarSection: "settings",
        routeName: "settings",
        settingsSection: "worktrees",
      }),
    ).toEqual([]);
    expect(
      topicsForSurface({
        sidebarVisible: true,
        sidebarSection: "settings",
        routeName: "settings",
      }),
    ).toEqual([]);
    expect(
      topicsForSurface({
        sidebarVisible: true,
        sidebarSection: "settings",
        routeName: "session",
        settingsSection: "skills",
      }),
    ).toEqual([]);
  });

  it("subscribes to skills while the session inspector renders them", () => {
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
        sessionInspectorVisible: true,
      }),
    ).toEqual(["skills"]);
  });

  it("holds Workflow Runs alone for a visible Sessions browser", () => {
    // The run items are made of the run summaries and their cards; the Task
    // titles beside them stay a best-effort join, so the large Backlog
    // broadcasts do not ride along on the session list.
    expect(
      topicsForSurface({
        sidebarVisible: true,
        sidebarSection: "sessions",
        routeName: "session",
      }),
    ).toEqual(["workflow"]);
  });

  it("subscribes to nothing for a conversation with the browser hidden", () => {
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
      }),
    ).toEqual([]);
  });
});
