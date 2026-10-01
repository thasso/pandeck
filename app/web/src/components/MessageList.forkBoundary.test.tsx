// @vitest-environment jsdom
/**
 * The fork-boundary marker: a forked session shows its inherited prefix, and one
 * quiet rule says where that prefix ends and links back to the session it came
 * from.
 *
 * Without it the copied rows are indistinguishable from this session's own work
 * — the reader sees a conversation that never happened here and no way back to
 * where it did.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayMessage } from "@assistant/shared";
import { MessageList } from "./MessageList.tsx";
import type { TranscriptViewPrefs } from "./transcriptView.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const view: TranscriptViewPrefs = {
  showThinking: false,
  showTools: true,
  expandThinking: false,
  expandTools: false,
  wrapToolLines: false,
};

const inherited = (id: string, text: string): DisplayMessage => ({
  id,
  role: id.startsWith("u") ? "user" : "assistant",
  blocks: [{ kind: "text", text }],
  inheritedFrom: { sessionId: "parent-1", entryId: id },
});

const own = (id: string, text: string): DisplayMessage => ({
  id,
  role: id.startsWith("u") ? "user" : "assistant",
  blocks: [{ kind: "text", text }],
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  vi.unstubAllGlobals();
  root = null;
  container?.remove();
  container = null;
});

function render(props: {
  messages: DisplayMessage[];
  forkBoundary?: { parentTitle: string; onOpen: () => void };
}) {
  act(() =>
    root!.render(
      <MessageList
        sessionId="s1"
        messages={props.messages}
        view={view}
        {...(props.forkBoundary ? { forkBoundary: props.forkBoundary } : {})}
      />,
    ),
  );
}

/** The row ids in render order, with the marker in its place. */
function layout(): string[] {
  return [
    ...container!.querySelectorAll("[data-message-id], [data-fork-boundary]"),
  ].map((el) =>
    el.hasAttribute("data-fork-boundary")
      ? "«boundary»"
      : (el.getAttribute("data-message-id") ?? ""),
  );
}

describe("fork boundary marker", () => {
  it("draws one marker after the last inherited row", () => {
    const onOpen = vi.fn();
    render({
      messages: [
        inherited("u1", "parent prompt"),
        inherited("a1", "parent answer"),
        own("u2", "my prompt"),
        own("a2", "my answer"),
      ],
      forkBoundary: { parentTitle: "Parent chat", onOpen },
    });

    expect(layout()).toEqual(["u1", "a1", "«boundary»", "u2", "a2"]);
    const marker = container!.querySelector("[data-fork-boundary] button")!;
    expect(marker.textContent).toContain("Forked from Parent chat");

    act(() => (marker as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("draws it at the very end when nothing has been added yet", () => {
    // The state right after forking: the child holds only what it inherited, so
    // the boundary is the bottom of the transcript.
    render({
      messages: [inherited("u1", "parent prompt")],
      forkBoundary: { parentTitle: "Parent chat", onOpen: vi.fn() },
    });
    expect(layout()).toEqual(["u1", "«boundary»"]);
  });

  it("draws nothing in a session that is not a fork", () => {
    render({ messages: [own("u1", "hello"), own("a1", "hi")] });
    expect(layout()).toEqual(["u1", "a1"]);
  });

  it("stays hidden when the window opens past the inherited prefix", () => {
    // A long fork renders a bounded window of recent rows; with no inherited row
    // on screen there is nothing for the marker to sit under, and drawing it at
    // the top would claim the wrong rows came from the parent.
    render({
      messages: [own("u2", "my prompt"), own("a2", "my answer")],
      forkBoundary: { parentTitle: "Parent chat", onOpen: vi.fn() },
    });
    expect(layout()).toEqual(["u2", "a2"]);
  });
});
