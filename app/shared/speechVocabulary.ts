/**
 * Post-decode jargon repair for dictated transcripts.
 *
 * Decoder-level hotword biasing is not available for the shipped Parakeet model:
 * `--hotwords-file` requires `--modeling-unit=bpe`, which requires a
 * `--bpe-vocab` the model archive does not include (with the default modeling
 * unit the flag is accepted and output is byte-identical). So domain words like
 * "Forgejo" or "Acme" are fixed here instead, from a user-editable list.
 *
 * Deliberately literal: whole-word, case-insensitive matching with no fuzzy
 * scoring, so a rule can never mangle unrelated text. The refine wand remains
 * the smarter option when context is needed.
 *
 * This lives in the shared package rather than the server so the Settings
 * editor's live preview runs the EXACT rules the server will apply — a
 * reimplementation would silently drift and make the preview a liar.
 */
import type { SpeechVocabularyEntry } from "./protocol.ts";

/** Bound the rule set so a pathological settings file cannot stall a transcript. */
const MAX_RULES = 200;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pattern source for one phrase. `\b` does not fire next to a non-word
 * character, so anchor on word boundaries only where the phrase actually starts
 * or ends with a word character — otherwise a rule like `c++` could never match.
 * Internal whitespace is flexible, since a recognizer may emit more of it.
 */
function phraseSource(from: string): string {
  const escaped = escapeRegExp(from).replace(/\s+/g, "\\s+");
  const prefix = /^\w/.test(from) ? "\\b" : "";
  const suffix = /\w$/.test(from) ? "\\b" : "";
  return `${prefix}${escaped}${suffix}`;
}

/**
 * Apply every rule in ONE pass over the text.
 *
 * Applying rules sequentially would let a later rule rewrite text an earlier one
 * just produced — `sherpa onyx → sherpa-onnx` followed by `sherpa → Sherpa`
 * would yield "Sherpa-onnx". A single pass means output is never re-matched.
 * Longer phrases are tried first so a multi-word rule beats an overlapping
 * single-word one.
 */
export function applySpeechVocabulary(
  text: string,
  vocabulary: SpeechVocabularyEntry[],
): string {
  if (!text) return text;
  const rules = vocabulary
    .map((entry) => ({ from: entry.from.trim(), to: entry.to }))
    .filter((entry) => entry.from.length > 0)
    .slice(0, MAX_RULES)
    .sort((a, b) => b.from.length - a.from.length);
  if (rules.length === 0) return text;

  const combined = new RegExp(
    rules.map((rule) => phraseSource(rule.from)).join("|"),
    "gi",
  );
  // Each alternative carries its own boundaries, so identify the winning rule by
  // re-testing the matched text in the same longest-first order.
  const matchers = rules.map((rule) => ({
    to: rule.to,
    test: new RegExp(`^(?:${phraseSource(rule.from)})$`, "i"),
  }));

  return text.replace(
    combined,
    (match) =>
      matchers.find((matcher) => matcher.test.test(match))?.to ?? match,
  );
}
