// @vitest-environment jsdom
/**
 * The login dialog over its real hook and a scripted socket: what a Cancel
 * does is scoped to the run it was sent for, never to the dialog's mount
 * (Task-1402 B1 follow-up, review rv-1402-b11-code-01 C1).
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CredentialProfileSummary } from "@assistant/shared";
import { mount } from "../test/mount.tsx";
import { AccountLoginDialog } from "./AccountLoginDialog.tsx";

class FakeWebSocket {
  static OPEN = 1;
  static sockets: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.sockets.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  receive(message: object) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
  drop() {
    this.readyState = 3;
    act(() => this.onclose?.());
  }
}

const PROFILE: CredentialProfileSummary = {
  id: "cp_fixture",
  name: "OpenAI fixture",
  provider: "openai-codex",
  enabled: true,
  enterprise: false,
  status: "disconnected",
  health: { state: "unknown", since: null },
  createdAt: 0,
  updatedAt: 0,
};
const TAKEN_OVER = "This login was started again elsewhere.";

const snapshot = (runId: string, status = "connecting", extra = {}) => ({
  type: "snapshot",
  profileId: PROFILE.id,
  runId,
  provider: "openai-codex",
  status,
  output: "",
  startedAt: 0,
  startToken: "another-start",
  ...extra,
});
const cancelFor = (runId: string) => JSON.stringify({ type: "cancel", runId });

function open() {
  const onClose = vi.fn();
  const view = mount(
    <AccountLoginDialog
      profile={PROFILE}
      onFinished={() => {}}
      onClose={onClose}
    />,
  );
  const node = () =>
    document.querySelector<HTMLElement>('[role="dialog"]') ?? document.body;
  const button = (label: string) =>
    [...node().querySelectorAll("button")].find((b) => b.textContent === label);
  const first = FakeWebSocket.sockets[0]!;
  const reconnect = (socket: FakeWebSocket) => {
    socket.drop();
    act(() => {
      vi.advanceTimersByTime(800);
    });
    const next = FakeWebSocket.sockets.at(-1)!;
    next.open();
    return next;
  };
  return { view, onClose, node, button, first, reconnect };
}

beforeEach(() => {
  FakeWebSocket.sockets = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a Cancel concerns only the run it was sent for", () => {
  test("Cancel for run-1 does not show Cancelling… or disable Cancel on another viewer's run-2", () => {
    const { view, node, button, first, reconnect } = open();
    first.open();
    first.receive(snapshot("run-1"));
    act(() => button("Cancel login")!.click());
    expect(first.sent).toEqual([cancelFor("run-1")]);
    expect(node().textContent).toContain("Cancelling…");
    const second = reconnect(first);
    second.receive(snapshot("run-2"));
    expect(second.sent).toEqual([]);
    expect(node().textContent).not.toContain("Cancelling…");
    expect(button("Cancel login")?.disabled).toBe(false);
    // The anti-trap Close stays: Cancel was pressed.
    expect(button("Close")).toBeDefined();
    act(() => view.root.unmount());
  });

  test("another actor cancelling run-2 after our Cancel for run-1 keeps its notice", () => {
    const { view, onClose, node, button, first, reconnect } = open();
    first.open();
    first.receive(snapshot("run-1"));
    act(() => button("Cancel login")!.click());
    const second = reconnect(first);
    second.receive(snapshot("run-2"));
    second.receive({
      type: "status",
      runId: "run-2",
      status: "cancelled",
      error: TAKEN_OVER,
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(node().textContent).toContain(TAKEN_OVER);
    expect(button("Close")).toBeDefined();
    act(() => view.root.unmount());
  });

  test("an unproven early Cancel meeting another run already cancelled keeps its notice", () => {
    const { view, onClose, node, button, first, reconnect } = open();
    act(() => button("Cancel login")!.click());
    const second = reconnect(first);
    second.receive(snapshot("run-2", "cancelled", { error: TAKEN_OVER }));
    expect(second.sent).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(node().textContent).toContain(TAKEN_OVER);
    act(() => view.root.unmount());
  });
});

describe("this dialog's own Cancel", () => {
  test("on the shown run closes the dialog once when the run reports cancelled", () => {
    const { view, onClose, node, button, first } = open();
    first.open();
    first.receive(snapshot("run-1"));
    act(() => button("Cancel login")!.click());
    expect(first.sent).toEqual([cancelFor("run-1")]);
    expect(onClose).not.toHaveBeenCalled();
    first.receive({
      type: "status",
      runId: "run-1",
      status: "cancelled",
      error: "The login was cancelled.",
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(node().textContent).not.toContain("The login was cancelled.");
    first.receive({ type: "status", runId: "run-1", status: "cancelled" });
    expect(onClose).toHaveBeenCalledOnce();
    act(() => view.root.unmount());
  });

  test("pressed before any snapshot is still delivered after a reconnect, then closes once", () => {
    const { view, onClose, button, first, reconnect } = open();
    act(() => button("Cancel login")!.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(first.sent).toEqual([]);
    const second = reconnect(first);
    const startToken = new URL(first.url).searchParams.get("startToken");
    second.receive(snapshot("run-1", "connecting", { startToken }));
    expect(second.sent).toEqual([cancelFor("run-1")]);
    expect(onClose).not.toHaveBeenCalled();
    second.receive({ type: "status", runId: "run-1", status: "cancelled" });
    expect(onClose).toHaveBeenCalledOnce();
    act(() => view.root.unmount());
  });

  test("sent before a drop, and the run cancelled while offline, closes on the reconnect snapshot", () => {
    const { view, onClose, first, button, reconnect } = open();
    first.open();
    first.receive(snapshot("run-1"));
    act(() => button("Cancel login")!.click());
    const second = reconnect(first);
    second.receive(snapshot("run-1", "cancelled"));
    expect(second.sent).toEqual([]);
    expect(onClose).toHaveBeenCalledOnce();
    act(() => view.root.unmount());
  });
});

test("an outside click does not close a running login; a Cancel without an answer exposes Close", () => {
  const { view, onClose, button } = open();
  const overlay = document.querySelector("[data-slot=dialog-overlay]")!;
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"])
      overlay.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
  });
  expect(onClose).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  act(() => button("Cancel login")!.click());
  expect(onClose).not.toHaveBeenCalled();
  act(() => button("Close")!.click());
  expect(onClose).toHaveBeenCalledOnce();
  act(() => view.root.unmount());
});
