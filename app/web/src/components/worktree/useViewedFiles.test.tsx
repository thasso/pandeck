// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useViewedFiles } from "./useViewedFiles.ts";

/**
 * Two mounted surfaces can read one worktree at once — its route page and the
 * right panel's Worktree tab — and they share one localStorage key, which
 * `storage` does not announce inside the document that wrote it. What is pinned
 * here is that they see ONE set of marks: the second reader must not keep a
 * stale copy, and its next toggle must not write that copy back over the first
 * reader's marks.
 *
 * Each test uses its own worktree id, because the marks live in a module store
 * that outlives one test — which is the point of the store, not something to
 * reset around.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PATHS = ["src/a.ts", "src/b.ts"];

/** One reading surface: what it sees, and a control per path to toggle. */
function Reader({
  name,
  worktreeId,
  scope,
}: {
  name: string;
  worktreeId: string;
  scope: string;
}) {
  const { viewedPaths, toggleViewed } = useViewedFiles(worktreeId, scope);
  return (
    <div>
      <span data-testid={name}>{[...viewedPaths].sort().join(",")}</span>
      {PATHS.map((path) => (
        <button
          key={path}
          type="button"
          data-testid={`${name}:${path}`}
          onClick={() => toggleViewed(path)}
        />
      ))}
    </div>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
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

function viewed(name: string): string {
  return (
    container?.querySelector(`[data-testid="${name}"]`)?.textContent ?? "???"
  );
}

function toggle(name: string, path: string): void {
  act(() =>
    container
      ?.querySelector<HTMLButtonElement>(`[data-testid="${name}:${path}"]`)!
      .click(),
  );
}

it("shows both readers of one worktree the same marks", () => {
  act(() =>
    root!.render(
      <>
        <Reader name="route" worktreeId="wt-shared" scope="workingTree" />
        <Reader name="panel" worktreeId="wt-shared" scope="workingTree" />
      </>,
    ),
  );
  expect(viewed("route")).toBe("");

  // Marked in the panel, seen on the route.
  toggle("panel", "src/a.ts");
  expect(viewed("route")).toBe("src/a.ts");
  expect(viewed("panel")).toBe("src/a.ts");

  // And the other way: the second mark must ADD to the first, not replace a
  // stale set that never heard about it.
  toggle("route", "src/b.ts");
  expect(viewed("panel")).toBe("src/a.ts,src/b.ts");
  expect(
    JSON.parse(
      window.localStorage.getItem(
        "assistant.worktreeViewed:wt-shared:workingTree",
      )!,
    ).sort(),
  ).toEqual(["src/a.ts", "src/b.ts"]);

  toggle("panel", "src/a.ts");
  expect(viewed("route")).toBe("src/b.ts");
});

it("keeps each diff scope on its own marks", () => {
  act(() =>
    root!.render(
      <>
        <Reader name="working" worktreeId="wt-scopes" scope="workingTree" />
        <Reader name="range" worktreeId="wt-scopes" scope="range:base:" />
      </>,
    ),
  );
  toggle("working", "src/a.ts");
  expect(viewed("working")).toBe("src/a.ts");
  expect(viewed("range")).toBe("");
});
