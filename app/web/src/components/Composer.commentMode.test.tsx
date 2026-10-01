// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AssistantActions } from "../hooks/useAssistant.ts";
import type {
  NewPendingChatComment,
  PendingChatCommentsController,
} from "../hooks/usePendingChatComments.ts";
import { Composer } from "./Composer.tsx";

const actions = { runSlashCommand: () => {} } as unknown as AssistantActions;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

if (!window.matchMedia)
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as typeof window.matchMedia;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function type(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("preserves the prompt draft byte-for-byte through comment mode", () => {
  const chatComments: PendingChatCommentsController = {
    comments: [],
    activeCommentId: null,
    add: vi.fn(() => true),
    update: vi.fn(async () => ({ status: "saved" as const })),
    remove: vi.fn(),
    clear: vi.fn(),
    select: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Harness() {
    const [draft, setDraft] = useState<Omit<
      NewPendingChatComment,
      "body"
    > | null>(null);
    return (
      <>
        <button
          onClick={() =>
            setDraft({
              sessionId: "s1",
              entryId: "e1",
              blockIndex: 0,
              quote: "selected text",
              selectors: {
                quote: { exact: "selected text", prefix: "", suffix: "" },
              },
              transcriptPosition: {
                rowCreatedAt: "2026-08-20T14:00:00.000Z",
                rowId: "e1",
                blockIndex: 0,
              },
            })
          }
        >
          Open comment
        </button>
        <Composer
          onSend={() => {}}
          onAbort={() => {}}
          streaming={false}
          disabled={false}
          contextInfo={null}
          session={
            { sessionId: "s1", agentType: "developer", harness: "pi" } as never
          }
          models={[]}
          slashCommands={[]}
          actions={actions}
          draftAutoFocus={false}
          chatComments={chatComments}
          commentDraft={draft}
          onCommentDraftChange={setDraft}
          onAddComment={() => {}}
        />
      </>
    );
  }
  act(() => root!.render(<Harness />));
  const addComment = [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "Add comment",
  )!;
  expect(addComment.getAttribute("data-comment-actuation")).toBe("true");
  const down = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    addComment.dispatchEvent(down);
  });
  expect(down.defaultPrevented).toBe(true);
  const textarea = container.querySelector("textarea")!;
  type(textarea, "  keep every byte  ");
  act(() => container!.querySelector("button")!.click());
  type(container.querySelector("textarea")!, "A note");
  act(() =>
    [...container!.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Attach comment")!
      .click(),
  );

  expect(chatComments.add).toHaveBeenCalledWith(
    expect.objectContaining({ body: "A note" }),
  );
  expect(container.querySelector("textarea")!.value).toBe(
    "  keep every byte  ",
  );
});

it("takes the mobile bottom edge while a captured anchor waits", () => {
  const chatComments: PendingChatCommentsController = {
    comments: [],
    activeCommentId: null,
    add: vi.fn(() => true),
    update: vi.fn(async () => ({ status: "saved" as const })),
    remove: vi.fn(),
    clear: vi.fn(),
    select: vi.fn(),
  };
  const visibility = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const composer = (draft: Omit<NewPendingChatComment, "body"> | null) => (
    <Composer
      onSend={() => {}}
      onAbort={() => {}}
      streaming={false}
      disabled={false}
      contextInfo={null}
      session={
        { sessionId: "s1", agentType: "developer", harness: "pi" } as never
      }
      models={[]}
      slashCommands={[]}
      actions={actions}
      draftAutoFocus={false}
      mobile
      onVisibilityChange={visibility}
      chatComments={chatComments}
      commentDraft={draft}
      onCommentDraftChange={() => {}}
    />
  );
  // Hidden at rest on a phone once nothing holds it: the dock's action row is
  // the bottom edge there.
  act(() => root!.render(composer(null)));
  act(() => container!.querySelector("textarea")!.blur());
  expect(visibility).toHaveBeenLastCalledWith(false);
  // The dock's Send slot turns into the comment button, and pressing it must
  // put the comment box on screen — there is no other place to type it.
  act(() =>
    root!.render(
      composer({
        sessionId: "s1",
        entryId: "e1",
        blockIndex: 0,
        quote: "selected text",
        selectors: {
          quote: { exact: "selected text", prefix: "", suffix: "" },
        },
        transcriptPosition: {
          rowCreatedAt: "2026-08-20T14:00:00.000Z",
          rowId: "e1",
          blockIndex: 0,
        },
      }),
    ),
  );
  expect(visibility).toHaveBeenLastCalledWith(true);
});

/** A pending comment as the controller hands it out. */
function pending(id: string, body: string) {
  return {
    id,
    anchor: {
      kind: "session" as const,
      sessionId: "s1",
      entryId: "e1",
      blockIndex: 0,
    },
    selectors: { quote: { exact: "selected text", prefix: "", suffix: "" } },
    quote: "selected text",
    body,
    transcriptPosition: {
      rowCreatedAt: "2026-08-20T14:00:00.000Z",
      rowId: "e1",
      blockIndex: 0,
    },
  };
}

function controller(
  overrides: Partial<PendingChatCommentsController> = {},
): PendingChatCommentsController {
  return {
    comments: [],
    activeCommentId: null,
    add: vi.fn(() => true),
    update: vi.fn(async () => ({ status: "saved" as const })),
    remove: vi.fn(),
    clear: vi.fn(),
    select: vi.fn(),
    ...overrides,
  };
}

function composer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  return (
    <Composer
      onSend={() => {}}
      onAbort={() => {}}
      streaming={false}
      disabled={false}
      contextInfo={null}
      session={
        { sessionId: "s1", agentType: "developer", harness: "pi" } as never
      }
      models={[]}
      slashCommands={[]}
      actions={actions}
      draftAutoFocus={false}
      onCommentDraftChange={() => {}}
      {...props}
    />
  );
}

