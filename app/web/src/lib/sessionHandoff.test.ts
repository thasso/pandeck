import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  SessionListItem,
  TaskSummary,
  WorktreeRecord,
} from "@assistant/shared";
import {
  appendReviewReportConvention,
  buildPullRequestReviewPrompt,
  buildSessionReviewPrompt,
  pullRequestReviewContext,
  reviewAgentType,
  reviewContextForSession,
  sessionContextForWorktree,
} from "./sessionHandoff.ts";

function worktree(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: "wt-1",
    projectId: "proj-1",
    taskIds: [],
    ...overrides,
  } as WorktreeRecord;
}

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "task-1",
    title: "Implement the thing",
    status: "doing",
    ...overrides,
  } as TaskSummary;
}

function session(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: "s-1",
    title: "Session",
    worktreeId: "wt-1",
    ...overrides,
  } as SessionListItem;
}

describe("reviewContextForSession", () => {
  it("inherits the session's worktree, project, and origin Task", () => {
    expect(
      reviewContextForSession(
        {
          sessionId: "s-1",
          worktreeId: "wt-1",
          projectId: "proj-1",
          originTask: { id: "task-1", title: "Implement the thing" },
        },
        [worktree()],
        [session()],
        [task()],
      ),
    ).toEqual({
      worktreeId: "wt-1",
      projectId: "proj-1",
      task: { taskId: "task-1", title: "Implement the thing" },
    });
  });

  it("falls back to the single Task claiming the session, then the worktree's Task", () => {
    const claimed = task({
      sessionRefs: [{ sessionId: "s-1" }],
    });
    expect(
      reviewContextForSession({ sessionId: "s-1" }, null, [], [claimed]),
    ).toEqual({
      projectId: undefined,
      task: { taskId: "task-1", title: "Implement the thing" },
    });
    const viaWorktree = reviewContextForSession(
      { sessionId: "s-2", worktreeId: "wt-1" },
      [worktree({ taskIds: ["task-1"] })],
      [],
      [task()],
    );
    expect(viaWorktree.task).toEqual({
      taskId: "task-1",
      title: "Implement the thing",
    });
  });

  it("attaches NO Task when the claim is ambiguous, rather than guessing", () => {
    const tasks = [
      task({ sessionRefs: [{ sessionId: "s-1" }] }),
      task({ id: "task-2", sessionRefs: [{ sessionId: "s-1" }] }),
    ];
    expect(
      reviewContextForSession({ sessionId: "s-1" }, null, [], tasks).task,
    ).toBeUndefined();
  });

  it("ignores archived Tasks when disambiguating", () => {
    const tasks = [
      task({ sessionRefs: [{ sessionId: "s-1" }], archivedAt: 1 }),
      task({ id: "task-2", sessionRefs: [{ sessionId: "s-1" }] }),
    ];
    expect(
      reviewContextForSession({ sessionId: "s-1" }, null, [], tasks).task,
    ).toEqual({ taskId: "task-2", title: "Implement the thing" });
  });

  it("derives the project from the worktree, then from the Task", () => {
    expect(
      reviewContextForSession(
        { sessionId: "s-1", worktreeId: "wt-1" },
        [worktree()],
        [],
        [],
      ).projectId,
    ).toBe("proj-1");
    expect(
      reviewContextForSession(
        { sessionId: "s-1" },
        null,
        [],
        [task({ sessionRefs: [{ sessionId: "s-1" }], projectId: "proj-2" })],
      ).projectId,
    ).toBe("proj-2");
  });

  it("keeps the session's worktree id even when its record is unknown or removed", () => {
    // An unloaded worktree list must not drop a worktree the session really
    // runs in; only project/Task derivation needs the record.
    expect(
      reviewContextForSession(
        { sessionId: "s-1", worktreeId: "wt-1" },
        null,
        [],
        [],
      ),
    ).toEqual({ worktreeId: "wt-1" });
    expect(
      reviewContextForSession(
        { sessionId: "s-1", worktreeId: "wt-1" },
        [worktree({ removedAt: 5, taskIds: ["task-1"] })],
        [],
        [task()],
      ),
    ).toEqual({ worktreeId: "wt-1" });
  });

  it("degrades to nothing for a session that hangs off nothing", () => {
    expect(reviewContextForSession({ sessionId: "s-1" }, null, [], [])).toEqual(
      {},
    );
  });
});

