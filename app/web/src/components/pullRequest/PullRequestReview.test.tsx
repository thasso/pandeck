// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PullRequestCheckoutOutcome,
  PullRequestInventoryItem,
  PullRequestViewCheckoutRequest,
  PullRequestViewCheckoutResponse,
  SessionListItem,
  TaskSummary,
  WorktreeRecord,
} from "@assistant/shared";
import type { LoadState } from "../../lib/loadState.ts";

/**
 * The checkout actions of the Pull Requests view's object panel: Review and
 * Create worktree, plus the session action the checkout enables.
 *
 * What they must not get wrong: they address the pull request by all four
 * identity components and nothing else, each busies itself alone while the
 * checkout runs (R5), and they hand off ONLY what the server reported — a
 * refusal reaches no composer and is said on a toast NAMING the pull request
 * (a menu row has no inline home), and the hand-off carries the server's
 * worktree id rather than one this surface had lying around.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const requests: PullRequestViewCheckoutRequest[] = [];
const handoffs: {
  number: number;
  worktreeId: string;
  outcome: PullRequestCheckoutOutcome;
}[] = [];
const sessions: string[] = [];
const opened: string[] = [];
const toasts: {
  message: string;
  action?: { label: string; onClick: () => void };
}[] = [];
let reloads = 0;
let answer: PullRequestViewCheckoutResponse | Error;
/**
 * Holds the checkout in flight, for the cases that assert the busy state
 * before the answer. Set by the test; the endpoint waits on it.
 */
let gate: { promise: Promise<void>; open: () => void } | undefined;

function hold(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showToast: (
    message: string,
    opts?: { action?: { label: string; onClick: () => void } },
  ) =>
    toasts.push({ message, ...(opts?.action ? { action: opts.action } : {}) }),
}));

vi.mock("../../lib/pullRequestsApi.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkoutPullRequestFromView: async (
    request: PullRequestViewCheckoutRequest,
  ) => {
    requests.push(request);
    if (gate) await gate.promise;
    if (answer instanceof Error) throw answer;
    return answer;
  },
}));

const { PullRequestInspector } = await import("../objectInspectors.tsx");
const { failed, loading, ready } = await import("../../lib/loadState.ts");

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
    mergeable: true,
    capabilities: {
      defaultBranch: "main",
      mergeMethods: ["squash", "merge"],
      canDeleteBranchOnMerge: true,
    },
    sessionIds: [],
    taskIds: [],
    ...patch,
  };
}

function created(
  patch: Partial<
    Extract<PullRequestCheckoutOutcome, { status: "created" }>
  > = {},
): PullRequestViewCheckoutResponse {
  return {
    number: 7,
    headBranch: "pull-requests",
    outcome: {
      status: "created",
      worktreeId: "wt-new",
      branch: "pull-requests",
      path: "/checkouts/pa-pull-requests",
      head: "a".repeat(40),
      base: {
        branch: "main",
        pullRequestBase: "main",
        matchesPullRequestBase: true,
      },
      taskIds: [],
      ...patch,
    },
  };
}

function updated(): PullRequestViewCheckoutResponse {
  return {
    number: 7,
    headBranch: "pull-requests",
    outcome: {
      status: "updated",
      worktreeId: "wt-1",
      branch: "pull-requests",
      previousHead: "b".repeat(40),
      head: "a".repeat(40),
      base: {
        branch: "main",
        pullRequestBase: "main",
        matchesPullRequestBase: true,
      },
      taskIds: [],
    },
  };
}

function refused(
  outcome: Partial<Extract<PullRequestCheckoutOutcome, { status: "refused" }>>,
): PullRequestViewCheckoutResponse {
  return {
    number: 7,
    headBranch: "pull-requests",
    outcome: {
      status: "refused",
      kind: "dirty",
      reason: "The checkout on pull-requests has uncommitted changes.",
      ...outcome,
    },
  };
}

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  requests.length = 0;
  handoffs.length = 0;
  sessions.length = 0;
  opened.length = 0;
  toasts.length = 0;
  reloads = 0;
  gate = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("open", (url: string) => {
    opened.push(url);
    return null;
  });
});

afterEach(() => {
  try {
    act(() => root?.unmount());
  } finally {
    root = undefined;
    host.remove();
    vi.unstubAllGlobals();
  }
});

async function render(
  item: PullRequestInventoryItem | LoadState<PullRequestInventoryItem | null>,
): Promise<void> {
  const element = (
    <PullRequestInspector
      state={"status" in item ? item : ready(item)}
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
      onStartSession={(worktreeId) => sessions.push(worktreeId)}
      onReview={(handed, worktreeId, outcome) =>
        handoffs.push({ number: handed.number, worktreeId, outcome })
      }
      onReload={() => {
        reloads += 1;
      }}
    />
  );
  await act(async () => {
    root?.render(element);
  });
}

function button(label: RegExp): HTMLButtonElement {
  const found = optionalButton(label);
  if (!found) throw new Error(`no button matching ${String(label)}`);
  return found;
}

