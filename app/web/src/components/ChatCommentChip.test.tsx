// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PendingChatComment } from "../lib/chatCommentPrompt.ts";
import { ChatCommentChip } from "./ChatCommentChip.tsx";

/**
 * The chip is a LIST of what will ride with the next prompt. What it must not
 * be: a preview of the quotes (they are highlighted in the transcript, which is
 * where a row takes you), a second editor, or one tap from losing the lot.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function comment(id: string, body: string): PendingChatComment {
  return {
    id,
    anchor: {
      kind: "session",
      sessionId: "s1",
      entryId: `entry-${id}`,
      blockIndex: 0,
    },
    selectors: {
      quote: { exact: "the selected passage", prefix: "", suffix: "" },
    },
    quote: "the selected passage",
    body,
    transcriptPosition: {
      rowCreatedAt: "2026-08-20T14:00:00.000Z",
      rowId: `row-${id}`,
      blockIndex: 0,
    },
  };
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
}

function withText(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
}

const handlers = {
  onSelect: vi.fn(),
  onRemove: vi.fn(),
  onClear: vi.fn(),
  onReveal: vi.fn(),
};

function render(comments: PendingChatComment[]) {
  act(() =>
    root.render(
      <ChatCommentChip
        comments={comments}
        activeCommentId={null}
        onSelect={handlers.onSelect}
        onRemove={handlers.onRemove}
        onClear={handlers.onClear}
        onReveal={handlers.onReveal}
      />,
    ),
  );
}

it("counts the comments without quoting anything, and expands to a list", () => {
  handlers.onReveal.mockClear();
  render([comment("c1", "First thought"), comment("c2", "Second thought")]);

  const header = container.querySelector("button")!;
  expect(header.textContent).toContain("Comments");
  expect(header.textContent).toContain("2");
  expect(container.textContent).not.toContain("the selected passage");
  // Nothing that removes anything sits in the header, where the control beside
  // it merely collapses the panel.
  expect(button("Remove comment")).toBeUndefined();

  act(() => header.click());
  const row = withText("First thought")!;
  // One line, with the whole comment on hover.
  expect(row.title).toBe("First thought");
  act(() => row.click());
  expect(handlers.onReveal).toHaveBeenCalledWith(
    expect.objectContaining({ id: "c1" }),
  );
});

it("edits through the composer and removes one row at a time", () => {
  handlers.onSelect.mockClear();
  handlers.onRemove.mockClear();
  render([comment("c1", "First thought")]);
  act(() => container.querySelector("button")!.click());

  act(() => button("Edit comment")!.click());
  expect(handlers.onSelect).toHaveBeenCalledWith("c1");
  act(() => button("Remove comment")!.click());
  expect(handlers.onRemove).toHaveBeenCalledWith("c1");
});

it("asks before removing every comment", () => {
  handlers.onClear.mockClear();
  render([comment("c1", "First thought"), comment("c2", "Second thought")]);
  act(() => container.querySelector("button")!.click());

  act(() => withText("Remove all")!.click());
  expect(handlers.onClear).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Remove all 2?");

  act(() => withText("Keep")!.click());
  expect(handlers.onClear).not.toHaveBeenCalled();

  act(() => withText("Remove all")!.click());
  act(() => withText("Remove all")!.click());
  expect(handlers.onClear).toHaveBeenCalledTimes(1);
});