describe("sessionContextForWorktree", () => {
  it("resolves the worktree's project and its single implementing Task", () => {
    expect(
      sessionContextForWorktree(
        "wt-1",
        [worktree({ taskIds: ["task-1"] })],
        [],
        [task()],
      ),
    ).toEqual({
      worktreeId: "wt-1",
      projectId: "proj-1",
      task: { taskId: "task-1", title: "Implement the thing" },
    });
  });

  it("attaches NO Task for zero or several linked Tasks", () => {
    expect(
      sessionContextForWorktree("wt-1", [worktree()], [], [task()]).task,
    ).toBeUndefined();
    expect(
      sessionContextForWorktree(
        "wt-1",
        [worktree({ taskIds: ["task-1", "task-2"] })],
        [],
        [task(), task({ id: "task-2" })],
      ).task,
    ).toBeUndefined();
  });

  it("falls back to the Task claiming a session that runs in the worktree", () => {
    // The `task —in_worktree→` edge is only written when the checkout was made
    // FOR the Task; a Task picked up later in an existing worktree links its
    // SESSION, and that is the link a new session here must inherit.
    expect(
      sessionContextForWorktree(
        "wt-1",
        [worktree()],
        [session({ id: "s-9" })],
        [task({ sessionRefs: [{ sessionId: "s-9" }] })],
      ).task,
    ).toEqual({ taskId: "task-1", title: "Implement the thing" });
  });

  it("ignores sessions that run in ANOTHER worktree", () => {
    expect(
      sessionContextForWorktree(
        "wt-1",
        [worktree()],
        [session({ id: "s-9", worktreeId: "wt-2" }), session({ id: "s-8" })],
        [task({ sessionRefs: [{ sessionId: "s-9" }] })],
      ).task,
    ).toBeUndefined();
  });

  it("treats an edge naming only archived Tasks as spent and uses the sessions", () => {
    // The checkout was created for work that is finished and has since been
    // reused; the Task worked in it now is the one the sessions name.
    expect(
      sessionContextForWorktree(
        "wt-1",
        [worktree({ taskIds: ["task-1"] })],
        [session({ id: "s-9" })],
        [
          task({ archivedAt: 1 }),
          task({ id: "task-2", sessionRefs: [{ sessionId: "s-9" }] }),
        ],
      ).task,
    ).toEqual({ taskId: "task-2", title: "Implement the thing" });
  });

  it("attaches NO Task when several Tasks were worked in the worktree", () => {
    expect(
      sessionContextForWorktree(
        "wt-1",
        [worktree()],
        [session({ id: "s-9" }), session({ id: "s-8" })],
        [
          task({ sessionRefs: [{ sessionId: "s-9" }] }),
          task({ id: "task-2", sessionRefs: [{ sessionId: "s-8" }] }),
        ],
      ).task,
    ).toBeUndefined();
  });

  it("prefers the worktree's own edge over the sessions that ran in it", () => {
    // An ambiguous edge stays ambiguous: the session fallback exists for
    // worktrees with NO edge, not as a tiebreaker for one.
    expect(
      sessionContextForWorktree(
        "wt-1",
        [worktree({ taskIds: ["task-1", "task-2"] })],
        [session({ id: "s-9" })],
        [
          task(),
          task({ id: "task-2" }),
          task({ id: "task-3", sessionRefs: [{ sessionId: "s-9" }] }),
        ],
      ).task,
    ).toBeUndefined();
  });

  it("keeps the worktree id without a live record but derives nothing from it", () => {
    expect(sessionContextForWorktree("wt-1", null, [], [])).toEqual({
      worktreeId: "wt-1",
    });
  });
});

