// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechToTextStatus } from "@assistant/shared";

/**
 * The recorder is faked so the row's three interiors can be rendered on demand:
 * `useDictation` opens a socket and a microphone, and neither says anything about
 * where the controls sit. `peaks` is only ever read inside the waveform's own
 * animation frame, so a stub with a version is all this needs.
 */
const speech = vi.hoisted(() => ({
  phase: "idle" as "idle" | "recording" | "transcribing",
}));
vi.mock("../hooks/useDictation.ts", () => ({
  useDictation: () => ({
    phase: speech.phase,
    busyElsewhere: false,
    elapsedSeconds: 3,
    peaks: { version: 0 },
    uploading: false,
    unavailableReason: undefined,
    toggle: () => {},
    cancel: () => {},
  }),
}));

const { SessionDockActions } = await import("./SessionDockActions.tsx");
type RowProps = Parameters<typeof SessionDockActions>[0];

const configured: SpeechToTextStatus = {
  configured: true,
  availableModelIds: ["small"],
  maxUtteranceSeconds: 120,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  speech.phase = "idle";
});

function row(props: Partial<RowProps> = {}): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <SessionDockActions
        disabled={false}
        streaming={false}
        onAbort={() => {}}
        draft=""
        onCompose={() => {}}
        onSubmit={() => {}}
        contextSlot={{ kind: "worktree", dirty: true, onOpen: () => {} }}
        dictation={{ enabled: true, status: configured }}
        startRequest={null}
        onStartHandled={() => {}}
        onTranscript={() => {}}
        onActiveChange={() => {}}
        {...props}
      />,
    ),
  );
  return container;
}

/** Every control in the row, in the order a thumb meets them. */
function controls(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll("button")).map(
    (button) => button.getAttribute("aria-label") ?? "",
  );
}

function control(host: HTMLElement, label: string): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`no control labelled "${label}" in the row`);
  return found;
}

function press(button: HTMLButtonElement) {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("SessionDockActions arrangement", () => {
  it("puts the context jump before the field, and the mic and Send after it", () => {
    expect(controls(row())).toEqual([
      "View this session's worktree changes",
      "Write a message",
      "Start dictation",
      "Send message",
    ]);
  });

  it("carries the staged-context picker instead of a worktree before the first send", () => {
    // The new-session screen: a worktree is one of the things that picker
    // stages there, not a screen to leave for.
    expect(
      controls(row({ contextSlot: { kind: "add-context", onRun: () => {} } })),
    ).toEqual([
      "Attach a Task, worktree, or project",
      "Write a message",
      "Start dictation",
      "Send message",
    ]);
  });

  it("falls back to the composer's paperclip for a session that hangs off nothing", () => {
    const host = row({ contextSlot: { kind: "attach", onRun: () => {} } });
    expect(controls(host)[0]).toBe("Attach files or images");
  });

  it("renders without a context slot at all rather than moving Send", () => {
    expect(controls(row({ contextSlot: undefined }))).toEqual([
      "Write a message",
      "Start dictation",
      "Send message",
    ]);
  });
});

describe("SessionDockActions comment selection", () => {
  it("uses the field and Send slot as protected Comment actuators", () => {
    let opened = 0;
    const host = row({
      draft: "prompt survives",
      commentSelection: { quote: "selected passage" },
      onComment: () => {
        opened += 1;
      },
    });
    expect(controls(host)).toEqual([
      "View this session's worktree changes",
      "Comment on selected text",
      "Start dictation",
      "Comment",
    ]);
    for (const button of [
      control(host, "Comment on selected text"),
      control(host, "Comment"),
    ]) {
      expect(button.getAttribute("data-comment-actuation")).toBe("true");
      const down = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        button.dispatchEvent(down);
      });
      expect(down.defaultPrevented).toBe(true);
      press(button);
    }
    expect(opened).toBe(2);
    expect(host.textContent).toContain("selected passage");
  });

  it("keeps recording ahead of a captured selection", () => {
    speech.phase = "recording";
    const host = row({ commentSelection: { quote: "selected passage" } });
    expect(controls(host)).toContain("Stop recording and transcribe");
    expect(controls(host)).not.toContain("Comment");
  });
});

