// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantActions, ForkDraft } from "../hooks/useAssistant.ts";
import { composerDraftStorageKey } from "../lib/newSessionRuntime.ts";
import { Composer } from "./Composer.tsx";

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
  consumed.length = 0;
  window.localStorage.clear();
});

function render(node: React.ReactElement): HTMLTextAreaElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
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

describe("Composer staged drafts", () => {
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