function labelled(label: string): HTMLButtonElement | undefined {
  return [...container!.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === label,
  );
}

// Writing a comment is not writing a prompt: what a comment cannot carry has no
// business staying on screen while one is being written.
it("stands the prompt's own controls down while a comment is being written", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const draft = {
    sessionId: "s1",
    entryId: "e1",
    blockIndex: 0,
    quote: "selected text",
    selectors: { quote: { exact: "selected text", prefix: "", suffix: "" } },
    transcriptPosition: {
      rowCreatedAt: "2026-08-20T14:00:00.000Z",
      rowId: "e1",
      blockIndex: 0,
    },
  };
  act(() =>
    root!.render(
      composer({ chatComments: controller(), onAddComment: () => {} }),
    ),
  );
  expect(labelled("Add comment")).toBeTruthy();
  expect(
    container.querySelector('[title="Attach files or images"]'),
  ).toBeTruthy();

  act(() =>
    root!.render(
      composer({
        chatComments: controller(),
        onAddComment: () => {},
        commentDraft: draft,
      }),
    ),
  );
  expect(
    container.querySelector('[title="Attach files or images"]'),
  ).toBeNull();
  expect(labelled("Add comment")).toBeUndefined();
  expect(labelled("Conversation branches")).toBeUndefined();
  // And nothing repeats the passage back: the user selected it one gesture ago
  // and it is highlighted in the transcript above.
  expect(container.textContent).not.toContain("selected text");
  // What a comment DOES have: leave it, and send it. (Delete belongs to a
  // comment that already exists.)
  expect(labelled("Cancel comment")).toBeTruthy();
  expect(labelled("Delete comment")).toBeUndefined();
  expect(labelled("Attach comment")).toBeTruthy();
});

