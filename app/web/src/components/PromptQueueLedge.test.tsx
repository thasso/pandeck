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
    onRemove: vi.fn(),
    onSendNow: vi.fn(),
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
    expect(container.textContent).toContain("from Reviewer");
    expect(container.textContent).toContain("wants a reply");
    // The sender's message is withdrawn, not removed like the user's own.
    expect(button("Remove queued message")).toBeNull();

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
    // The user's row is removed, the peer's withdrawn.
    expect(button("Remove queued message")).not.toBeNull();
    expect(button("Withdraw message")).not.toBeNull();
    expect(container.textContent).toContain("delivery failed, retrying");
    const rows = [...container.querySelectorAll("li")].map(
      (li) => li.textContent ?? "",
    );
    expect(rows[0]).toContain("mine");
    expect(rows[1]).toContain("Two findings");
  });
});

describe("PromptQueueLedge after a Stop", () => {
  it("stays for its Resume when a Stop holds the session with nothing queued", () => {
    const props = render({
      queue: { items: [], paused: false, automaticTurnsHeld: true },
      running: false,
    });
    expect(container.textContent).toContain("Stopped");
    expect(container.textContent).toContain(
      "Agent messages and background updates wait until you resume.",
    );
    const resume = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Resume",
    );
    act(() => resume!.click());
    expect(props.onResume).toHaveBeenCalledTimes(1);
  });

  it("marks waiting peer prompts as held, with the same Resume", () => {
    render({
      queue: { items: [], paused: false, automaticTurnsHeld: true },
      peers: [peer()],
      running: false,
    });
    expect(container.textContent).toContain("Queue paused · 1");
    expect(container.textContent).toContain("Two findings on the drain.");
    expect(
      [...container.querySelectorAll("button")].some(
        (b) => b.textContent === "Resume",
      ),
    ).toBe(true);
  });

  it("renders nothing once nothing is queued or held", () => {
    render({ queue: { items: [], paused: false }, running: false });
    expect(container.textContent).toBe("");
  });
});