describe("reviewAgentType", () => {
  it("uses the coding persona when a worktree is staged", () => {
    expect(reviewAgentType({ worktreeId: "wt-1" }, "workshop")).toBe(
      "workshop",
    );
    expect(reviewAgentType({ worktreeId: "wt-1" }, "developer")).toBe(
      "developer",
    );
  });

  it("degrades a worktree-less Developer to assistant (it could never be sent)", () => {
    expect(reviewAgentType({}, "developer")).toBe("assistant");
    expect(reviewAgentType({}, "workshop")).toBe("workshop");
  });
});

describe("appendReviewReportConvention", () => {
  it("appends the convention once to an edited review draft", () => {
    const edited = "Code-review this, including the migration.";
    const appended = appendReviewReportConvention(edited);
    expect(appended).toContain(edited);
    expect(appended).toContain("Review-report convention:");
    expect(appendReviewReportConvention(appended)).toBe(appended);
  });

  it("injects only at the App's staged /review first-send seam", () => {
    const app = readFileSync(
      fileURLToPath(new URL("../App.tsx", import.meta.url)),
      "utf8",
    );
    expect(app).toContain("!displayHasUserPrompt && sessionReviewDraft");
    expect(app).toContain("? appendReviewReportConvention(text)");
    expect((app.match(/additionalPrompt: sentText/g) ?? []).length).toBe(1);
    expect((app.match(/text: sentText/g) ?? []).length).toBe(2);
    expect(app).toContain("actions.prompt(\n        sentText,");
  });
});

describe("buildSessionReviewPrompt", () => {
  it("names the source session and stays a single short instruction", () => {
    const prompt = buildSessionReviewPrompt("session-abc");
    expect(prompt).toContain("`session-abc`");
    expect(prompt).toContain("Do not modify code.");
    expect(prompt).not.toContain("\n");
  });

  it("sends the review through session_send_prompt and ends the turn", () => {
    // The reviewer must not busy-wait: peer replies only reach an IDLE
    // session, so the draft asks for a response and then ends the turn.
    const prompt = buildSessionReviewPrompt("s-1");
    expect(prompt).toContain("session_send_prompt");
    expect(prompt).toContain("end your turn");
    expect(prompt).not.toContain("stay in the loop");
  });

  it("appends /review args as a second paragraph, trimmed", () => {
    expect(buildSessionReviewPrompt("s-1", "  focus on the tests  ")).toMatch(
      /reply\.\n\nfocus on the tests$/,
    );
    expect(buildSessionReviewPrompt("s-1", "   ")).not.toContain("\n");
  });
});

