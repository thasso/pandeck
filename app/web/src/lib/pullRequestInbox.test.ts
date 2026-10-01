import { describe, expect, it } from "vitest";
import type { PullRequestInventoryItem } from "@assistant/shared";
import {
  buildPullRequestInbox,
  classifyPullRequest,
  comparePullRequests,
  isPullRequestTarget,
  matchesPullRequestQuery,
  pullRequestCiState,
  pullRequestDetailState,
  pullRequestMergeability,
  pullRequestMergeBlockedReason,
  pullRequestReviewState,
  pullRequestRowId,
  pullRequestJoinSources,
  pullRequestStateLabel,
  pullRequestTargetOf,
  resolveJoinRows,
  PULL_REQUEST_GROUPS,
} from "./pullRequestInbox.ts";
import { failed, loading, ready, refreshing } from "./loadState.ts";

function pr(
  patch: Partial<PullRequestInventoryItem> = {},
): PullRequestInventoryItem {
  return {
    projectId: "pa",
    provider: "forgejo",
    repositoryKey: "acme/pa",
    repoWebUrl: "https://forge/acme/pa",
    number: 7,
    url: "https://forge/acme/pa/pulls/7",
    title: "Add the Pull Requests view",
    headBranch: "pull-requests",
    baseBranch: "main",
    mine: true,
    reviewRequested: false,
    state: "open",
    sessionIds: [],
    taskIds: [],
    ...patch,
  };
}

describe("grouping", () => {
  it("renders the three groups in a fixed order", () => {
    expect(PULL_REQUEST_GROUPS.map((group) => group.id)).toEqual([
      "needs-review",
      "yours",
      "cleanup",
    ]);
  });

  it("puts a review request above your own authorship", () => {
    // Someone is blocked on it, which outranks the fact that you opened it.
    expect(classifyPullRequest(pr({ mine: true, reviewRequested: true }))).toBe(
      "needs-review",
    );
    expect(classifyPullRequest(pr({ mine: true }))).toBe("yours");
  });

  it("files every terminal pull request under cleanup", () => {
    // The server inventories one ONLY while a worktree still holds its branch,
    // so the checkout is the whole reason it is listed — even for a review
    // request that has since been merged.
    expect(
      classifyPullRequest(
        pr({ state: "merged", reviewRequested: true, worktreeId: "wt" }),
      ),
    ).toBe("cleanup");
    expect(classifyPullRequest(pr({ state: "closed" }))).toBe("cleanup");
  });

  it("omits a group with no rows rather than drawing an empty heading", () => {
    const view = buildPullRequestInbox([pr()]);
    expect(view.groups.map((group) => group.id)).toEqual(["yours"]);
    expect(view.total).toBe(1);
    expect(view.empty).toBe(false);
  });

  it("is empty only when nothing matched", () => {
    expect(buildPullRequestInbox([]).empty).toBe(true);
    expect(buildPullRequestInbox([pr()], { query: "nothing" }).empty).toBe(
      true,
    );
  });
});

