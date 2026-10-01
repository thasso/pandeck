// @vitest-environment jsdom
/**
 * A message sent while a turn was running says how it reached the model: a
 * steer where the turn read it, a follow-up as having come after the reply, so
 * the transcript never implies the model saw it before answering.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DisplayMessage } from "@assistant/shared";
import { MessageList } from "./MessageList.tsx";
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
    container!.querySelector(`[data-message-id="${id}"]`)?.textContent ?? ""
  );
}

it("labels steers and follow-ups, and leaves ordinary prompts alone", () => {
  act(() =>
    root!.render(
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
