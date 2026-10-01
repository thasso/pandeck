import { applyPatch } from "@assistant/shared";
import { describe, expect, it } from "vitest";
import type { WorktreeHostingStatusResponse } from "@assistant/shared";
import {
  hostingAttention,
  hostingSurfaces,
  worktreeHostingKey,
  worktreeHostingMap,
  type HostingFacts,
} from "./worktreeHosting.ts";

const OPEN_PR = {
  number: 91,
  url: "https://forge/pulls/91",
  title: "t",
  state: "open" as const,
};

describe("hostingAttention", () => {
  it("ranks a red check above a review, a review above the merge", () => {
    const facts: HostingFacts = {
      pr: OPEN_PR,
      ci: { state: "failure", total: 5 },
      review: { changesRequested: true },
    };
    expect(hostingAttention(facts)).toBe("ci-failed");
    expect(hostingAttention(applyPatch(facts, { ci: undefined }))).toBe(
      "review-requested",
    );
    expect(hostingAttention({ pr: { ...OPEN_PR, state: "merged" } })).toBe(
      "merged",
    );
  });

  it("reads an unresolved thread as a review even with no verdict", () => {
    expect(
      hostingAttention({
        pr: OPEN_PR,
        review: { changesRequested: false, unresolvedThreads: 2 },
      }),
    ).toBe("review-requested");
  });

  // The one that is invisible when wrong: absence is unknown, never clean, and
  // a state invented for it would read as "nothing to do here".
  it("answers null when nothing is being asked", () => {
    expect(hostingAttention(undefined)).toBeNull();
    expect(hostingAttention({})).toBeNull();
    expect(hostingAttention({ ci: { state: "success", total: 3 } })).toBeNull();
    expect(
      hostingAttention({ pr: { ...OPEN_PR, state: "closed" } }),
    ).toBeNull();
  });

  it("keeps a plain open PR last, below its running checks", () => {
    expect(
      hostingAttention({ pr: OPEN_PR, ci: { state: "pending", total: 2 } }),
    ).toBe("ci-pending");
    expect(hostingAttention({ pr: OPEN_PR })).toBe("open");
  });
});

describe("worktreeHostingKey", () => {
  const status = (
    worktreeId: string,
    ci: "success" | "failure",
  ): WorktreeHostingStatusResponse => ({
    worktreeId,
    ci: { state: ci, total: 1 },
  });

  // The server fills the list from a concurrent worker pool, so the ORDER is
  // incidental. Keying on it would hand the memoized sidebar a new projection
  // — and every Task row a repaint — for a response that said nothing new.
  it("ignores the order the server happened to answer in", () => {
    expect(
      worktreeHostingKey([status("a", "success"), status("b", "failure")]),
    ).toBe(
      worktreeHostingKey([status("b", "failure"), status("a", "success")]),
    );
  });

  it("changes when any state a surface reads changes", () => {
    expect(worktreeHostingKey([status("a", "success")])).not.toBe(
      worktreeHostingKey([status("a", "failure")]),
    );
    expect(worktreeHostingKey([status("a", "success")])).not.toBe(
      worktreeHostingKey([]),
    );
  });

  it("maps the list by worktree id", () => {
    expect(worktreeHostingMap([status("a", "success")])).toEqual({
      a: status("a", "success"),
    });
  });
});

describe("hostingSurfaces", () => {
  const at = (patch: Partial<Parameters<typeof hostingSurfaces>[0]>) =>
    hostingSurfaces({
      sidebarVisible: true,
      sidebarSection: "sessions",
      routeName: "session",
      projectOpen: false,
      sidebarTaskRowsHaveMeta: false,
      ...patch,
    });

  it("asks for nothing for the Pull Requests browser", () => {
    // That section reads its OWN inventory (`hooks/usePullRequestInventory.ts`),
    // which is keyed by pull request rather than by checkout. Polling this
    // per-worktree projection for it would be a second provider conversation
    // for an answer nothing on that screen renders.
    expect(at({ sidebarSection: "pull-requests" })).toEqual({
      hosting: false,
      taskRows: false,
    });
  });

  it("polls for a two-line Backlog and not for the rail's one-line rows", () => {
    // The caller answers `sidebarTaskRowsHaveMeta` from density AND view: the
    // rail's tree rows have no second line, its Focus rows do.
    expect(
      at({ sidebarSection: "tasks", sidebarTaskRowsHaveMeta: true }).hosting,
    ).toBe(true);
    expect(
      at({ sidebarSection: "tasks", sidebarTaskRowsHaveMeta: false }).hosting,
    ).toBe(false);
    // The Project PAGE's Tasks section is two-line whatever the sidebar is —
    // but the projects INDEX renders no Tasks section, so the route name alone
    // would poll for a surface that is not there.
    expect(at({ routeName: "projects", projectOpen: true }).hosting).toBe(true);
    expect(at({ routeName: "projects", projectOpen: false }).hosting).toBe(
      false,
    );
  });

  it("names the two-line Task rows separately from the polling", () => {
    // `taskRows` is what App watches git status for, and it must follow the
    // ROWS: a project page shows them with no sidebar open at all, while a
    // browser that shows none of them asks for nothing.
    expect(at({ sidebarSection: "pull-requests" }).taskRows).toBe(false);
    expect(
      at({ sidebarSection: "tasks", sidebarTaskRowsHaveMeta: true }).taskRows,
    ).toBe(true);
    expect(
      at({
        routeName: "projects",
        projectOpen: true,
        sidebarVisible: false,
      }).taskRows,
    ).toBe(true);
  });

  // Section selection survives navigating away from the browser (ui-shell.md),
  // so a phone showing a conversation must not keep polling for a sidebar that
  // is not on screen.
  it("does not count a selected section whose browser is hidden", () => {
    expect(
      at({
        sidebarSection: "tasks",
        sidebarVisible: false,
        sidebarTaskRowsHaveMeta: true,
      }),
    ).toEqual({
      hosting: false,
      taskRows: false,
    });
  });

  it("asks for nothing on a surface that states none of it", () => {
    expect(at({})).toEqual({
      hosting: false,
      taskRows: false,
    });
  });
});
