/**
 * Pure, dependency-free validation/normalization for the memory system.
 *
 * Shared so the lifecycle service, agent tools, management API, and Settings
 * normalization all reject the same invalid shapes with the same rules — model
 * output proposes, deterministic code (this module) validates. Runtime-light and
 * safe in both Node and the browser.
 */
import {
  MEMORY_KINDS,
  MEMORY_TEMPORAL_MODES,
  MEMORY_TEXT_MAX_CHARS,
  MEMORY_TEXT_MIN_CHARS,
  type MemoryKind,
  type MemoryRecurrence,
  type MemoryScope,
  type MemoryTemporal,
  type MemoryTemporalMode,
} from "./memory.ts";
import type { SessionAgentType } from "./protocol.ts";

/** A validation failure with a machine-usable field path and message. */
export interface MemoryValidationError {
  field: string;
  message: string;
}

export type MemoryValidationResult<T> =
  { ok: true; value: T } | { ok: false; error: MemoryValidationError };

function fail<T>(field: string, message: string): MemoryValidationResult<T> {
  return { ok: false, error: { field, message } };
}

/** Whether a string is a valid IANA timezone (uses Intl, available in Node + browsers). */
export function isValidIanaTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.trim() === "") return false;
  try {
    // Throws RangeError for an unknown/invalid zone.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Collapse whitespace and trim; memory text is a single concise line/paragraph. */
export function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Heuristic secret-like detector. Rejects obvious credentials so untrusted or
 * careless input never becomes durable memory. Intentionally conservative — it
 * flags high-entropy token shapes and explicit secret labels, not ordinary prose.
 */
export function looksSecretLike(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Common credential prefixes/shapes.
  if (/\b(sk|pk|ghp|gho|ghs|xox[baprs]|AKIA|ASIA)[-_][A-Za-z0-9]{8,}/.test(t))
    return true;
  if (
    /\b(api[_-]?key|secret|password|passwd|token|bearer|private[_-]?key)\b\s*[:=]\s*\S{6,}/i.test(
      t,
    )
  )
    return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) return true;
  // A long unbroken high-entropy run with no spaces (opaque token).
  if (/[A-Za-z0-9+/=_-]{40,}/.test(t) && !/\s/.test(t)) return true;
  return false;
}

/** Validate memory card text: non-empty, within bounds, not secret-like. */
export function validateMemoryText(
  raw: unknown,
): MemoryValidationResult<string> {
  if (typeof raw !== "string") return fail("text", "text must be a string");
  const text = normalizeMemoryText(raw);
  if (text.length < MEMORY_TEXT_MIN_CHARS)
    return fail(
      "text",
      `text must be at least ${MEMORY_TEXT_MIN_CHARS} characters`,
    );
  if (text.length > MEMORY_TEXT_MAX_CHARS)
    return fail(
      "text",
      `text must be at most ${MEMORY_TEXT_MAX_CHARS} characters`,
    );
  if (looksSecretLike(text))
    return fail(
      "text",
      "text looks like a secret/credential and cannot be stored",
    );
  return { ok: true, value: text };
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return (
    typeof value === "string" &&
    (MEMORY_KINDS as readonly string[]).includes(value)
  );
}

function isMemoryTemporalMode(value: unknown): value is MemoryTemporalMode {
  return (
    typeof value === "string" &&
    (MEMORY_TEMPORAL_MODES as readonly string[]).includes(value)
  );
}

/** Validate a scope: optional non-empty projectId and a known persona key. */
export function validateMemoryScope(
  raw: unknown,
): MemoryValidationResult<MemoryScope> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object") return fail("scope", "scope must be an object");
  const input = raw as Record<string, unknown>;
  const scope: MemoryScope = {};
  if (input.projectId !== undefined && input.projectId !== null) {
    if (typeof input.projectId !== "string" || input.projectId.trim() === "")
      return fail("scope.projectId", "projectId must be a non-empty string");
    scope.projectId = input.projectId.trim();
  }
  if (input.persona !== undefined && input.persona !== null) {
    const persona = input.persona;
    if (
      persona !== "assistant" &&
      persona !== "workshop" &&
      persona !== "developer" &&
      persona !== "personal-assistant"
    ) {
      return fail("scope.persona", "persona must be a known persona key");
    }
    scope.persona = persona as SessionAgentType;
  }
  return { ok: true, value: scope };
}

