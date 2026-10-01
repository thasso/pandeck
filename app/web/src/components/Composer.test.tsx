// @vitest-environment jsdom
import {
  act,
  createRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  ModelOption,
  PromptAttachment,
  SessionState,
  SlashCommandInfo,
} from "@assistant/shared";
import type { AssistantActions, ForkDraft } from "../hooks/useAssistant.ts";
import type {
  NewPendingChatComment,
  PendingChatCommentsController,
} from "../hooks/usePendingChatComments.ts";
import { composerDraftStorageKey } from "../lib/newSessionRuntime.ts";
import { stubMatchMedia } from "../test/matchMedia.ts";
import { mount } from "../test/mount.tsx";
import { Composer, ModeSelector, resolveSlashSubmit } from "./Composer.tsx";

stubMatchMedia();

describe("resolveSlashSubmit", () => {
  const commands: SlashCommandInfo[] = [
    {
      name: "commit",
      description: "Commit",
      usage: "/commit",
      agentTypes: ["workshop", "developer"],
    },
    {
      name: "review",
      description:
        "Open a NEW session staged to code-review this session's work",
      usage: "/review [extra instructions]",
      agentTypes: ["workshop", "developer"],
      execution: "client",
    },
  ];

  const workshopSession = {
    agentType: "workshop",
    harness: "pi",
    streaming: false,
    attachmentCount: 0,
    commentCount: 0,
  } as const;

  it("passes non-commands and unregistered slashes through as ordinary sends", () => {
    expect(resolveSlashSubmit("hello", commands, workshopSession)).toEqual({
      kind: "send",
    });
    expect(resolveSlashSubmit("/model gpt", commands, workshopSession)).toEqual(
      { kind: "send" },
    );
  });

  it("dispatches a host command to runSlashCommand with its args", () => {
    expect(
      resolveSlashSubmit("/commit fix the thing", commands, workshopSession),
    ).toEqual({ kind: "host", name: "commit", rawArgs: "fix the thing" });
  });

  it("intercepts a client-execution command and never resolves it to host", () => {
    expect(
      resolveSlashSubmit("/review focus on tests", commands, workshopSession),
    ).toEqual({ kind: "client", name: "review", rawArgs: "focus on tests" });
  });

  it("errors on an inapplicable command instead of sending it to the model", () => {
    expect(
      resolveSlashSubmit("/review", commands, {
        ...workshopSession,
        agentType: "assistant",
      }).kind,
    ).toBe("error");
  });

  it("refuses any registered command while streaming or with attachments or comments", () => {
    expect(
      resolveSlashSubmit("/review", commands, {
        ...workshopSession,
        streaming: true,
      }).kind,
    ).toBe("error");
    expect(
      resolveSlashSubmit("/review", commands, {
        ...workshopSession,
        attachmentCount: 1,
      }).kind,
    ).toBe("error");
    expect(
      resolveSlashSubmit("/review", commands, {
        ...workshopSession,
        commentCount: 1,
      }),
    ).toEqual({
      kind: "error",
      message: "Slash commands do not support attached comments yet.",
    });
  });
});

/**
 * While a turn runs, a message steers it or queues behind it: Enter does what
 * this device last chose, Alt+Enter the other, and a provider that cannot
 * steer only queues.
 */
