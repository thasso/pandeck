// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { WorktreeGitStatus, WorktreeRecord } from "@assistant/shared";
import { RemoveWorktreeDialog } from "./WorktreeDialogs.tsx";

/**
 * The force decision has to be REACHABLE, and it has to be asked about the
 * removal the user actually configured — no more and no less.
 *
 * Ways it was not: a base branch that no longer resolves reports
 * `ahead: 0, merged: true` — an unverifiable branch looking delivered — so no
 * consent was ever offered while the server refused the removal on the same
 * missing ref; keeping the branch was treated as losing its commits, which
 * demanded force for work that stays on the ref; and a dirty tree spoke for an
 * unverifiable branch too, so one sentence about working-tree loss bought a
 * consent that also skipped containment.
 *
 * The other direction matters as much: consent must not pre-empt a check the
 * server can still make. Remove never fetches, so a base missing locally is
 * its final answer; Retire fetches the base and compares against that exact
 * commit, so ONLY its own refusal establishes that delivery is unverifiable.
 */

const WORKTREE: WorktreeRecord = {
  id: "wt-1",
  projectId: "pa",
  mainRepoRoot: "/repo",
  path: "/worktrees/wt-1",
  branch: "feat/orphan",
  baseBranch: "gone-base",
  baseCommit: "abc",
  status: "active",
  sessionIds: [],
  taskIds: [],
  createdAt: 0,
  updatedAt: 0,
};

function git(partial: Partial<WorktreeGitStatus> = {}): WorktreeGitStatus {
  return {
    worktreeId: "wt-1",
    branch: "feat/orphan",
    head: "abc1234",
    dirty: false,
    filesChanged: 0,
    untracked: 0,
    additions: 0,
    deletions: 0,
    ahead: 0,
    behind: 0,
    merged: false,
    updatedAt: 0,
    ...partial,
  };
}

let host: HTMLDivElement;
let root: Root | undefined;
const removals: { deleteBranch: boolean; force: boolean }[] = [];

beforeEach(() => {
  removals.length = 0;
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

async function open(
  status: WorktreeGitStatus,
  retire?: { sessionCount: number; merged: boolean; refusal?: string },
): Promise<void> {
  await act(async () => {
    root = createRoot(host);
    root.render(
      <RemoveWorktreeDialog
        worktree={WORKTREE}
        status={status}
        {...(retire ? { retire } : {})}
        onRemove={(options) => removals.push(options)}
        onClose={() => {}}
      />,
    );
  });
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

function confirmButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((element) =>
    /(Remove|Retire) worktree/.test(element.textContent ?? ""),
  );
  if (!(button instanceof HTMLButtonElement))
    throw new Error("no confirm button");
  return button;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

it("asks for force when Remove cannot resolve the base at all", async () => {
  await open(git({ baseUnresolved: true }));

  expect(document.body.textContent).toContain("does not exist locally");
  expect(confirmButton().disabled).toBe(true);

  await click(checkbox(/delete the branch unverified/));
  expect(confirmButton().disabled).toBe(false);
  await click(confirmButton());
  expect(removals).toEqual([{ deleteBranch: true, force: true }]);
});

it("leaves an unresolved base to Retire's own refreshed verification", async () => {
  await open(git({ baseUnresolved: true }), { sessionCount: 0, merged: false });

  // Forcing on a LOCAL absence would skip the containment check Retire is about
  // to make against the exact refreshed commit: absent locally does not mean
  // absent from the remote, so this is consent to a loss nobody established.
  expect(document.body.textContent).not.toContain("cannot be");
  expect(confirmButton().disabled).toBe(false);
  await click(confirmButton());
  expect(removals).toEqual([{ deleteBranch: true, force: false }]);
});

it("escalates a retirement only from the refusal its verification produced", async () => {
  await open(git({ baseUnresolved: true }), {
    sessionCount: 0,
    merged: false,
    refusal: "gone-base could not be refreshed.",
  });

  expect(document.body.textContent).toContain("could not be refreshed");
  expect(confirmButton().disabled).toBe(true);
  await click(checkbox(/retire anyway/));
  await click(confirmButton());
  expect(removals).toEqual([{ deleteBranch: true, force: true }]);
});

it("states the unverifiable branch alongside a dirty tree, not instead of it", async () => {
  await open(git({ dirty: true, baseUnresolved: true }));

  const shown = document.body.textContent ?? "";
  expect(shown).toContain("Uncommitted changes will be LOST");
  expect(shown).toContain("cannot be checked here");
  expect(shown).toContain("discard this work and delete the branch unverified");
});

it("needs no force to remove only the checkout of an undelivered branch", async () => {
  await open(git({ ahead: 3, merged: false }));

  // With the branch going too, this is the lost-work alarm.
  expect(document.body.textContent).toContain("Unmerged commits will be LOST");
  expect(confirmButton().disabled).toBe(true);

  await click(checkbox(/Also delete the branch/));
  expect(document.body.textContent).not.toContain("will be LOST");
  expect(confirmButton().disabled).toBe(false);
  await click(confirmButton());
  expect(removals).toEqual([{ deleteBranch: false, force: false }]);
});

it("still loses a dirty working tree whether or not the branch is kept", async () => {
  await open(git({ dirty: true, ahead: 1 }));

  await click(checkbox(/Also delete the branch/));
  expect(document.body.textContent).toContain(
    "Uncommitted changes will be LOST",
  );
  expect(document.body.textContent).not.toContain("not merged into");
  await click(checkbox(/discard this work/));
  await click(confirmButton());
  expect(removals).toEqual([{ deleteBranch: false, force: true }]);
});
