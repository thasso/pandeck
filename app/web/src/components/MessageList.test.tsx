// @vitest-environment jsdom
import { act, useCallback, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppearanceSettings, DisplayMessage } from "@assistant/shared";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";
import type { TurnStatsSeed } from "@assistant/shared/turnStats";
import type { PromptQueueState } from "../hooks/useAssistant.ts";
import type {
  NewPendingChatComment,
  PendingChatCommentsController,
} from "../hooks/usePendingChatComments.ts";
import { mount } from "../test/mount.tsx";
import { chatToolCommentTargets, MessageList } from "./MessageList.tsx";
import type { TranscriptViewPrefs } from "./transcriptView.ts";

describe("MessageList chat comments", () => {
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
    ({ container, root } = mount());
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
    // Unmount before removing the popovers React portaled into the body.
    act(() => root.unmount());
    document.body
      .querySelectorAll("[data-popover-panel]")
      .forEach((node) => node.remove());
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
          blocks: [
            { kind: "text", text: "Finish here in the second message." },
          ],
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
            target.closest<HTMLElement>("[data-chat-render-block-index]")
              ?.dataset.chatRenderBlockIndex,
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
      const namedAction = [
        ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((button) =>
        button.textContent?.includes("Comment on this message"),
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
      const named = [
        ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((button) =>
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
      expect(
        projection.targetsByMessage.get("assistant-entry")?.get(1),
      ).toEqual({
        entryId: "result-entry",
        blockIndex: 0,
      });
    });
  });
});

/**
 * The fork-boundary marker: a forked session shows its inherited prefix, and one
 * quiet rule says where that prefix ends and links back to the session it came
 * from.
 *
 * Without it the copied rows are indistinguishable from this session's own work
 * — the reader sees a conversation that never happened here and no way back to
 * where it did.
 */
