import { applyPatch } from "@assistant/shared";
import type {
  Patch,
  PullRequestCard as PullRequestCardData,
} from "@assistant/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PullRequestCard } from "./PullRequestCard.tsx";

function card(patch: Patch<PullRequestCardData> = {}): PullRequestCardData {
  return applyPatch(
    {
      renderKind: "pullRequest",
      id: "pr_1",
      sessionId: "session-1",
      status: "merged",
      createdAt: 0,
      updatedAt: 0,
      provider: "github",
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      title: "Existing pull request",
      headBranch: "feature",
      baseBranch: "main",
      reused: true,
      warnings: [
        "Existing pull request #42 is merged; no new pull request was created.",
      ],
      // The merge picker offers exactly what the repository allows; without
      // this an open card would legitimately offer no method at all.
      repositoryCapabilities: {
        defaultBranch: "main",
        mergeMethods: ["squash", "merge", "rebase"],
        canClose: true,
      },
    },
    patch,
  );
}

describe("PullRequestCard", () => {
  it("surfaces a reused PR's non-open state with a non-success tone", () => {
    const html = renderToStaticMarkup(<PullRequestCard pullRequest={card()} />);
    expect(html).toContain("Pull request reused");
    expect(html).toContain("Merged");
    expect(html).not.toContain("border-success");
    expect(html).toContain("no new pull request was created");
  });

  it("keeps an open PR success-toned", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard pullRequest={card({ status: "open", warnings: [] })} />,
    );
    expect(html).toContain("border-success");
    expect(html).toContain(">Open<");
  });

  it("shows CI and mergeability badges while open", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({
          status: "open",
          warnings: [],
          ci: { state: "failure", total: 3 },
          mergeable: false,
          conflicts: true,
        })}
      />,
    );
    expect(html).toContain("CI failed");
    expect(html).toContain("Conflicting");
  });

  it("renders a Task chooser for a choosing-task card", () => {
    let chosen: [string, string | null] | undefined;
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({
          status: "choosing-task",
          number: undefined,
          url: undefined,
          provider: undefined,
          reused: false,
          warnings: [],
          taskCandidates: [
            {
              id: "322",
              title: "Add /pr",
              status: "doing",
              source: { createdBy: "user" },
              createdAt: 0,
              updatedAt: 0,
            },
            {
              id: "320",
              title: "Combine commit/push/PR",
              status: "todo",
              source: { createdBy: "user" },
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        })}
        onChooseTask={(cardId, taskId) => {
          chosen = [cardId, taskId];
        }}
      />,
    );
    expect(html).toContain("Choose a Task");
    expect(html).toContain("Task-322: Add /pr");
    expect(html).toContain("None of these");
    expect(chosen).toBeUndefined();
  });

  /* --------------------------------- actions -------------------------------- */

  const noop = () => undefined;

  it("offers merge and update on an open card, and no cleanup yet", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({ status: "open", warnings: [], worktreeId: "wt-1" })}
        onAction={noop}
      />,
    );
    expect(html).toContain("Merge");
    expect(html).toContain("Update with main");
    expect(html).not.toContain("Clean up worktree");
  });

  // Deleting the remote branch stays the default, and the card says what the
  // click will do to it BEFORE it is clicked rather than reporting it after.
  // The checked default itself is pinned where it can be toggled
  // (`PullRequestCard.merge.test.tsx`); here it is the WORDING that matters.
  it("offers the remote-branch opt-out and states the outcome", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({ status: "open", warnings: [], worktreeId: "wt-1" })}
        onAction={noop}
      />,
    );
    expect(html).toContain("Delete remote branch");
    expect(html).toContain("Merging deletes the remote branch feature");
    expect(button(html, ">Merge<")).toContain(
      "delete the remote branch feature",
    );
  });

  // A conflicting PR cannot be merged at all, so the card must not offer it —
  // and the update that fixes it becomes the visible next step.
  it("disables merge and promotes the update while conflicting", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({
          status: "open",
          warnings: [],
          worktreeId: "wt-1",
          mergeable: false,
          conflicts: true,
        })}
        onAction={noop}
      />,
    );
    expect(isDisabled(html, ">Merge<")).toBe(true);
    expect(isDisabled(html, "Squash")).toBe(true);
    // The whole merge group goes with it: the remote-branch opt-out only
    // decides what a merge does, and its outcome line would describe a button
    // that is off.
    expect(/<input[^>]*type="checkbox"[^>]*>/.exec(html)?.[0]).toContain(
      'disabled=""',
    );
    expect(html).not.toContain("Merging deletes the remote branch");
    expect(isDisabled(html, "Update with main")).toBe(false);
    expect(button(html, "Update with main")).toContain("bg-primary");
    // The reason is TEXT: a disabled button's tooltip reaches neither a
    // keyboard nor a phone.
    expect(html).toContain(
      "feature conflicts with main, so it cannot be merged",
    );
    expect(html).toContain("Update with main rebases it");
  });

  // Without a checkout there is no update button, so the note has to name the
  // path the user does have.
  it("explains the manual path when a conflicting card has no worktree", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({
          status: "open",
          warnings: [],
          mergeable: false,
          conflicts: true,
        })}
        onAction={noop}
      />,
    );
    expect(html).not.toContain("Update with main");
    expect(html).toContain("Resolve the conflicts on feature and push it");
  });

  // The card is store-driven: the watcher clearing `conflicts` (or an
  // update-with-main resetting mergeability to "still computing") must hand the
  // merge back, and a provider that has not answered yet is not a conflict.
  it("keeps merge offered when mergeability is unknown or resolved", () => {
    const checking = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({
          status: "open",
          warnings: [],
          worktreeId: "wt-1",
          mergeable: null,
        })}
        onAction={noop}
      />,
    );
    expect(checking).toContain("Checking mergeability…");
    expect(isDisabled(checking, ">Merge<")).toBe(false);

    const resolved = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({
          status: "open",
          warnings: [],
          worktreeId: "wt-1",
          mergeable: true,
          conflicts: false,
        })}
        onAction={noop}
      />,
    );
    expect(isDisabled(resolved, ">Merge<")).toBe(false);
    expect(button(resolved, "Update with main")).not.toContain("bg-primary");
    expect(resolved).not.toContain("so it cannot be merged");
  });

  // Cleanup removes a checkout: it may only appear once the pull request is
  // merged, and only for a session that actually has a worktree.
  it("offers cleanup only after a merge, and only with a worktree", () => {
    const merged = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({ warnings: [], worktreeId: "wt-1" })}
        onAction={noop}
      />,
    );
    expect(merged).toContain("Clean up worktree");
    expect(merged).toContain("only after main is confirmed to contain");
    expect(merged).not.toContain("Update with main");

    const noWorktree = renderToStaticMarkup(
      <PullRequestCard pullRequest={card({ warnings: [] })} onAction={noop} />,
    );
    expect(noWorktree).not.toContain("Clean up worktree");
  });

  // The server resolves the worktree from the session when the card stored
  // none (an older card, a session linked afterwards). A stricter client gate
  // hides a button the server would run.
  it("falls back to the session's worktree for the cleanup gate", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({ warnings: [] })}
        sessionWorktreeId="wt-1"
        onAction={noop}
      />,
    );
    expect(html).toContain("Clean up worktree");
  });

  // Cleanup settles every live session on the checkout, so the button states
  // that BEFORE the click rather than reporting it afterwards.
  it("names the other live sessions cleanup will settle", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({ warnings: [], worktreeId: "wt-1" })}
        sessionWorktreeId="wt-1"
        worktreeLiveSiblings={2}
        onAction={noop}
      />,
    );
    expect(button(html, "Clean up worktree")).toContain(
      "settle this session and 2 others on this worktree",
    );
    expect(html).toContain("2 other live sessions run on this worktree");
  });

  // The count belongs to the VIEWED session's worktree; a card naming another
  // checkout must not borrow it.
  it("ignores the sibling count for a card on a different worktree", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({ warnings: [], worktreeId: "wt-other" })}
        sessionWorktreeId="wt-1"
        worktreeLiveSiblings={2}
        onAction={noop}
      />,
    );
    expect(button(html, "Clean up worktree")).toContain("settle this session");
    expect(html).not.toContain("live sessions run on this worktree");
  });

  /** The rendered `<button>` whose text contains `label`. */
  function button(html: string, label: string): string {
    const match = [...html.matchAll(/<button\b[^>]*>.*?<\/button>/gs)].find(
      (candidate) => candidate[0].includes(label),
    );
    expect(match, `no button labelled ${label}`).toBeDefined();
    return match![0];
  }

  /**
   * Whether that button carries the `disabled` ATTRIBUTE. Every button also
   * carries the `disabled:opacity-40` class, so a plain `toContain("disabled")`
   * holds for an enabled one too.
   */
  function isDisabled(html: string, label: string): boolean {
    return /\sdisabled=""/.test(button(html, label));
  }

  it("keeps every action disabled while the server is running one", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({
          status: "open",
          warnings: [],
          worktreeId: "wt-1",
          busyAction: "merge",
        })}
        onAction={noop}
      />,
    );
    // Named per button: "four things are disabled" would pass with the wrong
    // four, and the claim is that no action can be started while one runs.
    expect(isDisabled(html, ">Merge<")).toBe(true);
    expect(isDisabled(html, "Update with main")).toBe(true);
    expect(isDisabled(html, "Squash")).toBe(true);
  });

  // The click on a conflicting card becomes a PROMPT, and the card is the only
  // place that says so: without this the button came straight back, offering a
  // second rebase of the branch the agent is holding.
  it("says the agent has the rebase while its turn runs", () => {
    const handed = card({
      status: "open",
      warnings: [],
      worktreeId: "wt-1",
      mergeable: false,
      conflicts: true,
      rebaseHandedOff: true,
      actionMessage:
        "Rebasing feature onto main hit a conflict; handed it to this session's agent.",
    });
    const running = renderToStaticMarkup(
      <PullRequestCard pullRequest={handed} sessionBusy onAction={noop} />,
    );
    expect(isDisabled(running, "Agent is rebasing")).toBe(true);
    expect(running).not.toContain("Update with main rebases it");
    expect(running).toContain("agent was asked to resolve the conflicts");
    // Not the primary button either: there is nothing to press.
    expect(button(running, "Agent is rebasing")).not.toContain("bg-primary");

    // An agent that gave up must not leave a card with no button to press, so
    // the offer returns with its turn.
    const idle = renderToStaticMarkup(
      <PullRequestCard pullRequest={handed} onAction={noop} />,
    );
    expect(isDisabled(idle, "Update with main")).toBe(false);
    expect(idle).toContain("hit a conflict; handed it to this session");
  });

  // The session still owns the checkout it is working in.
  it("disables cleanup while the session is streaming", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({ warnings: [], worktreeId: "wt-1" })}
        sessionBusy
        onAction={noop}
      />,
    );
    expect(isDisabled(html, "Clean up worktree")).toBe(true);
  });

  it("renders no action section when there is nothing to offer or say", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({
          warnings: [],
          linkedTask: {
            id: "324",
            title: "Stage 3",
            status: "done",
            source: { createdBy: "user" },
            createdAt: 0,
            updatedAt: 0,
          },
        })}
        onAction={noop}
      />,
    );
    expect(html).not.toContain("<button");
  });

  it("shows an action failure where the button is", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({
          status: "open",
          warnings: [],
          actionError: "At least 1 approving review is required.",
        })}
        onAction={noop}
      />,
    );
    expect(html).toContain("At least 1 approving review is required.");
  });

  it("renders no actions at all without a handler", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({ status: "open", warnings: [], worktreeId: "wt-1" })}
      />,
    );
    expect(html).not.toContain("Update with main");
  });

  it("surfaces a failed card's error", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        pullRequest={card({
          status: "failed",
          number: undefined,
          url: undefined,
          provider: undefined,
          reused: false,
          warnings: [],
          error: "No git hosting provider is configured for this repository.",
        })}
      />,
    );
    expect(html).toContain("Failed");
    expect(html).toContain(
      "No git hosting provider is configured for this repository.",
    );
  });
});
