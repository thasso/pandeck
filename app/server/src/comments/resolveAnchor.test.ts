/**
 * The anchor ladder against real document drift: an unchanged body, whitespace
 * reflow, a relocated passage, duplicate quotes with and without disambiguating
 * context, deletion, a word changed inside a long quote, and the short-quote
 * guard. The invariants that decide whether the model is honest are asserted
 * explicitly: offsets are into RAW text, normalization is comparison-only, and
 * an ambiguous or short quote orphans rather than guessing.
 *
 * The fuzzy error budget has its own describe block: one fixture per boundary,
 * each pinning its drift with a measured error count, so the constants cannot be
 * changed back without a failure here.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import search from "approx-string-match";
import { measureCpuMs } from "../test/cpuBudget.ts";
import {
  normalizeAnchorText,
  PREFIX_LEN,
  SUFFIX_LEN,
  type AnchorState,
  type SelectorBundle,
} from "@assistant/shared/comments";
import { resolveAnchor } from "./resolveAnchor.ts";

const OVERVIEW =
  "The scheduler now retries failed jobs with exponential backoff and gives up after five attempts, so a poisoned job cannot wedge the queue for the rest of the day. Operators see the give-up in the run log.";
const HEARTBEAT =
  "Every worker keeps a heartbeat so the supervisor can tell a slow job from a dead one.";

const BASE = [
  "# Release notes",
  "",
  "## Overview",
  "",
  OVERVIEW,
  "",
  "## Details",
  "",
  HEARTBEAT,
  "",
  "## Notes",
  "",
  "- [ ] TODO",
  "- [ ] TODO",
  "- [ ] TODO",
  "",
].join("\n");

const RELOCATED = [
  "# Release notes",
  "",
  "## Overview",
  "",
  "## Details",
  "",
  HEARTBEAT,
  "",
  OVERVIEW,
  "",
  "## Notes",
  "",
].join("\n");

const REPEAT = "Retry with exponential backoff.";
const SECTIONED = [
  "# Runbook",
  "",
  "## Scheduler",
  "",
  REPEAT,
  "",
  "## Worker",
  "",
  REPEAT,
  "",
  "## Gateway",
  "",
  REPEAT,
  "",
].join("\n");
const AMBIGUOUS = [
  "# Runbook",
  "",
  `- ${REPEAT}`,
  `- ${REPEAT}`,
  `- ${REPEAT}`,
  `- ${REPEAT}`,
  "",
].join("\n");
/** Shifting every offset forces the ladder past the stored-position step. */
const shift = (doc: string): string => `> Updated for 0.8.\n\n${doc}`;

/** Build the bundle a describer would have stored for a quote in `doc`. */
function bundleFor(doc: string, exact: string, occurrence = 0): SelectorBundle {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = doc.indexOf(exact, start + 1);
  assert.ok(start >= 0, `fixture does not contain the quote: ${exact}`);
  const end = start + exact.length;
  return {
    quote: {
      exact,
      prefix: doc.slice(Math.max(0, start - PREFIX_LEN), start),
      suffix: doc.slice(end, end + SUFFIX_LEN),
    },
    position: { start, end },
  };
}

/** Wrap on spaces, i.e. reflow the paragraph without changing its words. */
function wrap(text: string, width: number): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function nthIndex(doc: string, needle: string, occurrence: number): number {
  let at = -1;
  for (let i = 0; i <= occurrence; i++) at = doc.indexOf(needle, at + 1);
  return at;
}

interface Case {
  name: string;
  /** The document as it was when the comment was made. */
  from: string;
  quote: string;
  occurrence?: number;
  /** The document as it is now. */
  to: string;
  state: AnchorState;
  /** Raw text expected at the resolved position. */
  text?: string;
  /** Expected resolved start offset, when the case pins one. */
  start?: number;
}