describe("fork boundary marker", () => {
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

  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    ({ container, root } = mount());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function render(props: {
    messages: DisplayMessage[];
    forkBoundary?: { parentTitle: string; onOpen: () => void };
  }) {
    act(() =>
      root.render(
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
      ...container.querySelectorAll("[data-message-id], [data-fork-boundary]"),
    ].map((el) =>
      el.hasAttribute("data-fork-boundary")
        ? "«boundary»"
        : (el.getAttribute("data-message-id") ?? ""),
    );
  }

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
    const marker = container.querySelector("[data-fork-boundary] button")!;
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

/**
 * A message sent while a turn was running says how it reached the model: a
 * steer where the turn read it, a follow-up as having come after the reply, so
 * the transcript never implies the model saw it before answering.
 */
describe("MessageList prompt delivery", () => {
  const view: TranscriptViewPrefs = {
    showThinking: false,
    showTools: true,
    expandThinking: false,
    expandTools: false,
    wrapToolLines: false,
  };

  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    ({ container, root } = mount());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const user = (
    id: string,
    text: string,
    promptDelivery?: DisplayMessage["promptDelivery"],
  ): DisplayMessage => ({
    id,
    role: "user",
    blocks: [{ kind: "text", text }],
    ...(promptDelivery ? { promptDelivery } : {}),
  });

  function rowText(id: string): string {
    return (
      container.querySelector(`[data-message-id="${id}"]`)?.textContent ?? ""
    );
  }

  it("labels steers and follow-ups, and leaves ordinary prompts alone", () => {
    act(() =>
      root.render(
        <MessageList
          sessionId="s"
          view={view}
          messages={[
            user("u1", "fix the test"),
            user("u2", "check the lock key", "steer"),
            user("u3", "add a regression test", "followUp"),
          ]}
        />,
      ),
    );
    expect(rowText("u1")).not.toMatch(/Steered|after the reply/);
    expect(rowText("u2")).toContain("Steered");
    expect(rowText("u3")).toContain("Arrived after the reply");
  });

  // Hover is the desktop reveal; a touch screen has no hover, so the row is
  // shown outright there instead of being an invisible tap target.
  it("shows message actions on coarse pointers and reveals them on hover elsewhere", () => {
    act(() =>
      root.render(
        <MessageList
          sessionId="s"
          view={view}
          messages={[user("u1", "fix the test")]}
        />,
      ),
    );
    const bar = container
      .querySelector('[data-message-id="u1"] [aria-label="Copy message text"]')
      ?.closest("div");
    expect(bar?.className).toContain("opacity-0");
    expect(bar?.className).toContain("group-hover/message:opacity-100");
    expect(bar?.className).toContain("focus-within:opacity-100");
    expect(bar?.className).toContain("pointer-coarse:opacity-100");
  });
});

describe("MessageList prompt origins", () => {
  const view: TranscriptViewPrefs = {
    showThinking: false,
    showTools: true,
    expandThinking: false,
    expandTools: false,
    wrapToolLines: false,
  };

  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    ({ container, root } = mount());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function render(
    message: DisplayMessage,
    onOpenBackgroundWork?: (taskId: string) => void,
  ): void {
    act(() =>
      root.render(
        <MessageList
          sessionId="session-1"
          messages={[message]}
          view={view}
          {...(onOpenBackgroundWork ? { onOpenBackgroundWork } : {})}
        />,
      ),
    );
  }

  it("labels a provider-initiated assistant turn with its system origin", () => {
    const message: DisplayMessage = {
      id: "provider-turn",
      role: "assistant",
      promptOrigin: {
        kind: "system",
        source: "claude-background:item-1",
      },
      blocks: [{ kind: "text", text: "Background work finished." }],
    };

    render(message);

    expect(container.textContent).toContain(
      "System prompt · claude-background:item-1",
    );
    expect(container.textContent).toContain("Background work finished.");
  });

  function backgroundMessage(
    update: Record<string, unknown>,
    omittedCount?: number,
  ): DisplayMessage {
    return {
      id: "background-turn",
      role: "user",
      promptOrigin: {
        kind: "system",
        source: "background-completion",
        presentation: {
          kind: "background-work",
          updates: [
            {
              taskId: "bgw_d7372bf0-c886-4282-8b6d-483b872d8872",
              label: "Build web bundle",
              humanLink:
                "/background-tasks?task=bgw_d7372bf0-c886-4282-8b6d-483b872d8872",
              ...update,
            },
          ],
          ...(omittedCount !== undefined ? { omittedCount } : {}),
        },
      },
      blocks: [
        {
          kind: "text",
          text: "Background work updated. Agent-only detail must stay hidden.",
        },
      ],
    } as DisplayMessage;
  }

  it("rests as one line: the job, and which way it ended as a glyph", () => {
    render(
      backgroundMessage({
        description: "Build web bundle",
        command: "cd app/web && pnpm run build",
        status: "completed",
        exitCode: 0,
        outcomeSummary: "Exited with code 0",
        output: {
          url: "/api/session-artifacts/session-1/output.txt",
          capturedBytes: 12,
        },
      }),
    );

    expect(container.textContent).toContain("Build web bundle");
    // The card only ever appears for a delivered update, and for a supervised
    // process the state IS the exit code: neither word adds anything.
    expect(container.textContent).not.toContain("Completed · exit 0");
    expect(container.textContent).not.toContain("Background work updated");
    expect(container.textContent).not.toContain("Agent-only detail");
    // Everything else waits behind the disclosure, including the output panel,
    // so a closed card fetches nothing.
    expect(container.textContent).not.toContain("cd app/web && pnpm run build");
    expect(container.textContent).not.toContain("Output · 12 B");
    expect(container.textContent).not.toContain("Open in registry");
    // The shared row exposes status even when the phone hides its visual label.
    expect(
      container
        .querySelector("button[aria-expanded]")
        ?.getAttribute("aria-label"),
    ).toContain("Completed");
  });

  it("opens to the command, the output and the registry without moving its top line", () => {
    const onOpenBackgroundWork = vi.fn();
    render(
      backgroundMessage({
        description: "Build web bundle",
        command: "cd app/web && pnpm run build",
        status: "completed",
        exitCode: 0,
        output: {
          url: "/api/session-artifacts/session-1/output.txt",
          capturedBytes: 12,
        },
      }),
      onOpenBackgroundWork,
    );

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[title="Build web bundle"]',
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle?.click());

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    // The line the reader clicked is still the line they clicked.
    expect(container.textContent).toContain("Build web bundle");
    expect(container.textContent).toContain("cd app/web && pnpm run build");
    expect(container.textContent).toContain("Output · 12 B");
    expect(container.textContent).not.toContain("Loading output");
    expect(
      container.querySelector('a[href^="/background-tasks?task="]'),
    ).toBeNull();
    const taskButton = container.querySelector<HTMLButtonElement>(
      'button[title="bgw_d7372bf0-c886-4282-8b6d-483b872d8872"]',
    );
    expect(taskButton).not.toBeNull();
    act(() => taskButton?.click());
    expect(onOpenBackgroundWork).toHaveBeenCalledWith(
      "bgw_d7372bf0-c886-4282-8b6d-483b872d8872",
    );
  });

  it("says how a failure ended once it is opened, and never twice", () => {
    render(
      backgroundMessage({
        label: "Run the gate",
        description: "Run the gate",
        command: "pnpm run test",
        status: "failed",
        exitCode: 2,
        outcomeSummary: "Exited with code 2",
      }),
    );

    expect(
      container
        .querySelector("button[aria-expanded]")
        ?.getAttribute("aria-label"),
    ).toContain("Failed");
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[title="Run the gate"]')
        ?.click(),
    );
    expect(container.textContent).toContain("Exited with code 2");
    // The server's sentence already carries the code; the card adds no second one.
    expect(container.textContent).not.toContain("exit 2");
  });

  it("drops the outcome summary that only repeats the job's own title", () => {
    render(
      backgroundMessage({
        label: "Find lucide install anywhere",
        description: "Find lucide install anywhere",
        command: "find / -name lucide-react",
        status: "stopped",
        outcomeSummary: "Find lucide install anywhere",
      }),
    );

    expect(
      container
        .querySelector("button[aria-expanded]")
        ?.getAttribute("aria-label"),
    ).toContain("Stopped");
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[title="Find lucide install anywhere"]',
        )
        ?.click(),
    );
    expect(container.textContent).toContain("find / -name lucide-react");
    expect(
      container.textContent?.match(/Find lucide install anywhere/g)?.length,
    ).toBe(1);
  });

  it("opens to the whole command even where the title was cut from it", () => {
    const command =
      "for pkg in shared server web; do pnpm --filter @assistant/$pkg run build; done";
    render(
      backgroundMessage({
        // No description: the label IS the command's first line, cut at the cap
        // and ellipsized on screen. The body still has to be readable.
        label: command.slice(0, 40),
        command,
        status: "completed",
      }),
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          `button[title="${command.slice(0, 40)}"]`,
        )
        ?.click(),
    );
    expect(container.textContent).toContain(command);
  });

  it("does not repeat a short command the visible top line already carries", () => {
    render(
      backgroundMessage({
        // No description, one short line: the title IS the command, and the row
        // shows it whole. Printing it again in the body would say it twice.
        label: "pnpm test",
        command: "pnpm test",
        status: "completed",
      }),
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[title="pnpm test"]')
        ?.click(),
    );
    expect(container.textContent?.match(/pnpm test/g)?.length).toBe(1);
  });

  it("repeats a command the top line had to ellipsize", () => {
    const command =
      "pnpm --filter @assistant/web exec vitest run src/components";
    render(backgroundMessage({ label: command, command, status: "completed" }));

    const toggle = container.querySelector<HTMLButtonElement>(
      `button[title="${command}"]`,
    );
    const title = toggle?.querySelector("span.truncate");
    // jsdom has no layout: state the overflow the browser would have measured.
    Object.defineProperty(title!, "scrollWidth", { value: 600 });
    Object.defineProperty(title!, "clientWidth", { value: 200 });
    act(() => toggle?.click());

    expect(container.textContent?.match(/pnpm --filter/g)?.length).toBe(2);
  });

  it("repeats a description the top line had to ellipsize, wrapped", () => {
    const description =
      "Watch the deploy log until the systemd unit reports the new release active";
    render(
      backgroundMessage({
        label: description,
        description,
        command: "journalctl -u personal-assistant -f",
        status: "completed",
      }),
    );

    const toggle = container.querySelector<HTMLButtonElement>(
      `button[title="${description}"]`,
    );
    const title = toggle?.querySelector("span.truncate");
    // jsdom has no layout: state the overflow the browser would have measured.
    Object.defineProperty(title!, "scrollWidth", { value: 600 });
    Object.defineProperty(title!, "clientWidth", { value: 200 });
    act(() => toggle?.click());

    // Once in the stable top line, once wrapped in the body — the command block
    // carries the command, and nothing else on the card carries the title.
    expect(
      container.textContent?.match(/until the systemd unit/g)?.length,
    ).toBe(2);
  });

  it("leaves a description the row showed whole out of the body", () => {
    render(
      backgroundMessage({
        label: "Build web bundle",
        description: "Build web bundle",
        command: "pnpm run build",
        status: "completed",
      }),
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[title="Build web bundle"]')
        ?.click(),
    );
    expect(container.textContent).toContain("pnpm run build");
    expect(container.textContent?.match(/Build web bundle/g)?.length).toBe(1);
  });

  it("keeps dropped updates visible while the card is closed", () => {
    render(
      backgroundMessage({ status: "completed", command: "pnpm run build" }, 2),
    );

    expect(container.textContent).toContain("2 more updates omitted");
  });

  it("does not add an origin badge to an ordinary assistant turn", () => {
    render({
      id: "ordinary-turn",
      role: "assistant",
      blocks: [{ kind: "text", text: "Ordinary answer." }],
    });

    expect(container.textContent).toBe("Ordinary answer.");
  });
});

