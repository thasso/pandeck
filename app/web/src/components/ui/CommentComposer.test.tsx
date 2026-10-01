// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeakRing } from "../../lib/waveform.ts";
import { CommentComposer } from "./CommentComposer.tsx";

/** A refinement the test settles by hand, to land it after the card closed. */
const refinement = vi.hoisted(() => {
  let settle: ((value: string) => void) | null = null;
  return {
    finish: (value: string) => settle?.(value),
    refineText: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          settle = resolve;
        }),
    ),
  };
});
vi.mock("../../lib/refineText.ts", () => ({
  refineText: refinement.refineText,
}));

/** A recorder the test drives: what a mounted-but-closed card must shut down. */
const recorder = vi.hoisted(() => ({
  phase: "idle" as "idle" | "recording" | "transcribing",
  cancel: vi.fn(),
  toggle: vi.fn(),
  transcript: null as ((text: string) => void) | null,
}));
vi.mock("../../hooks/useDictation.ts", () => ({
  useDictation: (options: { onTranscript: (text: string) => void }) => {
    recorder.transcript = options.onTranscript;
    return {
      phase: recorder.phase,
      busyElsewhere: false,
      elapsedSeconds: 2,
      peaks: new PeakRing(8),
      uploading: false,
      unavailableReason: undefined,
      toggle: recorder.toggle,
      cancel: recorder.cancel,
    };
  },
}));

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
  recorder.phase = "idle";
  recorder.transcript = null;
  vi.clearAllMocks();
});

function setDraft(value: string): HTMLTextAreaElement {
  const textarea = container.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement))
    throw new Error("Expected comment textarea");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

describe("CommentComposer", () => {
  it("renders the optional header and controls in refine, mic, send order", () => {
    act(() =>
      root.render(
        <CommentComposer
          onSubmit={() => {}}
          header={<div data-anchor>Comment on “selected text”</div>}
          refine={{}}
          dictation={{
            enabled: true,
            status: {
              configured: false,
              reason: "No speech model is deployed.",
              availableModelIds: [],
              maxUtteranceSeconds: 120,
            },
          }}
        />,
      ),
    );

    expect(container.querySelector("[data-anchor]")?.textContent).toContain(
      "selected text",
    );
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("form button"),
    );
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Refine comment",
      "Start dictation",
      "Add a comment",
    ]);
    expect(buttons[0]?.title).toBe("Enter a comment to refine");
    expect(buttons[1]?.title).toBe("No speech model is deployed.");

    setDraft("A comment");
    expect(buttons[0]?.hasAttribute("disabled")).toBe(false);
  });

  it("omits optional controls when their capabilities are not supplied", () => {
    act(() => root.render(<CommentComposer onSubmit={() => {}} />));

    expect(
      container.querySelector('button[aria-label="Refine comment"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Start dictation"]'),
    ).toBeNull();
  });

  // The chat composer's rule, because writing a comment is the same act as
  // writing a prompt and two different Enters in one app is a coin toss.
  it("submits on Enter, breaks the line on Shift+Enter", () => {
    const onSubmit = vi.fn();
    act(() => root.render(<CommentComposer onSubmit={onSubmit} />));
    const textarea = setDraft("First line\nSecond line");

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
    expect(onSubmit).not.toHaveBeenCalled();

    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onSubmit).toHaveBeenCalledWith("First line\nSecond line");
  });

  it("still submits with the ⌘/Ctrl chord the fingers learned", () => {
    const onSubmit = vi.fn();
    act(() => root.render(<CommentComposer onSubmit={onSubmit} />));
    const textarea = setDraft("A comment");

    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onSubmit).toHaveBeenCalledWith("A comment");
  });

  // A `card` composer stays MOUNTED once closed (its field is what the next tap
  // focuses), so it no longer gets the unmount that used to end everything it
  // had running. These are the two things that would otherwise write into a
  // draft the host already discarded. Telling one UTTERANCE from another is not
  // this composer's job and cannot be — that lives in `useDictation`, with its
  // own tests; here the rule is only "a closed card takes nothing".
  it("stops a recording when its card closes, and takes nothing while closed", () => {
    const onChange = vi.fn();
    const card = (collapsed: boolean, value: string) => (
      <CommentComposer
        layout="card"
        collapsed={collapsed}
        value={value}
        onChange={onChange}
        onCancel={() => {}}
        onSubmit={() => {}}
        dictation={{
          enabled: true,
          status: {
            configured: true,
            availableModelIds: ["whisper"],
            maxUtteranceSeconds: 120,
          },
        }}
      />
    );
    act(() => root.render(card(false, "half a thought")));
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Start dictation"]',
        )!
        .click(),
    );
    expect(recorder.toggle).toHaveBeenCalledTimes(1);
    recorder.phase = "recording";
    act(() => root.render(card(false, "half a thought")));
    expect(recorder.cancel).not.toHaveBeenCalled();

    // The host cancelled: the card collapses, the draft is gone, and the open
    // microphone goes with it rather than recording behind an invisible card
    // with no Stop to reach for.
    act(() => root.render(card(true, "")));
    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    recorder.phase = "idle";

    // Anything still arriving for it writes nothing: there is no draft to write.
    act(() => recorder.transcript?.("half a thought spoken aloud"));
    expect(onChange).not.toHaveBeenCalled();

    // Reopened, the card takes dictation again as normal.
    act(() => root.render(card(false, "")));
    act(() => recorder.transcript?.("a fresh thought"));
    expect(onChange).toHaveBeenCalledWith("a fresh thought");
  });

  it("drops a refinement that lands after its card closed", async () => {
    const onChange = vi.fn();
    const card = (collapsed: boolean, value: string) => (
      <CommentComposer
        layout="card"
        collapsed={collapsed}
        value={value}
        onChange={onChange}
        refine={{}}
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    );
    act(() => root.render(card(false, "rough note")));
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Refine comment"]',
        )!
        .click(),
    );
    expect(refinement.refineText).toHaveBeenCalledTimes(1);

    act(() => root.render(card(true, "")));
    await act(async () => {
      refinement.finish("A polished note");
      await Promise.resolve();
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")!.value).toBe("");
    // Nor does the card come back busy: the close settled that state.
    expect(
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Refine comment"]',
        )!
        .getAttribute("aria-busy"),
    ).toBeNull();
  });
});
