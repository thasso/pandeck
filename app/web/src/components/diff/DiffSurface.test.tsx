// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Prefs } from "../../hooks/usePrefs.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiffCommentBarProvider } from "./comments.tsx";
import { DiffSurface } from "./DiffSurface.tsx";
import { CommentActuationProvider } from "../review/CommentActuation.tsx";

const pierreState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: () => null,
  MultiFileDiff: (props: { options: Record<string, unknown> }) => {
    pierreState.options = props.options;
    return null;
  },
}));

vi.mock("./DiffWorkerProvider.tsx", () => ({
  DiffWorkerProvider: ({ children }: { children: ReactNode }) => children,
  useDiffWorkerCompletionVersion: () => 0,
  useDiffWorkerReady: () => true,
}));

vi.mock("./useDiffScrollRestoration.ts", () => ({
  useDiffScrollRestoration: () => undefined,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let reactRoot: Root;

beforeEach(() => {
  pierreState.options = null;
  container = document.createElement("div");
  document.body.append(container);
  reactRoot = createRoot(container);
});

afterEach(async () => {
  await act(async () => reactRoot.unmount());
  container.remove();
});

it("starts comments from a text selection, never from Pierre's gutter", async () => {
  const prefs = { diffStyle: "unified", theme: "dark" } as Prefs;
  await act(async () =>
    reactRoot.render(
      <CommentActuationProvider>
        <DiffCommentBarProvider pendingCount={0} onSubmitReview={vi.fn()}>
          <DiffSurface
            prefs={prefs}
            oldFile={{ name: "file.ts", contents: "old\n" }}
            newFile={{ name: "file.ts", contents: "new\n" }}
            comments={{
              path: "file.ts",
              comments: [],
              actions: {
                onAddComment: vi.fn(),
                onResolveComment: vi.fn(),
                onDeleteComment: vi.fn(),
              },
            }}
          />
        </DiffCommentBarProvider>
      </CommentActuationProvider>,
    ),
  );

  expect(pierreState.options).not.toBeNull();
  for (const key of [
    "enableGutterUtility",
    "enableLineSelection",
    "onGutterUtilityClick",
    "onLineSelectionChange",
  ])
    expect(pierreState.options).not.toHaveProperty(key);
});