const CASES: Case[] = [
  {
    name: "unchanged document keeps the stored position",
    from: BASE,
    quote: OVERVIEW,
    to: BASE,
    state: "anchored",
    text: OVERVIEW,
    start: BASE.indexOf(OVERVIEW),
  },
  {
    name: "whitespace reflow of the paragraph moves the anchor, quote intact",
    from: BASE,
    quote: OVERVIEW,
    to: BASE.replace(OVERVIEW, wrap(OVERVIEW, 40)),
    state: "moved",
    text: wrap(OVERVIEW, 40),
  },
  {
    name: "a passage moved to another section resolves at its new position",
    from: BASE,
    quote: OVERVIEW,
    to: RELOCATED,
    state: "moved",
    text: OVERVIEW,
    start: RELOCATED.indexOf(OVERVIEW),
  },
  {
    name: "three occurrences, prefix disambiguates the right one",
    from: SECTIONED,
    quote: REPEAT,
    occurrence: 1,
    to: shift(SECTIONED),
    state: "moved",
    text: REPEAT,
    start: nthIndex(shift(SECTIONED), REPEAT, 1),
  },
  {
    name: "three occurrences the context cannot separate orphan, never guess",
    from: AMBIGUOUS,
    quote: REPEAT,
    occurrence: 1,
    to: shift(AMBIGUOUS),
    state: "orphaned",
  },
  {
    name: "a deleted passage orphans",
    from: BASE,
    quote: HEARTBEAT,
    to: BASE.replace(`${HEARTBEAT}\n`, ""),
    state: "orphaned",
  },
  {
    name: "one word changed inside a long quote resolves fuzzily",
    from: BASE,
    quote: OVERVIEW,
    to: BASE.replace("five attempts", "seven attempts"),
    state: "moved",
    text: OVERVIEW.replace("five attempts", "seven attempts"),
  },
  {
    name: "a short generic quote orphans instead of fuzzy-matching (TODO)",
    from: BASE,
    quote: "TODO",
    occurrence: 1,
    to: BASE.replaceAll("TODO", "TO DO"),
    state: "orphaned",
  },
  {
    name: "a short generic quote orphans instead of fuzzy-matching (heading)",
    from: BASE,
    quote: "## Notes",
    to: BASE.replace("## Notes", "## Note"),
    state: "orphaned",
  },
];

describe("resolveAnchor", () => {
  for (const testCase of CASES) {
    test(testCase.name, () => {
      const bundle = bundleFor(
        testCase.from,
        testCase.quote,
        testCase.occurrence,
      );
      const resolved = resolveAnchor(bundle, testCase.to);
      assert.equal(resolved.state, testCase.state, testCase.name);
      if (testCase.state === "orphaned") {
        assert.equal(resolved.position, undefined);
        assert.equal(resolved.line, undefined);
        assert.equal(resolved.confidence, 0);
        return;
      }
      assert.ok(resolved.position, "a non-orphan carries a position");
      const { start, end } = resolved.position;
      if (testCase.start !== undefined) assert.equal(start, testCase.start);
      if (testCase.text !== undefined)
        assert.equal(testCase.to.slice(start, end), testCase.text);
      assert.ok(resolved.confidence > 0 && resolved.confidence <= 1);
    });
  }
});

test("the short-quote guard suppresses a fuzzy match that exists", () => {
  const drifted = BASE.replaceAll("TODO", "TO DO");
  assert.ok(
    search(drifted, "TODO", 1).length > 0,
    "fixture must offer a fuzzy candidate for the guard to suppress",
  );
  assert.equal(
    resolveAnchor(bundleFor(BASE, "TODO", 1), drifted).state,
    "orphaned",
  );
});

/**
 * The fuzzy error budget, one test per boundary it is made of. The budget is
 * `clamp(round(rate * len), 1, 128)` with `rate` 0.35 from `LONG_QUOTE_LEN` = 40
 * characters up and 0.2 below; the pre-Task-426 budget was
 * `clamp(round(0.2 * len), 1, 32)`. Each fixture pins its own drift with a
 * measured error count, so reverting either boundary fails here rather than only
 * in the opt-in golden harness.
 */
