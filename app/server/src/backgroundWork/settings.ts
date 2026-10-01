/**
 * The "Background processes" settings card, resolved into the exact numbers an
 * admission freezes ([Task-483](pa://task/483)).
 *
 * The card itself is an ordinary `AppSettings` section — validated once, in
 * `normalizeBackgroundWorkSettings` — so this module only converts its
 * user-facing units into the store's milliseconds and stamps the snapshot with
 * a GENERATION.
 *
 * The generation is derived from the values themselves rather than counted:
 * equal settings produce equal generations across restarts, and — because the
 * derivation is INJECTIVE, not a hash — every distinct edit produces a distinct
 * one. That is all a frozen row needs: it records which configuration governed
 * it, and nothing compares two generations for order. Deriving it also removes
 * the read/edit race a counter would have — a snapshot cannot carry one edit's
 * numbers under another edit's generation.
 */
import {
  BACKGROUND_WORK_SETTINGS_RANGES,
  normalizeBackgroundWorkSettings,
  type BackgroundWorkSettings,
} from "@assistant/shared";
import { getSettings } from "../settings.ts";

/** The settings that governed one admission, in the store's units. */
export interface BackgroundWorkSettingsSnapshot {
  enabled: boolean;
  /** Sessions that may own background work at once; the store's `ownerLimit`. */
  ownerSessionCap: number;
  /** Frozen onto the item; its deadline is derived from this at admission. */
  taskLifetimeMs: number;
  /** Frozen onto a retained Claude host epoch when one is created. */
  claudeEmptyHostGraceMs: number;
  generation: number;
}

const RANGE = BACKGROUND_WORK_SETTINGS_RANGES;

/** How many distinct values one field can hold, from its shared range. */
function span(range: { min: number; max: number }): number {
  return range.max - range.min + 1;
}

/**
 * The exact index of this card among all cards the ranges permit: mixed-radix
 * packing, one digit per field, each digit's stride the product of the radices
 * below it.
 *
 * INJECTIVE, which a hash would not be. The whole normalized domain is
 * 2 × 20 × 1436 × 301 = 17,289,440 cards — small enough to number exactly
 * inside the safe-integer column, so paying for a hash's collisions would buy
 * nothing. Two different frozen policies must never share a generation: a row
 * records WHICH configuration governed it, and an alias would silently claim
 * two of them are the same.
 *
 * The input is normalized first, so the function is total: an out-of-range
 * value is clamped into the domain rather than packing into another card's
 * index.
 */
export function backgroundWorkSettingsGeneration(
  settings: BackgroundWorkSettings,
): number {
  const card = normalizeBackgroundWorkSettings(settings);
  const digits: Array<[number, number]> = [
    [card.enabled ? 1 : 0, 2],
    [
      card.ownerSessionCap - RANGE.ownerSessionCap.min,
      span(RANGE.ownerSessionCap),
    ],
    [
      card.taskLifetimeMinutes - RANGE.taskLifetimeMinutes.min,
      span(RANGE.taskLifetimeMinutes),
    ],
    [
      card.claudeEmptyHostGraceSeconds - RANGE.claudeEmptyHostGraceSeconds.min,
      span(RANGE.claudeEmptyHostGraceSeconds),
    ],
  ];
  let generation = 0;
  for (const [digit, radix] of digits) generation = generation * radix + digit;
  return generation;
}

/**
 * How many generations exist at all. Exported so a test can assert the packing
 * is onto exactly that many indices — the other half of injectivity.
 */
export const BACKGROUND_WORK_SETTINGS_GENERATION_COUNT =
  2 *
  span(RANGE.ownerSessionCap) *
  span(RANGE.taskLifetimeMinutes) *
  span(RANGE.claudeEmptyHostGraceSeconds);

/**
 * Read the card once and resolve it. Every admission calls this exactly once,
 * so one admission cannot mix values from two different edits.
 */
export function resolveBackgroundWorkSettings(): BackgroundWorkSettingsSnapshot {
  const settings = normalizeBackgroundWorkSettings(
    getSettings().backgroundWork,
  );
  return {
    enabled: settings.enabled,
    ownerSessionCap: settings.ownerSessionCap,
    taskLifetimeMs: settings.taskLifetimeMinutes * 60_000,
    claudeEmptyHostGraceMs: settings.claudeEmptyHostGraceSeconds * 1_000,
    generation: backgroundWorkSettingsGeneration(settings),
  };
}