/**
 * A prompt waiting in the permanent Assistant's queue says so ON ITSELF.
 *
 * `queued` and `working` are conditions, not events (`docs/messaging.md`): they
 * are states that one message is IN until the next update replaces them, so
 * they belong on that message's row and are never announced. They each used to
 * raise an info toast, which is the shape this closed.
 */
describe("MessageList queued prompts", () => {
  const view: TranscriptViewPrefs = {
    showThinking: false,
    showTools: true,
    expandThinking: false,
    expandTools: false,
    wrapToolLines: false,
  };

  /** The echo of a send, keyed the way `useAssistant` keys one. */
  const echo = (clientRequestId: string, text: string): DisplayMessage => ({
    id: `creq-${clientRequestId}`,
    role: "user",
    blocks: [{ kind: "text", text }],
  });

  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    ({ container, root } = mount());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function render(
    messages: DisplayMessage[],
    promptQueueStates?: Record<string, PromptQueueState>,
  ) {
    act(() =>
      root.render(
        <MessageList
          sessionId="pa"
          messages={messages}
          view={view}
          {...(promptQueueStates ? { promptQueueStates } : {})}
        />,
      ),
    );
  }

  /** What each row says about its own queue state, by row id. */
  function conditions(): Record<string, string> {
    const found: Record<string, string> = {};
    for (const row of container.querySelectorAll("[data-message-id]")) {
      const id = row.getAttribute("data-message-id") ?? "";
      for (const label of ["Queued", "Working"])
        if (row.textContent?.includes(label)) found[id] = label;
    }
    return found;
  }

  it("renders a queued prompt's condition on that prompt's own row", () => {
    const messages = [
      echo("c1", "what is on today?"),
      echo("c2", "and after?"),
    ];

    render(messages, { "creq-c1": "working", "creq-c2": "queued" });
    expect(conditions()).toEqual({ "creq-c1": "Working", "creq-c2": "Queued" });

    // Replaced by the next state, and gone once nothing is unresolved: the
    // condition is retired by what resolves it, never by a timer.
    render(messages, { "creq-c2": "working" });
    expect(conditions()).toEqual({ "creq-c2": "Working" });

    render(messages);
    expect(conditions()).toEqual({});
  });

  // The condition is per-message, not per-session: an ordinary row in the same
  // transcript says nothing, which is what stops it drifting into a second
  // working indicator for the whole chat.
  it("says nothing on a row that is not the one waiting", () => {
    render(
      [{ id: "u1", role: "user", blocks: [{ kind: "text", text: "hi" }] }],
      {
        "creq-c1": "queued",
      },
    );
    expect(conditions()).toEqual({});
  });
});