describe("pullRequestReviewContext", () => {
  const source = (
    overrides: Partial<Parameters<typeof pullRequestReviewContext>[0]> = {},
  ) => ({
    worktreeId: "wt-1",
    projectId: "proj-1",
    checkoutTaskIds: [] as string[],
    pullRequestTaskIds: [] as string[],
    ...overrides,
  });
  const lists = (
    tasks: TaskSummary[],
    sessions: SessionListItem[] = [],
    fresh = true,
  ) => ({
    sessions: { rows: sessions, fresh },
    tasks: { rows: tasks, fresh },
  });

  it("uses the checkout's OWN Task, as the server reported it", () => {
    expect(
      pullRequestReviewContext(
        source({ checkoutTaskIds: ["task-1"], pullRequestTaskIds: ["task-2"] }),
        lists([task({ id: "task-1" }), task({ id: "task-2" })]),
      ),
    ).toEqual({
      worktreeId: "wt-1",
      projectId: "proj-1",
      task: { taskId: "task-1", title: "Implement the thing" },
    });
  });

  it("falls back to the pull request's own single Task", () => {
    // A Task linked through the `/pr` card rather than through the checkout:
    // reachable only because the checkout answered that it has NONE.
    expect(
      pullRequestReviewContext(
        source({ pullRequestTaskIds: ["task-9"] }),
        lists([task({ id: "task-9", title: "Ship the view" })]),
      ).task,
    ).toEqual({ taskId: "task-9", title: "Ship the view" });
  });

  it("attaches nothing when the pull request names several Tasks", () => {
    expect(
      pullRequestReviewContext(
        source({ pullRequestTaskIds: ["task-1", "task-2"] }),
        lists([task({ id: "task-1" }), task({ id: "task-2" })]),
      ).task,
    ).toBeUndefined();
  });

  it("takes a Task claiming a session in the checkout over the card's", () => {
    expect(
      pullRequestReviewContext(
        source({ pullRequestTaskIds: ["task-card"] }),
        lists(
          [
            task({ id: "task-here", sessionRefs: [{ sessionId: "s-1" }] }),
            task({ id: "task-card" }),
          ],
          [session({ id: "s-1", worktreeId: "wt-1" })],
        ),
      ).task?.taskId,
    ).toBe("task-here");
  });

  // The failure this shape exists to prevent: a list that has not answered is
  // not a list that says NO. Neither of these may reach the weaker link.
  it("does not fall back while the client rule cannot be answered", () => {
    for (const cold of [
      {
        sessions: { rows: null, fresh: false },
        tasks: { rows: [task({ id: "task-9" })], fresh: true },
      },
      {
        sessions: { rows: [], fresh: true },
        tasks: { rows: null, fresh: false },
      },
    ]) {
      expect(
        pullRequestReviewContext(
          source({ pullRequestTaskIds: ["task-9"] }),
          cold,
        ).task,
      ).toBeUndefined();
    }
  });

  // The other half of the same rule: the checkout's OWN id is authoritative, so
  // a list that cannot confirm it must not make it disappear.
  it("stages a server id no ANSWERED list has ruled out", () => {
    expect(
      pullRequestReviewContext(source({ checkoutTaskIds: ["task-7"] }), {
        sessions: { rows: null, fresh: false },
        tasks: { rows: null, fresh: false },
      }).task,
    ).toEqual({ taskId: "task-7", title: "Task-task-7" });
  });

  // An archived Task is not IN the live projection a fresh list is built from —
  // `taskSummaryFor` answers null for one, so it LEAVES the list rather than
  // appearing with an `archivedAt`. Absence in a fresh list is therefore the
  // answer "spent", and staging `Task-<id>` for it would link an archived Task
  // on the first send.
  it("treats an id a FRESH list does not hold as spent", () => {
    expect(
      pullRequestReviewContext(
        source({ checkoutTaskIds: ["task-archived"] }),
        lists([task({ id: "task-other" })]),
      ).task,
    ).toBeUndefined();
    expect(
      pullRequestReviewContext(
        source({ pullRequestTaskIds: ["task-archived"] }),
        lists([task({ id: "task-other" })]),
      ).task,
    ).toBeUndefined();
  });

  // The same rule's other half: a SPENT tier is not a reason to attach nothing,
  // so the next tier gets its turn — as the worktree handoff already did.
  it("moves to the next tier when the checkout's edge is spent", () => {
    expect(
      pullRequestReviewContext(
        source({
          checkoutTaskIds: ["task-archived"],
          pullRequestTaskIds: ["task-card"],
        }),
        lists(
          [
            task({ id: "task-here", sessionRefs: [{ sessionId: "s-1" }] }),
            task({ id: "task-card" }),
          ],
          [session({ id: "s-1", worktreeId: "wt-1" })],
        ),
      ).task?.taskId,
    ).toBe("task-here");
    // …and all the way down when the session tier is empty too.
    expect(
      pullRequestReviewContext(
        source({
          checkoutTaskIds: ["task-archived"],
          pullRequestTaskIds: ["task-card"],
        }),
        lists([task({ id: "task-card", title: "Card Task" })]),
      ).task,
    ).toEqual({ taskId: "task-card", title: "Card Task" });
  });

  it("drops a row that does carry archivedAt, whatever list shape produced it", () => {
    expect(
      pullRequestReviewContext(
        source({ checkoutTaskIds: ["task-1"] }),
        lists([task({ id: "task-1", archivedAt: 1 })]),
      ).task,
    ).toBeUndefined();
  });

  it("keeps the project even with nothing else resolved", () => {
    expect(
      pullRequestReviewContext(source(), {
        sessions: { rows: null, fresh: false },
        tasks: { rows: null, fresh: false },
      }),
    ).toEqual({ worktreeId: "wt-1", projectId: "proj-1" });
  });
});

