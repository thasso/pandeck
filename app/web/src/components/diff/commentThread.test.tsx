// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorktreeComment } from "@assistant/shared";
import {
  CommentComposer,
  CommentThread,
  useLineComments,
  type LineAnnotationEntry,
} from "./comments.tsx";

/**
 * What a line comment looks like once it is written, and what the box that
 * writes it carries. Both used to disagree with the rest of the app: the body
 * was plain text at a size nothing else used, and leaving the composer was a ✕
 * bolted onto a caption instead of an action in the composer itself.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// These surfaces ask whether the pointer is fine before taking focus.
if (!window.matchMedia)
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as typeof window.matchMedia;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const actions = {
  onAddComment: vi.fn(),
  onResolveComment: vi.fn(),
  onDeleteComment: vi.fn(),
};

function comment(body: string): WorktreeComment {
  return {
    id: "c1",
    worktreeId: "w1",
    body,
    author: { kind: "user" },
    createdAt: "2026-08-20T14:00:00.000Z",
    anchor: { path: "src/app.ts", line: 9, commit: "abc" },
    current: { path: "src/app.ts", line: 9 },
    anchorState: "anchored",
  } as unknown as WorktreeComment;
}

it("renders a comment body as Markdown, at the size it was typed at", () => {
  act(() =>
    root.render(
      <CommentThread
        root={comment("**Careful**: this drops the `id`\n\n- and the name")}
        replies={[]}
        actions={actions}
      />,
    ),
  );

  expect(container.querySelector("strong")?.textContent).toBe("Careful");
  expect(container.querySelector("code")?.textContent).toBe("id");
  expect(container.querySelector("li")?.textContent).toContain("and the name");
  // The app's one comment-body size, not the diff's mono caption.
  expect(container.querySelector(".prose-compact")).not.toBeNull();
});

it("leaves the composer through its own action, with nothing stating the line", () => {
  const onCancel = vi.fn();
  act(() =>
    root.render(<CommentComposer onSubmit={() => {}} onCancel={onCancel} />),
  );

  // The caption existed to carry the ✕; the ✕ is the composer's own control now.
  expect(container.textContent).not.toContain("Commenting on line");
  const cancel = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Cancel comment"]',
  )!;
  act(() => cancel.click());
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it("wraps every annotation, whatever the code column inherits", () => {
  let entries: LineAnnotationEntry[] = [];
  function Harness() {
    entries = useLineComments(
      {
        path: "src/app.ts",
        comments: [comment("a line long enough to need a second one")],
        actions,
      },
      12,
      () => {},
      () => {},
    );
    return <>{entries.map((entry) => entry.node as ReactNode)}</>;
  }
  act(() => root.render(<Harness />));

  // Pierre slots these under the code column's `white-space: pre`: a comment
  // that inherits it lays out as one line and widens the diff's scroll area.
  expect(entries).toHaveLength(2);
  for (const child of container.children)
    expect(child.className).toContain("whitespace-normal");
});