describe("the fuzzy error budget", () => {
  const OLD_RATE = 0.2;
  const OLD_CLAMP = 32;
  const oldBudget = (len: number) =>
    Math.min(OLD_CLAMP, Math.max(1, Math.round(OLD_RATE * len)));

  /** Fewest errors any window of `text` needs to match `quote`. */
  function minErrors(text: string, quote: string): number {
    const matches = search(text, quote, quote.length);
    assert.ok(matches.length > 0, "fixture must offer some fuzzy candidate");
    return Math.min(...matches.map((match) => match.errors));
  }

  test("a long quote copy-edited past the old rate still resolves", () => {
    const quote =
      "The supervisor restarts a worker whose heartbeat is late, then reports the restart in the run log.";
    const edited =
      "The supervisor restarts any worker whose heartbeat goes stale, and records that restart in the daily run log.";
    const from = `# Notes\n\n${quote}\n\nDone.\n`;
    const to = `# Notes\n\n${edited}\n\nDone.\n`;
    // ~22% drift: past the old rate, inside the new one, and nowhere near the
    // clamp — so this fixture answers for the RATE alone.
    const errors = minErrors(to, quote);
    assert.ok(
      errors > oldBudget(quote.length) && errors < OLD_CLAMP,
      `fixture drift ${errors} must sit between the old rate budget ${oldBudget(quote.length)} and the old clamp ${OLD_CLAMP}`,
    );

    const resolved = resolveAnchor(bundleFor(from, quote), to);
    assert.equal(resolved.state, "moved");
    assert.ok(
      to
        .slice(resolved.position!.start, resolved.position!.end)
        .includes("heartbeat goes stale"),
      "the resolved span must be the copy-edited passage",
    );
  });

  test("a long quote needing more than the old clamp still resolves", () => {
    const quote =
      "The supervisor restarts a worker whose heartbeat is late, then reports the restart in the run log. A worker that dies mid-job leaves its lease behind, so the scheduler waits for the lease to expire before it hands the job to another worker. Operators who need the job to move sooner can release the lease by hand from the admin console.";
    const edited = quote.replace(
      "in the run log. ",
      "in the run log. Restarts are rate-limited to five per minute. ",
    );
    const from = `# Notes\n\n${quote}\n\nDone.\n`;
    const to = `# Notes\n\n${edited}\n\nDone.\n`;
    // A sentence inserted into a long passage: only ~14% drift, so the old RATE
    // would have allowed it and only the absolute clamp of 32 refused it. This
    // fixture answers for the CLAMP alone.
    const errors = minErrors(to, quote);
    assert.ok(
      errors > OLD_CLAMP && errors <= Math.round(OLD_RATE * quote.length),
      `fixture drift ${errors} must exceed the old clamp ${OLD_CLAMP} while staying inside the old rate ${Math.round(OLD_RATE * quote.length)}`,
    );

    const resolved = resolveAnchor(bundleFor(from, quote), to);
    assert.equal(resolved.state, "moved");
    assert.ok(
      to
        .slice(resolved.position!.start, resolved.position!.end)
        .includes("rate-limited to five per minute"),
      "the resolved span must be the extended passage",
    );
  });

  test("a deleted short list item orphans instead of taking its neighbour", () => {
    const item = "- Beta line two";
    const list = [
      "## Notes",
      "",
      "- Alpha line one",
      item,
      "- Gamma line three",
      "",
      "- Delta line four",
      "",
    ].join("\n");
    const deleted = list.replace(`${item}\n`, "");
    // A sibling item sits 4 edits away: inside the wide rate (0.35 * 15 = 5) and
    // outside the tight one (0.2 * 15 = 3). Short quotes keep the tight rate
    // precisely so this stays a refusal — a mis-anchor here would silently claim
    // the user commented on another bullet.
    const errors = minErrors(deleted, item);
    assert.equal(errors, 4);
    assert.ok(item.length < 40, "the fixture must be a short quote");

    const resolved = resolveAnchor(bundleFor(list, item), deleted);
    assert.equal(resolved.state, "orphaned");
    assert.equal(resolved.position, undefined);
  });
});

