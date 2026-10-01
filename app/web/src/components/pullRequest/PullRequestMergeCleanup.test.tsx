// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PullRequestInventoryItem,
  PullRequestViewCheckRequest,
  PullRequestViewCheckResponse,
  PullRequestViewMergeRequest,
  PullRequestViewMergeResponse,
  SessionListItem,
  TaskSummary,
  WorktreeRecord,
} from "@assistant/shared";

/**
 * Merge & clean up, from the Pull Requests view's object panel.
 *
 * The dialog is a CONSENT surface, so what it says has to be what the click
 * will do: the sentence under each control follows that control, the picker
 * offers only what the repository reported (and unknown offers nothing), and a
 * known conflict disables the action with its reason — `mergeable: null` is
 * the provider still checking and keeps merging on offer.
 *
 * The outcome is held to the same standard. Two phases are reported separately
 * because they can end differently: a merge that LANDED is never re-offered and
 * never reported as a failure, a cleanup refusal stays inline on the object
 * that is still there, and only a refusal `force` can answer arms the consent —
 * a session gate never does.
 */

const requests: PullRequestViewMergeRequest[] = [];
const toasts: string[] = [];
let response: PullRequestViewMergeResponse | Error;
/**
 * Answers for CONSECUTIVE merge requests, when a case needs them to differ — a
 * lost response first, then whatever a retry gets. An empty queue falls back to
 * `response`.
 */
const queued: (PullRequestViewMergeResponse | Error)[] = [];

/** The state CHECK: what the pull request is, answered under its own lock. */
const checks: PullRequestViewCheckRequest[] = [];
const checkQueue: (PullRequestViewCheckResponse | Error)[] = [];

vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showToast: (message: string) => toasts.push(message),
}));

// The real module's error CLASS is kept: telling an answered refusal from a
// dropped response is the whole point of it, so a mock that replaced it would
// test a distinction the app does not make.
vi.mock("../../lib/pullRequestsApi.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  mergePullRequestFromView: async (request: PullRequestViewMergeRequest) => {
    requests.push(request);
    const answer = queued.shift() ?? response;
    if (answer instanceof Error) throw answer;
    return answer;
  },
  checkPullRequestFromView: async (request: PullRequestViewCheckRequest) => {
    checks.push(request);
    const answer = checkQueue.shift();
    if (!answer) throw new Error("no check answer was queued for this request");
    if (answer instanceof Error) throw answer;
    return answer;
  },
}));

const { PullRequestInspector } = await import("../objectInspectors.tsx");
const { PullRequestApiError } = await import("../../lib/pullRequestsApi.ts");
const { ready } = await import("../../lib/loadState.ts");

const TARGET = {
  projectId: "pa",
  provider: "forgejo" as const,
  repositoryKey: "acme/pa",
  number: 7,
};

function pr(
  patch: Partial<PullRequestInventoryItem> = {},
): PullRequestInventoryItem {
  const base: PullRequestInventoryItem = {
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
  };
  // A TERMINAL pull request carries no mergeability and no capabilities — the
  // server does not read them for one — so the fixture does not either.
  return patch.state && patch.state !== "open"
    ? { ...base, ...patch }
    : {
        ...base,
        mergeable: true,
        capabilities: {
          defaultBranch: "main",
          mergeMethods: ["squash", "merge"],
          canDeleteBranchOnMerge: true,
        },
        ...patch,
      };
}

function merged(
  patch: Partial<PullRequestViewMergeResponse> = {},
): PullRequestViewMergeResponse {
  return {
    number: 7,
    merge: {
      status: "merged",
      method: "squash",
      headBranch: "pull-requests",
      baseBranch: "main",
      remoteBranch: "deleted",
    },
    cleanup: { status: "not-requested" },
    taskSuggestions: [],
    ...patch,
  };
}

let host: HTMLDivElement;
let root: Root | undefined;
let reloads = 0;

