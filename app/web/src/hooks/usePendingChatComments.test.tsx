// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  usePendingChatComments,
  type PendingChatCommentsController,
} from "./usePendingChatComments.ts";

let root: Root;
let container: HTMLDivElement;
let controller: PendingChatCommentsController;

function Harness({ storageKey }: { storageKey: string }) {
  const value = usePendingChatComments(storageKey);
  useEffect(() => {
    controller = value;
  }, [value]);
  return <span>{value.comments.length}</span>;
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(storageKey = "assistant.composerDraft.session:s1") {
  act(() => root.render(<Harness storageKey={storageKey} />));
}

function addComment() {
  act(() => {
    controller.add({
      sessionId: "s1",
      entryId: "e2",
      blockIndex: 0,
      selectors: {
        quote: { exact: "selected", prefix: "before ", suffix: " after" },
        position: { start: 7, end: 15 },
      },
      quote: "selected",
      body: "Please explain this.",
      transcriptPosition: {
        rowCreatedAt: "2026-08-20T14:32:00.000Z",
        rowId: "e2",
        blockIndex: 0,
      },
      entryCreatedAt: "2026-08-20T14:32:00.000Z",
    });
  });
}

it("restores attached comments from the composer draft namespace", () => {
  render();
  addComment();
  expect(container.textContent).toBe("1");
  // One record per comment, beside the text draft it rides with.
  const records = Object.keys(window.localStorage).filter((key) =>
    key.startsWith("assistant.composerDraft.session:s1.chatComments#"),
  );
  expect(records).toHaveLength(1);
  expect(window.localStorage.getItem(records[0]!)).toContain(
    "Please explain this.",
  );

  act(() => root.unmount());
  root = createRoot(container);
  render();
  expect(controller.comments).toHaveLength(1);
  expect(controller.comments[0]?.anchor).toEqual({
    kind: "session",
    sessionId: "s1",
    entryId: "e2",
    blockIndex: 0,
  });
});

it("switches session keys without copying comments between them", () => {
  render();
  addComment();
  render("assistant.composerDraft.session:s2");
  expect(controller.comments).toHaveLength(0);

  render("assistant.composerDraft.session:s1");
  expect(controller.comments).toHaveLength(1);
});

it("dismisses comments without touching the adjacent text draft", async () => {
  const draftKey = "assistant.composerDraft.session:s1";
  window.localStorage.setItem(draftKey, "Keep this text");
  render(draftKey);
  addComment();

  // Clearing waits for the store's cross-tab lock.
  await act(async () => controller.clear());
  expect(controller.comments).toHaveLength(0);
  expect(window.localStorage.getItem(draftKey)).toBe("Keep this text");
  expect(
    Object.keys(window.localStorage).filter((key) =>
      key.startsWith(`${draftKey}.chatComments`),
    ),
  ).toEqual([]);
});

it("reports a comment storage refused, so the composer can keep its text", () => {
  render();
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
  let stored = true;
  try {
    act(() => {
      stored = controller.add({
        sessionId: "s1",
        entryId: "e2",
        blockIndex: 0,
        selectors: { quote: { exact: "x", prefix: "", suffix: "" } },
        quote: "x",
        body: "Keep me",
        transcriptPosition: {
          rowCreatedAt: "2026-08-20T14:00:00.000Z",
          rowId: "e2",
          blockIndex: 0,
        },
      });
    });
  } finally {
    setItem.mockRestore();
  }
  expect(stored).toBe(false);
  expect(controller.comments).toHaveLength(0);
});
