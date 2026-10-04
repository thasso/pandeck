// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DisplayBlock,
  PeerPromptCard as PeerPromptCardType,
  PeerPromptThreadsProjection,
} from "@assistant/shared";
import { PeerPromptCardView } from "./PeerPromptCard.tsx";
import { PeerPromptsSection } from "./SessionContextSections.tsx";
import { renderToolBlock, toolBlockIsVisible } from "./tools/registry.tsx";

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

function renderCard(
  card: PeerPromptCardType,
  props: Omit<Parameters<typeof PeerPromptCardView>[0], "card"> = {},
) {
  act(() => root.render(<PeerPromptCardView card={card} {...props} />));
  return container.querySelector<HTMLButtonElement>("button[aria-controls]")!;
}

function expandCard() {
  act(() =>
    container
      .querySelector<HTMLButtonElement>("button[aria-controls]")!
      .click(),
  );
}

describe("PeerPromptCardView", () => {
  it("renders a sent card with recipient, task, and state", () => {
    const card: PeerPromptCardType = {
      direction: "sent",
      messageKey: "k1",
      senderTitle: "Impl",
      recipientTitle: "Reviewer",
      message: "please review",
      responseRequested: true,
      taskTitle: "Fix bug",
      state: "awaiting_response",
    };
    const html = renderToStaticMarkup(<PeerPromptCardView card={card} />);
    expect(html).toContain("To");
    expect(html).not.toContain("Peer prompt to");
    expect(html).toContain("lucide-arrow-up-right");
    expect(html).toContain("Reviewer");
    expect(html).toContain("please review");
    expect(html).toContain("Awaiting response");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Fix bug");
    expect(html).not.toContain("Response requested");
    const toggle = renderCard(card, { actions: <button>Copy message</button> });
    expect(container.textContent).not.toContain("Copy message");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Task: Fix bug");
    expect(container.textContent).toContain("Response requested");
    expect(container.textContent).toContain("Copy message");
    act(() => toggle.click());
    expect(container.textContent).not.toContain("Task: Fix bug");
    expect(container.textContent).not.toContain("Copy message");
  });

  it("renders a received card with sender and no ids", () => {
    const card: PeerPromptCardType = {
      direction: "received",
      messageKey: "k2",
      senderTitle: "Planner",
      message: "status?",
      responseRequested: false,
      state: "delivered",
    };
    const html = renderToStaticMarkup(<PeerPromptCardView card={card} />);
    expect(html).toContain("From");
    expect(html).not.toContain("Peer prompt from");
    expect(html).toContain("lucide-arrow-down-left");
    expect(html).toContain("Planner");
    expect(html).toContain("Delivered");
    // No peerSessionId on this (older) card: the party is plain text, not a link.
    expect(html).not.toContain("/sessions/");
  });

  it("shows the full peer title wrapped on expansion", () => {
    const senderTitle =
      "Review session for the very long deployment incident investigation";
    const toggle = renderCard({
      direction: "received",
      messageKey: "full-title",
      senderTitle,
      message: "Review this change",
      responseRequested: false,
      state: "delivered",
    });
    act(() => toggle.click());
    const body = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(body?.querySelector("p.break-words")?.textContent).toBe(
      `From ${senderTitle}`,
    );
  });

  it("renders the message as Markdown", () => {
    const card: PeerPromptCardType = {
      direction: "received",
      messageKey: "k4",
      senderTitle: "Planner",
      message: "**P1** is fixed\n\n- one\n- two",
      responseRequested: false,
      state: "delivered",
    };
    const toggle = renderCard(card);
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("li")).toBeNull();
    expect(container.textContent).not.toContain("**P1**");
    expect(toggle.getAttribute("aria-label")).not.toContain("\n");
    act(() => toggle.click());
    expect(container.querySelector("strong")?.textContent).toBe("P1");
    expect(container.querySelector("li")?.textContent).toBe("one");
  });

  it("links each direction's other party to its session", () => {
    const base = {
      messageKey: "k5",
      senderTitle: "Planner",
      recipientTitle: "Reviewer",
      message: "hi",
      responseRequested: false,
      state: "delivered",
      peerSessionId: "11111111-2222-3333-4444-555555555555",
    } as const;
    const sent = renderToStaticMarkup(
      <PeerPromptCardView card={{ ...base, direction: "sent" }} />,
    );
    expect(sent).toContain(
      'href="/sessions/11111111-2222-3333-4444-555555555555"',
    );
    expect(sent).toContain(">Reviewer</a>");
    const received = renderToStaticMarkup(
      <PeerPromptCardView card={{ ...base, direction: "received" }} />,
    );
    expect(received).toContain(
      'href="/sessions/11111111-2222-3333-4444-555555555555"',
    );
    expect(received).toContain(">Planner</a>");
  });

  it("navigates the peer independently without expanding the message", () => {
    const onOpenSession = vi.fn();
    const toggle = renderCard(
      {
        direction: "received",
        messageKey: "navigation",
        senderTitle: "Reviewer",
        peerSessionId: "peer / encoded",
        message: "please review",
        responseRequested: false,
        state: "delivered",
      },
      { onOpenSession },
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/sessions/peer%20%2F%20encoded");
    expect(toggle.contains(link)).toBe(false);
    act(() => link.click());
    expect(onOpenSession).toHaveBeenCalledWith("peer / encoded");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["ctrlKey", "metaKey", "shiftKey", "altKey"])(
    "leaves %s peer navigation to the browser",
    (modifier) => {
      const onOpenSession = vi.fn();
      const toggle = renderCard(
        {
          direction: "sent",
          messageKey: "native-navigation",
          senderTitle: "Planner",
          recipientTitle: "Reviewer",
          peerSessionId: "peer-1",
          message: "please review",
          responseRequested: false,
          state: "delivered",
        },
        { onOpenSession },
      );
      let preventedByRow = true;
      document.body.addEventListener(
        "click",
        (event) => {
          preventedByRow = event.defaultPrevented;
          event.preventDefault();
        },
        { once: true },
      );
      act(() => {
        container.querySelector("a")!.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            [modifier]: true,
          }),
        );
      });
      expect(onOpenSession).not.toHaveBeenCalled();
      expect(preventedByRow).toBe(false);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    },
  );

  it.each([
    ["retrying", "Retrying", "lucide-refresh-cw", "text-warning"],
    ["interrupted", "Interrupted", "lucide-triangle-alert", "text-warning"],
    ["cancelled", "Cancelled", "lucide-circle-slash", "text-muted"],
    ["expired", "Expired", "lucide-clock-alert", "text-warning"],
    ["failed", "Failed", "lucide-circle-x", "text-danger"],
  ] as const)(
    "keeps %s visible and distinct from success while collapsed",
    (state, label, icon, tone) => {
      const toggle = renderCard({
        direction: "sent",
        messageKey: "state",
        senderTitle: "Planner",
        message: "hi",
        responseRequested: false,
        state,
        failureReason: "Session unavailable",
      });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.getAttribute("aria-label")).toContain(label);
      expect(container.textContent).toContain(label);
      expect(container.querySelector(`.${icon}`)).not.toBeNull();
      expect(container.querySelector(".lucide-circle-check")).toBeNull();
      expect(
        container
          .querySelector(`.${icon}`)
          ?.parentElement?.classList.contains(tone),
      ).toBe(true);
      expect(container.textContent).not.toContain("Session unavailable");
    },
  );

  it("reveals the failure reason on the first expansion, with distinct non-Failed states", () => {
    const retrying: PeerPromptCardType = {
      direction: "sent",
      messageKey: "k3",
      senderTitle: "Me",
      message: "hi",
      responseRequested: false,
      state: "retrying",
      failureReason: "boom",
    };
    const html = renderToStaticMarkup(<PeerPromptCardView card={retrying} />);
    expect(html).toContain("Retrying");
    expect(html).not.toContain(">Failed<");
    expect(html).not.toContain("boom");
    expect(html).not.toContain("<details");
    renderCard(retrying);
    expandCard();
    expect(container.querySelector("p.text-danger")?.textContent).toBe("boom");
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("the sent side, as a session_send_prompt tool block", () => {
  const sentBlock: Extract<DisplayBlock, { kind: "tool" }> = {
    kind: "tool",
    toolId: "call_1",
    name: "session_send_prompt",
    args: { targetSessionId: "s2", prompt: "please review" },
    output: JSON.stringify({
      renderKind: "sessionPeerPrompt",
      version: 1,
      card: {
        direction: "sent",
        messageKey: "k1",
        senderTitle: "Impl",
        recipientTitle: "Reviewer",
        peerSessionId: "11111111-2222-3333-4444-555555555555",
        message: "please review",
        responseRequested: true,
        state: "queued",
      },
    }),
    isError: false,
    done: true,
  };

  it("renders with tools hidden, so both halves of the exchange stay in the transcript", () => {
    expect(toolBlockIsVisible(sentBlock, false)).toBe(true);
    expect(
      renderToolBlock(sentBlock, { showTools: false, expandTools: false }),
    ).not.toBeNull();
  });

  // A payload clipped by the timeline's inline budget no longer parses; the
  // server keeps this tool's output whole for exactly that reason.
  it("degrades to nothing rather than crashing on a clipped payload", () => {
    const clipped = { ...sentBlock, output: sentBlock.output.slice(0, 80) };
    expect(toolBlockIsVisible(clipped, false)).toBe(false);
    expect(
      renderToolBlock(clipped, { showTools: false, expandTools: false }),
    ).toBeNull();
  });

  // The payload is model-authored: it may be partial, streaming, or simply
  // wrong. None of those may reach the renderer as a "card".
  it("refuses a payload whose card is malformed, and renders it as an ordinary tool block", () => {
    const malformed = [
      { message: {}, direction: "sent", state: "queued" },
      { message: "hi", direction: "sideways", state: "queued" },
      { message: "hi", direction: "sent", state: "made_up" },
      { message: "hi", direction: "sent" },
      "not an object",
      ["also not an object"],
      null,
    ];
    for (const card of malformed) {
      const block = {
        ...sentBlock,
        output: JSON.stringify({
          renderKind: "sessionPeerPrompt",
          version: 1,
          card,
        }),
      };
      expect(toolBlockIsVisible(block, false)).toBe(false);
      expect(
        renderToolBlock(block, { showTools: false, expandTools: false }),
      ).toBeNull();
      // With tools shown it is still readable, just as a plain tool body.
      expect(
        renderToolBlock(block, { showTools: true, expandTools: false }),
      ).not.toBeNull();
    }
  });

  it("fills a card that is merely incomplete rather than dropping it", () => {
    const sparse = {
      ...sentBlock,
      output: JSON.stringify({
        renderKind: "sessionPeerPrompt",
        version: 1,
        card: { direction: "received", message: "hi", state: "delivered" },
      }),
    };
    expect(toolBlockIsVisible(sparse, false)).toBe(true);
    const html = renderToStaticMarkup(
      <>{renderToolBlock(sparse, { showTools: false, expandTools: false })}</>,
    );
    expect(html).toContain("another session");
    expect(html).toContain("Delivered");
  });
});

// The transcript-block path takes the server's own card, but a card written by
// an older build is still data: the view may not throw the row.
describe("PeerPromptCardView on a card from another build", () => {
  it("renders without a usable state, message, title or reason", () => {
    const broken = {
      direction: "received",
      messageKey: "k6",
      state: "from_the_future",
      message: undefined,
      senderTitle: undefined,
      failureReason: { why: "an object" },
      taskTitle: 7,
      peerSessionId: {},
      responseRequested: true,
    } as unknown as PeerPromptCardType;
    const html = renderToStaticMarkup(<PeerPromptCardView card={broken} />);
    expect(html).toContain("From");
    expect(html).toContain("another session");
    expect(html).not.toContain("Response requested");
    expect(html).not.toContain("from_the_future");
    renderCard(broken);
    expandCard();
    expect(container.textContent).toContain("Response requested");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("Task:");
    expect(html).not.toContain("Task:");
    expect(html).not.toContain("<details");
    // A non-string id is not a link: no href, and nothing to hand onOpenSession.
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("object%20Object");
  });

  it("does not link a numeric or empty peer session id", () => {
    for (const peerSessionId of [42, "", null]) {
      const card = {
        direction: "sent",
        messageKey: "k7",
        senderTitle: "Impl",
        recipientTitle: "Reviewer",
        peerSessionId,
        message: "hi",
        responseRequested: false,
        state: "delivered",
      } as unknown as PeerPromptCardType;
      const html = renderToStaticMarkup(
        <PeerPromptCardView card={card} onOpenSession={() => {}} />,
      );
      expect(html).toContain("Reviewer");
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("/sessions/");
    }
  });
});

describe("PeerPromptsSection", () => {
  const projection: PeerPromptThreadsProjection = {
    truncated: true,
    threads: [
      {
        conversationId: "kabc",
        otherPartyTitle: "Reviewer",
        peerSessionId: "peer-1",
        messages: [
          {
            id: "k1",
            direction: "sent",
            // Already flattened and bounded when it arrives (`peerPromptExcerpt`).
            message: "please review the lease sweep",
            state: "replied",
            responseRequested: true,
            taskTitle: "Fix bug",
            createdAt: 1,
          },
          {
            id: "k2",
            direction: "received",
            message: "approved",
            state: "completed",
            responseRequested: false,
            createdAt: 2,
          },
        ],
      },
    ],
  };

  /**
   * The section is collapsed by default, so every body assertion has to open it
   * first — through the same persisted preference the reader's own toggle
   * writes, since static markup cannot click.
   */
  function renderOpen(
    node: Parameters<typeof renderToStaticMarkup>[0],
  ): string {
    window.localStorage.setItem(
      "inspector-section:session:s1:peer-prompts",
      "open",
    );
    try {
      return renderToStaticMarkup(node);
    } finally {
      window.localStorage.clear();
    }
  }

  it("starts collapsed: the summary is there, the thread is not", () => {
    const html = renderToStaticMarkup(
      <PeerPromptsSection sessionId="s1" projection={projection} />,
    );
    expect(html).toContain("Peer prompts");
    expect(html).toContain("1 thread · 2 messages");
    expect(html).not.toContain("Reviewer");
  });

  it("renders each message as a bubble linking to the peer's copy", () => {
    const html = renderOpen(
      <PeerPromptsSection sessionId="s1" projection={projection} />,
    );
    expect(html).toContain("Reviewer");
    expect(html).toContain("Replied");
    expect(html).toContain("Completed");
    // Both the thread name and every bubble address the peer session, so a
    // middle-click still opens the conversation the message lives in.
    expect(html.match(/href="\/sessions\/peer-1"/g)?.length).toBe(3);
    expect(html).toContain("Older peer prompts are not shown.");
  });

  it("renders the excerpt it is given, and none of the record detail", () => {
    const html = renderOpen(
      <PeerPromptsSection sessionId="s1" projection={projection} />,
    );
    // Verbatim: the server already excerpted it, and truncating again here
    // would only add a second ellipsis.
    expect(html).toContain("please review the lease sweep");
    expect(html).not.toContain("Response requested");
    expect(html).not.toContain("Task: Fix bug");
    expect(html).not.toContain("<details");
  });

  it("keeps a failure reason, which lives nowhere else", () => {
    const failed: PeerPromptThreadsProjection = {
      truncated: false,
      threads: [
        {
          conversationId: "kfail",
          otherPartyTitle: "Reviewer",
          peerSessionId: "peer-1",
          messages: [
            {
              id: "k9",
              direction: "sent",
              message: "hi",
              state: "failed",
              responseRequested: false,
              failureReason: "recipient session is gone",
              createdAt: 1,
            },
          ],
        },
      ],
    };
    const html = renderOpen(
      <PeerPromptsSection sessionId="s1" projection={failed} />,
    );
    expect(html).toContain("Failed");
    expect(html).toContain("recipient session is gone");
    // …and no disclosure: the transition audit trail this used to be filed
    // under is not on the wire at all any more.
    expect(html).not.toContain("<details");
  });

  it("degrades gracefully with a malformed/empty thread", () => {
    const empty: PeerPromptThreadsProjection = {
      truncated: false,
      threads: [
        {
          conversationId: "kx",
          otherPartyTitle: "Someone",
          peerSessionId: "peer-1",
          messages: [],
        },
      ],
    };
    const html = renderOpen(
      <PeerPromptsSection sessionId="s1" projection={empty} />,
    );
    expect(html).toContain("Someone");
  });

  it("renders a Load more button when truncated and an expand handler is provided", () => {
    const withExpand = renderOpen(
      <PeerPromptsSection
        sessionId="s1"
        projection={projection}
        onExpand={() => {}}
      />,
    );
    expect(withExpand).toContain("Load more history");
    const withoutExpand = renderOpen(
      <PeerPromptsSection sessionId="s1" projection={projection} />,
    );
    expect(withoutExpand).toContain("Older peer prompts are not shown.");
  });
});
