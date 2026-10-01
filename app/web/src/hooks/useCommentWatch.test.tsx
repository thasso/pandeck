// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  useWorktreeCommentWatch,
  type CommentWatch,
  type WorktreeCommentWatchTransport,
} from "./useCommentWatch.ts";

/**
 * Two surfaces may read one object at once — a route and the side panel beside
 * it — and `unwatchComments` is not refcounted on the wire. What is pinned here
 * is the union: one list for the first holder, the unwatch only after the last
 * one leaves.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sent: string[] = [];
const worktreeTransport: WorktreeCommentWatchTransport = {
  listWorktreeComments: (worktreeId) => sent.push(`list:${worktreeId}`),
  unwatchWorktreeComments: (worktreeId) => sent.push(`unwatch:${worktreeId}`),
};

/** One reading surface: it holds its entry's threads while it is mounted. */
function Reader({ entryId, watch }: { entryId: string; watch: CommentWatch }) {
  useEffect(() => {
    watch.list(entryId);
    return () => watch.unwatch(entryId);
  }, [entryId, watch]);
  return null;
}

function Host({ readers }: { readers: { key: string; entryId: string }[] }) {
  const watch = useWorktreeCommentWatch(worktreeTransport);
  return (
    <>
      {readers.map((reader) => (
        <Reader key={reader.key} entryId={reader.entryId} watch={watch} />
      ))}
    </>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  sent.length = 0;
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

function show(readers: { key: string; entryId: string }[]): void {
  act(() => root!.render(<Host readers={readers} />));
}

/** Let a queued release reach the transport (or be cancelled before it does). */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

it("lists once for an entry and unwatches only when the last reader leaves", async () => {
  show([{ key: "route", entryId: "wt-alpha" }]);
  expect(sent).toEqual(["list:wt-alpha"]);

  // The panel opens the same entry: no second list, and no new subscription to
  // lose.
  show([
    { key: "route", entryId: "wt-alpha" },
    { key: "panel", entryId: "wt-alpha" },
  ]);
  expect(sent).toEqual(["list:wt-alpha"]);

  // The panel closes. The route is still reading the entry, so its threads
  // must survive.
  show([{ key: "route", entryId: "wt-alpha" }]);
  expect(sent).toEqual(["list:wt-alpha"]);

  show([]);
  await flushMicrotasks();
  expect(sent).toEqual(["list:wt-alpha", "unwatch:wt-alpha"]);

  // Coming back after the release landed is a fresh hold, so it lists again.
  show([{ key: "panel", entryId: "wt-alpha" }]);
  await flushMicrotasks();
  expect(sent).toEqual(["list:wt-alpha", "unwatch:wt-alpha", "list:wt-alpha"]);
});

it("keeps the subscription across a same-commit handoff between surfaces", async () => {
  show([{ key: "route", entryId: "wt-alpha" }]);
  expect(sent).toEqual(["list:wt-alpha"]);

  // The route releases and the panel acquires in ONE commit, and React runs
  // cleanups before setups — so the count touches zero between two surfaces
  // that never both let go. The wire must not see that.
  show([{ key: "panel", entryId: "wt-alpha" }]);
  await flushMicrotasks();
  expect(sent).toEqual(["list:wt-alpha"]);

  // A real release still reaches the wire, one microtask later.
  show([]);
  expect(sent).toEqual(["list:wt-alpha"]);
  await flushMicrotasks();
  expect(sent).toEqual(["list:wt-alpha", "unwatch:wt-alpha"]);
});

it("counts each entry on its own", async () => {
  show([
    { key: "route", entryId: "wt-alpha" },
    { key: "panel", entryId: "wt-beta" },
  ]);
  expect(sent).toEqual(["list:wt-alpha", "list:wt-beta"]);

  show([{ key: "panel", entryId: "wt-beta" }]);
  await flushMicrotasks();
  expect(sent).toEqual(["list:wt-alpha", "list:wt-beta", "unwatch:wt-alpha"]);
});

/** The worktree half: same union, its own pair of sends. */
function WorktreeHost({ readers }: { readers: { key: string; id: string }[] }) {
  const watch = useWorktreeCommentWatch(worktreeTransport);
  return (
    <>
      {readers.map((reader) => (
        <Reader key={reader.key} entryId={reader.id} watch={watch} />
      ))}
    </>
  );
}

it("counts the worktree route and the side panel as one subscription", async () => {
  act(() =>
    root!.render(<WorktreeHost readers={[{ key: "route", id: "wt-1" }]} />),
  );
  expect(sent).toEqual(["list:wt-1"]);

  // The session's worktree opens in the panel while its page is routed.
  act(() =>
    root!.render(
      <WorktreeHost
        readers={[
          { key: "route", id: "wt-1" },
          { key: "panel", id: "wt-1" },
        ]}
      />,
    ),
  );
  expect(sent).toEqual(["list:wt-1"]);

  // Leaving the page keeps the panel's diffs commentable.
  act(() =>
    root!.render(<WorktreeHost readers={[{ key: "panel", id: "wt-1" }]} />),
  );
  await flushMicrotasks();
  expect(sent).toEqual(["list:wt-1"]);

  act(() => root!.render(<WorktreeHost readers={[]} />));
  await flushMicrotasks();
  expect(sent).toEqual(["list:wt-1", "unwatch:wt-1"]);
});
