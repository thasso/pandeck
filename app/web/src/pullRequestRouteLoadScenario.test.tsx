// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PullRequestInventoryItem,
  PullRequestInventoryResponse,
} from "@assistant/shared";
import { usePullRequestInventory } from "./hooks/usePullRequestInventory.ts";
import {
  pullRequestDetailState,
  type PullRequestTarget,
} from "./lib/pullRequestInbox.ts";
import { PullRequestBrowser } from "./components/PullRequestBrowser.tsx";
import { PullRequestDetailPage } from "./components/pullRequest/PullRequestDetailPage.tsx";

/**
 * The Pull Requests routes' real ownership seam: ONE inventory read for the
 * whole app, polled only while a Pull Requests surface is on screen, with the
 * browser and the detail page reading the same projection.
 *
 * Every rule here fails silently. A detail page that fetched for itself would
 * render perfectly while doubling the provider traffic; a poll that reset the
 * key would blank the list once a minute; and a switch between pull requests
 * that kept the previous body would show the wrong pull request's checks under
 * the new number — the worst of the three, because it looks like an answer.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function pr(
  patch: Partial<PullRequestInventoryItem> & { number: number },
): PullRequestInventoryItem {
  return {
    projectId: "pa",
    provider: "forgejo",
    repositoryKey: "acme/pa",
    repoWebUrl: "https://forge/acme/pa",
    url: `https://forge/acme/pa/pulls/${patch.number}`,
    title: `Pull request ${patch.number}`,
    headBranch: `branch-${patch.number}`,
    baseBranch: "main",
    mine: true,
    reviewRequested: false,
    state: "open",
    sessionIds: [],
    taskIds: [],
    ...patch,
  };
}

const ITEMS = [pr({ number: 1 }), pr({ number: 2 })];

const TARGET_1: PullRequestTarget = {
  projectId: "pa",
  provider: "forgejo",
  repositoryKey: "acme/pa",
  number: 1,
};
const TARGET_2: PullRequestTarget = { ...TARGET_1, number: 2 };

/** Fresh and empty: the join lists are not what these cases are about. */
const NO_JOINS = {
  worktrees: { rows: [], fresh: true },
  sessions: { rows: [], fresh: true },
  tasks: { rows: [], fresh: true },
} as const;

/** Resolved by each test, so a pending first load can be observed. */
let answer: (response: PullRequestInventoryResponse) => void = () => {};
let requests = 0;

/**
 * The route seam, without the shell: `active` is what App derives from the
 * route and the visible section, and `target` is what the route addresses.
 */