beforeEach(() => {
  requests.length = 0;
  queued.length = 0;
  checks.length = 0;
  checkQueue.length = 0;
  toasts.length = 0;
  reloads = 0;
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

async function render(item: PullRequestInventoryItem): Promise<void> {
  const element = (
    <PullRequestInspector
      state={ready(item)}
      projects={[]}
      joins={{
        worktrees: { rows: [] as WorktreeRecord[], fresh: true },
        sessions: { rows: [] as SessionListItem[], fresh: true },
        tasks: { rows: [] as TaskSummary[], fresh: true },
      }}
      openers={{
        onOpenTask: () => {},
        onOpenProject: () => {},
        onOpenSession: () => {},
        onOpenWorktree: () => {},
        onOpenKnowledge: () => {},
      }}
      onStartSession={() => {}}
      onReview={() => {}}
      onReload={() => {
        reloads += 1;
      }}
    />
  );
  await act(async () => {
    if (root) root.render(element);
    else {
      root = createRoot(host);
      root.render(element);
    }
  });
}

function button(label: RegExp, scope: ParentNode = host): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((element) =>
    label.test(element.textContent ?? ""),
  );
  if (!(found instanceof HTMLButtonElement))
    throw new Error(`no button matching ${String(label)}`);
  return found;
}

/**
 * The dialog's OWN confirming button. The panel's row carries the same words —
 * that is the point, it opens what it promises — so a search over the whole
 * document would click the row again and assert nothing.
 */
function confirm(label: RegExp): HTMLButtonElement {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error("no dialog is open");
  return button(label, dialog);
}

function checkbox(label: RegExp): HTMLInputElement {
  const found = [...document.querySelectorAll("label")].find((element) =>
    label.test(element.textContent ?? ""),
  );
  const input = found?.querySelector("input[type=checkbox]");
  if (!(input instanceof HTMLInputElement))
    throw new Error(`no checkbox labelled ${String(label)}`);
  return input;
}

function optionalCheckbox(label: RegExp): HTMLInputElement | undefined {
  const found = [...document.querySelectorAll("label")].find((element) =>
    label.test(element.textContent ?? ""),
  );
  const input = found?.querySelector("input[type=checkbox]");
  return input instanceof HTMLInputElement ? input : undefined;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/**
 * Let a chain that CONTINUES after its first response settle — the automatic
 * recovery a lost response starts. `act` flushes React, not a second round trip
 * the handler makes on its own.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/* ------------------------------ the sentences ------------------------------ */

it("states what THIS click will do, per control, before it is clicked", async () => {
  response = merged();
  await render(pr({ worktreeId: "wt-1" }));
  await click(button(/Merge & clean up/));

  expect(document.body.textContent).toContain(
    "The remote branch pull-requests is deleted with the merge.",
  );
  expect(document.body.textContent).toContain(
    "The checkout of pull-requests is removed once delivery into main is verified",
  );

  // Opting out rewrites both sentences, because they describe the click and not
  // the default.
  await click(checkbox(/Delete the remote branch/));
  await click(checkbox(/Remove the local worktree/));
  expect(document.body.textContent).toContain(
    "The remote branch pull-requests is kept.",
  );
  expect(document.body.textContent).toContain(
    "The local checkout of pull-requests is kept",
  );

  await click(confirm(/^Merge$/));
  expect(requests).toEqual([
    {
      projectId: "pa",
      provider: "forgejo",
      repositoryKey: "acme/pa",
      number: 7,
      method: "squash",
      deleteRemoteBranch: false,
      removeWorktree: false,
    },
  ]);
  // Every component of the identity travels; nothing else does.
  expect(requests[0]).not.toHaveProperty("headBranch");
  expect(requests[0]).not.toHaveProperty("worktreeId");
});

it("offers only the merge methods the repository reported", async () => {
  response = merged();
  await render(pr({ capabilities: { mergeMethods: ["merge"] } }));
  await click(button(/Merge & clean up/));

  const methods = [...document.querySelectorAll("label")]
    .filter((label) => label.querySelector("input[type=radio]"))
    .map((label) => label.textContent ?? "");
  expect(methods).toHaveLength(1);
  expect(methods[0]).toContain("Merge commit");
});

it("offers no merge at all while the repository's methods are unknown", async () => {
  response = merged();
  await render(pr({ capabilities: { unknownReason: "403 from the API" } }));

  // Fail closed: the action is disabled and says why (the page states the
  // same sentence as text, since a disabled row's tooltip reaches no phone).
  expect(button(/Merge & clean up/).disabled).toBe(true);
  expect(button(/Merge & clean up/).title).toBe(
    "The merge methods this repository allows could not be read (403 from the API), so no merge is offered.",
  );
});

/* ------------------------------- mergeability ------------------------------ */

it("disables merging on a known conflict, with the reason", async () => {
  response = merged();
  await render(pr({ mergeable: false }));

  expect(button(/Merge & clean up/).disabled).toBe(true);
  expect(button(/Merge & clean up/).title).toBe(
    "#7 conflicts with main. Merging is not offered until the branch is updated.",
  );
});

it("keeps merging on offer while the provider is still checking", async () => {
  response = merged();
  await render(pr({ mergeable: null }));

  // `mergeable: null` is "ask again", never a conflict.
  expect(button(/Merge & clean up/).disabled).toBe(false);
  expect(button(/Merge & clean up/).title).toBe("");
});

/* -------------------------------- outcomes --------------------------------- */

it("reports a landed merge as landed when the cleanup refuses, and escalates", async () => {
  response = merged({
    cleanup: {
      status: "refused",
      worktreeId: "wt-1",
      refusal: "pull-requests is not contained in the refreshed main.",
      refusalKind: "delivery",
    },
  });
  await render(pr({ worktreeId: "wt-1" }));
  await click(button(/Merge & clean up/));
  await click(confirm(/^Merge & clean up$/));

  // The merge is stated, the refusal is inline on the dialog that asked for it,
  // and nothing is announced: the object is still on screen.
  expect(document.body.textContent).toContain(
    "Merged into main (squash). Deleted the remote branch pull-requests.",
  );
  expect(document.body.textContent).toContain(
    "is not contained in the refreshed",
  );
  expect(toasts).toEqual([]);
  expect(reloads).toBe(1);

  // The merge is not offered a second time; only the cleanup is left.
  expect(document.querySelectorAll("input[type=radio]")).toHaveLength(0);

  response = merged({
    merge: { status: "already-terminal", state: "merged" },
    cleanup: {
      status: "retired",
      worktreeId: "wt-1",
      branch: "pull-requests",
      baseBranch: "main",
      branchDeleted: true,
      settledSessions: 2,
      deliveryVerified: false,
    },
  });
  const consent = optionalCheckbox(/I understand/);
  if (!consent) throw new Error("a delivery refusal must offer the consent");
  await click(consent);
  await click(confirm(/Clean up/));

  expect(requests[1]).toMatchObject({
    number: 7,
    removeWorktree: true,
    forceRemoveWorktree: true,
  });
  // The toast is the sanctioned one — the object left the inventory with its
  // checkout — and it reports what the run did: a forced removal SKIPPED the
  // delivery check and says so.
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain("WITHOUT verifying delivery into main");
});

it("never offers force as an answer to a session gate", async () => {
  response = merged({
    cleanup: {
      status: "refused",
      worktreeId: "wt-1",
      refusal: "a session is still running in it.",
      refusalKind: "sessions",
    },
  });
  await render(pr({ worktreeId: "wt-1" }));
  await click(button(/Merge & clean up/));
  await click(confirm(/^Merge & clean up$/));

  expect(document.body.textContent).toContain(
    "a session is still running in it.",
  );
  expect(optionalCheckbox(/I understand/)).toBeUndefined();
});

it("announces the outcome only once the object is gone", async () => {
  // Kept checkout: the pull request stays listed as cleanup, the state change
  // speaks for itself on the object, and success is silent.
  response = merged({ cleanup: { status: "not-requested" } });
  await render(pr({ worktreeId: "wt-1" }));
  await click(button(/Merge & clean up/));
  await click(checkbox(/Remove the local worktree/));
  await click(confirm(/^Merge$/));
  expect(toasts).toEqual([]);
  expect(reloads).toBe(1);

  // No checkout at all: merging takes the pull request out of the view, so the
  // outcome has nothing left to sit on and is announced, naming it.
  response = merged({
    cleanup: { status: "not-requested" },
    taskSuggestions: [{ id: "704" } as TaskSummary],
  });
  await render(pr());
  await click(button(/Merge & clean up/));
  await click(confirm(/^Merge$/));
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain("#7:");
  expect(toasts[0]).toContain("Merged into main (squash).");
  expect(toasts[0]).toContain("Suggested done on Task-704.");
});

it("states an ANSWERED failure inline on the object, and arms no consent", async () => {
  // Answered, so nothing landed and nothing is uncertain: it is stated where
  // the retry is, and it buys no consent.
  response = new PullRequestApiError(
    "Pull request #7 is busy: a merge is running.",
    409,
  );
  await render(pr({ worktreeId: "wt-1" }));
  await click(button(/Merge & clean up/));
  await click(confirm(/^Merge & clean up$/));

  expect(document.body.textContent).toContain("is busy: a merge is running.");
  expect(optionalCheckbox(/I understand/)).toBeUndefined();
  expect(toasts).toEqual([]);
});

/* ------------------------------ the cleanup queue -------------------------- */

it("offers cleanup alone for a merged pull request, and nothing at all without a checkout", async () => {
  response = merged({
    merge: { status: "already-terminal", state: "merged" },
    cleanup: {
      status: "retired",
      worktreeId: "wt-1",
      branch: "pull-requests",
      baseBranch: "main",
      branchDeleted: true,
      settledSessions: 1,
      deliveryVerified: true,
    },
  });
  await render(pr({ state: "merged", worktreeId: "wt-1" }));
  await click(button(/Clean up/));
  expect(document.querySelectorAll("input[type=radio]")).toHaveLength(0);
  await click(confirm(/^Clean up$/));

  expect(requests[0]).toMatchObject({ removeWorktree: true });
  expect(requests[0]).not.toHaveProperty("method");
  expect(toasts[0]).toContain("after verifying delivery into main");

  // A terminal pull request whose checkout is gone has nothing left to offer,
  // so no control is rendered at all.
  await render(pr({ state: "merged" }));
  expect(
    [...document.querySelectorAll("button")].some((element) =>
      /Clean up|Merge/.test(element.textContent ?? ""),
    ),
  ).toBe(false);
});

/* ---------------------------- a dropped response --------------------------- */

it("treats a response that never came back as UNKNOWN, and asks the STATE under the lock", async () => {
  // Not a `PullRequestApiError`: the server never answered, so the merge may
  // have landed with the answer lost. The automatic check that follows finds
  // the lock still held — which is the lost attempt STILL RUNNING, the one
  // answer that resolves nothing.
  queued.push(new TypeError("Failed to fetch"));
  checkQueue.push(
    new PullRequestApiError(
      "Pull request #7 is busy: a merge & clean up is running.",
      409,
    ),
  );
  response = new TypeError("Failed to fetch");
  await render(pr({ worktreeId: "wt-1" }));
  await click(button(/Merge & clean up/));
  const merges = requests.length;
  await click(confirm(/^Merge & clean up$/));
  await flush();

  // The recovery ASKS WHAT THE PULL REQUEST IS. It never re-attempts the merge,
  // and it carries the same four-component identity.
  expect(requests).toHaveLength(merges + 1);
  expect(checks).toEqual([TARGET]);
  expect(document.body.textContent).toContain("is still unknown");
  expect(document.querySelectorAll("input[type=radio]")).toHaveLength(0);
  expect(toasts).toEqual([]);

  // THE RACE. A refetch that answers `ready` proves nothing: the attempt can
  // still hold the lock, and the read can have described the repository from
  // before it merged. So a whole refresh cycle that comes back OPEN leaves the
  // uncertainty exactly where it was.
  await click(confirm(/Close/));
  await render(pr({ worktreeId: "wt-1" }));
  await render(pr({ worktreeId: "wt-1" }));
  // The row offers the only thing that can answer, not the act itself.
  expect(
    [...host.querySelectorAll("button")].some((element) =>
      /Merge & clean up/.test(element.textContent ?? ""),
    ),
  ).toBe(false);
  expect(button(/Check again/, host).disabled).toBe(false);

  // THE OTHER TRAP. The lost attempt finished WITHOUT merging and the pull
  // request has since become a draft, so every re-issued merge would now be
  // refused by an authoritative guard — forever. The state read answers anyway,
  // and the uncertainty ends with the ordinary blocked surface underneath.
  checkQueue.push({
    number: 7,
    state: "open",
    draft: true,
    mergeable: true,
    checkout: { status: "one", worktreeId: "wt-1" },
  });
  await click(button(/Check again/, host));
  await click(confirm(/Check again/));

  expect(checks).toHaveLength(2);
  // No second merge was ever attempted.
  expect(requests).toHaveLength(merges + 1);
  expect(document.body.textContent).toContain(
    "#7 is still open, so the attempt did not merge it",
  );
  expect(document.body.textContent).not.toContain("is still unknown");
  // The uncertainty is over, so the dialog is an ordinary one again — down to
  // its cancel label.
  await click(confirm(/Cancel/));
  // The object is back to the ordinary blocked state, with its reason.
  await render(pr({ worktreeId: "wt-1", draft: true }));
  expect(button(/Merge & clean up/, host).disabled).toBe(true);
  expect(button(/Merge & clean up/, host).title).toBe(
    "#7 is a draft. Mark it ready for review before merging.",
  );
  expect(toasts).toEqual([]);
});

it("ends the uncertainty with what the check found, when the lost attempt HAD merged", async () => {
  queued.push(new TypeError("Failed to fetch"));
  // The response was lost after the merge landed and its cleanup ran: nothing
  // local is left, so this pull request is leaving the view.
  checkQueue.push({
    number: 7,
    state: "merged",
    mergeable: null,
    checkout: { status: "none" },
  });
  response = new TypeError("Failed to fetch");
  await render(pr({ worktreeId: "wt-1" }));
  await click(button(/Merge & clean up/));
  await click(confirm(/^Merge & clean up$/));
  await flush();

  expect(checks).toHaveLength(1);
  expect(document.body.textContent).not.toContain("is still unknown");
  // Merge is not offered again for a pull request the check found merged, even
  // while the item on screen still says open.
  expect(document.querySelectorAll("input[type=radio]")).toHaveLength(0);
  expect(document.body.textContent).toContain(
    "Checked under the pull request's lock: #7 is merged.",
  );
  // The sanctioned toast: its surface is gone with its checkout.
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain(
    "#7 is merged; no local checkout is left to clean up.",
  );
});

it("keeps offering the action after an ANSWERED refusal, which landed nothing", async () => {
  response = new PullRequestApiError(
    "Pull request #7 is busy: a merge is running.",
    409,
  );
  await render(pr({ worktreeId: "wt-1" }));
  await click(button(/Merge & clean up/));
  await click(confirm(/^Merge & clean up$/));

  // The server answered, so this is a clean "nothing happened": the control is
  // the retry and the merge is still on offer.
  expect(document.body.textContent).toContain("is busy: a merge is running.");
  expect(document.body.textContent).not.toContain("is unknown");
  expect(document.querySelectorAll("input[type=radio]").length).toBeGreaterThan(
    0,
  );
  expect(confirm(/^Merge & clean up$/).disabled).toBe(false);
});

/* ------------------------------ identity binding --------------------------- */

it("carries no refusal, consent or merged note onto another pull request", async () => {
  response = merged({
    cleanup: {
      status: "refused",
      worktreeId: "wt-1",
      refusal: "pull-requests is not contained in the refreshed main.",
      refusalKind: "delivery",
    },
  });
  await render(pr({ worktreeId: "wt-1" }));
  await click(button(/Merge & clean up/));
  await click(confirm(/^Merge & clean up$/));
  expect(optionalCheckbox(/I understand/)).not.toBeUndefined();

  // Another pull request — one component of the identity differs, which is all
  // it takes. A consent-bearing refusal shown here would arm a FORCED removal
  // on the strength of a check that ran somewhere else.
  await render(pr({ number: 9, worktreeId: "wt-9" }));
  expect(host.textContent).not.toContain("is not contained in the refreshed");
  expect(optionalCheckbox(/I understand/)).toBeUndefined();
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  // And its own dialog opens fresh: the merge on offer, no note, no consent.
  await click(button(/Merge & clean up/));
  expect(document.body.textContent).not.toContain("Merged into main");
  expect(optionalCheckbox(/I understand/)).toBeUndefined();
  expect(document.querySelectorAll("input[type=radio]").length).toBeGreaterThan(
    0,
  );
});

/* ---------------------------- the branch outcome --------------------------- */

it("reports a branch deletion the provider did not confirm as what it was", async () => {
  response = merged({
    merge: {
      status: "merged",
      method: "squash",
      headBranch: "pull-requests",
      baseBranch: "main",
      remoteBranch: "not-deleted",
      remoteBranchError: "the branch is protected",
    },
  });
  await render(pr());
  await click(button(/Merge & clean up/));
  await click(confirm(/^Merge$/));

  // Never "deleted", and never the opt-out's "kept": the provider's own answer.
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain(
    "The remote branch pull-requests was NOT deleted: the branch is protected",
  );
});

it("never reads AMBIGUOUS local checkouts as none", async () => {
  queued.push(new TypeError("Failed to fetch"));
  // The merge landed, and two local worktrees stand on the head branch: the
  // cleanup could not choose between them, so both are still there.
  checkQueue.push({
    number: 7,
    state: "merged",
    mergeable: null,
    checkout: {
      status: "ambiguous",
      reason:
        "2 local worktrees stand on pull-requests in acme/pa; none was removed. Remove the one you mean from its own page.",
    },
  });
  response = new TypeError("Failed to fetch");
  await render(pr({ worktreeId: "wt-1" }));
  await click(button(/Merge & clean up/));
  await click(confirm(/^Merge & clean up$/));
  await flush();

  // The uncertainty is over and the merge is not re-offered...
  expect(document.body.textContent).not.toContain("is still unknown");
  expect(document.body.textContent).toContain("#7 is merged.");
  // ...but nothing claims the checkouts are gone, and the situation is stated.
  expect(toasts).toEqual([]);
  expect(document.body.textContent).not.toContain("no local checkout is left");
  expect(document.body.textContent).toContain(
    "2 local worktrees stand on pull-requests in acme/pa; none was removed.",
  );
});
