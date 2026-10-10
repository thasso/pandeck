import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import {
  backgroundTasksPath,
  canonicalizeEmptySessionToCreate,
  fileViewerPath,
  isSectionIndexRoute,
  knowledgePath,
  parseRoute,
  PERMANENT_ASSISTANT_PATH,
  projectPath,
  pullRequestPath,
  sessionArtifactPath,
  settingsPath,
  stagedSendCreatedSession,
  taskPath,
  worktreePath,
} from "./useSessionRouting.ts";
import {
  canonicalSidebarSection,
  sectionIndexPath,
  type SidebarSection,
} from "./useSidebarSection.ts";
import { sessionPath } from "../lib/sessionRoutes.ts";

describe("parseRoute", () => {
  it("parses the canonical session routes", () => {
    expect(parseRoute(PERMANENT_ASSISTANT_PATH)).toEqual({
      name: "permanentAssistant",
    });
    expect(parseRoute("/sessions")).toEqual({ name: "sessions" });
    expect(parseRoute("/sessions/create")).toEqual({ name: "new" });
    expect(parseRoute("/sessions/abc-123")).toEqual({
      name: "session",
      id: "abc-123",
    });
  });

  it("parses task routes", () => {
    expect(parseRoute("/tasks")).toEqual({ name: "tasks" });
    expect(parseRoute("/tasks/task_1")).toEqual({
      name: "tasks",
      id: "task_1",
    });
  });

  it("parses project routes", () => {
    expect(parseRoute("/projects")).toEqual({ name: "projects" });
    expect(parseRoute("/projects/proj_1")).toEqual({
      name: "projects",
      id: "proj_1",
    });
  });

  it("rejects removed calendar routes", () => {
    for (const path of [
      "/calendar",
      "/calendar/week/2026-07-05",
      "/calendar/2026-07-05",
    ]) {
      expect(parseRoute(path)).toEqual({ name: "new" });
    }
  });

  it("parses knowledge routes as the knowledge checkout", () => {
    expect(parseRoute("/knowledge")).toEqual({ name: "knowledge" });
    expect(parseRoute("/knowledge/files?path=notes%2Fa%20b.md#L3")).toEqual({
      name: "knowledge",
      view: "files",
      path: "notes/a b.md",
      anchor: { start: 3 },
    });
    expect(parseRoute("/knowledge/changes?path=a.md&from=abc&to=def")).toEqual({
      name: "knowledge",
      view: "changes",
      path: "a.md",
      from: "abc",
      to: "def",
    });
    // The page builds its links with `worktreePath`; for the KB they stay here.
    expect(worktreePath("knowledge", "files", { path: "a.md" })).toBe(
      "/knowledge/files?path=a.md",
    );
    // Entry-id routes are gone: an entry is its file now.
    expect(parseRoute("/knowledge/kb-1")).not.toMatchObject({
      name: "knowledge",
    });
  });

  it("parses settings routes and rejects unknown sections", () => {
    // Bare /settings is the section INDEX route, not a shorthand for the first
    // section: on small screens it is the Settings browser screen.
    expect(parseRoute("/settings")).toEqual({ name: "settings" });
    expect(parseRoute("/settings/models")).toEqual({
      name: "settings",
      section: "models",
    });
    expect(parseRoute("/settings/openai")).toEqual({
      name: "settings",
      section: "openai",
    });
    expect(parseRoute("/settings/notifications")).toEqual({
      name: "settings",
      section: "notifications",
    });
    expect(parseRoute("/settings/nonsense")).toEqual({ name: "new" });
  });

  it("ignores unrelated query and hash values", () => {
    expect(parseRoute("/tasks/task_1?x=1#y")).toEqual({
      name: "tasks",
      id: "task_1",
    });
  });

  it("keeps document line anchors and session-artifact identity", () => {
    expect(parseRoute("/files/tmp/example/a.md#L42-L57")).toEqual({
      name: "files",
      path: "/tmp/example/a.md",
      anchor: { start: 42, end: 57 },
    });
    expect(parseRoute("/artifacts/s%201/out/log.txt#L8")).toEqual({
      name: "artifacts",
      sessionId: "s 1",
      path: "out/log.txt",
      anchor: { start: 8 },
    });
  });

  it("keeps worktree file view distinct from explicit diff view", () => {
    expect(parseRoute("/worktrees/w1/files?path=src%2Fa.ts#L4")).toMatchObject({
      name: "worktrees",
      id: "w1",
      view: "files",
      path: "src/a.ts",
      anchor: { start: 4 },
    });
    expect(
      parseRoute("/worktrees/w1/changes?path=src%2Fa.ts&view=diff"),
    ).toMatchObject({ view: "changes", path: "src/a.ts" });
    expect(parseRoute("/worktrees/w1?path=src%2Fa.ts")).toMatchObject({
      view: "files",
      path: "src/a.ts",
    });
  });

  it("decodes encoded object ids", () => {
    expect(parseRoute("/tasks/task%201")).toEqual({
      name: "tasks",
      id: "task 1",
    });
  });

  it("falls back to the new-chat landing for unknown paths", () => {
    expect(parseRoute("/")).toEqual({ name: "new" });
    expect(parseRoute("/todos/task_1")).toEqual({ name: "new" });
    expect(parseRoute("/c/abc")).toEqual({ name: "new" });
  });
});