describe("Composer busy mode", () => {
  const commands: SlashCommandInfo[] = [
    {
      name: "compact",
      description: "Compact the context",
      usage: "/compact",
      agentTypes: ["developer"],
      execution: "host",
    },
  ];

  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container = null;
    window.localStorage.clear();
  });

  function renderComposer(canSteer: boolean) {
    const onSend = vi.fn();
    const onQueue = vi.fn();
    const runSlashCommand = vi.fn();
    ({ container, root } = mount());
    act(() =>
      root!.render(
        <Composer
          onSend={onSend}
          onQueue={onQueue}
          onAbort={() => {}}
          streaming
          disabled={false}
          contextInfo={null}
          session={{ agentType: "developer", harness: "pi", canSteer } as never}
          models={[]}
          slashCommands={commands}
          actions={{ runSlashCommand } as unknown as AssistantActions}
        />,
      ),
    );
    const textarea = container.querySelector("textarea")!;
    return { textarea, onSend, onQueue, runSlashCommand };
  }

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

  function press(textarea: HTMLTextAreaElement, altKey = false) {
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", altKey, bubbles: true }),
      );
    });
  }

  function choose(label: "Steer" | "Queue") {
    const radio = [
      ...container!.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ].find((el) => el.textContent === label);
    act(() => radio!.click());
  }

  it("steers on Enter and queues on Alt+Enter by default", () => {
    const { textarea, onSend, onQueue } = renderComposer(true);
    type(textarea, "turn left");
    press(textarea);
    expect(onSend).toHaveBeenCalledWith("turn left", []);
    type(textarea, "then this");
    press(textarea, true);
    expect(onQueue).toHaveBeenCalledWith({ text: "then this" });
  });

  it("remembers Queue on this device and swaps what Alt+Enter does", () => {
    const first = renderComposer(true);
    choose("Queue");
    type(first.textarea, "after");
    press(first.textarea);
    expect(first.onQueue).toHaveBeenCalledWith({ text: "after" });
    act(() => root?.unmount());
    container?.remove();

    const second = renderComposer(true);
    type(second.textarea, "now");
    press(second.textarea, true);
    expect(second.onSend).toHaveBeenCalledWith("now", []);
  });

  it("only queues behind a provider that cannot steer", () => {
    const { textarea, onSend, onQueue } = renderComposer(false);
    expect(container!.querySelector('[role="radiogroup"]')).toBeNull();
    type(textarea, "later");
    press(textarea, true);
    expect(onSend).not.toHaveBeenCalled();
    expect(onQueue).toHaveBeenCalledWith({ text: "later" });
  });

  it("queues a host command to run when its turn comes", () => {
    const { textarea, onQueue, runSlashCommand } = renderComposer(true);
    type(textarea, "/compact");
    // The first Enter completes the command from the slash menu, as it does for
    // a user; the second sends it.
    press(textarea, true);
    press(textarea, true);
    expect(runSlashCommand).not.toHaveBeenCalled();
    expect(onQueue).toHaveBeenCalledWith({
      text: "/compact",
      command: { name: "compact", rawArgs: "" },
    });
  });
});