function optionalButton(label: RegExp): HTMLButtonElement | undefined {
  const found = [...host.querySelectorAll("button")].find((element) =>
    label.test(element.textContent ?? ""),
  );
  return found instanceof HTMLButtonElement ? found : undefined;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function release(): Promise<void> {
  await act(async () => {
    gate?.open();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/* --------------------------------- review --------------------------------- */

it("addresses the pull request by all four identity components", async () => {
  answer = created();
  await render(pr());
  await click(button(/Review in a session/));

  expect(requests).toEqual([
    {
      projectId: "pa",
      provider: "forgejo",
      repositoryKey: "acme/pa",
      number: 7,
    },
  ]);
});

it("hands off the server's worktree id and outcome, and says nothing", async () => {
  answer = created({ worktreeId: "wt-42" });
  await render(pr({ worktreeId: "wt-stale" }));
  await click(button(/Review in a session/));

  // The item on screen carries `wt-stale`; the hand-off carries what the
  // checkout ANSWERED, because that is the checkout that now exists.
  expect(handoffs).toEqual([
    {
      number: 7,
      worktreeId: "wt-42",
      outcome: created({ worktreeId: "wt-42" }).outcome,
    },
  ]);
  // Success is silent: the navigation to the composer is the confirmation.
  expect(toasts).toEqual([]);
  expect(host.textContent).not.toContain("wt-42");
});

it("busies its own row only, and stops when the checkout answers", async () => {
  answer = created();
  gate = hold();
  await render(pr({ worktreeId: "wt-1" }));
  await click(button(/Review in a session/));

  const review = button(/Review in a session/);
  expect(review.disabled).toBe(true);
  expect(review.getAttribute("aria-busy")).toBe("true");
  // R5: everything around it stays interactive.
  expect(button(/Merge & clean up/).disabled).toBe(false);
  expect(button(/Update worktree/).disabled).toBe(false);

  await release();
  expect(button(/Review in a session/).disabled).toBe(false);
  expect(handoffs).toHaveLength(1);
});

it("says a refusal on a toast naming the pull request, and hands nothing off", async () => {
  answer = refused({
    kind: "diverged",
    reason:
      "The checkout on pull-requests is at abc123, which is not in the pull request's head def456.",
    worktreeId: "wt-1",
  });
  await render(pr({ worktreeId: "wt-1" }));
  await click(button(/Review in a session/));

  expect(handoffs).toEqual([]);
  expect(toasts.map((toast) => toast.message)).toEqual([
    "#7: The checkout on pull-requests is at abc123, which is not in the pull request's head def456.",
  ]);
  // The act stays on offer — it is the retry.
  expect(button(/Review in a session/).disabled).toBe(false);
});

it("states a failure without claiming which side it happened on", async () => {
  answer = new Error("network down.");
  await render(pr());
  await click(button(/Review in a session/));

  expect(handoffs).toEqual([]);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]?.message).toContain("#7");
  expect(toasts[0]?.message).toContain("network down.");
  expect(toasts[0]?.message).toContain(
    "Trying again picks up a checkout that was created.",
  );
});

/* -------------------------------- identity --------------------------------- */

it("never shows one pull request's busy state under another", async () => {
  answer = created();
  gate = hold();
  await render(pr());
  await click(button(/Review in a session/));
  expect(button(/Review in a session/).disabled).toBe(true);

  // Same panel component, a DIFFERENT pull request: its state is not this
  // one's.
  await render(pr({ number: 9, url: "https://forge/acme/pa/pulls/9" }));
  expect(button(/Review in a session/).disabled).toBe(false);
  await release();
});

/* ------------------------------ what is offered ---------------------------- */

it("offers neither review nor a checkout for a terminal pull request", async () => {
  answer = created();
  await render(pr({ state: "merged", worktreeId: "wt-1" }));

  // Its head branch is normally deleted, so the only possible answer would be
  // that the branch is gone — that is not an offer.
  expect(optionalButton(/Review in a session/)).toBeUndefined();
  expect(optionalButton(/(Create|Update) worktree/)).toBeUndefined();
  expect(optionalButton(/Clean up/)).toBeDefined();
});

it("offers nothing to merge or clean up for a terminal pull request without a checkout", async () => {
  await render(pr({ state: "closed" }));
  expect(optionalButton(/Clean up|Merge/)).toBeUndefined();
  // The link out is the one thing a gone pull request still has.
  expect(optionalButton(/Open on Forgejo/)).toBeDefined();
});

it("opens the pull request on its provider", async () => {
  await render(pr({ provider: "github" }));
  await click(button(/Open on GitHub/));
  expect(opened).toEqual(["https://forge/acme/pa/pulls/7"]);
});

/* ---------------------------- the session action --------------------------- */

it("lists the session action disabled until the checkout exists, then enables it", async () => {
  await render(pr());
  const before = button(/Start session in worktree/);
  expect(before.disabled).toBe(true);
  expect(before.title).toBe("Create a worktree for this pull request first.");
  // And as visible row text: the tooltip reaches neither a keyboard nor a phone.
  expect(before.textContent).toContain("needs a worktree");

  await render(pr({ worktreeId: "wt-1" }));
  const after = button(/Start session in worktree/);
  expect(after.disabled).toBe(false);
  await click(after);
  expect(sessions).toEqual(["wt-1"]);
});

/* ------------------------------ create worktree ---------------------------- */

it("creates the checkout, refetches, and offers the session on the toast", async () => {
  answer = created();
  await render(pr());
  await click(button(/Create worktree/));

  expect(requests).toHaveLength(1);
  // The checkout alone: no composer, no navigation.
  expect(handoffs).toEqual([]);
  expect(reloads).toBe(1);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]?.message).toBe("#7: created the checkout of pull-requests.");
  expect(toasts[0]?.action?.label).toBe("Start session");
  toasts[0]?.action?.onClick();
  // The SERVER's worktree id, from the outcome.
  expect(sessions).toEqual(["wt-new"]);
});

