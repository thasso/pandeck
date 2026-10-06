/**
 * The one anchor resolver: a stored `SelectorBundle` plus the current document
 * text in, a `ResolvedAnchor` out. Serves every commentable surface (worktree
 * diffs, session transcripts) — see `docs/comments.md` for the model.
 *
 * The ladder, first hit wins: stored position → block hint → exact quote
 * (prefix/suffix disambiguates duplicates) → bounded fuzzy quote → orphaned.
 * Lines are DERIVED from the resolved position, never matched on.
 *
 * All offsets in and out are into the RAW `documentText`; normalization
 * (`normalizeAnchorText`) is used for comparison decisions only.
 *
 * Ambiguity is an answer, not a tie to break: a quote whose duplicates no
 * surrounding context separates orphans rather than picking one. A short generic
 * quote fuzzy-matched against a whole document is the known
 * pathology (slow, and confidently wrong), so quotes shorter than
 * `MIN_FUZZY_QUOTE_LEN` normalized characters never reach the fuzzy step. An
 * honest orphan beats a wrong anchor: an orphaned thread is kept and revivable,
 * a mis-anchored one silently lies.
 */
import search from "approx-string-match";
import {
  normalizeAnchorText,
  type PositionSelector,
  type QuoteSelector,
  type ResolvedAnchor,
  type SelectorBundle,
} from "@assistant/shared/comments";

/** Context characters the winner must beat the runner-up by to be trusted. */
const CONTEXT_MARGIN = 8;
/** Below this many normalized quote characters the fuzzy step is skipped. */
const MIN_FUZZY_QUOTE_LEN = 12;
/**
 * Fuzzy error budget: a share of the quote length, then clamped.
 *
 * The share is length-dependent, and the numbers are empirical — from the
 * Task-426 golden run over the real KB. A long quote carries enough signal to
 * stay recognizable through real copy-editing: passages that were still the same
 * passage had drifted by up to 31% of their characters, while genuinely
 * rewritten ones sat at 47% and above, so 0.35 falls in that gap. A SHORT quote
 * has no such margin — at 0.35 a deleted 15-character list item matched a
 * neighbouring item 4 edits away, which is the "confidently wrong" outcome the
 * ladder exists to refuse — so short quotes keep the tighter 0.2.
 *
 * The absolute clamp is a sanity bound on "still the same passage", not a cost
 * bound (the matcher is O(n·⌈m/64⌉) whatever the budget): at 32 it rejected an
 * 18%-drifted 335-character quote whose passage was plainly still there.
 *
 * `resolveAnchor.test.ts` pins one fixture per boundary. Every length here is a
 * RAW character count, because the errors being budgeted are raw edits — unlike
 * `MIN_FUZZY_QUOTE_LEN`, which asks a different question (is there enough
 * distinct text to search for at all?) and so measures normalized length.
 */
const FUZZY_ERROR_RATE_SHORT = 0.2;
const FUZZY_ERROR_RATE_LONG = 0.35;
/** Raw quote length from which the wider rate applies. */
const LONG_QUOTE_LEN = 40;
const MAX_FUZZY_ERRORS = 128;

function fuzzyErrorBudget(quoteLength: number): number {
  const rate =
    quoteLength >= LONG_QUOTE_LEN
      ? FUZZY_ERROR_RATE_LONG
      : FUZZY_ERROR_RATE_SHORT;
  return Math.min(
    MAX_FUZZY_ERRORS,
    Math.max(1, Math.round(rate * quoteLength)),
  );
}
/** Floor for a fuzzy match's reported confidence. */
const MIN_FUZZY_CONFIDENCE = 0.3;

export interface ResolveAnchorOptions {
  /** Ranges of the domain's structural blocks in `documentText`, by block id. */
  blockRanges?: Map<string, PositionSelector>;
  /**
   * Skip the direct stored-position rung while retaining the stored position for
   * block/exact state and tie-breaking. Use when positions belong to an immutable
   * source coordinate system rather than `documentText`; a projected block may
   * be present, but fallback must also avoid coincidental raw-offset matches.
   */
  skipPositionStep?: boolean;
}

export function resolveAnchor(
  bundle: SelectorBundle,
  documentText: string,
  opts?: ResolveAnchorOptions,
): ResolvedAnchor {
  const { quote } = bundle;
  if (!quote.exact) return orphaned();
  const lines = lineStarts(documentText);

  // 1. Stored position, verified against the exact text.
  const stored = bundle.position;
  if (
    !opts?.skipPositionStep &&
    stored &&
    stored.start >= 0 &&
    documentText.slice(stored.start, stored.end) === quote.exact
  ) {
    return resolved("anchored", stored, lines, 1);
  }

  // 2. Structural hint: search inside the block the comment was made in.
  const blockRange = bundle.block
    ? opts?.blockRanges?.get(bundle.block.id)
    : undefined;
  if (blockRange) {
    const inBlock = occurrences(
      documentText,
      quote.exact,
      blockRange.start,
      blockRange.end,
    );
    const best = pickByContext(documentText, inBlock, quote, stored);
    if (best !== null) {
      return resolved(stateAt(best, stored), span(best, quote), lines, 0.9);
    }
  }

  // 3. Exact quote anywhere, disambiguated by surrounding context. The exact
  // text being present but ambiguous is an answer: fuzzy matching would only
  // rediscover the same tie, so an uncorroborated duplicate orphans instead.
  const all = occurrences(documentText, quote.exact, 0, documentText.length);
  if (all.length > 0) {
    const corroborated = disambiguate(documentText, all, quote);
    if (corroborated === null) return orphaned();
    return resolved(
      stateAt(corroborated, stored),
      span(corroborated, quote),
      lines,
      0.8,
    );
  }

  // 4. Fuzzy quote — never for short generic quotes (see the module header).
  if (normalizeAnchorText(quote.exact).length < MIN_FUZZY_QUOTE_LEN)
    return orphaned();
  const fuzzy = bestFuzzyMatch(documentText, quote, stored);
  if (fuzzy) {
    const confidence = Math.max(
      MIN_FUZZY_CONFIDENCE,
      1 - fuzzy.errors / quote.exact.length,
    );
    return resolved(
      "moved",
      { start: fuzzy.start, end: fuzzy.end },
      lines,
      confidence,
    );
  }

  // 5. Nothing left to believe.
  return orphaned();
}