describe("Composer client commands", () => {
  const REVIEW_PROMPT = "Code-review the changes made in session `s-1`.";

  const commands: SlashCommandInfo[] = [
    {
      name: "review",
      description:
        "Open a NEW session staged to code-review this session's work",
      usage: "/review [extra instructions]",
      agentTypes: ["workshop"],
      execution: "client",
    },
  ];

  const actions = {
    runSlashCommand: () => {},
  } as unknown as AssistantActions;

  /**
   * The host's side of a client slash command, as `App` does it: stage a draft
   * for the destination, move to it (which changes `draftStorageKey`), and
   * commit that staging synchronously — `startStagedSession` uses `flushSync`,
   * which also flushes the composer's draft effect INSIDE the handler.
   */
  function Host({ error = null }: { error?: string | null }) {
    const [draft, setDraft] = useState<ForkDraft | null>(null);
    const [sessionId, setSessionId] = useState<string | null>("s-1");
    const [, setStaged] = useState(0);
    return (
      <Composer
        onSend={() => {}}
        onAbort={() => {}}
        streaming={false}
        disabled={false}
        contextInfo={null}
        session={{ agentType: "workshop", harness: "pi" } as never}
        models={[]}
        slashCommands={commands}
        draft={draft}
        draftAutoFocus={false}
        draftStorageKey={composerDraftStorageKey(sessionId, false)}
        onClientSlashCommand={(_name, rawArgs) => {
          if (error) return error;
          setDraft({
            sessionId: "pending-session-review",
            text: rawArgs ? `${REVIEW_PROMPT}\n\n${rawArgs}` : REVIEW_PROMPT,
            token: 1,
          });
          setSessionId(null);
          flushSync(() => setStaged((n) => n + 1));
          return null;
        }}
        actions={actions}
      />
    );
  }

  // jsdom ships no media-query engine; the composer only asks whether it is on a
  // touch viewport, which this desktop-shaped stub answers with "no".

  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container = null;
    window.localStorage.clear();
  });

  function render(node: React.ReactElement): HTMLTextAreaElement {
    ({ container, root } = mount());
    act(() => root!.render(node));
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("composer textarea did not render");
    return textarea;
  }

  /** Type as a user does: React only sees a value set through the native setter. */
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

  function pressEnter(textarea: HTMLTextAreaElement) {
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
  }

  describe("Composer client slash commands", () => {
    it("keeps the draft a client command stages into this same composer", () => {
      window.localStorage.setItem(
        "assistant.composerDraft.session:new",
        "stale prompt",
      );
      window.localStorage.setItem(
        "assistant.composerDraft.session:new.chatComments",
        "stale comments",
      );
      const textarea = render(<Host />);
      // Trailing space closes the autocomplete menu, so Enter submits.
      type(textarea, "/review ");
      pressEnter(textarea);

      expect(textarea.value).toBe(REVIEW_PROMPT);
      // …and it survives a remount through the destination's storage key.
      expect(
        window.localStorage.getItem("assistant.composerDraft.session:new-v2"),
      ).toBe(REVIEW_PROMPT);
      // The command itself is not left behind under the source session's key.
      expect(
        window.localStorage.getItem("assistant.composerDraft.session:s-1"),
      ).toBeNull();
      // Loading the rotated slot retires the poisoned legacy draft and comments.
      expect(
        window.localStorage.getItem("assistant.composerDraft.session:new"),
      ).toBeNull();
      expect(
        window.localStorage.getItem(
          "assistant.composerDraft.session:new.chatComments",
        ),
      ).toBeNull();
    });

    it("passes the command's arguments to the staged draft", () => {
      const textarea = render(<Host />);
      type(textarea, "/review focus on tests");
      pressEnter(textarea);

      expect(textarea.value).toBe(`${REVIEW_PROMPT}\n\nfocus on tests`);
    });

    it("hands the command text back when the host refuses it", () => {
      const textarea = render(<Host error="Nothing to review yet." />);
      type(textarea, "/review ");
      pressEnter(textarea);

      expect(textarea.value).toBe("/review ");
      expect(container?.textContent).toContain("Nothing to review yet.");
    });

    it("refuses a client command on a surface that cannot run it", () => {
      const textarea = render(
        <Composer
          onSend={() => {}}
          onAbort={() => {}}
          streaming={false}
          disabled={false}
          contextInfo={null}
          session={{ agentType: "workshop", harness: "pi" } as never}
          models={[]}
          slashCommands={commands}
          actions={actions}
        />,
      );
      type(textarea, "/review ");
      pressEnter(textarea);

      expect(textarea.value).toBe("/review ");
      expect(container?.textContent).toContain(
        "/review is not available here.",
      );
    });
  });

  describe("ModeSelector", () => {
    it("selects Plan from an icon-labelled dropdown", () => {
      const onChange = vi.fn();
      ({ container, root } = mount());
      act(() =>
        root!.render(<ModeSelector mode="build" onChange={onChange} />),
      );

      const trigger = container.querySelector('button[title="Session mode"]');
      expect(trigger?.textContent).toContain("Build");
      act(() => {
        trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const plan = [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Plan",
      );
      expect(plan).toBeDefined();
      act(() => {
        plan?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(onChange).toHaveBeenCalledWith("plan");
    });
  });
});

describe("Composer comment mode", () => {
  const actions = { runSlashCommand: () => {} } as unknown as AssistantActions;
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
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
    ({ container, root } = mount());
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
              {
                sessionId: "s1",
                agentType: "developer",
                harness: "pi",
              } as never
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
        .find(
          (button) => button.getAttribute("aria-label") === "Attach comment",
        )!
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
    ({ container, root } = mount());
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
    ({ container, root } = mount());
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
    ({ container, root } = mount());
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
    ({ container, root } = mount());
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
    ({ container, root } = mount());
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
        .find(
          (button) => button.getAttribute("aria-label") === "Attach comment",
        )!
        .click(),
    );
    expect(chatComments.add).not.toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalledWith(null);
  });

  it("keeps a comment storage refused in the field, with the reason", () => {
    const dismiss = vi.fn();
    const chatComments = controller({ add: vi.fn(() => false) });
    ({ container, root } = mount());
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
    ({ container, root } = mount());
    act(() => root!.render(composer({ chatComments })));
    const textarea = container.querySelector("textarea")!;
    type(textarea, "A sharper thought");
    await act(async () => labelled("Save comment")!.click());

    expect(chatComments.select).not.toHaveBeenCalledWith(null);
    expect(container.querySelector("textarea")!.value).toBe(
      "A sharper thought",
    );
    expect(container.textContent).toContain("couldn't store the change");
  });

  it("keeps an edit open when another tab sent its comment", async () => {
    const chatComments = controller({
      comments: [pending("c1", "First thought")],
      activeCommentId: "c1",
      update: vi.fn(async () => ({ status: "missing" as const })),
    });
    ({ container, root } = mount());
    act(() => root!.render(composer({ chatComments })));
    type(container.querySelector("textarea")!, "Still mine");
    // The comment leaves this outbox while the edit is open.
    act(() =>
      root!.render(
        composer({ chatComments: { ...chatComments, comments: [] } }),
      ),
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
    ({ container, root } = mount());
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
    ({ container, root } = mount());
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
});

/**
 * The mobile mic hand-over. The composer's toolbar mic does not record on
 * mobile — it asks the host (`onRequestDictation`) and HIDES, because the dock
 * row that owns the recorder mounts only where the composer stood. Staged chat
 * comments and attachments normally pin the composer open, and that hold used
 * to outrank the hand-over: the composer stayed up, the row never mounted, and
 * the mic tap silently expired. These tests pin the override and its end — the
 * hold resumes the moment the user engages the composer again.
 */
describe("Composer dictation hand-over", () => {
  const actions = { runSlashCommand: () => {} } as unknown as AssistantActions;

  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
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
      ({ container, root } = mount());
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

/**
 * The dock row's Send, which reaches into the composer through `submitRef`
 * because the draft never leaves this component — the host only ever holds the
 * bounded preview it shows on the row's field.
 */
describe("Composer submitRef", () => {
  const actions = { runSlashCommand: () => {} } as unknown as AssistantActions;

  // jsdom ships no media-query engine; the composer only asks whether it is on a
  // touch viewport, which this desktop-shaped stub answers with "no".

  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container = null;
    window.localStorage.clear();
  });

  function render(options: {
    submitRef: RefObject<(() => void) | null>;
    onSend: (text: string, attachments?: PromptAttachment[]) => void;
    sendBlockedReason?: string;
    chatComments?: PendingChatCommentsController;
    slashCommands?: SlashCommandInfo[];
  }): HTMLTextAreaElement {
    ({ container, root } = mount());
    act(() =>
      root!.render(
        <Composer
          onSend={options.onSend}
          onAbort={() => {}}
          streaming={false}
          disabled={false}
          contextInfo={null}
          session={{ agentType: "developer", harness: "pi" } as never}
          models={[]}
          slashCommands={options.slashCommands ?? []}
          actions={actions}
          draftAutoFocus={false}
          mobile
          sendBlockedReason={options.sendBlockedReason}
          submitRef={options.submitRef}
          chatComments={options.chatComments}
        />,
      ),
    );
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("composer textarea did not render");
    return textarea;
  }

  /** Type as a user does: React only sees a value set through the native setter. */
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

  it("sends the draft the host cannot see, and clears it", () => {
    const submitRef = createRef<(() => void) | null>();
    const sent: string[] = [];
    const textarea = render({ submitRef, onSend: (text) => sent.push(text) });

    type(textarea, "ship it");
    act(() => submitRef.current?.());

    expect(sent).toEqual(["ship it"]);
    expect(textarea.value).toBe("");
  });

  it("opens on the hint instead of sending while a send is blocked", () => {
    const submitRef = createRef<(() => void) | null>();
    const sent: string[] = [];
    const textarea = render({
      submitRef,
      onSend: (text) => sent.push(text),
      // A Developer session staged without the worktree it requires.
      sendBlockedReason: "Developer sessions run in a worktree — pick one.",
    });

    type(textarea, "ship it");
    act(() => submitRef.current?.());

    // Nothing left, the draft is intact, and the composer is now up with the
    // reason showing above it.
    expect(sent).toEqual([]);
    expect(textarea.value).toBe("ship it");
    expect(document.activeElement).toBe(textarea);
    expect(container?.textContent).toContain(
      "Developer sessions run in a worktree",
    );
  });

  it("sends attached comments with an empty overall message and clears them", () => {
    const submitRef = createRef<(() => void) | null>();
    const sent: string[] = [];
    const clear = vi.fn();
    const comment = {
      id: "c1",
      anchor: {
        kind: "session" as const,
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
    };
    const chatComments: PendingChatCommentsController = {
      comments: [comment],
      activeCommentId: null,
      add: vi.fn(() => true),
      update: vi.fn(async () => ({ status: "saved" as const })),
      remove: vi.fn(),
      clear,
      select: vi.fn(),
    };
    render({
      submitRef,
      onSend: (text) => sent.push(text),
      chatComments,
    });

    act(() => submitRef.current?.());
    expect(sent).toEqual([
      "Comments on your previous response:\n\n1. On “a passage”:\n   Please explain this.",
    ]);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("refuses a registered slash command without consuming attached comments", () => {
    const submitRef = createRef<(() => void) | null>();
    const sent: string[] = [];
    const clear = vi.fn();
    const chatComments: PendingChatCommentsController = {
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
            quote: { exact: "passage", prefix: "", suffix: "" },
            position: { start: 0, end: 7 },
          },
          quote: "passage",
          body: "Explain this.",
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
      clear,
      select: vi.fn(),
    };
    const textarea = render({
      submitRef,
      onSend: (text) => sent.push(text),
      chatComments,
      slashCommands: [
        {
          name: "commit",
          description: "Commit changes",
          usage: "/commit",
          agentTypes: ["developer"],
        },
      ],
    });
    type(textarea, "/commit ");

    act(() => submitRef.current?.());

    expect(sent).toEqual([]);
    expect(clear).not.toHaveBeenCalled();
    expect(textarea.value).toBe("/commit ");
    expect(container?.textContent).toContain(
      "Slash commands do not support attached comments yet.",
    );
  });

  it("does nothing with an empty draft", () => {
    const submitRef = createRef<(() => void) | null>();
    const sent: string[] = [];
    render({ submitRef, onSend: (text) => sent.push(text) });

    act(() => submitRef.current?.());
    expect(sent).toEqual([]);
  });
});

describe("Composer staged drafts", () => {
  const STAGED = "Background work updates: …";
  const SESSION_KEY = composerDraftStorageKey("s-2", false);

  const actions = {} as unknown as AssistantActions;

  const consumed: number[] = [];

  /**
   * The host's side of a fork handoff, as `App` + the reducer do it: the staged
   * draft lives OUTSIDE this composer and survives its unmount, so it is dropped
   * the moment the composer reports it took it.
   */
  function Host({ mounted = true }: { mounted?: boolean }) {
    const [draft, setDraft] = useState<ForkDraft | null>({
      sessionId: "s-2",
      text: STAGED,
      token: 7,
    });
    if (!mounted) return null;
    return (
      <Composer
        onSend={() => {}}
        onAbort={() => {}}
        streaming={false}
        disabled={false}
        contextInfo={null}
        session={{ agentType: "workshop", harness: "pi" } as never}
        models={[]}
        slashCommands={[]}
        draft={draft}
        draftAutoFocus={false}
        draftStorageKey={SESSION_KEY}
        onDraftConsumed={(token) => {
          consumed.push(token);
          setDraft((current) => (current?.token === token ? null : current));
        }}
        actions={actions}
      />
    );
  }

  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container = null;
    consumed.length = 0;
    window.localStorage.clear();
  });

  function render(node: React.ReactElement): HTMLTextAreaElement {
    ({ container, root } = mount());
    act(() => root!.render(node));
    return textarea();
  }

  function textarea(): HTMLTextAreaElement {
    const field = container?.querySelector("textarea");
    if (!field) throw new Error("composer textarea did not render");
    return field;
  }

  /** Type as a user does: React only sees a value set through the native setter. */
  function type(field: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("takes a staged draft once, and lets the field be emptied for good", () => {
    const field = render(<Host />);
    expect(field.value).toBe(STAGED);
    expect(consumed).toEqual([7]);
    // It is ordinary composer text now: persisted under this session's key.
    expect(window.localStorage.getItem(SESSION_KEY)).toBe(STAGED);

    type(field, "");
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();

    // Leaving the session and coming back: the handoff is spent, so the
    // composer opens on what the user left in it, not on the forked prompt.
    act(() => root!.render(<Host mounted={false} />));
    act(() => root!.render(<Host />));
    expect(textarea().value).toBe("");
    expect(consumed).toEqual([7]);
  });

  it("restores an edited draft rather than the staged text on remount", () => {
    const field = render(<Host />);
    type(field, "my own prompt");

    act(() => root!.render(<Host mounted={false} />));
    act(() => root!.render(<Host />));
    expect(textarea().value).toBe("my own prompt");
  });
});

/**
 * The bottom row folds its runtime pickers by MEASUREMENT, and jsdom measures
 * everything as 0. These stubs give the four marked boxes
 * (`data-composer-fit`) a width, so the fold can be exercised the way a
 * squeezed desktop composer exercises it: same DOM, different budget.
 */
describe("Composer runtime fold", () => {
  const widths = { row: 900, lead: 32, trail: 160, runtime: 320 };

  function markedWidth(element: HTMLElement): number | null {
    const mark = element.dataset.composerFit;
    if (!mark || !(mark in widths)) return null;
    return widths[mark as keyof typeof widths];
  }

  /**
   * The pills draw narrower below Tailwind's `sm` (a tighter model cap, the short
   * thinking label), so the media query is a width input like any other. jsdom
   * has no media-query engine: this stub is one the test can flip and notify.
   */
  const WIDE_LABEL_MEDIA = "(min-width: 40rem)";
  let wideLabels = true;
  let mediaChanged: (query: string) => void = () => {};

  function setLabelPresentation(wide: boolean, stripWidth: number) {
    wideLabels = wide;
    widths.runtime = stripWidth;
    act(() => mediaChanged(WIDE_LABEL_MEDIA));
  }

  const measured = ["clientWidth", "offsetWidth"] as const;
  const unmeasured = measured.map((property) =>
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, property),
  );

  beforeAll(() => {
    for (const property of measured) {
      Object.defineProperty(HTMLElement.prototype, property, {
        configurable: true,
        get(this: HTMLElement) {
          return markedWidth(this) ?? 0;
        },
      });
    }
    mediaChanged = stubMatchMedia((query) =>
      query === WIDE_LABEL_MEDIA ? wideLabels : false,
    );
  });

  afterAll(() => {
    measured.forEach((property, index) => {
      const descriptor = unmeasured[index];
      if (descriptor)
        Object.defineProperty(HTMLElement.prototype, property, descriptor);
      else delete (HTMLElement.prototype as Partial<HTMLElement>)[property];
    });
    stubMatchMedia();
  });

  const model: ModelOption = {
    provider: "anthropic",
    id: "claude-opus-5",
    name: "Opus 5",
  } as ModelOption;

  const session = {
    id: "s-1",
    harness: "pi",
    agentType: "developer",
    model,
    thinkingLevel: "high",
    mode: "build",
  } as unknown as SessionState;

  const actions = {
    setModel: () => {},
    setThinkingLevel: () => {},
    setSessionMode: () => {},
  } as unknown as AssistantActions;

  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container = null;
    widths.row = 900;
    widths.runtime = 320;
    wideLabels = true;
    window.localStorage.clear();
  });

  function render() {
    if (!container) {
      ({ container, root } = mount());
    }
    act(() =>
      root!.render(
        <Composer
          onSend={() => {}}
          onAbort={() => {}}
          streaming={false}
          disabled={false}
          contextInfo={null}
          session={session}
          models={[model]}
          slashCommands={[]}
          actions={actions}
        />,
      ),
    );
  }

  /** Re-render the mounted composer so it re-measures against the new widths. */
  const relayout = render;

  const strip = () =>
    container?.querySelector('[data-composer-fit="runtime"]') ?? null;
  const sheetTrigger = () =>
    container?.querySelector<HTMLButtonElement>(
      'button[aria-label^="Runtime settings"]',
    ) ?? null;

  it("keeps the pickers inline while the row can hold them", () => {
    render();

    expect(strip()).not.toBeNull();
    expect(strip()?.textContent).toContain("Build");
    expect(strip()?.textContent).toContain("Opus 5");
    expect(sheetTrigger()).toBeNull();
  });

  it("folds them into the Runtime trigger once the row cannot", () => {
    widths.row = 400;
    render();

    expect(strip()).toBeNull();
    expect(sheetTrigger()?.textContent).toContain("Opus 5");
  });

  it("brings them back inline when the room returns", () => {
    widths.row = 400;
    render();
    expect(strip()).toBeNull();

    widths.row = 900;
    relayout();

    expect(strip()).not.toBeNull();
    expect(sheetTrigger()).toBeNull();
  });

  it("re-measures when the pills change presentation while folded", () => {
    // Folded at the wide presentation: 32 + 4 + 320 + 8 + 160 is past 420.
    widths.row = 420;
    render();
    expect(strip()).toBeNull();

    // Below `sm` the same pickers draw narrower and now fit — but the strip is
    // gone, so nothing can re-measure it unless the mode invalidates the width
    // the fold remembered.
    setLabelPresentation(false, 200);

    expect(strip()).not.toBeNull();
    expect(sheetTrigger()).toBeNull();
  });

  it("folds again when the pills widen back while inline", () => {
    widths.row = 420;
    widths.runtime = 200;
    wideLabels = false;
    render();
    expect(strip()).not.toBeNull();

    setLabelPresentation(true, 320);

    expect(strip()).toBeNull();
    expect(sheetTrigger()).not.toBeNull();
  });
});
