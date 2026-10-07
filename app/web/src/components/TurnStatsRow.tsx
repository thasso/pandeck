import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { SessionTotals, Turn } from "@assistant/shared/turnStats";
import { usePerfRenderCount } from "../lib/perfStats.ts";
import {
  promptCacheHitRatio,
  turnRuns,
  turnTotals,
} from "@assistant/shared/turnStats";

/** Compact token count: 340, 5.1k, 1.2M. */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Signed delta, e.g. +14.2k / −5.0k / +0. */
function fmtDelta(n: number): string {
  const sign = n < 0 ? "−" : "+";
  return `${sign}${fmtTokens(Math.abs(n))}`;
}

function fmtCost(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/**
 * Two-decimal cost for the collapsed lines, which must fit a phone; sub-cent
 * amounts say so rather than rounding to a misleading `$0.00`. The precise
 * figure stays one tap away in the expanded breakdown's cost row, and in the
 * collapsed span's own `title`.
 */
function fmtCostCompact(usd: number): string {
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

function fmtPct(ratio: number): string {
  const rounded = Math.round(ratio * 1000) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/**
 * Whole-percent variant for the collapsed lines; the tenth lives in the tooltip
 * and the expanded breakdown. Rounding is CLAMPED at both ends: only an exact 1
 * may print 100% and only an exact 0 may print 0%. A 99.6%-cached turn saying
 * "100% cached" would re-introduce the very overstatement the honest denominator
 * removes — thousands of prompt tokens were still billed as misses — and a
 * sliver of reuse must not vanish into "0%" either.
 */
function fmtPctCompact(ratio: number): string {
  const pct = Math.round(ratio * 100);
  if (pct >= 100 && ratio < 1) return "99%";
  if (pct <= 0 && ratio > 0) return "1%";
  return `${pct}%`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

/**
 * Billed input processed across every model request in a provider run. This can
 * greatly exceed context-window occupancy because a tool loop repeatedly sends
 * the growing conversation to the model.
 */
function totalInput(t: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number {
  return t.input + t.cacheRead + t.cacheWrite;
}

const INPUT_TITLE =
  "Billed input processed across provider runs: cache read + cache write + uncached input. A tool loop repeatedly processes the conversation, so this can exceed context-window occupancy.";
const UNCACHED_TITLE =
  "Input billed at the full uncached rate. Near zero is normal with prompt caching.";
const CACHED_TITLE =
  "Share of billed input served from the prompt cache: cache read / (cache read + cache write + uncached input). Cache writes count as misses — they were processed uncached to seed the cache.";
const CONTEXT_TITLE =
  "Prompt tokens occupying the model's context window after this turn, and the window's capacity.";
const CONTEXT_ESTIMATE_TITLE = `~ marks an estimate: the harness reported no context size, so this is the last run's prompt-token sum. It over-counts when that run made several internal model requests. ${CONTEXT_TITLE}`;
const CONTEXT_DELTA_TITLE =
  "Change in context-window occupancy since the previous completed turn; it can be negative after compaction.";
const DELTA_ESTIMATE_NOTE =
  "This turn's occupancy is an estimate (see the used value), so the change is one too.";
const TURN_TIME_TITLE =
  "First provider run's start to the last one's end, so tool execution between runs is included — not model generation time alone.";

function Dot() {
  return <span className="text-faint/60">·</span>;
}

/** One label/value detail line (vertical layout — never overflows on mobile). */
function Detail({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4" title={title}>
      <span className="text-faint">{label}</span>
      <span className="tabular-nums text-muted-foreground">{value}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mt-1.5 text-xs font-medium uppercase tracking-wide text-faint/70">
      {children}
    </div>
  );
}

/**
 * Completed-turn accounting, context-window state, and (after the first usage
 * turn) session cumulative, in that order: Turn, Session, Context. The three
 * concepts stay deliberately separate: billed input is work processed across
 * repeated requests, while Context is the one prompt snapshot occupying the
 * model's finite window. Omitting Session on the first usage turn avoids
 * repeating the Turn totals verbatim.
 *
 * Each COLLAPSED line must fit one row of a 360 px-wide phone, which is why the
 * wording is telegraphic and the percent/cost formats are the compact ones —
 * the precise figures live in the tooltips and the expanded breakdown. Measured
 * worst case (5-digit counts, $10+ cost, widest system stack) is ~305 px of the
 * ~305 px available; `flex-wrap` stays as the graceful fallback for a larger
 * text scale.
 */
/**
 * Memoized because there is one of these per completed TURN, and the transcript
 * above them re-renders for anything that reaches it — every session broadcast,
 * every streamed token. Their content only changes when the turn does, and the
 * host keeps the entry objects stable across a recompute
 * (`reuseStableTurnEnds`), so this compares by identity.
 */
export const TurnStatsRow = memo(function TurnStatsRow({
  turn,
  sessionCumulative,
  contextDelta,
  showSessionCumulative,
  perRun,
}: {
  turn: Turn;
  sessionCumulative: SessionTotals;
  contextDelta: number;
  showSessionCumulative: boolean;
  perRun: boolean;
}) {
  usePerfRenderCount("TurnStatsRow");
  const [expanded, setExpanded] = useState(false);
  const totals = turnTotals(turn);
  if (totals.runCount === 0) return null;

  const session = sessionCumulative;
  const sessionHit = promptCacheHitRatio(session);
  const runs = perRun && expanded ? turnRuns(turn) : [];
  const contextPercent =
    totals.contextWindow && totals.contextWindow > 0
      ? totals.contextSize / totals.contextWindow
      : null;
  const contextAvailable =
    totals.contextWindow === undefined
      ? undefined
      : Math.max(0, totals.contextWindow - totals.contextSize);
  // An estimated occupancy is marked "~" wherever it is shown; the tooltip says why.
  const contextUsed = `${totals.contextSizeIsEstimate ? "~" : ""}${fmtTokens(totals.contextSize)}`;
  const contextTitle = totals.contextSizeIsEstimate
    ? CONTEXT_ESTIMATE_TITLE
    : CONTEXT_TITLE;

  return (
    <div
      data-turn-stats-row=""
      className="flex flex-col gap-0.5 px-1 text-sm text-faint"
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full flex-col gap-0.5 text-left"
      >
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
          <ChevronRight
            size={11}
            className={`shrink-0 text-faint/70 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span className="font-medium text-muted-foreground">Turn</span>
          <span className="tabular-nums" title={INPUT_TITLE}>
            {fmtTokens(totalInput(totals))} in
          </span>
          <Dot />
          <span className="tabular-nums">{fmtTokens(totals.output)} out</span>
          {totals.cacheHitRatio !== null && (
            <>
              <Dot />
              <span className="tabular-nums" title={CACHED_TITLE}>
                {fmtPctCompact(totals.cacheHitRatio)} cached
              </span>
            </>
          )}
          {totals.cost > 0 && (
            <>
              <Dot />
              <span className="tabular-nums" title={fmtCost(totals.cost)}>
                {fmtCostCompact(totals.cost)}
              </span>
            </>
          )}
        </div>

        {showSessionCumulative && (
          <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 pl-[15px]">
            <span className="font-medium text-muted-foreground">Session</span>
            <span className="tabular-nums" title={INPUT_TITLE}>
              {fmtTokens(totalInput(session))} in
            </span>
            <Dot />
            <span className="tabular-nums">
              {fmtTokens(session.output)} out
            </span>
            {sessionHit !== null && (
              <>
                <Dot />
                <span className="tabular-nums" title={CACHED_TITLE}>
                  {fmtPctCompact(sessionHit)} cached
                </span>
              </>
            )}
            {session.cost > 0 && (
              <>
                <Dot />
                <span className="tabular-nums" title={fmtCost(session.cost)}>
                  {fmtCostCompact(session.cost)}
                </span>
              </>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 pl-[15px]">
          <span className="font-medium text-muted-foreground">Context</span>
          <span className="tabular-nums" title={contextTitle}>
            {contextUsed}
            {totals.contextWindow !== undefined
              ? `/${fmtTokens(totals.contextWindow)}`
              : ""}
          </span>
          {contextPercent !== null && (
            <>
              <Dot />
              {/* Derived from the same occupancy figure, so it inherits its basis. */}
              <span className="tabular-nums" title={contextTitle}>
                {fmtPctCompact(contextPercent)}
              </span>
            </>
          )}
          <Dot />
          <span
            className="tabular-nums"
            title={
              totals.contextSizeIsEstimate
                ? `${CONTEXT_DELTA_TITLE} ${DELTA_ESTIMATE_NOTE}`
                : CONTEXT_DELTA_TITLE
            }
          >
            {fmtDelta(contextDelta)}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="mt-0.5 flex flex-col gap-0.5 pl-[15px]">
          <SectionLabel>Turn</SectionLabel>
          <Detail
            label="billed input"
            value={fmtTokens(totalInput(totals))}
            title={INPUT_TITLE}
          />
          <Detail label="output" value={fmtTokens(totals.output)} />
          <Detail
            label="cache read"
            value={`${fmtTokens(totals.cacheRead)}${totals.cacheHitRatio !== null ? ` (${fmtPct(totals.cacheHitRatio)})` : ""}`}
            title={CACHED_TITLE}
          />
          <Detail label="cache write" value={fmtTokens(totals.cacheWrite)} />
          <Detail
            label="uncached input"
            value={fmtTokens(totals.input)}
            title={UNCACHED_TITLE}
          />
          {/* The collapsed line rounds to the cent; this is the precise figure,
              and it matches what the Session section already shows. */}
          {totals.cost > 0 && (
            <Detail label="cost" value={fmtCost(totals.cost)} />
          )}
          {totals.durationMs !== undefined && (
            <Detail
              label="turn time"
              value={fmtDuration(totals.durationMs)}
              title={TURN_TIME_TITLE}
            />
          )}
          {totals.toolCalls > 0 && (
            <Detail label="tool calls" value={String(totals.toolCalls)} />
          )}
          {totals.runCount > 1 && (
            <Detail label="provider runs" value={String(totals.runCount)} />
          )}
          {totals.model && <Detail label="model" value={totals.model} />}

          <SectionLabel>Context window</SectionLabel>
          <Detail label="used" value={contextUsed} title={contextTitle} />
          <Detail
            label="capacity"
            value={
              totals.contextWindow === undefined
                ? "unknown"
                : fmtTokens(totals.contextWindow)
            }
          />
          {contextAvailable !== undefined && (
            <Detail label="available" value={fmtTokens(contextAvailable)} />
          )}
          {contextPercent !== null && (
            <Detail label="utilization" value={fmtPct(contextPercent)} />
          )}
          <Detail
            label="change this turn"
            value={fmtDelta(contextDelta)}
            title={CONTEXT_DELTA_TITLE}
          />

          {showSessionCumulative && (
            <>
              <SectionLabel>Session</SectionLabel>
              <Detail
                label="billed input"
                value={fmtTokens(totalInput(session))}
                title={INPUT_TITLE}
              />
              <Detail label="output" value={fmtTokens(session.output)} />
              <Detail
                label="cache read"
                value={`${fmtTokens(session.cacheRead)}${sessionHit !== null ? ` (${fmtPct(sessionHit)})` : ""}`}
                title={CACHED_TITLE}
              />
              <Detail
                label="cache write"
                value={fmtTokens(session.cacheWrite)}
              />
              <Detail
                label="uncached input"
                value={fmtTokens(session.input)}
                title={UNCACHED_TITLE}
              />
              {session.cost > 0 && (
                <Detail label="cost" value={fmtCost(session.cost)} />
              )}
            </>
          )}

          {runs.length > 0 && (
            <>
              <SectionLabel>Provider runs</SectionLabel>
              {runs.map((run) => (
                <div
                  key={run.id}
                  className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5"
                >
                  <span className="text-faint/80">#{run.index}</span>
                  <span title={INPUT_TITLE}>
                    {fmtTokens(totalInput(run))} billed in
                  </span>
                  <Dot />
                  <span>{fmtTokens(run.cacheRead)} cache read</span>
                  <Dot />
                  <span>{fmtTokens(run.output)} out</span>
                  {run.cacheWrite > 0 && (
                    <>
                      <Dot />
                      <span>{fmtTokens(run.cacheWrite)} cache write</span>
                    </>
                  )}
                  {run.input > 0 && (
                    <>
                      <Dot />
                      <span title={UNCACHED_TITLE}>
                        {fmtTokens(run.input)} uncached
                      </span>
                    </>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
});
