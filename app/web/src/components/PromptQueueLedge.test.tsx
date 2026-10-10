// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedPeerPrompt } from "@assistant/shared";
import {
  PromptQueueLedge,
  type PromptQueueLedgeProps,
} from "./PromptQueueLedge.tsx";

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
});

const peer = (over: Partial<QueuedPeerPrompt> = {}): QueuedPeerPrompt => ({
  id: "k1",
  senderTitle: "Reviewer",
  senderSessionId: "session-reviewer",
  message: "Two findings on the drain.",
  responseRequested: true,
  createdAt: 0,
  ...over,
});

function render(props: Partial<PromptQueueLedgeProps>) {
  const all: PromptQueueLedgeProps = {
    queue: { items: [], paused: false },
    running: true,
    canSteer: true,
    onEdit: vi.fn(),
    onRemove: vi.fn(),
    onMove: vi.fn(),
    onSendNow: vi.fn(),
    onClear: vi.fn(),
    onResume: vi.fn(),
    onSendPeerNow: vi.fn(),
    onWithdrawPeer: vi.fn(),
    onOpenSession: vi.fn(),
    ...props,
  };
  act(() => root.render(<PromptQueueLedge {...all} />));
  return all;
}

const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe("PromptQueueLedge peer rows", () => {
  it("shows a waiting peer prompt with its sender, and steers or withdraws it", () => {
    const props = render({ peers: [peer()] });
    expect(container.textContent).toContain("1 queued");
    expect(container.textContent).toContain("Two findings on the drain.");
    expect(container.textContent).toContain("From Reviewer");
    expect(container.textContent).toContain("wants a reply");
    // Only the user's own queue clears in one go.
    expect(container.textContent).not.toContain("Clear");
    // The text is the sender's: nothing offers to edit or reorder it.
    expect(button("Edit queued message")).toBeNull();
    expect(button("Move up")).toBeNull();

    act(() => button("Steer it in now")!.click());
    expect(props.onSendPeerNow).toHaveBeenCalledWith("k1");
    act(() => button("Withdraw message")!.click());
    expect(props.onWithdrawPeer).toHaveBeenCalledWith("k1");

    const link = container.querySelector<HTMLAnchorElement>("a")!;
    act(() => link.click());
    expect(props.onOpenSession).toHaveBeenCalledWith("session-reviewer");
  });

  it("says a steer is under way instead of offering actions on it", () => {
    render({ peers: [peer({ sending: true })] });
    expect(container.textContent).toContain("Steering…");
    expect(button("Steer it in now")).toBeNull();
    expect(button("Withdraw message")).toBeNull();
  });

  it("offers no steer into a turn that cannot take one, and sends next when idle", () => {
    render({ peers: [peer()], canSteer: false });
    expect(button("Steer it in now")).toBeNull();
    expect(button("Withdraw message")).not.toBeNull();
    render({ peers: [peer()], running: false, canSteer: false });
    expect(button("Send it next")).not.toBeNull();
  });

  it("counts peers after the user's own rows", () => {
    render({
      queue: {
        items: [{ id: "q1", text: "mine", createdAt: 0 }],
        paused: false,
      },
      peers: [peer({ retrying: true })],
    });
    expect(container.textContent).toContain("2 queued");
    expect(container.textContent).toContain("Clear");
    expect(container.textContent).toContain("delivery failed, retrying");
    const rows = [...container.querySelectorAll("li")].map(
      (li) => li.textContent ?? "",
    );
    expect(rows[0]).toContain("mine");
    expect(rows[1]).toContain("Two findings");
  });
});
