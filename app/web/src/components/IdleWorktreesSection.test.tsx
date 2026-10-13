// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdleWorktree, WorktreeRecord } from "@assistant/shared";
import { failed, idle, loading, ready, refreshing } from "../lib/loadState.ts";

const hoisted = vi.hoisted(() => ({ retire: vi.fn() }));
vi.mock("../lib/worktrees.ts", () => ({ retireWorktree: hoisted.retire }));

const { IdleWorktreesSection } = await import("./IdleWorktreesSection.tsx");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  hoisted.retire.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

function worktree(id: string): WorktreeRecord {
  return {
    id,
    projectId: "pa",
    mainRepoRoot: "/repo",
    path: `/repo-${id}`,
    branch: `branch-${id}`,
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    sessionIds: [],
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Held once, quiet since the epoch: what the bulk act may take. */
function item(id: string, kind: IdleWorktree["kind"]): IdleWorktree {
  return {
    worktree: { ...worktree(id), treeSessionIds: ["s"] },
    kind,
    lastActivityAt: 0,
  };
}

const PROJECTS = new Map([
  ["pa", { key: "PA", name: "Pandeck", color: "#000" }],
]);
const NOOP = () => {};

function render(
  state: Parameters<typeof IdleWorktreesSection>[0]["idle"],
  onRetired = NOOP,
) {
  act(() =>
    root!.render(
      <IdleWorktreesSection
        idle={state}
        fetchedAt={10 * 86_400_000}
        pullRequests={[]}
        projects={PROJECTS}
        density="tight"
        onReload={NOOP}
        onOpenWorktree={NOOP}
        onRetired={onRetired}
      />,
    ),
  );
  return container!;
}

describe("IdleWorktreesSection", () => {
  it("reserves a row while loading, states a failure, and is absent when answered empty", () => {
    expect(
      render(loading()).querySelector('[aria-label="Loading idle worktrees"]'),
    ).not.toBeNull();
    expect(render(failed("boom")).textContent).toContain("boom");
    expect(render(ready([])).textContent).toBe("");
    expect(render(idle()).textContent).toBe("");
  });

  it("lists rows and offers the bulk act only for what has nothing unmerged", () => {
    const el = render(
      ready([item("a", "delivered"), item("b", "uncommitted")]),
    );
    expect(el.querySelectorAll("[data-idle-worktree-row]")).toHaveLength(2);
    expect(el.textContent).toContain("Idle worktrees (2)");
    expect(el.textContent).toContain("Retire 1…");
    expect(render(ready([item("b", "uncommitted")])).textContent).not.toContain(
      "Retire",
    );
  });

  it("retires without force, one at a time, and keeps a refusal in its dialog", async () => {
    hoisted.retire
      .mockResolvedValueOnce({ worktreeId: "a", status: "retired" })
      .mockResolvedValueOnce({
        worktreeId: "c",
        status: "refused",
        refusal: "branch has unmerged commits",
        refusalKind: "unmerged",
      });
    const onRetired = vi.fn();
    const el = render(
      ready([item("a", "delivered"), item("c", "delivered")]),
      onRetired,
    );
    const open = [...el.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retire 2…"),
    )!;
    act(() => open.click());
    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retire 2",
    )!;
    await act(async () => {
      confirm.click();
    });
    expect(hoisted.retire.mock.calls).toEqual([
      ["a", { deleteBranch: true, requireIdle: true }],
      ["c", { deleteBranch: true, requireIdle: true }],
    ]);
    expect(onRetired).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "1 retired; 1 refused — branch-c: branch has unmerged commits",
    );
  });
});

describe("IdleWorktreesSection bulk dialog", () => {
  const open = (el: HTMLElement, label: string) =>
    act(() =>
      [...el.querySelectorAll("button")]
        .find((button) => button.textContent?.includes(label))!
        .click(),
    );
  const confirm = (label: string) =>
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    )!;

  it("keeps its refusal when the refused checkout leaves the queue", async () => {
    hoisted.retire.mockResolvedValueOnce({
      worktreeId: "a",
      status: "refused",
      refusal: "a session is live there",
      refusalKind: "sessions",
    });
    // The refusal is what moves the checkout out: the refetch answers empty.
    const onRetired = vi.fn(() => render(ready([])));
    const el = render(ready([item("a", "delivered")]), onRetired);
    open(el, "Retire 1…");
    await act(async () => {
      confirm("Retire 1").click();
    });
    expect(onRetired).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "0 retired; 1 refused — branch-a: a session is live there",
    );
    // Answered: dismissed, not re-run.
    expect(confirm("Retire 1").disabled).toBe(true);
  });

  it("runs the targets it was opened on while a poll empties the rows", async () => {
    let settle: (value: unknown) => void = () => {};
    hoisted.retire.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const el = render(ready([item("a", "delivered")]));
    open(el, "Retire 1…");
    act(() => confirm("Retire 1").click());
    // A poll lands mid-run with an empty answer.
    render(ready([]));
    expect(document.body.textContent).toContain("Retire 1 worktree");
    await act(async () => {
      settle({ worktreeId: "a", status: "retired" });
    });
    expect(hoisted.retire).toHaveBeenCalledTimes(1);
  });
});

describe("IdleWorktreesSection retained states", () => {
  it("states a failed refresh over an empty retained answer", () => {
    expect(render(failed("idle read failed", [])).textContent).toContain(
      "idle read failed",
    );
  });

  it("marks a refresh over retained rows", () => {
    const el = render(refreshing([item("a", "uncommitted")]));
    expect(el.textContent).toContain("Refreshing idle worktrees");
    expect(el.querySelectorAll("[data-idle-worktree-row]")).toHaveLength(1);
  });
});
