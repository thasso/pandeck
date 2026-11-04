// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WorktreeChangeFile,
  WorktreeFileDiffResponse,
} from "@assistant/shared";
import type { DocumentLineAnchor } from "@assistant/shared/documentTargets";
import type { Prefs } from "../../hooks/usePrefs.ts";

/**
 * The stacked Changes list loads a file's diff only near the viewport and
 * folds viewed ones. An addressed line or a followed comment must reach the
 * file anyway: that is the only way to it now that the by-file view is gone.
 */

const requested: string[] = [];
vi.mock("../../lib/worktrees.ts", () => ({
  fetchWorktreeFileDiff: (_id: string, path: string) => {
    requested.push(path);
    return Promise.resolve({
      worktreeId: "wt-1",
      path,
      status: "modified",
      language: "typescript",
      binary: false,
      truncated: false,
      diff: `${path} patch`,
      oldContent: "old",
      newContent: "new",
      updatedAt: 1,
    } satisfies WorktreeFileDiffResponse);
  },
  hashContent: (value: string) => `hash:${value.length}`,
}));

const anchors: Array<DocumentLineAnchor | undefined> = [];
vi.mock("../diff/DiffSurface.tsx", () => ({
  DiffSurface: ({
    patch,
    lineAnchor,
  }: {
    patch: string;
    lineAnchor?: DocumentLineAnchor;
  }) => {
    anchors.push(lineAnchor);
    return <div>{patch}</div>;
  },
}));

const { WorktreeChangesetList } = await import("./WorktreeChangesetList.tsx");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const files: WorktreeChangeFile[] = ["near.ts", "far.ts"].map((path) => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 1,
  binary: false,
}));

let root: Root;
let container: HTMLDivElement;
const scrolled: string[] = [];

beforeEach(() => {
  requested.length = 0;
  anchors.length = 0;
  scrolled.length = 0;
  // Nothing is ever near the viewport: only an explicit request loads a diff.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.textContent ?? "");
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(
  props: Partial<Parameters<typeof WorktreeChangesetList>[0]> = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <WorktreeChangesetList
        worktreeId="wt-1"
        scope={{ kind: "workingTree" }}
        files={files}
        prefs={{ diffStyle: "unified" } as Prefs}
        refreshToken={0}
        commentsConfigFor={() => undefined}
        // Viewed, so folded.
        viewedPaths={new Set(["far.ts"])}
        onToggleViewed={() => {}}
        registerSection={() => {}}
        {...props}
      />,
    );
  });
}

it("loads nothing out of view on its own", async () => {
  await show();
  expect(requested).toEqual([]);
});

it("opens an addressed file and hands its diff the lines", async () => {
  const anchor = { start: 50, end: 55 };
  await show({ lineAnchor: { path: "far.ts", anchor } });
  expect(requested).toEqual(["far.ts"]);
  expect(container.textContent).toContain("far.ts patch");
  expect(anchors.at(-1)).toEqual(anchor);
  expect(scrolled.some((text) => text.includes("far.ts"))).toBe(true);
});

it("opens a followed comment's file, and again for a new follow", async () => {
  await show({ reveal: { path: "far.ts", nonce: 1 } });
  expect(requested).toEqual(["far.ts"]);
  expect(container.textContent).toContain("far.ts patch");
  expect(anchors.at(-1)).toBeUndefined();

  const before = scrolled.length;
  await show({ reveal: { path: "far.ts", nonce: 2 } });
  expect(scrolled.length).toBeGreaterThan(before);
});