it("reads as an update once the checkout exists, and reports what the update did", async () => {
  answer = updated();
  await render(pr({ worktreeId: "wt-1" }));
  expect(optionalButton(/Create worktree/)).toBeUndefined();
  await click(button(/Update worktree/));

  expect(toasts.map((toast) => toast.message)).toEqual([
    "#7: brought the checkout of pull-requests to the pull request's head.",
  ]);
});

it("busies the checkout row alone, and states a refusal on the toast", async () => {
  answer = refused({ reason: "The checkout on pull-requests is dirty." });
  gate = hold();
  await render(pr({ worktreeId: "wt-1" }));
  await click(button(/Update worktree/));

  expect(button(/Update worktree/).disabled).toBe(true);
  expect(button(/Review in a session/).disabled).toBe(false);

  await release();
  expect(button(/Update worktree/).disabled).toBe(false);
  expect(reloads).toBe(0);
  expect(toasts.map((toast) => toast.message)).toEqual([
    "#7: The checkout on pull-requests is dirty.",
  ]);
});

/* ------------------------- when the surface is gone ------------------------ */

// A checkout takes seconds and the panel is keyed by the pull request, so the
// reader can be somewhere else when it answers. Navigating them into a composer
// for a pull request they left is the failure; the toast NAMING it, with the
// hand-off as its action, is what `docs/messaging.md` reserves for exactly this.
it("does not navigate once its surface is gone; it says so instead", async () => {
  answer = created();
  gate = hold();
  await render(pr());
  await click(button(/Review in a session/));

  await act(async () => {
    root?.unmount();
    root = undefined;
  });
  await release();

  expect(handoffs).toEqual([]);
  expect(toasts.map((toast) => toast.message)).toEqual([
    "#7: the checkout of pull-requests is ready.",
  ]);
  expect(toasts[0]?.action?.label).toBe("Review it");
  toasts[0]?.action?.onClick();
  expect(handoffs).toEqual([
    { number: 7, worktreeId: "wt-new", outcome: created().outcome },
  ]);
});

it("states a refusal that lands after its surface is gone, on the toast", async () => {
  answer = refused({ reason: "The checkout on pull-requests is dirty." });
  gate = hold();
  await render(pr());
  await click(button(/Review in a session/));

  await act(async () => {
    root?.unmount();
    root = undefined;
  });
  await release();

  expect(handoffs).toEqual([]);
  expect(toasts.map((toast) => toast.message)).toEqual([
    "#7: The checkout on pull-requests is dirty.",
  ]);
});

/* ------------------------------ the read itself ---------------------------- */

// The panel renders the read's three answers apart (R1): only a read that has
// not answered reserves it, "not in the inventory" is a statement, and a
// failure with nothing retained is the panel's whole answer with its retry.
it("reserves the panel only while the inventory has not answered", async () => {
  await render(loading());
  expect(
    host.querySelector('[aria-label="Loading Inspector details"]'),
  ).not.toBeNull();
  expect(optionalButton(/Start session in worktree/)).toBeUndefined();
});

it("states a pull request the inventory does not hold, rather than loading forever", async () => {
  await render(ready(null));
  expect(
    host.querySelector('[aria-label="Loading Inspector details"]'),
  ).toBeNull();
  expect(host.textContent).toContain("not in your inventory");
  expect(optionalButton(/Start session in worktree/)).toBeUndefined();
});

it("states a failed read with nothing retained, and keeps a retained item through one", async () => {
  await render(failed("inventory unreachable"));
  expect(
    host.querySelector('[aria-label="Loading Inspector details"]'),
  ).toBeNull();
  expect(host.textContent).toContain("inventory unreachable");
  expect(optionalButton(/Start session in worktree/)).toBeUndefined();

  // R2: the retained item stays actionable under a failed refresh, and the
  // failure is stated beside it — on a phone the dock covers the page's note.
  await render(failed("inventory unreachable", pr({ worktreeId: "wt-1" })));
  expect(button(/Start session in worktree/).disabled).toBe(false);
  expect(host.textContent).toContain("inventory unreachable");
});
