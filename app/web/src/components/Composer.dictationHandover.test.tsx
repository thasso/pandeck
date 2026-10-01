// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantActions } from "../hooks/useAssistant.ts";
import type { PendingChatCommentsController } from "../hooks/usePendingChatComments.ts";
import { Composer } from "./Composer.tsx";

/**
 * The mobile mic hand-over. The composer's toolbar mic does not record on
 * mobile — it asks the host (`onRequestDictation`) and HIDES, because the dock
 * row that owns the recorder mounts only where the composer stood. Staged chat
 * comments and attachments normally pin the composer open, and that hold used
 * to outrank the hand-over: the composer stayed up, the row never mounted, and
 * the mic tap silently expired. These tests pin the override and its end — the
 * hold resumes the moment the user engages the composer again.
 */

const actions = { runSlashCommand: () => {} } as unknown as AssistantActions;

if (!window.matchMedia)
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.localStorage.clear();
});

function makeChatComments(): PendingChatCommentsController {
  return {
    comments: [
      {
        id: "c1",
        anchor: {
          kind: "session",
          sessionId: "s1",
          entryId: "e1",
          blockIndex: 0,
        },
        selectors: {
          quote: { exact: "a passage", prefix: "", suffix: "" },
          position: { start: 0, end: 9 },
        },
        quote: "a passage",
        body: "Please explain this.",
        transcriptPosition: {
          rowCreatedAt: "2026-08-20T14:32:00.000Z",
          rowId: "e1",
          blockIndex: 0,
        },
      },
    ],
    activeCommentId: null,
    add: vi.fn(() => true),
    update: vi.fn(async () => ({ status: "saved" as const })),
    remove: vi.fn(),
    clear: vi.fn(),
    select: vi.fn(),
  };
}

function render(options: {
  onRequestDictation?: () => void;
  onVisibilityChange?: (visible: boolean) => void;
  chatComments?: PendingChatCommentsController;
  transcript?: { spoken: string; token: number } | null;
}): { textarea: HTMLTextAreaElement; mic: HTMLButtonElement } {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() =>
    root!.render(
      <Composer
        onSend={() => {}}
        onAbort={() => {}}
        streaming={false}
        disabled={false}
        contextInfo={null}
        session={{ agentType: "developer", harness: "pi" } as never}
        models={[]}
        slashCommands={[]}
        actions={actions}
        draftAutoFocus={false}
        mobile
        {...(options.chatComments !== undefined
          ? { chatComments: options.chatComments }
          : {})}
        {...(options.onRequestDictation !== undefined
          ? { onRequestDictation: options.onRequestDictation }
          : {})}
        {...(options.onVisibilityChange !== undefined
          ? { onVisibilityChange: options.onVisibilityChange }
          : {})}
        {...(options.transcript !== undefined
          ? { transcript: options.transcript }
          : {})}
        dictation={{
          enabled: true,
          status: {
            configured: true,
            availableModelIds: [],
            maxUtteranceSeconds: 120,
          },
        }}
      />,
    ),
  );
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("composer textarea did not render");
  // The compact bar's toggle carries the same label but sits in the inert,
  // collapsed section; the toolbar mic is the one the user can reach.
  const mic = Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Start dictation"]',
    ),
  ).find((button) => !button.closest("[inert]"));
  if (!mic) throw new Error("toolbar mic did not render");
  return { textarea, mic };
}

describe("Composer dictation hand-over", () => {
  it("inserts a transcript delivered after mount", () => {
    const { textarea } = render({ transcript: null });

    render({ transcript: { spoken: "dictated words", token: 1 } });

    expect(textarea.value).toBe("dictated words");
  });

  it("hides despite an attached comment chip so the host row can record", () => {
    const onRequestDictation = vi.fn();
    const onVisibilityChange = vi.fn();
    const { mic } = render({
      onRequestDictation,
      onVisibilityChange,
      chatComments: makeChatComments(),
    });

    // The chip pins the composer open, so it starts visible.
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);

    act(() => mic.click());

    expect(onRequestDictation).toHaveBeenCalledOnce();
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  });

  it("lets the comment chip hold the composer open again once re-engaged", () => {
    const { textarea, mic } = render({
      onRequestDictation: vi.fn(),
      onVisibilityChange: vi.fn(),
      chatComments: makeChatComments(),
    });

    act(() => mic.click());

    // The dock's compose control focuses the textarea; from then on the staged
    // comment holds the composer open as usual, through a later blur.
    act(() => textarea.focus());
    act(() => textarea.blur());

    const card = container?.querySelector("[data-compact]");
    expect(card).toBeNull();
  });
});
