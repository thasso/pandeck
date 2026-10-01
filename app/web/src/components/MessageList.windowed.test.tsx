// @vitest-environment jsdom
/**
 * What a WINDOWED transcript renders (Task-436): the reader must be able to walk
 * backwards past what the snapshot carried, and the turn stats over a suffix must
 * read as the continuation they are rather than a session that just started.
 *
 * Both fail silently — a missing control just looks like a short session, and an
 * unseeded Session line just looks like a cheap one.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppearanceSettings, DisplayMessage } from "@assistant/shared";
import type { TurnStatsSeed } from "@assistant/shared/turnStats";
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

const appearance: AppearanceSettings = {
  separatorAtTurnEnd: false,
  turnStatsRow: true,
  turnStatsPerRequest: false,
} as AppearanceSettings;

/** One complete turn: a prompt and an answer that reported usage. */
function turn(n: number, input: number, context: number): DisplayMessage[] {
  return [
    { id: `u${n}`, role: "user", blocks: [{ kind: "text", text: `ask ${n}` }] },
    {
      id: `a${n}`,
      role: "assistant",
      blocks: [{ kind: "text", text: `answer ${n}` }],
      model: "opus",
      usage: {
        inputTokens: input,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0.02,
        contextTokens: context,
      },
    },
  ];
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  // jsdom has no ResizeObserver; the transcript's scroll controller observes the
  // content box. A no-op is enough — nothing here depends on layout.
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

function render(props: {
  messages?: DisplayMessage[];
  seed?: TurnStatsSeed;
  hasOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  onLoadOlderMessages?: () => void;
}) {
  act(() =>
    root!.render(
      <MessageList
        sessionId="s1"
        messages={props.messages ?? [...turn(9, 1_000, 50_000)]}
        view={view}
        appearance={appearance}
        {...(props.seed ? { turnStatsSeed: props.seed } : {})}
        hasOlderMessages={props.hasOlderMessages ?? false}
        loadingOlderMessages={props.loadingOlderMessages ?? false}
        {...(props.onLoadOlderMessages
          ? { onLoadOlderMessages: props.onLoadOlderMessages }
          : {})}
      />,
    ),
  );
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container!.querySelectorAll("button")].find((el) =>
    el.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
}

describe("windowed transcript rendering", () => {
  it("marks rows for the platform-specific visibility policy", () => {
    render({});
    const rows = container!.querySelectorAll("[data-message-id]");
    expect(rows).toHaveLength(2);
    expect(
      [...rows].every((row) => row.classList.contains("transcript-row")),
    ).toBe(true);
  });

  it("offers the server fetch only when older entries exist", () => {
    render({});
    expect(button("Load earlier messages")).toBeUndefined();

    const onLoadOlderMessages = vi.fn();
    render({ hasOlderMessages: true, onLoadOlderMessages });
    const control = button("Load earlier messages");
    expect(control).toBeDefined();
    act(() => control!.click());
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
  });

  it("still offers it with NO rows at all (Task-450)", () => {
    // A window can project to zero display rows (a slice of orphan tool results,
    // or a cached range that was one). The reader's only way back into the
    // session is this control, so the empty transcript must still draw it — App
    // mounts the transcript for exactly that case rather than the new-session
    // surface.
    const onLoadOlderMessages = vi.fn();
    render({ messages: [], hasOlderMessages: true, onLoadOlderMessages });
    const control = button("Load earlier messages");
    expect(control).toBeDefined();
    act(() => control!.click());
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
  });

  it("shows the request in flight instead of a second one", () => {
    render({ hasOlderMessages: true, loadingOlderMessages: true });
    expect(button("Loading earlier messages…")?.disabled).toBe(true);
  });

  it("draws no turn row for a leading FRAGMENT, and one for the turn after it", () => {
    // The window opened inside a turn (a tool loop longer than the wire budget),
    // so its first rows are that turn's tail: `partialTurn` says so, and the row
    // must not be drawn — its numbers are a fraction of the turn's and would
    // change the moment the rest of the turn is loaded.
    const fragment: DisplayMessage = {
      id: "a-frag",
      role: "assistant",
      blocks: [{ kind: "text", text: "…still working" }],
      model: "opus",
      usage: {
        inputTokens: 1_300,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0.03,
        contextTokens: 60_000,
      },
    };
    const seed: TurnStatsSeed = {
      cumulative: {
        input: 500_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 12.5,
      },
      prevContextSize: 48_000,
      usageTurnCount: 7,
      partialTurn: true,
    };

    render({ messages: [fragment, ...turn(9, 1_000, 70_000)], seed });
    const rows = container!.querySelectorAll("[data-turn-stats-row]");
    expect(rows).toHaveLength(1);
    // The one row belongs to the COMPLETE turn after the fragment: its turn
    // input is that turn's 1.0k, never the fragment's 1.3k.
    expect(rows[0]!.textContent).toContain("Turn1.0k in");

    // Without the flag the same fragment would be drawn as if it were a turn.
    render({
      messages: [fragment, ...turn(9, 1_000, 70_000)],
      seed: { ...seed, partialTurn: false },
    });
    expect(container!.querySelectorAll("[data-turn-stats-row]")).toHaveLength(
      2,
    );
  });

  it("continues the Session cumulative and the context delta from the seed", () => {
    // Unseeded, one usage turn: no Session line to draw yet, and the turn claims
    // the whole context as its own growth.
    render({});
    expect(container!.textContent).not.toContain("Session");
    expect(container!.textContent).toContain("+50k");

    render({
      seed: {
        cumulative: {
          input: 500_000,
          output: 1_000,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 12.5,
        },
        prevContextSize: 48_000,
        usageTurnCount: 7,
      },
    });
    const seededText = container!.textContent ?? "";
    // 500k + this turn's 1k, $12.50 + $0.02, and a context delta measured from
    // the seed's 48k rather than from zero.
    expect(seededText).toContain("Session501k in");
    expect(seededText).toContain("$12.52");
    expect(seededText).toContain("Context50k·+2.0k");
  });
});