/**
 * What a WINDOWED transcript renders (Task-436): the reader must be able to walk
 * backwards past what the snapshot carried, and the turn stats over a suffix must
 * read as the continuation they are rather than a session that just started.
 *
 * Both fail silently — a missing control just looks like a short session, and an
 * unseeded Session line just looks like a cheap one.
 */
describe("windowed transcript rendering", () => {
  const view: TranscriptViewPrefs = {
    showThinking: false,
    showTools: true,
    expandThinking: false,
    expandTools: false,
    wrapToolLines: false,
  };

  const appearance: AppearanceSettings = {
    separatorAtTurnEnd: false,
    turnStatsRow: true,
    turnStatsPerRequest: false,
  } as AppearanceSettings;

  /** One complete turn: a prompt and an answer that reported usage. */
  function turn(n: number, input: number, context: number): DisplayMessage[] {
    return [
      {
        id: `u${n}`,
        role: "user",
        blocks: [{ kind: "text", text: `ask ${n}` }],
      },
      {
        id: `a${n}`,
        role: "assistant",
        blocks: [{ kind: "text", text: `answer ${n}` }],
        model: "opus",
        usage: {
          inputTokens: input,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUSD: 0.02,
          contextTokens: context,
        },
      },
    ];
  }

  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    // jsdom has no ResizeObserver; the transcript's scroll controller observes the
    // content box. A no-op is enough — nothing here depends on layout.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    ({ container, root } = mount());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function render(props: {
    messages?: DisplayMessage[];
    seed?: TurnStatsSeed;
    hasOlderMessages?: boolean;
    loadingOlderMessages?: boolean;
    onLoadOlderMessages?: () => void;
  }) {
    act(() =>
      root.render(
        <MessageList
          sessionId="s1"
          messages={props.messages ?? [...turn(9, 1_000, 50_000)]}
          view={view}
          appearance={appearance}
          {...(props.seed ? { turnStatsSeed: props.seed } : {})}
          hasOlderMessages={props.hasOlderMessages ?? false}
          loadingOlderMessages={props.loadingOlderMessages ?? false}
          {...(props.onLoadOlderMessages
            ? { onLoadOlderMessages: props.onLoadOlderMessages }
            : {})}
        />,
      ),
    );
  }

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find((el) =>
      el.textContent?.includes(label),
    ) as HTMLButtonElement | undefined;
  }

  it("marks rows for the platform-specific visibility policy", () => {
    render({});
    const rows = container.querySelectorAll("[data-message-id]");
    expect(rows).toHaveLength(2);
    expect(
      [...rows].every((row) => row.classList.contains("transcript-row")),
    ).toBe(true);
  });

  it("offers the server fetch only when older entries exist", () => {
    render({});
    expect(button("Load earlier messages")).toBeUndefined();

    const onLoadOlderMessages = vi.fn();
    render({ hasOlderMessages: true, onLoadOlderMessages });
    const control = button("Load earlier messages");
    expect(control).toBeDefined();
    act(() => control!.click());
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
  });

  it("still offers it with NO rows at all (Task-450)", () => {
    // A window can project to zero display rows (a slice of orphan tool results,
    // or a cached range that was one). The reader's only way back into the
    // session is this control, so the empty transcript must still draw it — App
    // mounts the transcript for exactly that case rather than the new-session
    // surface.
    const onLoadOlderMessages = vi.fn();
    render({ messages: [], hasOlderMessages: true, onLoadOlderMessages });
    const control = button("Load earlier messages");
    expect(control).toBeDefined();
    act(() => control!.click());
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
  });

  it("shows the request in flight instead of a second one", () => {
    render({ hasOlderMessages: true, loadingOlderMessages: true });
    expect(button("Loading earlier messages…")?.disabled).toBe(true);
  });

  it("draws no turn row for a leading FRAGMENT, and one for the turn after it", () => {
    // The window opened inside a turn (a tool loop longer than the wire budget),
    // so its first rows are that turn's tail: `partialTurn` says so, and the row
    // must not be drawn — its numbers are a fraction of the turn's and would
    // change the moment the rest of the turn is loaded.
    const fragment: DisplayMessage = {
      id: "a-frag",
      role: "assistant",
      blocks: [{ kind: "text", text: "…still working" }],
      model: "opus",
      usage: {
        inputTokens: 1_300,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0.03,
        contextTokens: 60_000,
      },
    };
    const seed: TurnStatsSeed = {
      cumulative: {
        input: 500_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 12.5,
      },
      prevContextSize: 48_000,
      usageTurnCount: 7,
      partialTurn: true,
    };

    render({ messages: [fragment, ...turn(9, 1_000, 70_000)], seed });
    const rows = container.querySelectorAll("[data-turn-stats-row]");
    expect(rows).toHaveLength(1);
    // The one row belongs to the COMPLETE turn after the fragment: its turn
    // input is that turn's 1.0k, never the fragment's 1.3k.
    expect(rows[0]!.textContent).toContain("Turn1.0k in");

    // Without the flag the same fragment would be drawn as if it were a turn.
    render({
      messages: [fragment, ...turn(9, 1_000, 70_000)],
      seed: { ...seed, partialTurn: false },
    });
    expect(container.querySelectorAll("[data-turn-stats-row]")).toHaveLength(2);
  });

  it("continues the Session cumulative and the context delta from the seed", () => {
    // Unseeded, one usage turn: no Session line to draw yet, and the turn claims
    // the whole context as its own growth.
    render({});
    expect(container.textContent).not.toContain("Session");
    expect(container.textContent).toContain("+50k");

    render({
      seed: {
        cumulative: {
          input: 500_000,
          output: 1_000,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 12.5,
        },
        prevContextSize: 48_000,
        usageTurnCount: 7,
      },
    });
    const seededText = container.textContent ?? "";
    // 500k + this turn's 1k, $12.50 + $0.02, and a context delta measured from
    // the seed's 48k rather than from zero.
    expect(seededText).toContain("Session501k in");
    expect(seededText).toContain("$12.52");
    expect(seededText).toContain("Context50k·+2.0k");
  });
});