describe("ordering", () => {
  it("puts the most recently updated first", () => {
    const view = buildPullRequestInbox([
      pr({ number: 1, updatedAt: 10 }),
      pr({ number: 2, updatedAt: 30 }),
      pr({ number: 3, updatedAt: 20 }),
    ]);
    expect(view.groups[0]!.items.map((item) => item.number)).toEqual([2, 3, 1]);
  });

  it("sorts an unknown timestamp last rather than first", () => {
    // Absent means unknown, and unknown must not win the top of the list.
    const view = buildPullRequestInbox([
      pr({ number: 1 }),
      pr({ number: 2, updatedAt: 5 }),
    ]);
    expect(view.groups[0]!.items.map((item) => item.number)).toEqual([2, 1]);
  });

  it("is TOTAL: a tie resolves by row id, both ways round", () => {
    const a = pr({ number: 1, updatedAt: 9 });
    const b = pr({ number: 2, updatedAt: 9 });
    expect(comparePullRequests(a, b)).toBeLessThan(0);
    expect(comparePullRequests(b, a)).toBeGreaterThan(0);
    expect(comparePullRequests(a, a)).toBe(0);
  });

  it("separates the same number in two repositories", () => {
    // One project can hold two of them (a `pushurl` repository), and every
    // repository has a #7 — so the number alone is not an identity. The server
    // emits exactly this pair (`pullRequestInventory.test.ts`).
    const here = pr();
    const elsewhere = pr({
      repositoryKey: "acme/other",
      repoWebUrl: "https://forge/acme/other",
    });
    expect(pullRequestRowId(here)).not.toBe(pullRequestRowId(elsewhere));
    expect(comparePullRequests(here, elsewhere)).not.toBe(0);
    // And the target each row hands back addresses only its own.
    expect(isPullRequestTarget(here, pullRequestTargetOf(here))).toBe(true);
    expect(isPullRequestTarget(elsewhere, pullRequestTargetOf(here))).toBe(
      false,
    );
  });

  it("separates the same owner/repo under two providers", () => {
    // `owner/repo` is unique within a provider, not across them.
    const forgejo = pr();
    const github = pr({
      provider: "github",
      repoWebUrl: "https://github.com/acme/pa",
    });
    expect(pullRequestRowId(forgejo)).not.toBe(pullRequestRowId(github));
    expect(comparePullRequests(forgejo, github)).not.toBe(0);
    expect(isPullRequestTarget(github, pullRequestTargetOf(forgejo))).toBe(
      false,
    );
  });
});

describe("search", () => {
  const item = pr({ title: "Ship the inbox", headBranch: "inbox-ship" });

  it("matches the title, both branches and the author", () => {
    expect(matchesPullRequestQuery(item, "inbox")).toBe(true);
    expect(matchesPullRequestQuery(item, "main")).toBe(true);
    expect(matchesPullRequestQuery(pr({ author: "ada" }), "ada")).toBe(true);
    expect(matchesPullRequestQuery(item, "nothing here")).toBe(false);
  });

  it("matches the number with or without the hash", () => {
    expect(matchesPullRequestQuery(item, "#7")).toBe(true);
    expect(matchesPullRequestQuery(item, "7")).toBe(true);
    expect(matchesPullRequestQuery(item, "#8")).toBe(false);
  });

  it("matches what the row DISPLAYS for the project", () => {
    expect(
      matchesPullRequestQuery(item, "pandeck", {
        projectLabels: { pa: "PA Pandeck" },
      }),
    ).toBe(true);
  });

  it("matches everything when the query is empty", () => {
    expect(matchesPullRequestQuery(item, "")).toBe(true);
    expect(matchesPullRequestQuery(item, "   ")).toBe(true);
  });

  it("normalizes the needle itself, so a direct caller cannot get it wrong", () => {
    expect(matchesPullRequestQuery(item, "INBOX")).toBe(true);
    expect(matchesPullRequestQuery(item, "  Inbox  ")).toBe(true);
  });
});

describe("status vocabulary", () => {
  it("distinguishes an unread CI from a head with no checks", () => {
    // Absent on an OPEN pull request is a provider we could not ask; on a
    // terminal one there is nothing left to have checked.
    expect(pullRequestCiState(pr()).tone).toBe("unknown");
    expect(pullRequestCiState(pr({ state: "merged" })).tone).toBe("none");
    expect(
      pullRequestCiState(pr({ ci: { state: "failure", total: 3 } })),
    ).toEqual({ tone: "failure", label: "CI failed (3 checks)" });
    expect(
      pullRequestCiState(pr({ ci: { state: "pending", total: 1 } })).label,
    ).toBe("CI running (1 check)");
  });

  it("never reports zero unresolved threads the provider could not count", () => {
    // `unresolvedThreads` is optional precisely because REST cannot always
    // tell, and a 0 there would read as "all resolved".
    expect(
      pullRequestReviewState(pr({ review: { changesRequested: false } })).tone,
    ).toBe("clear");
    expect(
      pullRequestReviewState(
        pr({ review: { changesRequested: false, unresolvedThreads: 2 } }),
      ),
    ).toEqual({ tone: "unresolved", label: "2 unresolved threads" });
    expect(
      pullRequestReviewState(pr({ review: { changesRequested: true } })).tone,
    ).toBe("changes-requested");
  });

  it("states an unread review as unknown, not as agreement", () => {
    expect(pullRequestReviewState(pr()).tone).toBe("unknown");
    expect(pullRequestReviewState(pr({ reviewRequested: true })).tone).toBe(
      "requested",
    );
  });

  it("never renders an unfinished mergeability check as a conflict", () => {
    // `null` is the provider still computing — GitHub right after a push, and
    // every Forgejo draft through the seam's mapping.
    expect(pullRequestMergeability(pr({ mergeable: null })).tone).toBe(
      "checking",
    );
    expect(pullRequestMergeability(pr({ mergeable: false })).tone).toBe(
      "conflicts",
    );
    expect(pullRequestMergeability(pr({ mergeable: true })).tone).toBe(
      "mergeable",
    );
    expect(pullRequestMergeability(pr()).tone).toBe("unknown");
    expect(pullRequestMergeability(pr({ state: "merged" })).tone).toBe(
      "not-applicable",
    );
  });

  it("marks a draft as its own state", () => {
    expect(pullRequestStateLabel(pr({ draft: true })).tone).toBe("draft");
    expect(pullRequestStateLabel(pr()).tone).toBe("open");
    expect(pullRequestStateLabel(pr({ state: "closed" })).tone).toBe("closed");
  });
});