function PullRequestRouteHarness({
  active,
  target,
}: {
  active: boolean;
  target: PullRequestTarget | null;
}) {
  const inventory = usePullRequestInventory(active);
  const detail = pullRequestDetailState(inventory.state, target);
  return target ? (
    <PullRequestDetailPage
      key={`${target.projectId}#${target.repositoryKey}#${target.number}`}
      target={target}
      state={detail}
      onReload={inventory.reload}
      projects={[]}
      joins={NO_JOINS}
      onOpenWorktree={() => {}}
      onOpenSession={() => {}}
      onOpenTask={() => {}}
    />
  ) : (
    <PullRequestBrowser
      inventory={inventory.state}
      onReload={inventory.reload}
      projects={[]}
      onOpen={() => {}}
      density="tight"
    />
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  requests = 0;
  vi.useFakeTimers();
  vi.stubGlobal("fetch", () => {
    requests += 1;
    return new Promise((resolve) => {
      answer = (response) =>
        resolve({
          ok: true,
          json: () => Promise.resolve(response),
        } as Response);
    });
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(node: Parameters<Root["render"]>[0]) {
  await act(async () => root!.render(node));
}

async function settle(items = ITEMS) {
  await act(async () => {
    answer({ status: "ready", items, fetchedAt: 1 });
    await Promise.resolve();
  });
}

async function settleCold() {
  await act(async () => {
    answer({ status: "cold", items: [], fetchedAt: null });
    await Promise.resolve();
  });
}

describe("Pull Requests route load scenario", () => {
  it("reads the inventory ONCE on the index and renders its rows", async () => {
    await render(<PullRequestRouteHarness active target={null} />);
    expect(requests).toBe(1);
    // R1 while the answer is outstanding: reserved rows, no empty claim.
    expect(
      container!.querySelector('[aria-label="Loading pull requests"]'),
    ).not.toBeNull();

    await settle();
    expect(requests).toBe(1);
    expect(container!.querySelectorAll("[data-pull-request-row]")).toHaveLength(
      2,
    );
  });

  it("keeps a cold server snapshot in loading rather than rendering an error or empty state", async () => {
    await render(<PullRequestRouteHarness active target={null} />);
    await settleCold();

    expect(
      container!.querySelector('[aria-label="Loading pull requests"]'),
    ).not.toBeNull();
    expect(container!.textContent).not.toContain("No pull requests need you");
  });

  it("polls while visible and stops the moment nothing shows it", async () => {
    await render(<PullRequestRouteHarness active target={null} />);
    await settle();
    expect(requests).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(requests).toBe(2);
    // R2: the poll is a refresh of the same key, so the rows stay put.
    expect(container!.querySelectorAll("[data-pull-request-row]")).toHaveLength(
      2,
    );

    await settle();
    await render(<PullRequestRouteHarness active={false} target={null} />);
    await act(async () => {
      vi.advanceTimersByTime(300_000);
    });
    expect(requests).toBe(2);
  });

  it("gives the detail page the SAME read, not a second one", async () => {
    await render(<PullRequestRouteHarness active target={TARGET_1} />);
    await settle();
    expect(requests).toBe(1);
    expect(container!.textContent).toContain("Pull request 1");
  });

  it("places a different pull request's PLACEHOLDER, never the last body", async () => {
    await render(<PullRequestRouteHarness active target={TARGET_1} />);
    await settle();
    expect(container!.textContent).toContain("Pull request 1");

    // R3, actually observed. Leaving the section drops the inventory, so
    // arriving at a DIFFERENT pull request is a real first load — and this is
    // the frame that matters: the new target must render its own loading
    // state, with none of the previous pull request left under it. Asserting
    // only the settled body (as the first version of this test did) passes
    // whether or not that rule holds, because both resolve from one answer.
    await render(<PullRequestRouteHarness active={false} target={TARGET_1} />);
    await render(<PullRequestRouteHarness active target={TARGET_2} />);
    expect(
      container!.querySelector('[aria-label="Loading pull request"]'),
    ).not.toBeNull();
    expect(container!.textContent).not.toContain("Pull request 1");
    expect(container!.textContent).not.toContain("not in your inventory");

    await settle();
    expect(container!.textContent).toContain("Pull request 2");
    expect(container!.textContent).not.toContain("Pull request 1");
  });

  it("swaps the body when the target moves within one settled answer", async () => {
    await render(<PullRequestRouteHarness active target={TARGET_1} />);
    await settle();
    await render(<PullRequestRouteHarness active target={TARGET_2} />);
    expect(container!.textContent).toContain("Pull request 2");
    expect(container!.textContent).not.toContain("Pull request 1");
  });

  it("never resolves another repository's pull request of the same number", async () => {
    // The server emits this pair; addressing on project + number alone would
    // open whichever came first.
    const fork = pr({
      number: 1,
      repositoryKey: "acme/pa-fork",
      repoWebUrl: "https://forge/acme/pa-fork",
      title: "Fork's first",
    });
    await render(
      <PullRequestRouteHarness
        active
        target={{ ...TARGET_1, repositoryKey: "acme/pa-fork" }}
      />,
    );
    await settle([pr({ number: 1 }), fork]);
    expect(container!.textContent).toContain("Fork's first");
    expect(container!.textContent).not.toContain("Pull request 1");
  });

  it("says loading, not 'no such pull request', on a cold deep link", async () => {
    await render(<PullRequestRouteHarness active target={TARGET_2} />);
    expect(
      container!.querySelector('[aria-label="Loading pull request"]'),
    ).not.toBeNull();
    expect(container!.textContent).not.toContain("not in your inventory");

    // …and once the inventory has answered without it, it says so.
    await settle([pr({ number: 1 })]);
    expect(container!.textContent).toContain("not in your inventory");
  });
});
