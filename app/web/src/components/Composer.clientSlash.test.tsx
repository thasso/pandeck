// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlashCommandInfo } from "@assistant/shared";
import type { AssistantActions, ForkDraft } from "../hooks/useAssistant.ts";
import { composerDraftStorageKey } from "../lib/newSessionRuntime.ts";
import { Composer, ModeSelector } from "./Composer.tsx";

const REVIEW_PROMPT = "Code-review the changes made in session `s-1`.";

const commands: SlashCommandInfo[] = [
  {
    name: "review",
    description: "Open a NEW session staged to code-review this session's work",
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

function render(node: React.ReactElement): HTMLTextAreaElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
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
    expect(container?.textContent).toContain("/review is not available here.");
  });
});

describe("ModeSelector", () => {
  it("selects Plan from an icon-labelled dropdown", () => {
    const onChange = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<ModeSelector mode="build" onChange={onChange} />));

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
