// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorktreeGitStatus } from "@assistant/shared";
import type { Prefs } from "../../hooks/usePrefs.ts";

/**
 * The right panel's Knowledge tab: the Knowledge Base folder, read beside the
 * main pane through the SAME worktree file page the `/knowledge` route draws.
 * What is pinned here is the panel's own boundary — where its one outward
 * button goes, and that a card's request moves the panel to a file.
 */

const listed: string[] = [];
vi.mock("../../lib/worktrees.ts", () => ({
  fetchWorktreeStatus: () => new Promise<never>(() => {}),
  fetchWorktreeChanges: () => new Promise<never>(() => {}),
  fetchWorktreeFile: () => new Promise<never>(() => {}),
  fetchWorktreeFileDiff: () => new Promise<never>(() => {}),
  fetchWorktreeTree: (id: string) => {
    listed.push(id);
    return Promise.resolve([]);
  },
  fetchWorktreeLog: () => new Promise<never>(() => {}),
  fetchWorktreeFileLog: () => new Promise<never>(() => {}),
  hashContent: (value: string) => `hash:${value.length}`,
  worktreeFileRawUrl: (id: string, path: string) => `raw:${id}/${path}`,
}));
vi.mock("../diff/DiffWorkerProvider.tsx", () => ({
  DiffWorkerProvider: ({ children }: { children: React.ReactNode }) => children,
  useDiffWorkerCompletionVersion: () => 0,
}));
vi.mock("../diff/DiffSurface.tsx", () => ({
  DiffSurface: () => <div>diff surface</div>,
}));
vi.mock("../diff/FileSurface.tsx", () => ({
  FileSurface: () => <div>file surface</div>,
}));

const { KnowledgePanel } = await import("./KnowledgePanel.tsx");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const status: WorktreeGitStatus = {
  worktreeId: "knowledge",
  branch: "main",
  head: "head-oid",
  dirty: false,
  filesChanged: 0,
  untracked: 0,
  additions: 0,
  deletions: 0,
  ahead: 0,
  behind: 0,
  merged: false,
  updatedAt: 1,
};

const prefs = {
  worktreeChangesRailWidth: 300,
  worktreeChangesRailCollapsed: false,
  worktreeNavigatorViewMode: "tree",
  worktreeReviewMode: "changeset",
  diffStyle: "unified",
  theme: "dark",
} as Prefs;

let container: HTMLDivElement;
let root: Root;
let navigated: string[];

beforeEach(() => {
  navigated = [];
  listed.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(
  openRequest: { path: string; nonce: number } | null = null,
): Promise<void> {
  await act(async () => {
    root.render(
      <KnowledgePanel
        status={status}
        prefs={prefs}
        onUpdatePrefs={() => {}}
        openRequest={openRequest}
        onNavigate={(path) => navigated.push(path)}
      />,
    );
  });
}

function openInKnowledge(): void {
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label="Open in Knowledge"]',
  );
  expect(button).not.toBeNull();
  act(() => button!.click());
}

it("reads the Knowledge Base checkout and links out to the Knowledge route", async () => {
  await render();
  expect(container.textContent).toContain("Knowledge Base");
  expect(listed).toContain("knowledge");
  openInKnowledge();
  expect(navigated).toEqual(["/knowledge"]);
});

it("moves to the file a card asked for", async () => {
  await render({ path: "projects/plan.md", nonce: 1 });
  openInKnowledge();
  expect(navigated).toEqual(["/knowledge/files?path=projects%2Fplan.md"]);
});