describe("buildPullRequestReviewPrompt", () => {
  const prompt = buildPullRequestReviewPrompt({
    number: 312,
    title: "Add the Pull Requests view",
    url: "https://forge/acme/pa/pulls/312",
    repositoryKey: "acme/pa",
    baseBranch: "main",
    headBranch: "pull-requests",
  });

  it("names the pull request, its range and its URL", () => {
    // Everything the agent needs to know WHICH change it is looking at: it
    // lands in a checkout, and this prose is all the context it gets.
    expect(prompt).toContain("#312");
    expect(prompt).toContain("Add the Pull Requests view");
    expect(prompt).toContain("acme/pa");
    expect(prompt).toContain("`main...pull-requests`");
    expect(prompt).toContain("https://forge/acme/pa/pulls/312");
  });

  it("stays a short review instruction that writes no code", () => {
    expect(prompt).toContain("do not modify it");
    expect(prompt.length).toBeLessThan(600);
  });
});

describe("the Pull Requests view's review staging", () => {
  // No test renders `App.tsx` (it is the shell), so the staging seam is held
  // to its shape HERE: the review must reuse the one staged-composer path and
  // must not send anything. Both fail silently — a second staging path drifts
  // from this one, and a send turns an editable draft into an injection.
  const app = readFileSync(
    fileURLToPath(new URL("../App.tsx", import.meta.url)),
    "utf8",
  );
  const handler = app.slice(
    app.indexOf("const startPullRequestReviewDraft = useCallback("),
    app.indexOf("const startWorktreeReviewDraft = useCallback("),
  );

  it("stages the project, the worktree, the Task and the prompt", () => {
    expect(handler).toContain("pullRequestReviewContext(");
    expect(handler).toContain("setPendingProjectContext(");
    expect(handler).toContain("setPendingWorktreeContext(worktreeId)");
    expect(handler).toContain("setPendingTaskAttach(context.task ?? null)");
    expect(handler).toContain("buildPullRequestReviewPrompt(item)");
    expect(handler).toContain("navigate(SESSIONS_CREATE_PATH)");
    expect(handler).toContain("startStagedSession(");
  });

  it("decides the Task from server ids, with the lists' currency alongside", () => {
    // The staged Task must not depend on how fresh this browser's lists are:
    // the checkout's own ids come from the answer, and the lists travel WITH
    // their freshness for the one rule that is genuinely client-side.
    expect(handler).toContain("checkoutTaskIds:");
    expect(handler).toContain("outcome.taskIds");
    expect(handler).toContain("pullRequestTaskIds: item.taskIds");
    expect(handler).toContain("fresh: state.sessionListFresh");
    expect(handler).toContain("fresh: state.taskListFresh");
    // The cold-list trap: no raw list may reach the derivation without one.
    expect(handler).not.toContain("state.worktrees,");
  });

  it("sends nothing: the composer lands with the draft in it", () => {
    expect(handler).not.toContain("actions.prompt(");
    expect(handler).not.toContain("harnessSend");
    expect(handler).not.toContain("submitWorktreeReview");
  });

  it("leaves the runtime at the ordinary new-session default", () => {
    // A review wants an independent look, exactly as the `/review` handoff:
    // model, provider and thinking stay the user's pick.
    expect(handler).toContain("newSessionRuntimeDefaults(");
    expect(handler).toContain(
      "reviewAgentType(context, defaultCodingAgentType)",
    );
  });
});
