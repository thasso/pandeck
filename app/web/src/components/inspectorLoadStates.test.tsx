// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WorktreeChangesResponse,
  WorktreeComment,
  WorktreeRecord,
} from "@assistant/shared";
import type { KnowledgeInspectResponse } from "@assistant/shared/knowledgeBase";
import type { Prefs } from "../hooks/usePrefs.ts";

/**
 * How the object inspectors draw the five states
 * (`app/web/docs/loading-states.md`, Task-361 Phase 3d).
 *
 * The stable Inspector header never names the inspected object. While one has
 * not arrived, the body reserves its sections and must not show stale facts;
 * after a same-entry refetch failure it keeps the facts it already had under an
 * `ErrorNote` (R1/R2).
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Pending<T> {
  key: string;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const inspectRequests: Array<Pending<KnowledgeInspectResponse>> = [];
const changesRequests: Array<Pending<WorktreeChangesResponse>> = [];

function pending<T>(list: Array<Pending<T>>, key: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    list.push({ key, resolve, reject });
  });
}

vi.mock("../lib/knowledgeBaseApi.ts", () => ({
  fetchKnowledgeInspector: (
    target: { id?: string; path?: string },
    opts: { diffCommit?: string } = {},
  ) =>
    pending(
      inspectRequests,
      `${target.id ?? target.path}${opts.diffCommit ? `@${opts.diffCommit}` : ""}`,
    ),
  knowledgeAssetUrl: (entryId: string, path: string) =>
    `asset:${entryId}/${path}`,
  knowledgeFileUrl: (path: string) => `file:${path}`,
}));

// Partial, because the inspector lazily mounts the delivery section: whether
// that chunk resolves before this file ends is a race, and a replacing mock
// turns the fetchers it happens to reach into "no export defined" failures.
vi.mock(import("../lib/worktrees.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchWorktreeChanges: (id: string) =>
    pending(changesRequests, `changes:${id}`),
  fetchWorktreeStatus: () => new Promise<never>(() => {}),
  fetchWorktreeHosting: () => new Promise<never>(() => {}),
}));

const { KnowledgeInspector, TaskInspector, WorktreeInspector } =
  await import("./objectInspectors.tsx");

const openers = {
  onOpenTask: () => {},
  onOpenProject: () => {},
  onOpenSession: () => {},
  onOpenWorktree: () => {},
  onOpenKnowledge: () => {},
};

const prefs = { diffStyle: "unified", theme: "dark" } as Prefs;

const worktree: WorktreeRecord = {
  id: "wt-1",
  projectId: "proj",
  mainRepoRoot: "/repo",
  path: "/repo-wt",
  branch: "feature",
  baseBranch: "main",
  baseCommit: "base-oid",
  status: "active",
  sessionIds: [],
  taskIds: [],
  createdAt: 0,
  updatedAt: 0,
};

function knowledgeEntry(id: string, title: string): KnowledgeInspectResponse {
  return {
    kind: "entry",
    id,
    path: `${id}/index.md`,
    folder: id,
    slug: id,
    uri: `pa://knowledge/${id}`,
    title,
    type: "note",
    status: "active",
    summary: null,
    tags: [],
    aliases: [],
    links: [],
    sourceRefs: [],
    assets: [],
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    sizeBytes: 10,
    history: [],
    latestDiff: null,
    paObjectReferences: [],
  } as unknown as KnowledgeInspectResponse;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
  inspectRequests.length = 0;
  changesRequests.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function text(): string {
  return container!.textContent ?? "";
}

function pulses(): number {
  return container!.querySelectorAll(".motion-safe\\:animate-pulse").length;
}

it("reserves inspector details for an object that has not arrived", async () => {
  await act(async () => {
    root!.render(
      <TaskInspector
        task={undefined}
        tasks={[]}
        sessions={[]}
        openers={openers}
        onStartSession={() => {}}
      />,
    );
  });

  expect(
    container!.querySelector('[aria-label="Loading Inspector details"]'),
  ).toBeTruthy();
  expect(pulses()).toBeGreaterThan(0);
  expect(text()).not.toContain("Loading…");
  // R1: an object nobody answered for has no relations to be missing.
  expect(text()).not.toContain("No related objects yet.");
});

it("shows the new entry's placeholder rather than the previous entry's panel", async () => {
  const show = async (entryId: string) => {
    await act(async () => {
      root!.render(
        <KnowledgeInspector
          entryId={entryId}
          openers={openers}
          onStartSession={() => {}}
          prefs={prefs}
        />,
      );
    });
  };

  await show("kb-alpha");
  expect(
    container!.querySelector('[aria-label="Loading Inspector details"]'),
  ).toBeTruthy();

  await act(async () => {
    inspectRequests[0]!.resolve(knowledgeEntry("kb-alpha", "Alpha entry"));
  });
  expect(text()).toContain("kb-alpha");
  // The entry viewer, not this inspector, owns pending review submission.
  expect(container!.querySelector("[data-comment-bar]")).toBeNull();

  // R3: entry → entry is a different object, so Alpha's facts may not survive
  // a single frame under Beta's id.
  await show("kb-beta");
  expect(text()).not.toContain("kb-alpha");
  expect(
    container!.querySelector('[aria-label="Loading Inspector details"]'),
  ).toBeTruthy();
  expect(inspectRequests.map((request) => request.key)).toEqual([
    "kb-alpha",
    "kb-beta",
  ]);
});

it("keeps the entry panel and offers a retry when a refetch fails (R2)", async () => {
  await act(async () => {
    root!.render(
      <KnowledgeInspector
        entryId="kb-alpha"
        refreshToken={1}
        openers={openers}
        onStartSession={() => {}}
        prefs={prefs}
      />,
    );
  });
  await act(async () => {
    inspectRequests[0]!.resolve(knowledgeEntry("kb-alpha", "Alpha entry"));
  });

  await act(async () => {
    root!.render(
      <KnowledgeInspector
        entryId="kb-alpha"
        refreshToken={2}
        openers={openers}
        onStartSession={() => {}}
        prefs={prefs}
      />,
    );
  });
  expect(inspectRequests).toHaveLength(2);
  await act(async () => {
    inspectRequests[1]!.reject(new Error("inspect failed"));
  });

  expect(text()).toContain("kb-alpha");
  expect(text()).toContain("inspect failed");
  expect(container!.querySelector('[role="alert"]')).toBeTruthy();
});

async function showWorktreeInspector(
  comments: WorktreeComment[] = [],
): Promise<void> {
  await act(async () => {
    root!.render(
      <WorktreeInspector
        worktree={worktree}
        projects={[]}
        sessions={[]}
        sessionsFresh
        comments={comments}
        openers={openers}
        onStartSession={() => {}}
        onMerge={() => {}}
        onRemove={() => {}}
      />,
    );
  });
}

it("keeps pending review submission out of the worktree inspector", async () => {
  await showWorktreeInspector([
    {
      id: "comment-1",
      worktreeId: worktree.id,
      author: { kind: "user" },
      body: "Review this",
      current: { path: "src/app.ts", line: 3 },
      anchorState: "anchored",
      createdAt: 1,
      updatedAt: 1,
    },
  ]);

  expect(container!.querySelector("[data-comment-bar]")).toBeNull();
});