function validateRecurrence(
  raw: unknown,
): MemoryValidationResult<MemoryRecurrence> {
  if (typeof raw !== "object" || raw === null)
    return fail("temporal.recurrence", "recurrence must be an object");
  const input = raw as Record<string, unknown>;
  if (input.kind !== "weekly")
    return fail("temporal.recurrence.kind", "recurrence.kind must be 'weekly'");
  if (!Array.isArray(input.weekdays) || input.weekdays.length === 0)
    return fail(
      "temporal.recurrence.weekdays",
      "weekdays must be a non-empty array",
    );
  const weekdays: number[] = [];
  for (const d of input.weekdays) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6)
      return fail(
        "temporal.recurrence.weekdays",
        "each weekday must be an integer 0-6",
      );
    if (!weekdays.includes(d)) weekdays.push(d);
  }
  weekdays.sort((a, b) => a - b);
  return { ok: true, value: { kind: "weekly", weekdays } };
}

/**
 * Validate a temporal specification for internal storage. Rejects ambiguous or
 * inconsistent shapes rather than guessing (per-mode required fields, ordered
 * window, valid IANA timezone, valid recurrence).
 */
export function validateMemoryTemporal(
  raw: unknown,
): MemoryValidationResult<MemoryTemporal> {
  if (raw === undefined || raw === null)
    return { ok: true, value: { mode: "persistent" } };
  if (typeof raw !== "object")
    return fail("temporal", "temporal must be an object");
  const input = raw as Record<string, unknown>;
  if (!isMemoryTemporalMode(input.mode))
    return fail("temporal.mode", "mode must be a known temporal mode");
  const mode = input.mode;

  const out: MemoryTemporal = { mode };

  if (input.timezone !== undefined && input.timezone !== null) {
    if (!isValidIanaTimeZone(input.timezone))
      return fail(
        "temporal.timezone",
        "timezone must be a valid IANA timezone",
      );
    out.timezone = input.timezone;
  }

  const from = input.validFromMs;
  const until = input.validUntilMs;
  const hasFrom = from !== undefined && from !== null;
  const hasUntil = until !== undefined && until !== null;
  if (hasFrom && (typeof from !== "number" || !Number.isFinite(from)))
    return fail("temporal.validFromMs", "validFromMs must be a finite number");
  if (hasUntil && (typeof until !== "number" || !Number.isFinite(until)))
    return fail(
      "temporal.validUntilMs",
      "validUntilMs must be a finite number",
    );
  if (hasFrom) out.validFromMs = from as number;
  if (hasUntil) out.validUntilMs = until as number;
  if (hasFrom && hasUntil && (until as number) < (from as number))
    return fail("temporal.validUntilMs", "validUntilMs must be >= validFromMs");

  switch (mode) {
    case "persistent":
    case "until-changed":
      // No window required; a window is allowed but not required.
      break;
    case "window":
      if (!hasFrom && !hasUntil)
        return fail(
          "temporal",
          "window mode requires validFromMs and/or validUntilMs",
        );
      break;
    case "recurring": {
      const rec = validateRecurrence(input.recurrence);
      if (!rec.ok) return rec as MemoryValidationResult<MemoryTemporal>;
      out.recurrence = rec.value;
      break;
    }
  }
  return { ok: true, value: out };
}

/** Clamp an integer setting to [min, max], defaulting when non-finite. */
export function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(value)
      : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Clamp a positive number setting to [min, max], defaulting when non-finite. */
export function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}