describe("stagedSendCreatedSession", () => {
  const knownAtArm = new Set(["existing-1", "existing-2", "viewed"]);

  it("adopts only a session unknown at send time (the one the send created)", () => {
    expect(stagedSendCreatedSession("fresh-id", true, knownAtArm)).toBe(
      "fresh-id",
    );
  });

  it("never adopts an already-existing session, however currentId drifted to it", () => {
    // Regression: a late loadSession snapshot, a background session's frames
    // settling, or a server-driven view switch re-establishes an EXISTING
    // session mid-staging; the old baseline-id comparison adopted it at send
    // time and the router then steered the server off the freshly created one.
    expect(stagedSendCreatedSession("existing-1", true, knownAtArm)).toBeNull();
    expect(stagedSendCreatedSession("viewed", true, knownAtArm)).toBeNull();
  });

  it("waits for an established, non-empty view", () => {
    expect(stagedSendCreatedSession(undefined, true, knownAtArm)).toBeNull();
    expect(stagedSendCreatedSession("fresh-id", false, knownAtArm)).toBeNull();
    expect(stagedSendCreatedSession("fresh-id", true, null)).toBeNull();
  });
});

describe("canonicalizeEmptySessionToCreate", () => {
  const listed = (id: string, messageCount: number) =>
    ({ id, messageCount }) as SessionListItem;

  it("keeps the id URL for a session the list says has messages", () => {
    // Task 449 defence in depth: a zero-message PROJECTION of a session the
    // list knows is non-empty is an unrenderable snapshot, not a bootstrap —
    // sending it to /sessions/create makes a real conversation unreachable.
    expect(
      canonicalizeEmptySessionToCreate(true, [listed("s1", 2)], "s1"),
    ).toBe(false);
  });

  it("withholds judgement until the session list has arrived", () => {
    // A cold deep link: the snapshot lands BEFORE `ready`'s list, so `sessions`
    // is still empty. An unknown id is "not yet known", never "empty" — the
    // guard must wait for hydration instead of rehoming on absent evidence.
    expect(canonicalizeEmptySessionToCreate(false, [], "s1")).toBe(false);
  });

  it("still rehomes a genuinely empty bootstrap session", () => {
    expect(
      canonicalizeEmptySessionToCreate(true, [listed("s1", 0)], "s1"),
    ).toBe(true);
    expect(canonicalizeEmptySessionToCreate(true, [], "s1")).toBe(true);
  });
});

describe("path helpers round-trip through parseRoute", () => {
  it("builds paths parseRoute maps back to the same object", () => {
    expect(parseRoute(sessionPath("s 1"))).toEqual({
      name: "session",
      id: "s 1",
    });
    expect(parseRoute(taskPath("t/1"))).toEqual({ name: "tasks", id: "t/1" });
    expect(parseRoute(projectPath("p1"))).toEqual({
      name: "projects",
      id: "p1",
    });
    expect(parseRoute(settingsPath("jira"))).toEqual({
      name: "settings",
      section: "jira",
    });
    expect(parseRoute(knowledgePath())).toEqual({ name: "knowledge" });
    expect(
      parseRoute(fileViewerPath("/tmp/example/a b.md", { start: 3 })),
    ).toEqual({
      name: "files",
      path: "/tmp/example/a b.md",
      anchor: { start: 3 },
    });
    expect(
      parseRoute(sessionArtifactPath("s 1", "out/report.txt", { start: 9 })),
    ).toEqual({
      name: "artifacts",
      sessionId: "s 1",
      path: "out/report.txt",
      anchor: { start: 9 },
    });
  });

  it("addresses the background registry, with and without an anchor", () => {
    expect(parseRoute(backgroundTasksPath())).toEqual({
      name: "backgroundTasks",
    });
    expect(parseRoute("/background-tasks/")).toEqual({
      name: "backgroundTasks",
    });
    // The exact shape the agent-facing tool hands a model as `humanLink`.
    expect(parseRoute(backgroundTasksPath("bw_1 2"))).toEqual({
      name: "backgroundTasks",
      taskId: "bw_1 2",
    });
    expect(parseRoute("/background-tasks?task=bw_9#frag")).toEqual({
      name: "backgroundTasks",
      taskId: "bw_9",
    });
  });
});

