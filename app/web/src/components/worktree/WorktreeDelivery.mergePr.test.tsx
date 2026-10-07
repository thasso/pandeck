// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WorktreeHostingStatusResponse,
  WorktreeMergePrRequest,
  WorktreeMergePrResponse,
  WorktreeRecord,
} from "@assistant/shared";

/**
 * The worktree page's merge, which is the SECOND surface of the same server
 * call: the dialog's remote-branch opt-out has to reach the request body, and
 * the toast afterwards has to report what happened to the branch rather than
 * what was asked for — "kept" and "was NOT deleted" are different outcomes and
 * only one of them is a decision.
 *
 * The two `lib/` seams are mocked because the point is the WIRING between the
 * dialog and the request, not fetch or the toast host.
 */

const merges: WorktreeMergePrRequest[] = [];
const toasts: string[] = [];
let mergeResponse: WorktreeMergePrResponse;

vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: (message: string) => toasts.push(message),
}));

vi.mock("../../lib/worktrees.ts", () => ({
  fetchWorktreeStatus: async () => undefined,
  fetchWorktreeHosting: async (): Promise<WorktreeHostingStatusResponse> => ({
    worktreeId: "wt-1",
    provider: "github",
    pr: {
      number: 42,
      url: "https://example.test/pull/42",
      title: "Add /pr",
      state: "open",
    },
    // The dialog offers only what the repository reports as allowed.
    capabilities: {
      defaultBranch: "main",
      mergeMethods: ["squash", "merge", "rebase"],
      canClose: true,
    },
  }),
  mergeWorktreePr: async (_id: string, input: WorktreeMergePrRequest) => {
    merges.push(input);
    return mergeResponse;
  },
  autoCommitWorktree: async () => undefined,
  cleanWorktree: async () => undefined,
  commitWorktree: async () => undefined,
  createWorktreePr: async () => undefined,
  pushWorktree: async () => undefined,
  syncWorktree: async () => undefined,
}));

const { useWorktreeDelivery } = await import("./WorktreeDelivery.tsx");

/**
 * The delivery actions now live in the panel's own Actions section, so the test
 * host is what that section does: render each action as a button, and render
 * the dialogs the hook hands back.
 */
function DeliveryHost({ worktree }: { worktree: WorktreeRecord }) {
  const delivery = useWorktreeDelivery({ worktree });
  return (
    <>
      {delivery.actions.map((action) => (
        <button key={action.key} type="button" onClick={action.onRun}>
          {action.label}
          {action.hint ? <span>{action.hint}</span> : null}
        </button>
      ))}
      {delivery.dialogs}
    </>
  );
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const worktree: WorktreeRecord = {
  id: "wt-1",
  projectId: "proj",
  mainRepoRoot: "/repo",
  path: "/repo-wt",
  branch: "feature",
  baseBranch: "main",
  baseCommit: "abc",
  status: "active",
  sessionIds: [],
  taskIds: [],
  createdAt: 0,
  updatedAt: 0,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Render the section and open its merge dialog. */
async function openMergeDialog(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<DeliveryHost worktree={worktree} />);
  });
  click(find("button", "Merge pull request…#42"));
}

/** The element whose text is exactly `label`. */
function find<T extends Element>(selector: string, label: string): T {
  const match = [...document.querySelectorAll(selector)].find(
    (element) => (element.textContent ?? "").trim() === label,
  );
  expect(match, `nothing matching ${selector} labelled ${label}`).toBeDefined();
  return match as T;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** The dialog's remote-branch checkbox. */
function branchCheckbox(): HTMLInputElement {
  const label = [...document.querySelectorAll("label")].find((element) =>
    (element.textContent ?? "").includes("Delete the remote branch"),
  );
  expect(label, "no remote-branch checkbox in the merge dialog").toBeDefined();
  return label!.querySelector("input")!;
}

/** Click Merge and let the mocked request settle. */
async function confirmMerge(): Promise<void> {
  const button = find<HTMLButtonElement>("button", "Merge pull request");
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  merges.length = 0;
  toasts.length = 0;
  window.localStorage.clear();
  document.body.innerHTML = "";
  mergeResponse = {
    worktreeId: "wt-1",
    pr: {
      number: 42,
      url: "https://example.test/pull/42",
      title: "Add /pr",
      state: "merged",
    },
    method: "squash",
    branchDeleted: true,
  };
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

it("merges with the default method and deletes the remote branch", async () => {
  await openMergeDialog();
  expect(branchCheckbox().checked).toBe(true);
  await confirmMerge();

  // Deleting is the default, so the request says nothing about the branch.
  expect(merges).toEqual([{ method: "squash" }]);
  expect(toasts).toEqual(["Merged PR #42 and deleted the remote branch."]);
});

it("carries the dialog's opt-out into the request and reports the branch kept", async () => {
  mergeResponse = { ...mergeResponse, branchDeleted: false };
  await openMergeDialog();
  click(branchCheckbox());
  expect(document.body.textContent).toContain("The remote branch is kept");
  await confirmMerge();

  expect(merges).toEqual([{ method: "squash", deleteBranch: false }]);
  expect(toasts).toEqual(["Merged PR #42 and kept the remote branch."]);
});

// A deletion the provider refused is NOT the same event as one the user opted
// out of, and reporting it as "kept" would hide a stale branch behind a
// decision nobody made.
it("distinguishes a refused deletion from an intentional one", async () => {
  mergeResponse = { ...mergeResponse, branchDeleted: false };
  await openMergeDialog();
  await confirmMerge();

  expect(merges).toEqual([{ method: "squash" }]);
  expect(toasts).toEqual(["Merged PR #42; the remote branch was NOT deleted."]);
});
