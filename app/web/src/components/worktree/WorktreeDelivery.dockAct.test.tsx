// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WorktreeGitStatus,
  WorktreeHostingStatusResponse,
  WorktreeRecord,
} from "@assistant/shared";

/**
 * Delivery's acts are now the PANEL's actions, and on a phone that panel is the
 * dock sheet: `InspectorChromeProvider`'s `onAct` collapses it after an action, and a
 * collapse UNMOUNTS the sheet's body — which is where `useWorktreeDelivery`'s
 * state and its dialogs live. So an action that answers with a dialog must not
 * collapse the sheet, or it destroys the dialog it just opened. This is invisible
 * on a desktop panel (nothing collapses there) and silent on a phone (the sheet
 * simply closes), so it is asserted here.
 */

vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: () => {},
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
  }),
  mergeWorktreePr: async () => undefined,
  autoCommitWorktree: async () => undefined,
  cleanWorktree: async () => undefined,
  commitWorktree: async () => undefined,
  createWorktreePr: async () => undefined,
  pushWorktree: async () => undefined,
  syncWorktree: async () => undefined,
}));

const { useWorktreeDelivery } = await import("./WorktreeDelivery.tsx");
const { Inspector, InspectorChromeProvider } =
  await import("../shell/Inspector.tsx");

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

const dirty: WorktreeGitStatus = {
  worktreeId: worktree.id,
  branch: "feature",
  head: "head-oid",
  dirty: true,
  filesChanged: 1,
  untracked: 0,
  additions: 1,
  deletions: 0,
  ahead: 1,
  behind: 0,
  merged: false,
  updatedAt: 1,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** The panel as the DOCK mounts it: collapse-on-act wired to `onAct`. */
function DockPanel({ onAct }: { onAct: () => void }) {
  const delivery = useWorktreeDelivery({ worktree, status: dirty });
  return (
    <InspectorChromeProvider header={false} onAct={onAct}>
      <Inspector relations={[]} actions={delivery.actions}>
        {delivery.dialogs}
      </Inspector>
    </InspectorChromeProvider>
  );
}

function button(label: string): HTMLButtonElement {
  const match = [...container!.querySelectorAll("button")].find((element) =>
    (element.textContent ?? "").trim().startsWith(label),
  );
  expect(match, `no action labelled ${label}`).toBeDefined();
  return match as HTMLButtonElement;
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

it("keeps the dock open for delivery acts that answer with a dialog", async () => {
  const onAct = vi.fn();
  await act(async () => {
    root!.render(<DockPanel onAct={onAct} />);
  });

  for (const label of [
    "Auto commit",
    "Commit with message…",
    "Merge pull request…",
    "Clean worktree…",
  ]) {
    await act(async () => {
      button(label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onAct, `${label} collapsed the dock`).not.toHaveBeenCalled();
  }
});

it("opens and keeps a delivery dialog mounted", async () => {
  const onAct = vi.fn();
  await act(async () => {
    root!.render(<DockPanel onAct={onAct} />);
  });
  await act(async () => {
    button("Commit with message…").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
  });

  expect(document.body.textContent).toContain("Commit");
  expect(button("Commit with message…")).toBeDefined();
  expect(onAct).not.toHaveBeenCalled();
});

it("still collapses the dock for an act that only changes the surface", async () => {
  const onAct = vi.fn();
  await act(async () => {
    root!.render(<DockPanel onAct={onAct} />);
  });
  await act(async () => {
    button("Push").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(onAct).toHaveBeenCalledOnce();
});
