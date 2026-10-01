// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DisplayMessage } from "@assistant/shared";
import { AssistantMessage } from "./AssistantMessage.tsx";
import type { TranscriptViewPrefs } from "./transcriptView.ts";

/**
 * The mounted-block half of a session switch. `MessageList` binds the viewed
 * session into `onLiveBodyDemand` and re-binds it when the session changes;
 * a live row that survives the switch (same message id, same stream and block
 * key) therefore sees a NEW handler with the SAME block. That alone has to
 * move its demand from the old session to the new one — no visibility toggle,
 * no remount — or the expanded body would stay subscribed to nothing.
 */

let container: HTMLDivElement | undefined;
let root: Root | undefined;

class NearObserver {
  constructor(
    private readonly callback: (
      entries: Array<{ isIntersecting: boolean }>,
    ) => void,
  ) {}
  observe(): void {
    this.callback([{ isIntersecting: true }]);
  }
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", NearObserver);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

const view: TranscriptViewPrefs = {
  showThinking: true,
  showTools: true,
  expandThinking: false,
  expandTools: false,
  wrapToolLines: false,
};

const live = { streamId: "m1", blockIndex: 0, kind: "thinking" as const };
const message: DisplayMessage = {
  id: "live",
  role: "assistant",
  streaming: true,
  blocks: [{ kind: "thinking", text: "", live: { ...live, length: 9 } }],
};

it("moves a mounted live block's demand to the new handler without a visibility toggle", () => {
  const forA = vi.fn();
  const forB = vi.fn();
  act(() =>
    root!.render(
      <AssistantMessage
        message={message}
        view={view}
        onLiveBodyDemand={forA}
      />,
    ),
  );
  expect(forA.mock.calls).toEqual([[live, true]]);

  // The session changed underneath the same row: same message, same block.
  act(() =>
    root!.render(
      <AssistantMessage
        message={message}
        view={view}
        onLiveBodyDemand={forB}
      />,
    ),
  );
  expect(forA.mock.calls).toEqual([
    [live, true],
    [live, false],
  ]);
  expect(forB.mock.calls).toEqual([[live, true]]);

  // And leaving releases under the current handler only.
  act(() => root!.unmount());
  expect(forB.mock.calls).toEqual([
    [live, true],
    [live, false],
  ]);
  expect(forA).toHaveBeenCalledTimes(2);
});