it("edits a pending comment in the field, with delete beside cancel", async () => {
  const chatComments = controller({
    comments: [pending("c1", "First thought")],
    activeCommentId: "c1",
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(composer({ chatComments })));

  // The comment is IN the field — no second editor anywhere.
  const textarea = container.querySelector("textarea")!;
  expect(textarea.value).toBe("First thought");
  type(textarea, "A sharper thought");
  await act(async () => labelled("Save comment")!.click());
  // Compared against the body the edit began from.
  expect(chatComments.update).toHaveBeenCalledWith(
    "c1",
    "A sharper thought",
    "First thought",
  );
  expect(chatComments.select).toHaveBeenCalledWith(null);

  act(() => labelled("Delete comment")!.click());
  expect(chatComments.remove).toHaveBeenCalledWith("c1");
  act(() => labelled("Cancel edit")!.click());
  expect(chatComments.select).toHaveBeenLastCalledWith(null);
});

it("sends a comment on Enter and breaks the line on Shift+Enter", () => {
  const chatComments = controller({
    comments: [pending("c1", "First thought")],
    activeCommentId: "c1",
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(composer({ chatComments })));
  const textarea = container.querySelector("textarea")!;

  act(() => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(chatComments.update).not.toHaveBeenCalled();

  act(() => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(chatComments.update).toHaveBeenCalledWith(
    "c1",
    "First thought",
    "First thought",
  );
});

it("dismisses an anchor from another session instead of attaching it", () => {
  const chatComments: PendingChatCommentsController = {
    comments: [],
    activeCommentId: null,
    add: vi.fn(() => true),
    update: vi.fn(async () => ({ status: "saved" as const })),
    remove: vi.fn(),
    clear: vi.fn(),
    select: vi.fn(),
  };
  const dismiss = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <Composer
        onSend={() => {}}
        onAbort={() => {}}
        streaming={false}
        disabled={false}
        contextInfo={null}
        session={
          { sessionId: "s2", agentType: "developer", harness: "pi" } as never
        }
        models={[]}
        slashCommands={[]}
        actions={actions}
        draftAutoFocus={false}
        chatComments={chatComments}
        commentDraft={{
          sessionId: "s1",
          entryId: "e1",
          blockIndex: 0,
          quote: "old selection",
          selectors: {
            quote: { exact: "old selection", prefix: "", suffix: "" },
          },
          transcriptPosition: {
            rowCreatedAt: "2026-08-20T14:00:00.000Z",
            rowId: "e1",
            blockIndex: 0,
          },
        }}
        onCommentDraftChange={dismiss}
      />,
    ),
  );
  type(container.querySelector("textarea")!, "do not attach");
  act(() =>
    [...container!.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Attach comment")!
      .click(),
  );
  expect(chatComments.add).not.toHaveBeenCalled();
  expect(dismiss).toHaveBeenCalledWith(null);
});

it("keeps a comment storage refused in the field, with the reason", () => {
  const dismiss = vi.fn();
  const chatComments = controller({ add: vi.fn(() => false) });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      composer({
        chatComments,
        onCommentDraftChange: dismiss,
        commentDraft: {
          sessionId: "s1",
          entryId: "e1",
          blockIndex: 0,
          quote: "selected text",
          selectors: {
            quote: { exact: "selected text", prefix: "", suffix: "" },
          },
          transcriptPosition: {
            rowCreatedAt: "2026-08-20T14:00:00.000Z",
            rowId: "e1",
            blockIndex: 0,
          },
        },
      }),
    ),
  );
  const textarea = container.querySelector("textarea")!;
  type(textarea, "Worth keeping");
  act(() => labelled("Attach comment")!.click());

  expect(chatComments.add).toHaveBeenCalled();
  expect(dismiss).not.toHaveBeenCalledWith(null);
  expect(container.querySelector("textarea")!.value).toBe("Worth keeping");
  expect(container.textContent).toContain("couldn't store the comment");
});

it("keeps an edit storage refused in the field, with the reason", async () => {
  const chatComments = controller({
    comments: [pending("c1", "First thought")],
    activeCommentId: "c1",
    update: vi.fn(async () => ({ status: "failed" as const })),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(composer({ chatComments })));
  const textarea = container.querySelector("textarea")!;
  type(textarea, "A sharper thought");
  await act(async () => labelled("Save comment")!.click());

  expect(chatComments.select).not.toHaveBeenCalledWith(null);
  expect(container.querySelector("textarea")!.value).toBe("A sharper thought");
  expect(container.textContent).toContain("couldn't store the change");
});

it("keeps an edit open when another tab sent its comment", async () => {
  const chatComments = controller({
    comments: [pending("c1", "First thought")],
    activeCommentId: "c1",
    update: vi.fn(async () => ({ status: "missing" as const })),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(composer({ chatComments })));
  type(container.querySelector("textarea")!, "Still mine");
  // The comment leaves this outbox while the edit is open.
  act(() =>
    root!.render(composer({ chatComments: { ...chatComments, comments: [] } })),
  );
  expect(container.querySelector("textarea")!.value).toBe("Still mine");
  expect(labelled("Save comment")).toBeTruthy();

  await act(async () => labelled("Save comment")!.click());
  expect(container.querySelector("textarea")!.value).toBe("Still mine");
  expect(container.textContent).toContain("sent or removed in another tab");
});

it("ignores a late save answer once another comment has the field", async () => {
  let answer: (result: { status: "saved" | "missing" }) => void = () => {};
  const update = vi.fn(
    () =>
      new Promise<{ status: "saved" | "missing" }>((resolve) => {
        answer = resolve;
      }),
  );
  const comments = [pending("c1", "First"), pending("c2", "Second")];
  const chatComments = controller({
    comments,
    activeCommentId: "c1",
    update,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(composer({ chatComments })));
  type(container.querySelector("textarea")!, "First, sharper");
  // The save waits on another tab's lock...
  act(() => labelled("Save comment")!.click());
  // ...while the reader opens C2 and starts writing.
  act(() =>
    root!.render(
      composer({ chatComments: { ...chatComments, activeCommentId: "c2" } }),
    ),
  );
  type(container.querySelector("textarea")!, "Second, unsaved");

  await act(async () => answer({ status: "saved" }));
  expect(chatComments.select).not.toHaveBeenCalledWith(null);
  expect(container.querySelector("textarea")!.value).toBe("Second, unsaved");
  expect(container.textContent).not.toContain("another tab");
});

it("keeps text typed while its own save waited, and saves it next", async () => {
  let answer: (result: { status: "saved" }) => void = () => {};
  const update = vi.fn(
    () =>
      new Promise<{ status: "saved" }>((resolve) => {
        answer = resolve;
      }),
  );
  const chatComments = controller({
    comments: [pending("c1", "original")],
    activeCommentId: "c1",
    update,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(composer({ chatComments })));
  const textarea = container.querySelector("textarea")!;
  type(textarea, "first version");
  act(() => labelled("Save comment")!.click());
  type(textarea, "second version");

  await act(async () => answer({ status: "saved" }));
  expect(chatComments.select).not.toHaveBeenCalledWith(null);
  expect(container.querySelector("textarea")!.value).toBe("second version");

  // The next save is based on what the first one stored.
  act(() => labelled("Save comment")!.click());
  expect(update).toHaveBeenLastCalledWith(
    "c1",
    "second version",
    "first version",
  );
});