describe("SessionDockActions Send", () => {
  it("is disabled with no prompt to send and enabled with one", () => {
    expect(control(row(), "Send message").disabled).toBe(true);
    const withDraft = row({ draft: "ship it" });
    expect(control(withDraft, "Send message").disabled).toBe(false);
    // …and that draft is what the field itself shows.
    expect(withDraft.textContent).toContain("ship it");
  });

  it("stays disabled while there is no live session to talk to", () => {
    expect(
      control(row({ draft: "ship it", disabled: true }), "Send message")
        .disabled,
    ).toBe(true);
  });

  it("hands the press to the host, which reaches into the composer for the text", () => {
    let sent = 0;
    const host = row({
      draft: "ship it",
      onSubmit: () => {
        sent += 1;
      },
    });
    press(control(host, "Send message"));
    expect(sent).toBe(1);
  });
});

describe("SessionDockActions states", () => {
  it("puts Stop in Send's own slot while a turn runs, holding the mic beside it", () => {
    const host = row({ streaming: true, draft: "queued?" });
    expect(controls(host)).toEqual([
      "View this session's worktree changes",
      "Waiting for this response to finish",
      "Start dictation",
      "Stop response",
    ]);
    // The turn accepts no input, so the field states it and the mic greys out:
    // a recording would land in a surface that cannot send.
    expect(control(host, "Waiting for this response to finish").disabled).toBe(
      true,
    );
    expect(control(host, "Start dictation").disabled).toBe(true);
    expect(control(host, "Stop response").disabled).toBe(false);
  });

  it("stays live while a turn that takes a message runs, with Stop in Send's slot", () => {
    let composed = 0;
    const host = row({
      streaming: true,
      acceptsInputWhileRunning: true,
      onCompose: () => {
        composed += 1;
      },
    });
    expect(controls(host)).toEqual([
      "View this session's worktree changes",
      "Write a message for this response",
      "Start dictation",
      "Stop response",
    ]);
    expect(host.textContent).toContain("Steer or queue a message…");
    expect(control(host, "Start dictation").disabled).toBe(false);
    // The field opens the composer, where Steer or Queue decides.
    press(control(host, "Write a message for this response"));
    expect(composed).toBe(1);
  });

  it("shows a waiting draft on that live field", () => {
    const host = row({
      streaming: true,
      acceptsInputWhileRunning: true,
      draft: "one more thing",
    });
    expect(host.textContent).toContain("one more thing");
    expect(controls(host)).toContain("Continue your message");
  });

  it("aborts the turn from that Stop", () => {
    let aborted = 0;
    const host = row({
      streaming: true,
      onAbort: () => {
        aborted += 1;
      },
    });
    press(control(host, "Stop response"));
    expect(aborted).toBe(1);
  });

  it("keeps every slot in place while recording, with Send inert", () => {
    speech.phase = "recording";
    const host = row({ draft: "half a sentence" });
    expect(controls(host)).toEqual([
      "View this session's worktree changes",
      "Discard recording",
      "Stop recording and transcribe",
      "Send message",
    ]);
    // Nothing to send until the sentence being spoken lands in the draft.
    expect(control(host, "Send message").disabled).toBe(true);
    expect(control(host, "Stop recording and transcribe").disabled).toBe(false);
  });

  it("drops the mic when dictation is off in settings, keeping Send at the end", () => {
    expect(
      controls(row({ dictation: { enabled: false, status: null } })),
    ).toEqual([
      "View this session's worktree changes",
      "Write a message",
      "Send message",
    ]);
  });

  it("shows the mic disabled — never absent — when the server cannot dictate", () => {
    const host = row({
      dictation: {
        enabled: true,
        status: {
          configured: false,
          reason: "No speech model deployed.",
          availableModelIds: [],
          maxUtteranceSeconds: 120,
        },
      },
    });
    const mic = control(host, "Start dictation");
    expect(mic.disabled).toBe(true);
    expect(mic.getAttribute("title")).toBe("No speech model deployed.");
  });
});