describe("pullRequestMergeBlockedReason", () => {
  const mergeable = {
    mergeable: true,
    capabilities: { mergeMethods: ["squash" as const] },
  };

  it("blocks only on answers that are KNOWN", () => {
    expect(pullRequestMergeBlockedReason(pr(mergeable))).toBeUndefined();
    // Still being computed, and not read at all: neither is a conflict, and the
    // provider stays the authority on whether the merge is allowed.
    expect(
      pullRequestMergeBlockedReason(pr({ ...mergeable, mergeable: null })),
    ).toBeUndefined();
    expect(
      pullRequestMergeBlockedReason(
        pr({ capabilities: mergeable.capabilities }),
      ),
    ).toBeUndefined();
    expect(
      pullRequestMergeBlockedReason(pr({ ...mergeable, mergeable: false })),
    ).toMatch(/conflicts with main/);
  });

  it("fails closed on capabilities, and says why", () => {
    expect(pullRequestMergeBlockedReason(pr({ mergeable: true }))).toMatch(
      /could not be read, so no merge is offered/,
    );
    expect(
      pullRequestMergeBlockedReason(
        pr({ mergeable: true, capabilities: { unknownReason: "403" } }),
      ),
    ).toMatch(/\(403\)/);
    // An EMPTY set is a real answer, and a different sentence from unknown.
    expect(
      pullRequestMergeBlockedReason(
        pr({ mergeable: true, capabilities: { mergeMethods: [] } }),
      ),
    ).toMatch(/allows no merge method/);
  });

  it("blocks a draft, and says nothing about a terminal pull request", () => {
    expect(
      pullRequestMergeBlockedReason(pr({ ...mergeable, draft: true })),
    ).toMatch(/is a draft/);
    // Nothing to merge is not a blocked merge: the cleanup half still applies.
    expect(
      pullRequestMergeBlockedReason(pr({ state: "merged" })),
    ).toBeUndefined();
  });
});

