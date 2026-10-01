// @vitest-environment jsdom
/**
 * A prompt waiting in the permanent Assistant's queue says so ON ITSELF.
 *
 * `queued` and `working` are conditions, not events (`docs/messaging.md`): they
 * are states that one message is IN until the next update replaces them, so
 * they belong on that message's row and are never announced. They each used to
 * raise an info toast, which is the shape this closed.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DisplayMessage } from "@assistant/shared";
import { MessageList } from "./MessageList.tsx";
import type { PromptQueueState } from "../hooks/useAssistant.ts";
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

/** The echo of a send, keyed the way `useAssistant` keys one. */
const echo = (clientRequestId: string, text: string): DisplayMessage => ({
  id: `creq-${clientRequestId}`,
  role: "user",
  blocks: [{ kind: "text", text }],
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
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
});

afterEach(() => {
  act(() => root?.unmount());
  vi.unstubAllGlobals();
  root = null;
  container?.remove();
  container = null;
});

function render(
  messages: DisplayMessage[],
  promptQueueStates?: Record<string, PromptQueueState>,
) {
  act(() =>
    root!.render(
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
  for (const row of container!.querySelectorAll("[data-message-id]")) {
    const id = row.getAttribute("data-message-id") ?? "";
    for (const label of ["Queued", "Working"])
      if (row.textContent?.includes(label)) found[id] = label;
  }
  return found;
}

it("renders a queued prompt's condition on that prompt's own row", () => {
  const messages = [echo("c1", "what is on today?"), echo("c2", "and after?")];

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
  render([{ id: "u1", role: "user", blocks: [{ kind: "text", text: "hi" }] }], {
    "creq-c1": "queued",
  });
  expect(conditions()).toEqual({});
});
