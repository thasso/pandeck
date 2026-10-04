// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayMessage, PeerPromptCard } from "@assistant/shared";
import { mount } from "../test/mount.tsx";
import { MessageList } from "./MessageList.tsx";
import type { TranscriptViewPrefs } from "./transcriptView.ts";

const view: TranscriptViewPrefs = {
  showThinking: false,
  showTools: false,
  expandThinking: false,
  expandTools: false,
  wrapToolLines: false,
};
let root: Root;
let container: HTMLDivElement;
const onFork = vi.fn();
const onOpenSession = vi.fn();

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  ({ root, container } = mount());
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

function render(messages: DisplayMessage[]) {
  act(() =>
    root.render(
      <MessageList
        sessionId="activity-test"
        messages={messages}
        view={view}
        onForkMessage={onFork}
        onOpenSession={onOpenSession}
      />,
    ),
  );
}
function row(id: string) {
  return container.querySelector<HTMLDivElement>(`[data-message-id="${id}"]`)!;
}
function toggle(id: string) {
  return row(id).querySelector<HTMLButtonElement>("button[aria-expanded]")!;
}

const peer: PeerPromptCard = {
  direction: "received",
  messageKey: "peer-message",
  senderTitle: "Sol",
  recipientTitle: "Implementer",
  peerSessionId: "peer-session",
  message: "Review finished.\n\n**Keep** keyboard navigation intact.",
  responseRequested: false,
  state: "delivered",
};

describe("integrated side activity", () => {
  it("collapses automation and continuations, but leaves human messages intact", () => {
    const text = "**Full message** with a [link](https://example.com).";
    const human: DisplayMessage = {
      id: "human",
      role: "user",
      blocks: [{ kind: "text", text }],
    };
    render([
      human,
      {
        ...human,
        id: "system",
        forkBeforeEntryId: "system",
        promptOrigin: { kind: "system", source: "workflow" },
      },
      {
        ...human,
        id: "agent",
        promptOrigin: { kind: "agent", agentId: "post-reload-continuation" },
      },
    ]);
    expect(row("human").querySelector("strong")?.textContent).toBe(
      "Full message",
    );
    expect(row("human").hasAttribute("data-side-activity")).toBe(false);
    for (const id of ["system", "agent"]) {
      expect(row(id).hasAttribute("data-side-activity")).toBe(true);
      expect(toggle(id).getAttribute("aria-expanded")).toBe("false");
      expect(row(id).querySelector("strong")).toBeNull();
      expect(
        row(id).querySelector('[aria-label="Copy message text"]'),
      ).toBeNull();
    }
    act(() => toggle("system").click());
    expect(row("system").querySelector("strong")?.textContent).toBe(
      "Full message",
    );
    expect(
      row("system").querySelector('a[href="https://example.com"]'),
    ).not.toBeNull();
    const fork = row("system").querySelector<HTMLButtonElement>(
      '[aria-label="Fork and edit prompt"]',
    )!;
    act(() => fork.click());
    expect(onFork).toHaveBeenCalledWith("system", "before");
    act(() => toggle("system").click());
    expect(
      row("system").querySelector('[aria-label="Fork and edit prompt"]'),
    ).toBeNull();
  });

  it("keeps attachments inside the expanded automation message", () => {
    render([
      {
        id: "attachment",
        role: "user",
        promptOrigin: { kind: "system", source: "workflow" },
        blocks: [
          {
            kind: "attachment",
            attachment: {
              id: "file",
              name: "report.txt",
              mimeType: "text/plain",
              size: 42,
            },
          },
        ],
      },
    ]);
    expect(row("attachment").textContent).toContain("Attachments");
    expect(row("attachment").textContent).not.toContain("report.txt");
    act(() => toggle("attachment").click());
    expect(row("attachment").textContent).toContain("report.txt");
  });

  it("uses the same collapsed row for both peer paths even when tools are hidden", () => {
    render([
      {
        id: "sent",
        role: "assistant",
        blocks: [
          {
            kind: "tool",
            toolId: "send",
            name: "session_send_prompt",
            args: {},
            done: true,
            isError: false,
            output: JSON.stringify({
              renderKind: "sessionPeerPrompt",
              version: 1,
              card: { ...peer, direction: "sent", recipientTitle: "Sol" },
            }),
          },
        ],
      },
      {
        id: "received",
        role: "user",
        forkBeforeEntryId: "received",
        promptOrigin: { kind: "agent", agentId: "peer-session" },
        blocks: [{ kind: "peerPrompt", peerPrompt: peer }],
      },
    ]);
    for (const id of ["sent", "received"]) {
      expect(row(id).hasAttribute("data-side-activity")).toBe(true);
      expect(toggle(id).getAttribute("aria-expanded")).toBe("false");
      expect(row(id).querySelector("strong")).toBeNull();
    }
    act(() => row("received").querySelector<HTMLAnchorElement>("a")!.click());
    expect(onOpenSession).toHaveBeenCalledWith("peer-session");
    expect(toggle("received").getAttribute("aria-expanded")).toBe("false");
    act(() => toggle("received").click());
    expect(row("received").querySelector("strong")?.textContent).toBe("Keep");
    expect(
      row("received").querySelector('[aria-label="Copy message text"]'),
    ).not.toBeNull();
    act(() =>
      row("received")
        .querySelector<HTMLButtonElement>(
          '[aria-label="Fork and edit prompt"]',
        )!
        .click(),
    );
    expect(onFork).toHaveBeenCalledWith("received", "before");
  });

  it("collapses compaction summaries but not context-cleared boundaries or assistant replies", () => {
    render([
      {
        id: "compact",
        role: "assistant",
        blocks: [
          {
            kind: "compaction",
            compaction: {
              tokensBefore: 1000,
              tokensAfter: 200,
              summary: "**Retained summary**",
              firstKeptEntryId: "kept-entry",
            },
          },
        ],
      },
      {
        id: "clear",
        role: "assistant",
        blocks: [{ kind: "contextClear", contextClear: { tokensBefore: 200 } }],
      },
      {
        id: "reply",
        role: "assistant",
        promptOrigin: { kind: "system", source: "claude-background:job" },
        blocks: [{ kind: "text", text: "An answer you should see." }],
      },
    ]);
    expect(row("compact").textContent).toContain("1,000 → 200 tokens");
    expect(row("compact").querySelector("strong")).toBeNull();
    expect(row("compact").textContent).not.toContain("kept-entry");
    act(() => toggle("compact").click());
    expect(row("compact").querySelector("strong")?.textContent).toBe(
      "Retained summary",
    );
    expect(row("compact").textContent).toContain("kept-entry");
    expect(row("clear").querySelector('[role="separator"]')).not.toBeNull();
    expect(toggle("clear")).toBeNull();
    expect(row("reply").querySelector(".prose")?.textContent).toContain(
      "An answer you should see.",
    );
    expect(toggle("reply")).toBeNull();
  });

  it("keeps assistant errors visible outside activity disclosures", () => {
    render([
      {
        id: "error",
        role: "assistant",
        error: "The session could not continue.",
        blocks: [],
      },
    ]);
    expect(row("error").textContent).toContain(
      "The session could not continue.",
    );
    expect(row("error").hasAttribute("data-side-activity")).toBe(false);
    expect(toggle("error")).toBeNull();
  });
});