describe("pullRequestDetailState", () => {
  const target = {
    projectId: "pa",
    provider: "forgejo" as const,
    repositoryKey: "acme/pa",
    number: 7,
  };

  it("is idle with nothing addressed", () => {
    expect(pullRequestDetailState(ready([pr()]), null).status).toBe("idle");
  });

  it("says LOADING, never 'not found', while the inventory is silent (R1)", () => {
    expect(pullRequestDetailState(loading(), target).status).toBe("loading");
  });

  it("says not-found only once the inventory answered", () => {
    expect(pullRequestDetailState(ready([]), target)).toEqual({
      status: "ready",
      data: null,
    });
  });

  it("keeps the item through a poll and through a failed poll (R2)", () => {
    const item = pr();
    expect(pullRequestDetailState(refreshing([item]), target)).toEqual({
      status: "refreshing",
      data: item,
    });
    expect(pullRequestDetailState(failed("boom", [item]), target)).toEqual({
      status: "error",
      error: "boom",
      data: item,
    });
  });

  it("carries a failure with no data as a plain error", () => {
    expect(pullRequestDetailState(failed("boom"), target)).toEqual({
      status: "error",
      error: "boom",
    });
  });

  it("resolves on ALL FOUR components, never on a subset", () => {
    // Every collision the server can actually produce, one per component:
    // another project's #7; the SAME project's other repository's #7 (a
    // `pushurl` fork); and the same `owner/repo` under the other provider,
    // which is only unique within one. Any of them answering here opens the
    // wrong pull request.
    expect(
      pullRequestDetailState(ready([pr({ projectId: "other" })]), target),
    ).toEqual({ status: "ready", data: null });
    expect(
      pullRequestDetailState(
        ready([
          pr({
            repositoryKey: "acme/pa-fork",
            repoWebUrl: "https://forge/acme/pa-fork",
          }),
        ]),
        target,
      ),
    ).toEqual({ status: "ready", data: null });
    expect(
      pullRequestDetailState(
        ready([
          pr({
            provider: "github",
            repoWebUrl: "https://github.com/acme/pa",
          }),
        ]),
        target,
      ),
    ).toEqual({ status: "ready", data: null });
  });
});

describe("join sources", () => {
  const rows = [{ id: "a" }, { id: "b" }];
  const identify = (row: { id: string }) => row.id;

  it("resolves a present id however stale the list is", () => {
    for (const fresh of [true, false]) {
      expect(resolveJoinRows(["a"], { rows, fresh }, identify)).toEqual([
        { kind: "resolved", id: "a", row: rows[0] },
      ]);
    }
  });

  it("calls a missing id ABSENT only against a fresh list", () => {
    // The whole rule. A cold, stale or failed list is missing exactly what was
    // linked a moment ago, so quoting it as evidence is how a refresh
    // announces that a pull request has no Task.
    expect(resolveJoinRows(["z"], { rows, fresh: true }, identify)).toEqual([
      { kind: "absent", id: "z" },
    ]);
    expect(resolveJoinRows(["z"], { rows, fresh: false }, identify)).toEqual([
      { kind: "pending", id: "z" },
    ]);
    expect(
      resolveJoinRows(
        ["z"],
        { rows, fresh: false, error: "unavailable" },
        identify,
      ),
    ).toEqual([{ kind: "pending", id: "z" }]);
    expect(
      resolveJoinRows(["z"], { rows: null, fresh: true }, identify),
    ).toEqual([{ kind: "pending", id: "z" }]);
  });

  it("maps app state onto the three sources WITH their currency", () => {
    // The guard against the one-character regression: a future `?? []` or a
    // dropped `fresh` here turns "not answered yet" into "there are none".
    const state = {
      worktrees: [],
      worktreesFresh: true,
      worktreeListError: null,
      taskList: null,
      taskListFresh: false,
      taskListError: "Task list unavailable",
      sessions: [],
      sessionListFresh: true,
    };
    expect(pullRequestJoinSources(state)).toEqual({
      worktrees: { rows: [], fresh: true },
      sessions: { rows: [], fresh: true },
      // An unanswered Task list stays NULL — never `[]` — and carries its
      // failure so the page can state it beside whatever it retained.
      tasks: { rows: null, fresh: false, error: "Task list unavailable" },
    });
  });

  it("reads each source's OWN current-episode freshness", () => {
    // Sessions in particular: `hooks/useAssistant.ts` owns that flag because
    // the derivation that looks right (`connected && hydrationSource ===
    // "live"`) is historical and blesses previous-episode rows in the
    // reconnect window. This mapper must read the flag, never re-derive it.
    const base = {
      worktrees: null,
      worktreesFresh: false,
      worktreeListError: null,
      taskList: null,
      taskListFresh: false,
      taskListError: null,
      sessions: [],
      sessionListFresh: true,
    };
    expect(pullRequestJoinSources(base).sessions.fresh).toBe(true);
    expect(
      pullRequestJoinSources({ ...base, sessionListFresh: false }).sessions
        .fresh,
    ).toBe(false);
  });
});
