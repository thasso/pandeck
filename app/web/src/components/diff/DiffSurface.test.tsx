// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SelectedLineRange } from "@pierre/diffs";
import type { Prefs } from "../../hooks/usePrefs.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiffCommentBarProvider } from "./comments.tsx";
import { DiffSurface } from "./DiffSurface.tsx";
import {
  CommentActuationProvider,
  useCommentActuation,
} from "../review/CommentActuation.tsx";
import { dismissToastKey, getToasts } from "../../lib/toast.ts";

const pierreState = vi.hoisted(() => ({
  options: null as {
    onGutterUtilityClick?: (range: SelectedLineRange) => void;
    onLineClick?: () => void;
    onLineSelectionChange?: (range: SelectedLineRange | null) => void;
  } | null,
  lineAnnotations: [] as Array<{ lineNumber: number }>,
  selectedLines: null as SelectedLineRange | null,
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: () => null,
  MultiFileDiff: (props: {
    options: typeof pierreState.options;
    lineAnnotations: Array<{ lineNumber: number }>;
    selectedLines: SelectedLineRange | null;
  }) => {
    pierreState.options = props.options;
    pierreState.lineAnnotations = props.lineAnnotations;
    pierreState.selectedLines = props.selectedLines;
    return null;
  },
}));

vi.mock("./DiffWorkerProvider.tsx", () => ({
  DiffWorkerProvider: ({ children }: { children: ReactNode }) => children,
  useDiffWorkerCompletionVersion: () => 0,
}));

vi.mock("./useDiffScrollRestoration.ts", () => ({
  useDiffScrollRestoration: () => undefined,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let reactRoot: Root;

function ActuationProbe() {
  const actuation = useCommentActuation();
  return actuation?.onComment ? (
    <button
      type="button"
      data-comment-actuation
      disabled={actuation.canComment !== true}
      onClick={actuation.onComment}
    >
      Add comment
    </button>
  ) : null;
}

beforeEach(() => {
  pierreState.options = null;
  pierreState.lineAnnotations = [];
  pierreState.selectedLines = null;
  container = document.createElement("div");
  document.body.append(container);
  reactRoot = createRoot(container);
});

afterEach(async () => {
  dismissToastKey("diff-comment-side");
  await act(async () => reactRoot.unmount());
  container.remove();
});

it("opens a composer directly from the additions gutter and rejects deletions", async () => {
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
          <ActuationProbe />
        </DiffCommentBarProvider>
      </CommentActuationProvider>,
    ),
  );

  const deletionRange = {
    start: 1,
    end: 1,
    side: "deletions",
  } as SelectedLineRange;
  await act(async () =>
    pierreState.options?.onLineSelectionChange?.(deletionRange),
  );
  expect(pierreState.selectedLines).toEqual(deletionRange);

  await act(async () =>
    pierreState.options?.onGutterUtilityClick?.(deletionRange),
  );
  expect(pierreState.selectedLines).toBeNull();
  expect(
    container.querySelector<HTMLButtonElement>("[data-comment-actuation]")!
      .disabled,
  ).toBe(true);
  expect(
    getToasts().some(
      (toast) =>
        toast.key === "diff-comment-side" &&
        toast.message === "Comments attach to the new side of a diff.",
    ),
  ).toBe(true);

  await act(async () =>
    pierreState.options?.onGutterUtilityClick?.({
      start: 1,
      end: 1,
      side: "additions",
    }),
  );
  expect(
    container.querySelector<HTMLButtonElement>("[data-comment-actuation]")!
      .disabled,
  ).toBe(true);
  expect(pierreState.lineAnnotations).toEqual(
    expect.arrayContaining([expect.objectContaining({ lineNumber: 1 })]),
  );
});
