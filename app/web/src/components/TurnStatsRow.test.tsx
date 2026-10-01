import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { DisplayMessage } from "@assistant/shared";
import type { Turn } from "@assistant/shared/turnStats";
import { TurnStatsRow } from "./TurnStatsRow.tsx";

const reportedTurn: Turn = {
  messages: [],
  assistantMessages: [
    {
      id: "a1",
      role: "assistant",
      blocks: [{ kind: "text", text: "done" }],
      usage: {
        inputTokens: 2_572,
        outputTokens: 5_138,
        cacheReadTokens: 656_119,
        cacheCreationTokens: 48_967,
        contextTokens: 48_969,
        contextWindowTokens: 1_000_000,
        costUSD: 0.9485955,
      },
    },
  ],
  lastAssistantId: "a1",
  complete: true,
};

const firstTurnSession = {
  input: 2_572,
  output: 5_138,
  cacheRead: 656_119,
  cacheWrite: 48_967,
  cost: 0.9485955,
};

/** Visible text of the row: tags become the gap the flex row renders as a space. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One entry per collapsed line (the flex rows inside the toggle button). */
function collapsedLines(html: string): string[] {
  const button = html.slice(html.indexOf("<button"), html.indexOf("</button>"));
  return [...button.matchAll(/<div class="flex flex-wrap[^"]*">(.*?)<\/div>/g)]
    .map((match) => textOf(match[1] ?? ""))
    .filter((line) => line.length > 0);
}

/** A turn with 5-digit counts and a $10+ cost: the widest case that must not wrap. */
function wideTurn(usage: Record<string, number>): Turn {
  return {
    messages: [],
    assistantMessages: [
      {
        id: "a1",
        role: "assistant",
        blocks: [{ kind: "text", text: "done" }],
        usage,
      },
    ],
    lastAssistantId: "a1",
    complete: true,
  };
}

describe("TurnStatsRow", () => {
  test("separates billed input from context-window occupancy", () => {
    const html = renderToStaticMarkup(
      <TurnStatsRow
        turn={reportedTurn}
        sessionCumulative={firstTurnSession}
        contextDelta={48_969}
        showSessionCumulative={false}
        perRun={false}
      />,
    );

    expect(html).toContain("708k in");
    // 656k read of 708k prompt tokens: the 49k of cache WRITES count as misses.
    expect(html).toContain("93% cached");
    expect(html).not.toContain("99.6%");
    expect(html).not.toContain("100%");
    expect(textOf(html)).toContain("Context 49k/1.0M · 5% · +49k");
    // The wordy segments live in the tooltips now, not in the collapsed line.
    expect(textOf(html)).not.toContain("billed in");
    expect(textOf(html)).not.toContain("this turn");
  });

  test("puts Context after Turn and Session", () => {
    const html = renderToStaticMarkup(
      <TurnStatsRow
        turn={reportedTurn}
        sessionCumulative={firstTurnSession}
        contextDelta={1_000}
        showSessionCumulative
        perRun={false}
      />,
    );

    expect(textOf(html)).toMatch(/Turn .* Session .* Context /);
  });

  test("Turn and Session report the same ratio on identical tokens", () => {
    const html = renderToStaticMarkup(
      <TurnStatsRow
        turn={reportedTurn}
        sessionCumulative={firstTurnSession}
        contextDelta={1_000}
        showSessionCumulative
        perRun={false}
      />,
    );

    // The Session cumulative here IS the turn's usage, so both lines must agree.
    expect(html.match(/93% cached/g)).toHaveLength(2);
  });

  test("marks an estimated context size with ~", () => {
    const estimated: Turn = {
      ...reportedTurn,
      assistantMessages: [
        {
          ...(reportedTurn.assistantMessages[0] as DisplayMessage),
          usage: {
            inputTokens: 2_572,
            outputTokens: 5_138,
            cacheReadTokens: 656_119,
            cacheCreationTokens: 48_967,
            contextWindowTokens: 1_000_000,
          },
        },
      ],
    };
    const html = renderToStaticMarkup(
      <TurnStatsRow
        turn={estimated}
        sessionCumulative={firstTurnSession}
        contextDelta={707_658}
        showSessionCumulative={false}
        perRun={false}
      />,
    );

    // The fallback sums the run's prompt tokens: an upper bound, marked as one.
    expect(textOf(html)).toContain("Context ~708k/1.0M");
    // The reported case carries no marker.
    const reported = renderToStaticMarkup(
      <TurnStatsRow
        turn={reportedTurn}
        sessionCumulative={firstTurnSession}
        contextDelta={48_969}
        showSessionCumulative={false}
        perRun={false}
      />,
    );
    expect(reported).not.toContain("~");
  });

  test("omits a redundant Session line on the first usage turn", () => {
    const first = renderToStaticMarkup(
      <TurnStatsRow
        turn={reportedTurn}
        sessionCumulative={firstTurnSession}
        contextDelta={48_969}
        showSessionCumulative={false}
        perRun={false}
      />,
    );
    const later = renderToStaticMarkup(
      <TurnStatsRow
        turn={reportedTurn}
        sessionCumulative={{
          ...firstTurnSession,
          cacheRead: firstTurnSession.cacheRead * 2,
        }}
        contextDelta={1_000}
        showSessionCumulative
        perRun={false}
      />,
    );

    expect(first).not.toContain(">Session<");
    expect(later).toContain(">Session<");
  });

  test("a nearly-cached turn never claims 100%, a sliver never reads 0%", () => {
    // 999k read of 1M prompt tokens is 99.9%: rounding it up to "100% cached"
    // would hide the 1k of tokens that were billed as misses.
    const nearlyAll = renderToStaticMarkup(
      <TurnStatsRow
        turn={wideTurn({
          inputTokens: 1_000,
          outputTokens: 100,
          cacheReadTokens: 999_000,
          cacheCreationTokens: 0,
        })}
        sessionCumulative={{
          input: 1_000,
          output: 100,
          cacheRead: 999_000,
          cacheWrite: 0,
          cost: 0,
        }}
        contextDelta={0}
        showSessionCumulative
        perRun={false}
      />,
    );
    expect(nearlyAll).toContain("99% cached");
    expect(nearlyAll).not.toContain("100% cached");

    // Symmetrically, 0.05% of reuse is reported as 1%, not as no reuse at all.
    const sliver = renderToStaticMarkup(
      <TurnStatsRow
        turn={wideTurn({
          inputTokens: 100_000,
          outputTokens: 100,
          cacheReadTokens: 50,
          cacheCreationTokens: 0,
        })}
        sessionCumulative={{
          input: 100_000,
          output: 100,
          cacheRead: 50,
          cacheWrite: 0,
          cost: 0,
        }}
        contextDelta={0}
        showSessionCumulative
        perRun={false}
      />,
    );
    expect(sliver).toContain("1% cached");
    expect(sliver).not.toContain("0% cached");

    // An exact zero still reads 0%: there was nothing to round.
    const none = renderToStaticMarkup(
      <TurnStatsRow
        turn={wideTurn({
          inputTokens: 100_000,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        })}
        sessionCumulative={{
          input: 100_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
        }}
        contextDelta={0}
        showSessionCumulative
        perRun={false}
      />,
    );
    expect(none).toContain("0% cached");
  });

  /**
   * Width-drift guard. The real constraint is pixels — each collapsed line must
   * stay on ONE row at 360 px CSS width, measured at ~305 px of the ~305 px
   * available in the widest system font stack (see `TurnStatsRow`'s doc
   * comment). A DOM-free test cannot see pixels, so character count is the
   * proxy: the measured exact-fit line, "Session 99k in · 12k out · 75% cached
   * · $12.34", is 46 characters. A wording change that pushes past that budget
   * has to re-measure on a phone and move the number deliberately.
   */
  test("collapsed lines stay within the measured 360 px character budget", () => {
    const html = renderToStaticMarkup(
      <TurnStatsRow
        turn={wideTurn({
          inputTokens: 12_345,
          outputTokens: 12_345,
          cacheReadTokens: 123_456,
          cacheCreationTokens: 12_345,
          contextTokens: 154_321,
          contextWindowTokens: 200_000,
          costUSD: 12.34,
        })}
        sessionCumulative={{
          input: 12_345,
          output: 12_345,
          cacheRead: 74_321,
          cacheWrite: 12_345,
          cost: 12.34,
        }}
        contextDelta={98_765}
        showSessionCumulative
        perRun={false}
      />,
    );

    const lines = collapsedLines(html);
    expect(lines).toEqual([
      "Turn 148k in · 12k out · 83% cached · $12.34",
      "Session 99k in · 12k out · 75% cached · $12.34",
      "Context 154k/200k · 77% · +99k",
    ]);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(46);
  });
});
