// @vitest-environment jsdom
/**
 * While a turn runs, a message steers it or queues behind it: Enter does what
 * this device last chose, Alt+Enter the other, and a provider that cannot
 * steer only queues.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SlashCommandInfo } from "@assistant/shared";
import type { AssistantActions } from "../hooks/useAssistant.ts";
import { Composer } from "./Composer.tsx";

const commands: SlashCommandInfo[] = [
  {
    name: "compact",
    description: "Compact the context",
    usage: "/compact",
    agentTypes: ["developer"],
    execution: "host",
  },
];

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

function renderComposer(canSteer: boolean) {
  const onSend = vi.fn();
  const onQueue = vi.fn();
  const runSlashCommand = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
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