function orphaned(): ResolvedAnchor {
  return { state: "orphaned", confidence: 0 };
}

function resolved(
  state: "anchored" | "moved",
  position: PositionSelector,
  lines: number[],
  confidence: number,
): ResolvedAnchor {
  return {
    state,
    position,
    line: {
      start: lineAt(lines, position.start),
      end: lineAt(lines, position.end),
    },
    confidence,
  };
}

/**
 * `anchored` means the quote is exactly where it was stored; a bundle without a
 * stored position has nothing to be at, so its exact matches read as `moved`.
 */
function stateAt(
  offset: number,
  stored: PositionSelector | undefined,
): "anchored" | "moved" {
  return stored && stored.start === offset ? "anchored" : "moved";
}

function span(offset: number, quote: QuoteSelector): PositionSelector {
  return { start: offset, end: offset + quote.exact.length };
}

function occurrences(
  text: string,
  needle: string,
  from: number,
  to: number,
): number[] {
  const found: number[] = [];
  let at = text.indexOf(needle, Math.max(0, from));
  while (at !== -1 && at + needle.length <= to) {
    found.push(at);
    at = text.indexOf(needle, at + 1);
  }
  return found;
}

/**
 * Characters of `prefix` that match backwards from the occurrence plus
 * characters of `suffix` that match forwards from its end.
 */
function contextScore(
  text: string,
  offset: number,
  quote: QuoteSelector,
): number {
  let score = 0;
  const { prefix, suffix } = quote;
  for (let i = 1; i <= prefix.length; i++) {
    if (text[offset - i] !== prefix[prefix.length - i]) break;
    score++;
  }
  const end = offset + quote.exact.length;
  for (let i = 0; i < suffix.length; i++) {
    if (text[end + i] !== suffix[i]) break;
    score++;
  }
  return score;
}

/**
 * One candidate wins outright; several only if the best beats the runner-up by
 * `CONTEXT_MARGIN` characters of context. Otherwise `null` — an ambiguous quote
 * falls through rather than guessing.
 */
function disambiguate(
  text: string,
  candidates: number[],
  quote: QuoteSelector,
): number | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const scored = candidates
    .map((offset) => ({ offset, score: contextScore(text, offset, quote) }))
    .sort((a, b) => b.score - a.score);
  const [best, runnerUp] = scored as [
    { offset: number; score: number },
    { offset: number; score: number },
  ];
  return best.score - runnerUp.score >= CONTEXT_MARGIN ? best.offset : null;
}

/**
 * Inside a block the candidate set is already narrow, so the stored position
 * wins if it is among them and context decides otherwise.
 */
function pickByContext(
  text: string,
  candidates: number[],
  quote: QuoteSelector,
  stored: PositionSelector | undefined,
): number | null {
  if (candidates.length === 0) return null;
  if (stored && candidates.includes(stored.start)) return stored.start;
  let best = candidates[0]!;
  let bestScore = contextScore(text, best, quote);
  for (const offset of candidates.slice(1)) {
    const score = contextScore(text, offset, quote);
    if (score > bestScore) {
      best = offset;
      bestScore = score;
    }
  }
  return best;
}

/** Lowest error count wins; ties go to context, then to the stored position. */
function bestFuzzyMatch(
  text: string,
  quote: QuoteSelector,
  stored: PositionSelector | undefined,
): { start: number; end: number; errors: number } | null {
  const matches = search(
    text,
    quote.exact,
    fuzzyErrorBudget(quote.exact.length),
  );
  if (matches.length === 0) return null;
  let best = matches[0]!;
  let bestScore = contextScore(text, best.start, quote);
  for (const match of matches.slice(1)) {
    if (match.errors > best.errors) continue;
    const score = contextScore(text, match.start, quote);
    if (match.errors < best.errors || score > bestScore) {
      best = match;
      bestScore = score;
      continue;
    }
    if (score === bestScore && stored) {
      const closer =
        Math.abs(match.start - stored.start) <
        Math.abs(best.start - stored.start);
      if (closer) best = match;
    }
  }
  return best;
}

/** Offsets at which each line starts, so `lineAt` is a binary search. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
    starts.push(i + 1);
  return starts;
}

/** 1-based line containing `offset`. */
function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}