test("offsets are into raw text while comparison is normalized", () => {
  const rawQuote =
    "The scheduler  retries failed jobs\nwith exponential backoff.";
  const rawDoc = `# Notes\n\n\n${rawQuote}\n\nDone.\n`;
  const bundle = bundleFor(rawDoc, rawQuote);

  // Stored selectors keep the original text, whitespace and all.
  assert.equal(bundle.quote.exact, rawQuote);
  assert.ok(bundle.quote.exact.includes("  "));
  assert.ok(bundle.quote.exact.includes("\n"));

  const anchored = resolveAnchor(bundle, rawDoc);
  assert.equal(anchored.state, "anchored");
  assert.deepEqual(anchored.position, {
    start: rawDoc.indexOf(rawQuote),
    end: rawDoc.indexOf(rawQuote) + rawQuote.length,
  });
  // The same offset measured on normalized text would be a different number.
  assert.notEqual(
    normalizeAnchorText(rawDoc).indexOf(normalizeAnchorText(rawQuote)),
    anchored.position!.start,
  );
  assert.deepEqual(anchored.line, { start: 4, end: 5 });

  // Reflowed body: the raw text differs, the normalized text does not.
  const reflowed = rawDoc.replace(rawQuote, normalizeAnchorText(rawQuote));
  const moved = resolveAnchor(bundle, reflowed);
  assert.equal(moved.state, "moved");
  const found = reflowed.slice(moved.position!.start, moved.position!.end);
  assert.notEqual(found, bundle.quote.exact);
  assert.equal(
    normalizeAnchorText(found),
    normalizeAnchorText(bundle.quote.exact),
  );
});

test("the block hint searches inside its own block", () => {
  const blockA = "Reviewed the retry path.\n";
  const blockB = "Reviewed the retry path.\n";
  const doc = `${blockA}${blockB}`;
  const bundle: SelectorBundle = {
    quote: {
      exact: "Reviewed the retry path.",
      prefix: "",
      suffix: "\n",
    },
    position: { start: 999, end: 1023 },
    block: { id: "b2", occurrence: 0 },
  };
  const resolved = resolveAnchor(bundle, doc, {
    blockRanges: new Map([
      ["b1", { start: 0, end: blockA.length }],
      ["b2", { start: blockA.length, end: doc.length }],
    ]),
  });
  assert.equal(resolved.state, "moved");
  assert.deepEqual(resolved.position, {
    start: blockA.length,
    end: blockA.length + bundle.quote.exact.length,
  });
  assert.equal(resolved.confidence, 0.9);
  assert.deepEqual(resolved.line, { start: 2, end: 2 });
});

test("lines are derived 1-based from the resolved position", () => {
  const resolved = resolveAnchor(bundleFor(BASE, HEARTBEAT), BASE);
  assert.equal(resolved.state, "anchored");
  assert.deepEqual(resolved.line, { start: 9, end: 9 });
});

test("resolves a 4,000-line document without quadratic blowup", () => {
  const lines: string[] = [];
  for (let i = 0; i < 4000; i++)
    lines.push(
      i % 7 === 0
        ? `## Section ${i}`
        : `Line ${i}: the supervisor restarts a worker whose heartbeat is late.`,
    );
  const passage = `Line 2001: ${OVERVIEW}`;
  lines[2001] = passage;
  const from = lines.join("\n");
  const bundle = bundleFor(from, passage);
  // Worst case: the stored position is gone AND the quote changed, so the whole
  // ladder runs including the fuzzy step.
  lines.unshift("# Prepended", "");
  lines[2003] = passage.replace("five attempts", "seven attempts");
  const to = lines.join("\n");

  const { value: resolved, cpuMs } = measureCpuMs(() =>
    resolveAnchor(bundle, to),
  );
  assert.equal(resolved.state, "moved");
  // What this guards is algorithmic blowup — a quadratic ladder over 4,000
  // lines costs seconds, not milliseconds — so the bound sits far below
  // "something went badly wrong" rather than close to the ~32ms it takes. It
  // counts CPU time because the gate runs the three package suites at once and
  // a wall clock there measures the runner's spare capacity as much as the
  // ladder (see ../test/cpuBudget.ts).
  assert.ok(
    cpuMs < 500,
    `resolving a 4,000-line document took ${cpuMs.toFixed(1)} ms CPU`,
  );
});

test("an empty quote orphans", () => {
  assert.deepEqual(
    resolveAnchor(
      {
        quote: { exact: "", prefix: "", suffix: "" },
        position: { start: 0, end: 0 },
      },
      BASE,
    ),
    { state: "orphaned", confidence: 0 },
  );
});

test("SUFFIX_LEN and PREFIX_LEN are the shared 32-character contract", () => {
  assert.equal(PREFIX_LEN, 32);
  assert.equal(SUFFIX_LEN, 32);
});
