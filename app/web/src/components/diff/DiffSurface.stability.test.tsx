// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Prefs } from "../../hooks/usePrefs.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiffCommentBarProvider, type CommentActions } from "./comments.tsx";
import { DiffSurface } from "./DiffSurface.tsx";

/**
 * What a re-render of the review page is allowed to cost the diff under it.
 *
 * Pierre's render effect has no dependency array: it runs on every render of its
 * React wrapper and compares the `options`, file and annotation objects it was
 * handed BY IDENTITY, rebuilding the surface when any of them is new. That DOM
 * holds the hover gutter — the "+" that opens a comment — so a fresh object here
 * makes the affordance under the reader's pointer blink out and come back, and
 * re-runs the highlight for the whole file.
 *
 * Our callers all build those objects inline, under pages that re-render on
 * every socket broadcast, so the counts below are the contract: a parent render
 * that changed nothing hands pierre the SAME objects. They are counts, never
 * durations — a regression here means work came back.
 */

const pierreProps = vi.hoisted(() => ({
  renders: 0,
  options: [] as unknown[],
  oldFile: [] as unknown[],
  newFile: [] as unknown[],
  lineAnnotations: [] as unknown[],
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: () => null,
  MultiFileDiff: (props: Record<string, unknown>) => {
    pierreProps.renders += 1;
    pierreProps.options.push(props.options);
    pierreProps.oldFile.push(props.oldFile);
    pierreProps.newFile.push(props.newFile);
    pierreProps.lineAnnotations.push(props.lineAnnotations);
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

beforeEach(() => {
  pierreProps.renders = 0;
  pierreProps.options = [];
  pierreProps.oldFile = [];
  pierreProps.newFile = [];
  pierreProps.lineAnnotations = [];
  container = document.createElement("div");
  document.body.append(container);
  reactRoot = createRoot(container);
});

afterEach(async () => {
  await act(async () => reactRoot.unmount());
  container.remove();
});

const PREFS = { diffStyle: "unified", theme: "dark" } as Prefs;
const ACTIONS: CommentActions = {
  onAddComment: () => {},
  onResolveComment: () => {},
  onDeleteComment: () => {},
};
const NO_COMMENTS: never[] = [];

/**
 * The host as the app really writes it: every object the surface receives is
 * built inline in the host's render, and the host re-renders for reasons of its
 * own (a broadcast).
 */
function Host({ onBump }: { onBump: (bump: () => void) => void }) {
  const [tick, setTick] = useState(0);
  onBump(() => setTick((value) => value + 1));
  return (
    <DiffCommentBarProvider pendingCount={0} onSubmitReview={() => {}}>
      <div data-tick={tick}>
        <DiffSurface
          prefs={PREFS}
          patch="diff"
          oldFile={{ name: "a.ts", contents: "one\ntwo\n" }}
          newFile={{ name: "a.ts", contents: "one\ntwo\nthree\n" }}
          cacheKey="k1"
          comments={{
            comments: NO_COMMENTS,
            path: "a.ts",
            actions: ACTIONS,
          }}
        />
      </div>
    </DiffCommentBarProvider>
  );
}

it("hands pierre the same objects across a parent re-render", async () => {
  let bump = () => {};
  await act(async () =>
    reactRoot.render(<Host onBump={(next) => (bump = next)} />),
  );
  const afterMount = pierreProps.renders;

  await act(async () => bump());
  await act(async () => bump());

  // The wrapper re-renders with the host (nothing memoizes it), but everything
  // pierre compares must be the object it already holds.
  expect(pierreProps.renders).toBe(afterMount + 2);
  expect(new Set(pierreProps.options).size).toBe(1);
  expect(new Set(pierreProps.oldFile).size).toBe(1);
  expect(new Set(pierreProps.newFile).size).toBe(1);
  expect(new Set(pierreProps.lineAnnotations).size).toBe(1);
});
