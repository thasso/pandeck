// @vitest-environment jsdom
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayMessage } from "@assistant/shared";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";
import type {
  NewPendingChatComment,
  PendingChatCommentsController,
} from "../hooks/usePendingChatComments.ts";
import { chatToolCommentTargets, MessageList } from "./MessageList.tsx";
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

let root: Root;
let container: HTMLDivElement;
let comments: PendingChatCommentsController;

beforeEach(() => {
  vi.useFakeTimers();
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
  comments = {
    comments: [],
    activeCommentId: null,
    add: vi.fn(() => true),
    update: vi.fn(async () => ({ status: "saved" as const })),
    remove: vi.fn(),
    clear: vi.fn(),
    select: vi.fn(),
  };
});

afterEach(() => {
  act(() => root.unmount());
  document.body
    .querySelectorAll("[data-popover-panel]")
    .forEach((node) => node.remove());
  container.remove();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function CommentBridge({
  messages,
  sessionId,
  timeline,
}: {
  messages: DisplayMessage[];
  sessionId: string;
  timeline?: ClientTimelineEntry[] | undefined;
}) {
  const [selection, setSelection] = useState<{
    quote: string;
    onComment: () => void;
  } | null>(null);
  const [draft, setDraft] = useState<Omit<
    NewPendingChatComment,
    "body"
  > | null>(null);
  const [body, setBody] = useState("");
  const changeDraft = useCallback(
    (next: Omit<NewPendingChatComment, "body"> | null) => {
      setDraft(next);
      if (!next) setBody("");
    },
    [],
  );
  return (
    <>
      <MessageList
        sessionId={sessionId}
        messages={messages}
        timeline={timeline}
        view={view}
        chatComments={comments}
        commentDraft={draft}
        onCommentDraftChange={changeDraft}
        onCommentSelectionChange={setSelection}
      />
      {selection ? (
        <div data-comment-bar>
          <button
            onPointerDown={(event) => event.preventDefault()}
            onClick={selection.onComment}
          >
            Comment on “{selection.quote}”
          </button>
        </div>
      ) : null}
      {draft ? (
        <div data-comment-bar>
          <span>Comment on “{draft.quote}”</span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <button
            onClick={() => {
              comments.add({ ...draft, body });
              setDraft(null);
              setBody("");
            }}
          >
            Attach comment
          </button>
        </div>
      ) : null}
    </>
  );
}

function render(
  messages: DisplayMessage[],
  options: {
    sessionId?: string;
    timeline?: ClientTimelineEntry[];
  } = {},
) {
  const dated = messages.map((message, index) => ({
    ...message,
    createdAt:
      message.createdAt ??
      new Date(Date.UTC(2026, 7, 20, 14, index, 0)).toISOString(),
  }));
  act(() =>
    root.render(
      <CommentBridge
        sessionId={options.sessionId ?? "s1"}
        messages={dated}
        timeline={options.timeline}
      />,
    ),
  );
}

function textNodeContaining(value: string): Text {
  const walker = document.createTreeWalker(container, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node.textContent?.includes(value)) return node as Text;
  throw new Error(`Text node not found: ${value}`);
}

async function capture(range: Range) {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  await act(async () => vi.advanceTimersByTime(150));
}

describe("transcript chat comments", () => {
  it("does not scan or observe streaming DOM when no comments are pending", () => {
    let observerCount = 0;
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor() {
          observerCount += 1;
        }
        observe(): void {}
        disconnect(): void {}
        takeRecords(): MutationRecord[] {
          return [];
        }
      },
    );
    const queryAll = vi.spyOn(Element.prototype, "querySelectorAll");

    render([
      {
        id: "entry-a",
        role: "assistant",
        blocks: [{ kind: "text", text: "A steady-state response" }],
      },
    ]);

    expect(observerCount).toBe(0);
    expect(queryAll).not.toHaveBeenCalledWith("[data-chat-comment-target]");
  });

  it("captures an assistant text block and attaches the composed body", async () => {
    render([
      {
        id: "entry-a",
        role: "assistant",
        blocks: [{ kind: "text", text: "Before selected passage after." }],
      },
    ]);
    const text = textNodeContaining("Before selected");
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 23);
    await capture(range);

    const action = container.querySelector<HTMLButtonElement>(
      "[data-comment-bar] button",
    )!;
    expect(action.textContent).toContain("selected passage");
    act(() => action.click());
    expect(container.textContent).toContain("Attach comment");

    const editor = container.querySelector<HTMLTextAreaElement>(
      "[data-comment-bar] textarea",
    )!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(editor, "Clarify this");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const attach = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Attach comment",
    )!;
    act(() => attach.click());

    expect(comments.add).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        entryId: "entry-a",
        blockIndex: 0,
        quote: "selected passage",
        body: "Clarify this",
        transcriptPosition: {
          rowCreatedAt: "2026-08-20T14:00:00.000Z",
          rowId: "entry-a",
          blockIndex: 0,
        },
      }),
    );
  });

  it("captures again after comment mode closes", async () => {
    render([
      {
        id: "entry-a",
        role: "assistant",
        blocks: [
          {
            kind: "text",
            text: "First selected passage, then another passage.",
          },
        ],
      },
    ]);
    const text = textNodeContaining("First selected");
    const first = document.createRange();
    first.setStart(text, 6);
    first.setEnd(text, 22);
    await capture(first);
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-comment-bar] button")!
        .click(),
    );
    // Closing the bridge's comment mode follows the same null draft transition
    // as Composer attach/cancel and must release useSelectionAnchor's hold.
    act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Attach comment")!
        .click(),
    );

    const second = document.createRange();
    second.setStart(text, 29);
    second.setEnd(text, 44);
    await capture(second);
    expect(
      container.querySelector("[data-comment-bar]")?.textContent,
    ).toContain("another passage");
  });

  it("clamps a cross-message selection to the block containing its start", async () => {
    render([
      {
        id: "entry-a",
        role: "assistant",
        blocks: [{ kind: "text", text: "Start here and finish." }],
      },
      {
        id: "entry-b",
        role: "assistant",
        blocks: [{ kind: "text", text: "Do not include this." }],
      },
    ]);
    const first = textNodeContaining("Start here");
    const second = textNodeContaining("Do not include");
    const range = document.createRange();
    range.setStart(first, 6);
    range.setEnd(second, 7);
    await capture(range);
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-comment-bar] button")!
        .click(),
    );

    expect(
      container.querySelector("[data-comment-bar]")?.textContent,
    ).toContain("here and finish.");
    expect(
      container.querySelector("[data-comment-bar]")?.textContent,
    ).not.toContain("Do not include");
  });

  it("uses the drag origin when a cross-message selection runs backwards", async () => {
    render([
      {
        id: "entry-a",
        role: "assistant",
        blocks: [{ kind: "text", text: "Do not use this beginning." }],
      },
      {
        id: "entry-b",
        role: "assistant",
        blocks: [{ kind: "text", text: "Finish here in the second message." }],
      },
    ]);
    const first = textNodeContaining("Do not use");
    const second = textNodeContaining("Finish here");
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(second, 11, first, 7);
    document.dispatchEvent(new Event("selectionchange"));
    await act(async () => vi.advanceTimersByTime(150));
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-comment-bar] button")!
        .click(),
    );

    expect(
      container.querySelector("[data-comment-bar]")?.textContent,
    ).toContain("Finish here");
    expect(
      container.querySelector("[data-comment-bar]")?.textContent,
    ).not.toContain("Do not use");
  });

  it("uses one rendered row/block coordinate for mixed text and tool targets", () => {
    render(
      [
        {
          id: "assistant-entry",
          role: "assistant",
          createdAt: "2026-08-20T14:31:00.000Z",
          blocks: [
            { kind: "text", text: "Opening text" },
            {
              kind: "tool",
              toolId: "tc1",
              name: "read",
              args: {},
              output: "tool body",
              isError: false,
              done: true,
            },
            { kind: "text", text: "Final text" },
          ],
        },
      ],
      {
        timeline: [
          {
            id: "assistant-entry",
            seq: 10,
            createdAt: "2026-08-20T14:31:00.000Z",
            type: "message",
            role: "assistant",
            content: [
              { type: "text", text: "Opening text" },
              {
                type: "toolCall",
                toolCallId: "tc1",
                name: "read",
                input: {},
              },
              { type: "text", text: "Final text" },
            ],
          },
          {
            id: "tool-result",
            seq: 11,
            createdAt: "2026-08-20T14:31:01.000Z",
            type: "message",
            role: "toolResult",
            toolCallId: "tc1",
            content: [{ type: "text", text: "tool body" }],
          },
        ] as ClientTimelineEntry[],
      },
    );

    const targets = Array.from(
      container.querySelectorAll<HTMLElement>(
        "[data-chat-comment-target], [data-chat-comment-named-target]",
      ),
    );
    expect(
      targets.map((target) => ({
        entryId: target.dataset.chatEntryId,
        anchorBlock: Number(target.dataset.chatBlockIndex),
        renderedBlock: Number(
          target.closest<HTMLElement>("[data-chat-render-block-index]")?.dataset
            .chatRenderBlockIndex,
        ),
      })),
    ).toEqual([
      { entryId: "assistant-entry", anchorBlock: 0, renderedBlock: 0 },
      { entryId: "tool-result", anchorBlock: 0, renderedBlock: 1 },
      { entryId: "assistant-entry", anchorBlock: 2, renderedBlock: 2 },
    ]);
  });

  it("uses the same row coordinate before and after timeline hydration", async () => {
    const messages: DisplayMessage[] = [
      {
        id: "entry-a",
        role: "assistant",
        createdAt: "2026-08-20T14:31:00.000Z",
        blocks: [{ kind: "text", text: "Before hydration" }],
      },
      {
        id: "entry-b",
        role: "assistant",
        createdAt: "2026-08-20T14:32:00.000Z",
        blocks: [{ kind: "text", text: "After hydration" }],
      },
    ];
    const submitEditor = () => {
      expect(container.textContent).toContain("Attach comment");
      const editor = container.querySelector<HTMLTextAreaElement>(
        "[data-comment-bar] textarea",
      )!;
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(editor, "Comment");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      });
      act(() =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Attach comment")!
          .click(),
      );
    };

    render(messages);
    const beforeText = textNodeContaining("Before hydration");
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(beforeText);
    await capture(beforeRange);
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-comment-bar] button")!
        .click(),
    );
    submitEditor();
    const timeline = messages.map((message, index) => ({
      id: message.id,
      seq: 100 + index,
      createdAt: message.createdAt!,
      type: "message" as const,
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text:
            message.blocks[0]?.kind === "text" ? message.blocks[0].text : "",
        },
      ],
    }));
    render(messages, { timeline });
    const afterRow = Array.from(
      container.querySelectorAll<HTMLElement>("[data-message-id]"),
    ).find((row) => row.dataset.messageId === "entry-b")!;
    act(() =>
      afterRow
        .querySelector<HTMLButtonElement>(
          'button[title="More message actions"]',
        )!
        .click(),
    );
    const namedAction = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Comment on this message"),
    )!;
    act(() => namedAction.click());
    submitEditor();

    const calls = vi.mocked(comments.add).mock.calls;
    expect(calls[0]?.[0].transcriptPosition).toEqual({
      rowCreatedAt: "2026-08-20T14:31:00.000Z",
      rowId: "entry-a",
      blockIndex: 0,
    });
    expect(calls[1]?.[0].transcriptPosition).toEqual({
      rowCreatedAt: "2026-08-20T14:32:00.000Z",
      rowId: "entry-b",
      blockIndex: 0,
    });
  });

  it("does not expose optimistic prompt rows as session comment targets", async () => {
    render([
      {
        id: "creq-optimistic",
        role: "user",
        blocks: [{ kind: "text", text: "Optimistic prompt" }],
      },
    ]);

    expect(container.querySelector("[data-chat-comment-target]")).toBeNull();
    expect(
      container.querySelector('button[title="More message actions"]'),
    ).toBeNull();
    const text = textNodeContaining("Optimistic prompt");
    const range = document.createRange();
    range.selectNodeContents(text);
    await capture(range);
    container
      .querySelector<HTMLButtonElement>("[data-comment-bar] button")
      ?.click();
    expect(comments.add).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Attach comment");
  });

  it("closes an in-progress comment editor when the session changes", async () => {
    render([
      {
        id: "entry-a",
        role: "assistant",
        blocks: [{ kind: "text", text: "Session A passage" }],
      },
    ]);
    const text = textNodeContaining("Session A passage");
    const range = document.createRange();
    range.selectNodeContents(text);
    await capture(range);
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-comment-bar] button")!
        .click(),
    );
    expect(container.textContent).toContain("Attach comment");

    render(
      [
        {
          id: "entry-b",
          role: "assistant",
          blocks: [{ kind: "text", text: "Session B passage" }],
        },
      ],
      { sessionId: "s2" },
    );

    expect(container.textContent).not.toContain("Attach comment");
    expect(comments.add).not.toHaveBeenCalled();
  });

  it("offers the named message action when selection is awkward", () => {
    render([
      {
        id: "entry-u",
        role: "user",
        blocks: [{ kind: "text", text: "A previous prompt" }],
      },
    ]);
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[title="More message actions"]',
        )!
        .click(),
    );
    const named = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Comment on this message"),
    )!;
    act(() => named.click());
    expect(container.textContent).toContain("Comment on “A previous prompt”");
  });
});

describe("chatToolCommentTargets", () => {
  it("maps a rendered tool block to its separate tool-result entry", () => {
    const timeline = [
      {
        id: "assistant-entry",
        seq: 1,
        createdAt: "2026-08-20T14:31:00.000Z",
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", text: "hmm" },
          { type: "toolCall", toolCallId: "tc1", name: "read", input: {} },
        ],
      },
      {
        id: "result-entry",
        seq: 2,
        createdAt: "2026-08-20T14:32:00.000Z",
        type: "message",
        role: "toolResult",
        toolCallId: "tc1",
        content: [{ type: "text", text: "rendered body" }],
      },
    ] as ClientTimelineEntry[];

    const projection = chatToolCommentTargets(timeline);
    expect(projection.targetsByMessage.get("assistant-entry")?.get(1)).toEqual({
      entryId: "result-entry",
      blockIndex: 0,
    });
  });
});
