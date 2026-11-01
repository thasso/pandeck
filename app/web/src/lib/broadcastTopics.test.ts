import { describe, expect, it } from "vitest";
import {
  backgroundInspectorSubscribes,
  topicsForSurface,
  type TopicSurface,
} from "./broadcastTopics.ts";

/** The surface-dependent topics; `sessions` is held everywhere. */
const domainTopics = (surface: TopicSurface) =>
  topicsForSurface(surface).filter((topic) => topic !== "sessions");

describe("topicsForSurface", () => {
  it("holds the session list on every surface", () => {
    expect(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "settings",
        routeName: "settings",
      }),
    ).toEqual(["sessions"]);
    expect(
      topicsForSurface({
        sidebarVisible: true,
        sidebarSection: "tasks",
        routeName: "tasks",
      }),
    ).toContain("sessions");
  });

  it.each([
    "personal-assistant",
    "memory",
    "naming",
    "session-status",
    "refinement",
    "worktrees",
    "commit",
    "pull-request",
    "task-intake",
    "pdf-conversion",
  ])("holds usage for the %s Settings slot preview", (settingsSection) => {
    const surface = {
      sidebarVisible: false,
      sidebarSection: "settings" as const,
      routeName: "settings",
      settingsSection,
    };
    expect(domainTopics(surface)).toEqual(["usage"]);
    expect(domainTopics({ ...surface, routeName: "session" })).not.toContain(
      "usage",
    );
  });

  it.each([undefined, "appearance", "models", "peer-runtimes", "skills"])(
    "does not hold usage for the %s Settings section",
    (settingsSection) => {
      expect(
        domainTopics({
          sidebarVisible: true,
          sidebarSection: "settings",
          routeName: "settings",
          settingsSection,
        }),
      ).not.toContain("usage");
    },
  );
  it("subscribes for a visible browser's section", () => {
    expect(
      domainTopics({
        sidebarVisible: true,
        sidebarSection: "tasks",
        routeName: "session",
      }).sort(),
    ).toEqual(["projects", "tasks", "workflow", "worktrees"]);
    expect(
      domainTopics({
        sidebarVisible: true,
        sidebarSection: "knowledge",
        routeName: "session",
      }),
    ).toEqual(["projects"]);
  });

  it("gives the Pull Requests surfaces the lists its joins resolve against", () => {
    // The inventory carries IDS: the worktree behind a pull request, the
    // sessions in it, the Tasks it implements. Without these three the rows
    // and the detail page render perfectly and resolve nothing.
    const expected = ["projects", "tasks", "workflow", "worktrees"];
    expect(
      domainTopics({
        sidebarVisible: true,
        sidebarSection: "pull-requests",
        routeName: "session",
      }).sort(),
    ).toEqual(expected);
    // The detail ROUTE counts on its own, with no sidebar at all (a phone).
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "pullRequests",
      }).sort(),
    ).toEqual(expected);
    // …and a selected-but-hidden browser adds nothing to the conversation's
    // own Projects, on the general rule.
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "pull-requests",
        routeName: "session",
      }),
    ).toEqual(["projects"]);
  });

  it("holds the background registry only for its route and its one section", () => {
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "backgroundTasks",
      }),
    ).toEqual(["background"]);
    // A conversation whose session owns background work, with the inspector
    // rendering the section — and the same conversation without it.
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
        backgroundInspectorVisible: true,
      }),
    ).toEqual(["projects", "background"]);
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
      }),
    ).toEqual(["projects"]);
    // The composer's ledge subscribes only while it is OPEN: its collapsed
    // line reads the session row's own projection.
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
        backgroundLedgeOpen: true,
      }),
    ).toEqual(["projects", "background"]);
    // The session LIST never subscribes: its per-session activity rides on the
    // session row, so a visible sidebar costs nothing here.
    expect(
      domainTopics({
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
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "tasks",
        routeName: "session",
      }),
    ).toEqual(["projects"]);
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "knowledge",
        routeName: "session",
      }),
    ).toEqual(["projects"]);
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "settings",
        routeName: "permanentAssistant",
      }),
    ).toEqual([]);
  });

  it("always subscribes for the main pane's own route", () => {
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "tasks",
      }).sort(),
    ).toEqual(["projects", "tasks", "workflow"]);
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "projects",
      }).sort(),
    ).toEqual(["projects", "worktrees"]);
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "projects",
        projectSelected: true,
      }).sort(),
    ).toEqual(["projects", "tasks", "workflow", "worktrees"]);
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "new",
      }).sort(),
    ).toEqual(["agents", "projects", "usage", "workflow", "worktrees"]);
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "knowledge",
      }),
    ).toEqual([]);
  });

  it("subscribes to Tasks only while either staged-session picker is open", () => {
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "new",
        taskPickerOpen: true,
      }).sort(),
    ).toEqual([
      "agents",
      "projects",
      "tasks",
      "usage",
      "workflow",
      "worktrees",
    ]);
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "sessions",
        taskPickerOpen: true,
      }),
    ).toEqual(["tasks"]);
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "sessions",
        taskPickerOpen: false,
      }),
    ).toEqual([]);
    expect(
      domainTopics({
        sidebarVisible: true,
        sidebarSection: "tasks",
        routeName: "new",
        taskPickerOpen: false,
      }).sort(),
    ).toEqual([
      "agents",
      "projects",
      "tasks",
      "usage",
      "workflow",
      "worktrees",
    ]);
  });

  it("holds usage for desktop Sessions quick-start but not the mobile inbox", () => {
    const surface = {
      sidebarVisible: false,
      sidebarSection: "sessions" as const,
      routeName: "sessions",
    };
    expect(
      domainTopics({ ...surface, sessionsQuickStartVisible: true }),
    ).toEqual(["usage"]);
    expect(
      domainTopics({ ...surface, sessionsQuickStartVisible: false }),
    ).toEqual([]);
    expect(domainTopics({ ...surface, routeName: "session" })).not.toContain(
      "usage",
    );
  });

  it("carries usage only on the surfaces that meter accounts", () => {
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "usage",
      }),
    ).toEqual(["usage"]);
    expect(
      domainTopics({
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
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
        workflowStartOpen: true,
      }),
    ).toEqual(["worktrees", "projects", "usage"]);
    expect(
      domainTopics({
        sidebarVisible: true,
        sidebarSection: "tasks",
        routeName: "tasks",
        workflowStartOpen: true,
      }).sort(),
    ).toEqual(["projects", "tasks", "usage", "workflow", "worktrees"]);
    // Closed again, the surface stops paying for it.
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
        workflowStartOpen: false,
      }),
    ).toEqual(["projects"]);
  });

  it("subscribes to agents on its settings section and the new-session page", () => {
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "settings",
        settingsSection: "agents",
      }),
    ).toEqual(["agents"]);
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "settings",
        settingsSection: "skills",
      }),
    ).not.toContain("agents");
  });

  it("subscribes to skills only while that settings section renders", () => {
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "settings",
        settingsSection: "skills",
      }),
    ).toEqual(["skills"]);
    // Other sections, the index and the browser do not read the skills library:
    // subscribing rescans it. Worktree settings holds usage for its model slots.
    expect(
      domainTopics({
        sidebarVisible: true,
        sidebarSection: "settings",
        routeName: "settings",
        settingsSection: "worktrees",
      }),
    ).toEqual(["usage"]);
    expect(
      domainTopics({
        sidebarVisible: true,
        sidebarSection: "settings",
        routeName: "settings",
      }),
    ).toEqual([]);
    expect(
      domainTopics({
        sidebarVisible: true,
        sidebarSection: "settings",
        routeName: "session",
        settingsSection: "skills",
      }),
    ).toEqual(["projects"]);
  });

  it("subscribes to skills while the session inspector renders them", () => {
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
        sessionInspectorVisible: true,
      }),
    ).toEqual(["projects", "skills"]);
  });

  it("subscribes to skills while a session composer offers frozen skills", () => {
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
        composerSkillsVisible: true,
      }),
    ).toEqual(["projects", "skills"]);
    // A session without frozen skills reads no library.
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
        composerSkillsVisible: false,
      }),
    ).toEqual(["projects"]);
  });

  it("holds Worktrees while the session inspector lists the spawn tree's worktrees", () => {
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
        sessionTreeWorktreesVisible: true,
      }),
    ).toEqual(["worktrees", "projects"]);
  });

  it("holds Workflow Runs, Initiatives and Project-filter associations for a visible Sessions browser", () => {
    // Initiatives mark the cards. Project filters join sessions through
    // worktrees; Task titles remain best-effort without Backlog broadcasts.
    expect(
      domainTopics({
        sidebarVisible: true,
        sidebarSection: "sessions",
        routeName: "session",
      }),
    ).toEqual(["workflow", "initiatives", "projects", "worktrees"]);
    // A hidden Sessions browser holds neither.
    const hidden = domainTopics({
      sidebarVisible: false,
      sidebarSection: "sessions",
      routeName: "session",
    });
    expect(hidden).not.toContain("initiatives");
    expect(hidden).not.toContain("tasks");
  });

  it("holds Initiatives for the Projects browser and the Initiative pages", () => {
    expect(
      domainTopics({
        sidebarVisible: true,
        sidebarSection: "projects",
        routeName: "session",
      }).sort(),
    ).toEqual(["initiatives", "projects", "worktrees"]);
    // One Initiative's map recolours from the Tasks topic and names lanes from
    // Projects; it reads no Worktree projection.
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "projects",
        routeName: "initiatives",
      }).sort(),
    ).toEqual(["initiatives", "projects", "tasks"]);
    // A selected Task's detail reads its Workflow Runs, as on the Task page.
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "projects",
        routeName: "initiatives",
        initiativeTaskSelected: true,
      }).sort(),
    ).toEqual(["initiatives", "projects", "tasks", "workflow"]);
    // A hidden Projects browser holds nothing on a conversation.
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "projects",
        routeName: "session",
      }),
    ).not.toContain("initiatives");
  });

  it("holds only Projects for a conversation with the browser hidden", () => {
    // A session's title bar names its project and links to it.
    expect(
      domainTopics({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "session",
      }),
    ).toEqual(["projects"]);
  });
});
