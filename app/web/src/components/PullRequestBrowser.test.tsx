// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ProjectRecord,
  PullRequestInventoryItem,
} from "@assistant/shared";
import { PullRequestBrowser } from "./PullRequestBrowser.tsx";
import type { PullRequestTarget } from "../lib/pullRequestInbox.ts";
import { failed, loading, ready, refreshing } from "../lib/loadState.ts";

/**
 * What the browser DRAWS for each of the five states, and in what order.
 *
 * The failures these cover are the silent ones: an unanswered inventory that
 * says "nothing needs you" (R1), a poll that replaces the rows with skeletons
 * (R2), and a group order that stops putting somebody else's blocked review
 * first.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const PROJECTS: ProjectRecord[] = [
  { id: "pa", name: "Pandeck", key: "PA", status: "active" },
];

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

function render(node: Parameters<Root["render"]>[0]) {
  act(() => root!.render(node));
  return container!;
}

const NOOP = () => {};

describe("PullRequestBrowser", () => {
  it("reserves the rows while the inventory is silent, and claims nothing", () => {
    const el = render(
      <PullRequestBrowser
        inventory={loading()}
        onReload={NOOP}
        projects={PROJECTS}
        onOpen={NOOP}
        density="tight"
      />,
    );
    expect(
      el.querySelector('[aria-label="Loading pull requests"]'),
    ).not.toBeNull();
    // R1: an unanswered source may not tell the user their list is empty.
    expect(el.textContent).not.toContain("No pull requests need you");
    expect(el.querySelector("[data-pull-request-row]")).toBeNull();
  });

  it("names the three groups in order and puts a review request first", () => {
    const el = render(
      <PullRequestBrowser
        inventory={ready([
          pr({ number: 1, updatedAt: 100 }),
          pr({ number: 2, reviewRequested: true, updatedAt: 1 }),
          pr({ number: 3, state: "merged", worktreeId: "wt", updatedAt: 500 }),
        ])}
        onReload={NOOP}
        projects={PROJECTS}
        onOpen={NOOP}
        density="tight"
      />,
    );
    expect(
      [...el.querySelectorAll("h2")].map((node) =>
        node.textContent?.replace(/\s*\(\d+\)$/, ""),
      ),
    ).toEqual(["Needs your review", "Yours", "Needs cleanup"]);
    // …and the freshest pull request of all does not jump the groups.
    expect(
      [...el.querySelectorAll("[data-pull-request-row]")].map((node) =>
        node.getAttribute("data-list-row-id"),
      ),
    ).toEqual([
      "pa#forgejo#acme/pa#2",
      "pa#forgejo#acme/pa#1",
      "pa#forgejo#acme/pa#3",
    ]);
  });

  it("marks a local checkout and a draft on the row", () => {
    const el = render(
      <PullRequestBrowser
        inventory={ready([pr({ number: 4, draft: true, worktreeId: "wt-4" })])}
        onReload={NOOP}
        projects={PROJECTS}
        onOpen={NOOP}
        density="tight"
      />,
    );
    const row = el.querySelector("[data-pull-request-row]")!;
    expect(row.textContent).toContain("Draft");
    expect(row.textContent).toContain("local");
    expect(row.textContent).toContain("PA");
  });

  it("says empty only once the source answered with nothing", () => {
    const el = render(
      <PullRequestBrowser
        inventory={ready([])}
        onReload={NOOP}
        projects={PROJECTS}
        onOpen={NOOP}
        density="tight"
      />,
    );
    expect(el.textContent).toContain("No pull requests need you right now.");
  });

  it("keeps the rows through a poll and marks it instead (R2)", () => {
    const el = render(
      <PullRequestBrowser
        inventory={refreshing([pr({ number: 5 })])}
        onReload={NOOP}
        projects={PROJECTS}
        onOpen={NOOP}
        density="tight"
      />,
    );
    expect(el.querySelectorAll("[data-pull-request-row]")).toHaveLength(1);
    expect(el.textContent).toContain("Refreshing pull requests");
  });

  it("keeps the rows under a failed refresh and offers the retry", () => {
    const el = render(
      <PullRequestBrowser
        inventory={failed("forge unreachable", [pr({ number: 6 })])}
        onReload={NOOP}
        projects={PROJECTS}
        onOpen={NOOP}
        density="tight"
      />,
    );
    expect(el.querySelector('[role="alert"]')!.textContent).toContain(
      "forge unreachable",
    );
    expect(el.querySelectorAll("[data-pull-request-row]")).toHaveLength(1);
  });

  it("shows a first-load failure on its own, with nothing to keep", () => {
    const el = render(
      <PullRequestBrowser
        inventory={failed("forge unreachable")}
        onReload={NOOP}
        projects={PROJECTS}
        onOpen={NOOP}
        density="tight"
      />,
    );
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    expect(el.textContent).not.toContain("No pull requests need you");
  });

  it("opens a row by its ids, not by the row object", () => {
    const opened: PullRequestTarget[] = [];
    const el = render(
      <PullRequestBrowser
        inventory={ready([pr({ number: 9 })])}
        onReload={NOOP}
        projects={PROJECTS}
        onOpen={(target) => opened.push(target)}
        density="tight"
      />,
    );
    act(() => {
      el.querySelector<HTMLElement>("[data-pull-request-row]")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(opened).toEqual([
      {
        projectId: "pa",
        provider: "forgejo",
        repositoryKey: "acme/pa",
        number: 9,
      },
    ]);
  });

  // The collisions the server can actually produce, in ONE list: one project,
  // one number, a `pushurl` fork, and the same `owner/repo` under the other
  // provider. Addressing or selecting on a subset gives two rows one URL and
  // highlights both.
  describe("two repositories, one number", () => {
    const FORK = pr({
      number: 7,
      state: "merged",
      worktreeId: "wt",
      repositoryKey: "acme/pa-fork",
      repoWebUrl: "https://forge/acme/pa-fork",
    });
    const UPSTREAM = pr({ number: 7 });

    it("gives each row its own identity and its own target", () => {
      const opened: PullRequestTarget[] = [];
      const el = render(
        <PullRequestBrowser
          inventory={ready([UPSTREAM, FORK])}
          onReload={NOOP}
          projects={PROJECTS}
          onOpen={(target) => opened.push(target)}
          density="tight"
        />,
      );
      const rows = [
        ...el.querySelectorAll<HTMLElement>("[data-pull-request-row]"),
      ];
      expect(rows.map((row) => row.getAttribute("data-list-row-id"))).toEqual([
        "pa#forgejo#acme/pa#7",
        "pa#forgejo#acme/pa-fork#7",
      ]);
      act(() => {
        rows[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(opened).toEqual([
        {
          projectId: "pa",
          provider: "forgejo",
          repositoryKey: "acme/pa-fork",
          number: 7,
        },
      ]);
    });

    it("gives the same owner/repo under two providers its own row", () => {
      // `owner/repo` is unique within a provider, not across them: a project
      // with both remotes exposing `acme/pa` has two different #7s.
      const github = pr({
        number: 7,
        provider: "github",
        repoWebUrl: "https://github.com/acme/pa",
      });
      const opened: PullRequestTarget[] = [];
      const el = render(
        <PullRequestBrowser
          inventory={ready([UPSTREAM, github])}
          onReload={NOOP}
          projects={PROJECTS}
          selected={{
            projectId: "pa",
            provider: "github",
            repositoryKey: "acme/pa",
            number: 7,
          }}
          onOpen={(target) => opened.push(target)}
          density="tight"
        />,
      );
      const rows = [
        ...el.querySelectorAll<HTMLElement>("[data-pull-request-row]"),
      ];
      expect(rows.map((row) => row.getAttribute("data-list-row-id"))).toEqual([
        "pa#forgejo#acme/pa#7",
        "pa#github#acme/pa#7",
      ]);
      // Exactly one row is the routed one…
      expect(
        rows.map((row) => row.getAttribute("data-pull-request-row-active")),
      ).toEqual([null, "true"]);
      // …and each opens its own.
      act(() => {
        rows[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(opened).toEqual([
        {
          projectId: "pa",
          provider: "github",
          repositoryKey: "acme/pa",
          number: 7,
        },
      ]);
    });

    it("highlights only the repository the route names", () => {
      const el = render(
        <PullRequestBrowser
          inventory={ready([UPSTREAM, FORK])}
          onReload={NOOP}
          projects={PROJECTS}
          selected={{
            projectId: "pa",
            provider: "forgejo",
            repositoryKey: "acme/pa-fork",
            number: 7,
          }}
          onOpen={NOOP}
          density="tight"
        />,
      );
      expect(
        [...el.querySelectorAll("[data-pull-request-row]")].map((row) =>
          row.getAttribute("data-pull-request-row-active"),
        ),
      ).toEqual([null, "true"]);
    });
  });
});