describe("section index routes", () => {
  const SECTIONS: SidebarSection[] = [
    "sessions",
    "tasks",
    "projects",
    "pull-requests",
    "knowledge",
    "settings",
  ];

  it("recognizes every section's index route", () => {
    for (const section of SECTIONS) {
      expect(isSectionIndexRoute(parseRoute(sectionIndexPath(section)))).toBe(
        true,
      );
    }
  });

  it("does not treat object routes as index routes", () => {
    expect(isSectionIndexRoute(parseRoute(taskPath("t1")))).toBe(false);
    expect(isSectionIndexRoute(parseRoute(projectPath("p1")))).toBe(false);
    expect(isSectionIndexRoute(parseRoute("/worktrees/wt1"))).toBe(false);
    expect(
      isSectionIndexRoute(
        parseRoute(
          pullRequestPath({
            projectId: "pa",
            provider: "forgejo",
            repositoryKey: "acme/pa",
            number: 7,
          }),
        ),
      ),
    ).toBe(false);
    expect(
      isSectionIndexRoute(parseRoute("/knowledge/files?path=a%2Fb.json")),
    ).toBe(false);
    expect(isSectionIndexRoute(parseRoute(settingsPath("jira")))).toBe(false);
    expect(isSectionIndexRoute(parseRoute(sessionPath("s1")))).toBe(false);
  });

  it("does not treat sectionless action surfaces as index routes", () => {
    expect(isSectionIndexRoute(parseRoute("/sessions/create"))).toBe(false);
    expect(isSectionIndexRoute(parseRoute(PERMANENT_ASSISTANT_PATH))).toBe(
      false,
    );
    expect(isSectionIndexRoute(parseRoute("/usage"))).toBe(false);
    expect(isSectionIndexRoute(parseRoute("/background-tasks"))).toBe(false);
    expect(isSectionIndexRoute(parseRoute("/"))).toBe(false);
  });

  it("maps each index path back to its own section", () => {
    for (const section of SECTIONS) {
      expect(
        canonicalSidebarSection(parseRoute(sectionIndexPath(section))),
      ).toBe(section);
    }
  });
});

describe("pull request routes", () => {
  const target = {
    projectId: "pa",
    provider: "forgejo" as const,
    repositoryKey: "acme/pa",
    number: 7,
  };

  it("round-trips a pull request through its path", () => {
    expect(parseRoute(pullRequestPath(target))).toEqual({
      name: "pullRequests",
      ...target,
    });
  });

  it("carries the repository as ONE encoded segment", () => {
    // `owner/repo` is a single opaque identifier. Letting its slash through
    // would make the tail of this shape unparseable, and the route would
    // silently fall through to the new-chat landing.
    expect(pullRequestPath(target)).toBe(
      "/pull-requests/pa/forgejo/acme%2Fpa/7",
    );
  });

  it("addresses the same owner/repo under two providers separately", () => {
    // `owner/repo` is only unique WITHIN a provider: a project whose Forgejo
    // and GitHub remotes both expose `acme/repo` has two different #7s, and
    // dropping the provider gives them one URL.
    const github = { ...target, provider: "github" as const };
    expect(pullRequestPath(target)).not.toBe(pullRequestPath(github));
    expect(parseRoute(pullRequestPath(github))).toEqual({
      name: "pullRequests",
      ...github,
    });
  });

  it("rejects a provider this build does not have", () => {
    // Parsing it would mint an id nothing can ever resolve, and the page would
    // sit on "not in your inventory" as if the pull request had been deleted.
    expect(parseRoute("/pull-requests/pa/gitlab/acme%2Fpa/7").name).not.toBe(
      "pullRequests",
    );
  });

  it("addresses two repositories' #7 separately", () => {
    // The collision the server explicitly supports (one project publishing a
    // worktree to a `pushurl` fork). Two rows, two URLs, two routes.
    const fork = { ...target, repositoryKey: "acme/pa-fork" };
    expect(pullRequestPath(target)).not.toBe(pullRequestPath(fork));
    expect(parseRoute(pullRequestPath(fork))).toEqual({
      name: "pullRequests",
      ...fork,
    });
  });

  it("keeps the index a bare path", () => {
    expect(pullRequestPath()).toBe("/pull-requests");
    expect(parseRoute("/pull-requests")).toEqual({ name: "pullRequests" });
    expect(parseRoute("/pull-requests/")).toEqual({ name: "pullRequests" });
  });
});
