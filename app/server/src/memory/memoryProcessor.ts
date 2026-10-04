/**
 * The bounded, no-tool automatic memory processor (Task 91). It turns pending
 * observations into safe lifecycle operations with a configurable cheap model —
 * NO review queue, NO tools. Model output proposes structured operations;
 * deterministic code here validates and applies them through the lifecycle
 * service.
 *
 * Global ceilings (calls/hour + reported cost/day across ALL sessions/modes) are
 * enforced atomically BEFORE any model call and can never be bypassed by a mode,
 * high-signal trigger, retry, or maintenance. Per-run operation/char/timeout
 * bounds apply on top. A processor failure never alters a user response and
 * leaves observations retryable within bounded attempts.
 */
import { createHash } from "node:crypto";
import { CLAUDE_SDK_PROVIDER, isValidIanaTimeZone } from "@assistant/shared";
import { addLocalDays } from "@assistant/shared/zonedTime";
import type {
  MemoryCard,
  MemoryKind,
  MemoryScope,
  MemoryTemporal,
} from "@assistant/shared";
import { getSettings } from "../settings.ts";
import {
  memoryObservationStore,
  type MemoryObservation,
} from "../db/memoryObservationStore.ts";
import { memoryProcessorStore } from "../db/memoryProcessorStore.ts";
import { memoryStore } from "../db/memoryStore.ts";
import {
  archiveMemory,
  createMemory,
  reinforceMemory,
  resolveSessionScope,
  scopeMatches,
  supersedeMemory,
  withOperationIdempotency,
  type MemoryScopeContext,
} from "./memoryService.ts";
import { searchMemory } from "./memorySelector.ts";
import { findModelForProfile } from "../piSdk/models.ts";
import { runOneShot } from "../harnesses/oneShot.ts";
import { accountForSlot } from "../settingsModelSlots.ts";

/* -------------------------------- bounds --------------------------------- */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_OPERATIONS = 10;
const MAX_INPUT_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 45_000;
const SIMILAR_MEMORIES = 5;
const OBSERVATION_TEXT_CAP = 800;

/* -------------------------------- runner --------------------------------- */

interface MemoryProcessorRunInput {
  provider: string;
  modelId: string;
  /** Provider account the processor authenticates as (resolved from its settings pin). */
  credentialProfileId: string;
  thinkingLevel: import("@assistant/shared").ThinkingLevel;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
}
interface MemoryProcessorRunOutput {
  text: string;
  /** Reported cost in micro-USD, when the provider prices it. Undefined = unknown. */
  costMicrosUsd?: number;
}
export interface MemoryProcessorRunner {
  run(input: MemoryProcessorRunInput): Promise<MemoryProcessorRunOutput>;
}

const realRunner: MemoryProcessorRunner = {
  async run(input) {
    // Exact configured model only (no silent fallback); processorConfigStatus
    // gates the run so a missing model rarely throws. Claude reports no
    // per-call cost.
    const { text, usage } = await runOneShot({
      model: { provider: input.provider, modelId: input.modelId },
      thinkingLevel: input.thinkingLevel,
      credentialProfileId: input.credentialProfileId,
      modelFallback: "none",
      noModelMessage: `The configured memory processor model (${input.provider}/${input.modelId}) is not available.`,
      systemPrompt: input.systemPrompt,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs,
      timeoutMessage: "Memory processor timed out.",
    });
    const cost = usage.costUSD;
    return {
      text,
      ...(cost !== undefined && cost > 0
        ? { costMicrosUsd: Math.round(cost * 1_000_000) }
        : {}),
    };
  },
};

let runner: MemoryProcessorRunner = realRunner;
export function setMemoryProcessorRunnerForTests(
  r: MemoryProcessorRunner,
): void {
  runner = r;
}
export function resetMemoryProcessorRunnerForTests(): void {
  runner = realRunner;
}

let clock: () => number = () => Date.now();
export function setMemoryProcessorClockForTests(now: () => number): void {
  clock = now;
}
export function resetMemoryProcessorClockForTests(): void {
  clock = () => Date.now();
}

/* ------------------------------- budgeting ------------------------------- */

type BudgetReason = "rate" | "cost" | null;

/**
 * Atomically decide whether a processor call is allowed under the GLOBAL
 * ceilings and, if so, reserve a slot. Because node:sqlite is synchronous, the
 * check + insert here cannot interleave with another reservation in-process.
 * Returns the reserved run id, or null with the exhausted-ceiling reason.
 */
function tryReserveProcessorCall(
  nowMs: number,
  trigger: string,
): { runId: number } | { runId: null; reason: BudgetReason } {
  const settings = getSettings().memory;
  const calls = memoryProcessorStore.callsSince(nowMs - HOUR_MS);
  if (calls >= settings.maxCallsPerHour) return { runId: null, reason: "rate" };
  const costMicros = memoryProcessorStore.costMicrosSince(nowMs - DAY_MS);
  if (costMicros >= settings.maxCostPerDayUsd * 1_000_000)
    return { runId: null, reason: "cost" };
  return { runId: memoryProcessorStore.reserve(nowMs, trigger) };
}

/* ------------------------- processor config status ----------------------- */

export interface ProcessorConfigStatus {
  configured: boolean;
  /** User-actionable message when not configured. */
  message?: string;
}

/**
 * Whether the configured processor model can actually run, WITHOUT calling it.
 * Surfaced to Settings/API so an unconfigured/invalid model is actionable rather
 * than silently burning observation retries.
 */
export async function processorConfigStatus(): Promise<ProcessorConfigStatus> {
  const { processor } = getSettings().memory;
  if (processor.provider === CLAUDE_SDK_PROVIDER) {
    if (!getSettings().claudeSdk.enabled)
      return {
        configured: false,
        message:
          "The memory processor is set to Claude SDK, but the Claude SDK integration is disabled.",
      };
    return { configured: true };
  }
  // Validate the EXACT configured provider/model — never a silent fallback to a
  // different model, which would run something other than what was configured.
  // Availability is per account, so this checks the account the slot resolves to.
  if (
    !(await findModelForProfile(
      accountForSlot(processor),
      processor.provider,
      processor.modelId,
    ))
  ) {
    return {
      configured: false,
      message: `The configured memory processor model (${processor.provider}/${processor.modelId}) is not available. Pick an available model in Memory settings.`,
    };
  }
  return { configured: true };
}

/* ---------------------------- operation shape ---------------------------- */

interface ProcessorTemporal {
  mode: MemoryTemporal["mode"];
  /** Days relative to the source observation timestamp (deterministic normalization). */
  relativeFromDays?: number;
  relativeUntilDays?: number;
  timezone?: string;
  recurrence?: MemoryTemporal["recurrence"];
}
interface ProcessorOperation {
  action: "create" | "reinforce" | "replace" | "archive" | "ignore";
  observationIndex?: number;
  text?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  temporal?: ProcessorTemporal;
  targetId?: string;
  confidence?: "high" | "low";
  evidence?: "explicit" | "inferred";
  reason?: string;
}

interface AppliedOperation {
  action: ProcessorOperation["action"];
  ok: boolean;
  cardId?: string;
  rejected?: string;
}

export interface ProcessorOutcome {
  ran: boolean;
  reason?:
    | "no-input"
    | "budget-rate"
    | "budget-cost"
    | "error"
    | "parse-error"
    | "unconfigured";
  operationsApplied: number;
  operations: AppliedOperation[];
  costMicrosUsd?: number;
  error?: string;
}

/* -------------------------------- prompt --------------------------------- */

const SYSTEM_PROMPT = [
  "You maintain a small long-term memory for a personal assistant. You will receive recent observations (human turns) and a few existing memories.",
  'Return STRICT JSON only, no prose: {"operations":[...]}. Each operation is one of:',
  '- {"action":"create","observationIndex":N,"text":"...","kind":"preference|fact|constraint|working","scope":{"projectId"?,"persona"?},"temporal"?:{"mode":"persistent|window|until-changed|recurring","relativeFromDays"?,"relativeUntilDays"?,"timezone"?,"recurrence"?:{"kind":"weekly","weekdays":[0-6]}},"confidence":"high|low","evidence":"explicit|inferred","reason":"..."}',
  '- {"action":"reinforce","targetId":"<existing id>","reason":"..."}',
  '- {"action":"replace","targetId":"<existing id>","text":"...","kind":"...","reason":"..."}',
  '- {"action":"archive","targetId":"<existing id>","reason":"..."}',
  '- {"action":"ignore","reason":"..."}',
  "Rules: only store durable, reusable preferences/facts/constraints/near-term working state. NEVER store secrets, credentials, raw tool output, or ephemeral chatter. Use relativeFromDays/relativeUntilDays for time windows (0 = the observation day). Prefer replace over a contradictory duplicate. Use targetId only for an id shown in the existing memories. If nothing is worth storing, return an empty operations array.",
].join("\n");

function isoInZone(ms: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/** The applicable scope context for an observation (its persona + project). */
function observationScope(obs: MemoryObservation): MemoryScopeContext {
  return resolveSessionScope({
    persona: (obs.persona as MemoryScopeContext["persona"]) ?? "assistant",
    ...(obs.projectId !== undefined ? { projectId: obs.projectId } : {}),
  });
}

function buildPrompt(observations: MemoryObservation[]): {
  prompt: string;
  shownByObs: Map<number, Set<string>>;
} {
  const lines: string[] = ["Observations:"];
  observations.forEach((obs, i) => {
    const when = isoInZone(obs.sourceTimestampMs, obs.timezone);
    const scope = [
      obs.persona ? `persona=${obs.persona}` : "",
      obs.projectId ? `project=${obs.projectId}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const assistant = obs.assistantText
      ? `\n    assistant: ${obs.assistantText.slice(0, OBSERVATION_TEXT_CAP)}`
      : "";
    lines.push(
      `[${i}] (${when}, ${obs.timezone}${scope ? ", " + scope : ""}) ${obs.humanText.slice(0, OBSERVATION_TEXT_CAP)}${assistant}`,
    );
  });
  // A few similar existing memories, restricted to each observation's applicable
  // scope so the processor prompt never sees cross-project/persona memories. Track
  // which ids were surfaced for WHICH observation so evidence anchoring holds — an
  // op anchored to observation A may only target ids shown for A.
  const candidatesByObs = new Map<number, string[]>();
  const similar: string[] = [];
  const seen = new Set<string>();
  const cards = memoryStore.list({ states: ["active"], limit: 5_000 });
  observations.forEach((obs, i) => {
    const ctx = observationScope(obs);
    const inScope = cards.filter((c) => scopeMatches(c.scope, ctx));
    const forObs: string[] = [];
    for (const hit of searchMemory(obs.humanText, inScope, {
      context: ctx,
      limit: SIMILAR_MEMORIES,
    })) {
      forObs.push(hit.id);
      if (!seen.has(hit.id)) {
        seen.add(hit.id);
        similar.push(`[${hit.id}@${hit.revision}] (${hit.kind}) ${hit.text}`);
      }
    }
    candidatesByObs.set(i, forObs);
  });
  if (similar.length) {
    lines.push(
      "",
      "Existing memories (only these ids may be reinforced/replaced/archived):",
    );
    lines.push(...similar.slice(0, 20));
  }
  const joined = lines.join("\n");
  const prompt =
    joined.length > MAX_INPUT_CHARS ? joined.slice(0, MAX_INPUT_CHARS) : joined;
  // Per observation, the allowlist is exactly the ids surfaced for THAT observation
  // whose `[id@` marker survived slicing + truncation into the final prompt.
  const shownByObs = new Map<number, Set<string>>();
  for (const [i, ids] of candidatesByObs) {
    shownByObs.set(i, new Set(ids.filter((id) => prompt.includes(`[${id}@`))));
  }
  return { prompt, shownByObs };
}

/* ------------------------------ application ------------------------------ */

function resolveTemporal(
  op: ProcessorOperation,
  obs: MemoryObservation,
): MemoryTemporal | undefined {
  if (!op.temporal) return undefined;
  const t = op.temporal;
  const tz = t.timezone ?? obs.timezone;
  const base = obs.sourceTimestampMs;
  const temporal: MemoryTemporal = { mode: t.mode };
  if (typeof t.relativeFromDays === "number")
    temporal.validFromMs = addLocalDays(base, t.relativeFromDays, tz);
  if (typeof t.relativeUntilDays === "number")
    temporal.validUntilMs = addLocalDays(base, t.relativeUntilDays, tz);
  temporal.timezone = tz;
  if (t.recurrence) temporal.recurrence = t.recurrence;
  return temporal;
}

/** Stable content hash of a create op, so identical content maps to one idempotency key. */
function opContentHash(op: ProcessorOperation): string {
  const norm = JSON.stringify({
    text: (op.text ?? "").trim().toLowerCase(),
    kind: op.kind ?? "",
  });
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

function applyOperation(
  op: ProcessorOperation,
  observations: MemoryObservation[],
  shownByObs: Map<number, Set<string>>,
): AppliedOperation {
  // Every operation is anchored to a valid observation (its scope + source time).
  const index = op.observationIndex ?? 0;
  const obs = observations[index];
  if (!obs)
    return {
      action: op.action,
      ok: false,
      rejected: "invalid observationIndex",
    };
  const ctx = observationScope(obs);
  // A target must be one of the ids shown FOR THIS observation (evidence anchoring
  // — never one shown only for a different observation), and in scope.
  const shown = shownByObs.get(index) ?? new Set<string>();
  const targetOk = (id: string | undefined): boolean =>
    Boolean(id && shown.has(id));
  const provenance = {
    sourceKind: "processor" as const,
    sessionId: obs.sessionId,
    messageId: obs.userTurnId,
  };
  // Scope is DERIVED from the observation, never from model output — the model
  // cannot escalate a card to global or another project/persona.
  const personaValue = obs.persona as NonNullable<MemoryScope["persona"]>;
  const derivedScope: MemoryScope = {
    ...(obs.persona ? { persona: personaValue } : {}),
    ...(obs.projectId ? { projectId: obs.projectId } : {}),
  };

  switch (op.action) {
    case "ignore":
      return { action: "ignore", ok: true };
    case "create": {
      if (!op.text || !op.kind)
        return { action: "create", ok: false, rejected: "missing text/kind" };
      // Idempotency keyed by the observation id + operation content, so a rerun of
      // the same observation (e.g. after a crash-recovery re-claim) never
      // double-creates; a later independent observation still applies.
      const opKey = `proc:${obs.id}:create:${opContentHash(op)}`;
      const result = withOperationIdempotency(opKey, () => {
        const temporalValue = resolveTemporal(op, obs);
        return createMemory({
          text: op.text!,
          kind: op.kind!,
          scope: derivedScope,
          ...(temporalValue !== undefined ? { temporal: temporalValue } : {}),
          ...(op.reason !== undefined ? { reason: op.reason } : {}),
          provenance,
          observedAtMs: obs.sourceTimestampMs,
        });
      });
      return result.ok
        ? { action: "create", ok: true, cardId: result.card.id }
        : {
            action: "create",
            ok: false,
            rejected:
              result.reason === "invalid"
                ? `${result.error.field}: ${result.error.message}`
                : result.reason,
          };
    }
    case "reinforce": {
      const target = targetOk(op.targetId)
        ? memoryStore.get(op.targetId!)
        : undefined;
      if (!target || !scopeMatches(target.scope, ctx))
        return {
          action: "reinforce",
          ok: false,
          rejected: "unknown or out-of-scope target",
        };
      const opKey = `proc:${obs.id}:reinforce:${target.id}`;
      const result = withOperationIdempotency(opKey, () =>
        reinforceMemory(target.id, op.reason),
      );
      return result.ok
        ? { action: "reinforce", ok: true, cardId: target.id }
        : { action: "reinforce", ok: false, rejected: result.reason };
    }
    case "archive": {
      const target = targetOk(op.targetId)
        ? memoryStore.get(op.targetId!)
        : undefined;
      if (!target || !scopeMatches(target.scope, ctx))
        return {
          action: "archive",
          ok: false,
          rejected: "unknown or out-of-scope target",
        };
      const result = withOperationIdempotency(
        `proc:${obs.id}:archive:${target.id}`,
        () => archiveMemory(target.id, target.revision, op.reason),
      );
      return result.ok
        ? { action: "archive", ok: true, cardId: target.id }
        : { action: "archive", ok: false, rejected: result.reason };
    }
    case "replace": {
      const target = targetOk(op.targetId)
        ? memoryStore.get(op.targetId!)
        : undefined;
      // A contradictory operation without a valid, shown, in-scope target is rejected — never turned into a duplicate.
      if (!target || !scopeMatches(target.scope, ctx))
        return {
          action: "replace",
          ok: false,
          rejected: "unknown or out-of-scope target",
        };
      if (!op.text)
        return { action: "replace", ok: false, rejected: "missing text" };
      // Correction inherits the target's kind/scope/temporal unless the op sets them;
      // scope stays the target's (in-scope) scope — no escalation. Idempotent on rerun.
      const temporalOpt = resolveTemporal(op, obs);
      const result = supersedeMemory(
        target.id,
        target.revision,
        {
          text: op.text,
          ...(op.kind ? { kind: op.kind } : {}),
          ...(op.temporal
            ? {
                ...(temporalOpt !== undefined ? { temporal: temporalOpt } : {}),
              }
            : {}),
          ...(op.reason !== undefined ? { reason: op.reason } : {}),
          provenance,
          observedAtMs: obs.sourceTimestampMs,
        },
        `proc:${obs.id}:replace:${target.id}`,
      );
      return result.ok
        ? { action: "replace", ok: true, cardId: result.replacement.id }
        : {
            action: "replace",
            ok: false,
            rejected:
              result.reason === "invalid"
                ? `${result.error.field}: ${result.error.message}`
                : result.reason,
          };
    }
    default:
      return { action: op.action, ok: false, rejected: "unknown action" };
  }
}

const OP_KEYS = new Set([
  "action",
  "observationIndex",
  "text",
  "kind",
  "scope",
  "temporal",
  "targetId",
  "confidence",
  "evidence",
  "reason",
]);
const KIND_VALUES = new Set(["preference", "fact", "constraint", "working"]);
const PERSONA_VALUES = new Set([
  "assistant",
  "personal-assistant",
  "developer",
  "workshop",
]);
const TEMPORAL_MODES = new Set([
  "persistent",
  "window",
  "until-changed",
  "recurring",
]);
const MAX_RELATIVE_DAYS = 3650;
const REASON_MAX = 300;

function isStr(v: unknown): v is string {
  return typeof v === "string";
}
function isBoundedInt(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= max;
}

/** Validate one operation's structure/enums/bounds deterministically. Returns null if invalid. */
function validateOperation(raw: unknown): ProcessorOperation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!OP_KEYS.has(key)) return null; // reject unknown keys
  const action = r.action;
  if (
    action !== "create" &&
    action !== "reinforce" &&
    action !== "replace" &&
    action !== "archive" &&
    action !== "ignore"
  )
    return null;
  if (
    r.observationIndex !== undefined &&
    !isBoundedInt(r.observationIndex, 1000)
  )
    return null;
  if (r.text !== undefined && !isStr(r.text)) return null;
  if (
    r.targetId !== undefined &&
    (!isStr(r.targetId) || r.targetId.length === 0)
  )
    return null;
  if (
    r.reason !== undefined &&
    (!isStr(r.reason) || r.reason.length > REASON_MAX)
  )
    return null;
  if (r.kind !== undefined && !(isStr(r.kind) && KIND_VALUES.has(r.kind)))
    return null;
  if (
    r.confidence !== undefined &&
    r.confidence !== "high" &&
    r.confidence !== "low"
  )
    return null;
  if (
    r.evidence !== undefined &&
    r.evidence !== "explicit" &&
    r.evidence !== "inferred"
  )
    return null;
  if (r.scope !== undefined) {
    if (typeof r.scope !== "object" || r.scope === null) return null;
    const s = r.scope as Record<string, unknown>;
    for (const key of Object.keys(s))
      if (key !== "projectId" && key !== "persona") return null;
    if (
      s.projectId !== undefined &&
      (!isStr(s.projectId) || s.projectId.length === 0)
    )
      return null;
    if (
      s.persona !== undefined &&
      !(isStr(s.persona) && PERSONA_VALUES.has(s.persona))
    )
      return null;
  }
  if (r.temporal !== undefined) {
    if (typeof r.temporal !== "object" || r.temporal === null) return null;
    const t = r.temporal as Record<string, unknown>;
    for (const key of Object.keys(t))
      if (
        ![
          "mode",
          "relativeFromDays",
          "relativeUntilDays",
          "timezone",
          "recurrence",
        ].includes(key)
      )
        return null;
    if (!isStr(t.mode) || !TEMPORAL_MODES.has(t.mode)) return null;
    if (
      t.relativeFromDays !== undefined &&
      !isBoundedInt(t.relativeFromDays, MAX_RELATIVE_DAYS)
    )
      return null;
    if (
      t.relativeUntilDays !== undefined &&
      !isBoundedInt(t.relativeUntilDays, MAX_RELATIVE_DAYS)
    )
      return null;
    if (
      t.timezone !== undefined &&
      !(isStr(t.timezone) && isValidIanaTimeZone(t.timezone))
    )
      return null;
    if (t.recurrence !== undefined) {
      if (typeof t.recurrence !== "object" || t.recurrence === null)
        return null;
      const rec = t.recurrence as Record<string, unknown>;
      if (
        rec.kind !== "weekly" ||
        !Array.isArray(rec.weekdays) ||
        rec.weekdays.length === 0
      )
        return null;
      if (!rec.weekdays.every((d) => isBoundedInt(d, 6) && (d as number) >= 0))
        return null;
    }
  }
  // Action-specific required fields.
  if (
    action === "create" &&
    !(isStr(r.text) && r.text.trim().length > 0 && isStr(r.kind))
  )
    return null;
  if ((action === "reinforce" || action === "archive") && !isStr(r.targetId))
    return null;
  if (
    action === "replace" &&
    !(isStr(r.targetId) && isStr(r.text) && r.text.trim().length > 0)
  )
    return null;
  return raw as ProcessorOperation;
}

/** Parse + validate the model output. Returns null on any structural problem. */
function parseOperations(text: string): ProcessorOperation[] | null {
  if (text.length > MAX_OUTPUT_CHARS) return null;
  // Tolerate a fenced code block around the JSON.
  const cleaned = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  for (const key of Object.keys(parsed as Record<string, unknown>))
    if (key !== "operations") return null;
  const ops = (parsed as { operations?: unknown }).operations;
  if (!Array.isArray(ops)) return null;
  if (ops.length > MAX_OPERATIONS) return null;
  const out: ProcessorOperation[] = [];
  for (const raw of ops) {
    const op = validateOperation(raw);
    if (!op) return null;
    out.push(op);
  }
  return out;
}

/** Test-only accessor for the strict structured-output parser. */
export function __parseOperationsForTests(
  text: string,
): ProcessorOperation[] | null {
  return parseOperations(text);
}

/* --------------------------------- run ----------------------------------- */

export interface RunProcessorOptions {
  trigger: string;
}

/**
 * Process a batch of already-claimed observations. Enforces the global ceilings,
 * runs the configured cheap model once, validates + applies operations, marks
 * observation outcomes, and reconciles the usage ledger. Never throws.
 */
export async function runMemoryProcessor(
  observations: MemoryObservation[],
  opts: RunProcessorOptions,
): Promise<ProcessorOutcome> {
  if (observations.length === 0)
    return {
      ran: false,
      reason: "no-input",
      operationsApplied: 0,
      operations: [],
    };
  const settings = getSettings().memory;
  const nowMs = clock();

  // Unconfigured/invalid processor model: defer (release) rather than burning
  // bounded retries against a model that can never run. (A test-injected runner is
  // always considered configured — it IS the model.)
  if (runner === realRunner && !(await processorConfigStatus()).configured) {
    for (const obs of observations) memoryObservationStore.release(obs.id);
    return {
      ran: false,
      reason: "unconfigured",
      operationsApplied: 0,
      operations: [],
    };
  }

  const reservation = tryReserveProcessorCall(nowMs, opts.trigger);
  if (reservation.runId === null) {
    // Defer: return the claimed observations to pending for a later window.
    for (const obs of observations) memoryObservationStore.release(obs.id);
    return {
      ran: false,
      reason: reservation.reason === "cost" ? "budget-cost" : "budget-rate",
      operationsApplied: 0,
      operations: [],
    };
  }
  const runId = reservation.runId;
  const { prompt, shownByObs } = buildPrompt(observations);

  let output: MemoryProcessorRunOutput;
  try {
    output = await runner.run({
      provider: settings.processor.provider,
      modelId: settings.processor.modelId,
      credentialProfileId: accountForSlot(settings.processor),
      thinkingLevel: settings.processor.thinkingLevel,
      systemPrompt: SYSTEM_PROMPT,
      prompt,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    memoryProcessorStore.reconcile(runId, "error", clock());
    // Recoverable: release for a bounded retry, else give up on this batch.
    for (const obs of observations) {
      if (obs.attempts >= MAX_ATTEMPTS)
        memoryObservationStore.mark(
          obs.id,
          "failed",
          clock(),
          String(err instanceof Error ? err.message : err),
        );
      else memoryObservationStore.release(obs.id);
    }
    return {
      ran: true,
      reason: "error",
      operationsApplied: 0,
      operations: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const operations = parseOperations(output.text);
  if (operations === null) {
    memoryProcessorStore.reconcile(runId, "error", clock(), {
      ...(output.costMicrosUsd !== undefined
        ? { costMicrosUsd: output.costMicrosUsd }
        : {}),
    });
    for (const obs of observations) {
      if (obs.attempts >= MAX_ATTEMPTS)
        memoryObservationStore.mark(
          obs.id,
          "failed",
          clock(),
          "unparseable processor output",
        );
      else memoryObservationStore.release(obs.id);
    }
    return {
      ran: true,
      reason: "parse-error",
      operationsApplied: 0,
      operations: [],
      ...(output.costMicrosUsd !== undefined
        ? { costMicrosUsd: output.costMicrosUsd }
        : {}),
    };
  }

  const applied: AppliedOperation[] = operations.map((op) =>
    applyOperation(op, observations, shownByObs),
  );
  const appliedCount = applied.filter(
    (a) => a.ok && a.action !== "ignore",
  ).length;
  memoryProcessorStore.reconcile(runId, "success", clock(), {
    operationsApplied: appliedCount,
    ...(output.costMicrosUsd !== undefined
      ? { costMicrosUsd: output.costMicrosUsd }
      : {}),
  });

  // The batch was processed regardless of how many ops applied; scrub retained text.
  for (const obs of observations) {
    memoryObservationStore.mark(obs.id, "processed", clock());
    memoryObservationStore.scrubProcessed(obs.id);
  }

  return {
    ran: true,
    operationsApplied: appliedCount,
    operations: applied,
    ...(output.costMicrosUsd !== undefined
      ? { costMicrosUsd: output.costMicrosUsd }
      : {}),
  };
}

/* ----------------------------- consolidation ----------------------------- */

const CONSOLIDATION_SYSTEM_PROMPT = [
  "You consolidate an existing long-term memory. You will receive a bounded list of active memories.",
  'Return STRICT JSON only: {"operations":[...]}. You may ONLY use these actions, and only with a targetId shown in the list:',
  '- {"action":"reinforce","targetId":"<id>","reason":"..."} — the canonical card of a duplicate group',
  '- {"action":"replace","targetId":"<id>","text":"<corrected/merged text>","reason":"..."} — supersede an outdated/duplicative card with a merged one',
  '- {"action":"archive","targetId":"<id>","reason":"..."} — a redundant/obsolete duplicate',
  '- {"action":"ignore","reason":"..."}',
  "Never invent new memories (no create), never broaden scope, and never rewrite unrelated cards. If nothing needs consolidating, return an empty operations array.",
].join("\n");

const CONSOLIDATION_LIMIT = 60;

function buildConsolidationPrompt(cards: MemoryCard[]): string {
  const lines = ["Active memories:"];
  for (const c of cards) {
    const scope =
      [c.scope.persona, c.scope.projectId].filter(Boolean).join("/") ||
      "global";
    lines.push(
      `[${c.id}@${c.revision}] (${c.kind}, ${scope}) ${c.text.slice(0, OBSERVATION_TEXT_CAP)}`,
    );
  }
  const prompt = lines.join("\n");
  return prompt.length > MAX_INPUT_CHARS
    ? prompt.slice(0, MAX_INPUT_CHARS)
    : prompt;
}

/**
 * Model consolidation: merge duplicates/contradictions across existing active
 * memories through the SAME bounded processor/budget path and the same lifecycle
 * executor. Reinforce/replace/archive only (never create), scoped to the listed
 * cards. Enforces the global ceilings; never throws.
 */
export async function runConsolidation(): Promise<ProcessorOutcome> {
  const settings = getSettings().memory;
  const active = memoryStore.list({ states: ["active"], limit: 5_000 });
  // Consolidate ONE exact-scope group per run so the model never compares (or
  // archives "duplicates") across different project/persona scopes. Successive
  // maintenance ticks rotate through groups.
  const groups = new Map<string, MemoryCard[]>();
  for (const c of active) {
    const key = `${c.scope.projectId ?? "*"}|${c.scope.persona ?? "*"}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  // Fair rotation: among eligible groups (>=2 cards) pick the one consolidated
  // least recently (durably tracked via the run ledger's `consolidation:<key>`
  // trigger), tie-broken by key. This prevents a large group from starving
  // smaller ones and survives restart.
  const lastRun = memoryProcessorStore.consolidationGroupLastRun();
  const eligible = [...groups.entries()].filter(([, g]) => g.length >= 2);
  if (eligible.length === 0)
    return {
      ran: false,
      reason: "no-input",
      operationsApplied: 0,
      operations: [],
    };
  eligible.sort(
    ([ka], [kb]) =>
      (lastRun.get(ka) ?? 0) - (lastRun.get(kb) ?? 0) || (ka < kb ? -1 : 1),
  );
  const [groupKey, group] = eligible[0]!;
  const cards = group.slice(0, CONSOLIDATION_LIMIT);
  const allowed = new Map(cards.map((c) => [c.id, c]));
  const nowMs = clock();
  if (runner === realRunner && !(await processorConfigStatus()).configured)
    return {
      ran: false,
      reason: "unconfigured",
      operationsApplied: 0,
      operations: [],
    };

  const reservation = tryReserveProcessorCall(
    nowMs,
    `consolidation:${groupKey}`,
  );
  if (reservation.runId === null)
    return {
      ran: false,
      reason: reservation.reason === "cost" ? "budget-cost" : "budget-rate",
      operationsApplied: 0,
      operations: [],
    };
  const runId = reservation.runId;

  let output: MemoryProcessorRunOutput;
  try {
    output = await runner.run({
      provider: settings.processor.provider,
      modelId: settings.processor.modelId,
      credentialProfileId: accountForSlot(settings.processor),
      thinkingLevel: settings.processor.thinkingLevel,
      systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
      prompt: buildConsolidationPrompt(cards),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    memoryProcessorStore.reconcile(runId, "error", clock());
    return {
      ran: true,
      reason: "error",
      operationsApplied: 0,
      operations: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const operations = parseOperations(output.text);
  if (operations === null) {
    memoryProcessorStore.reconcile(runId, "error", clock(), {
      ...(output.costMicrosUsd !== undefined
        ? { costMicrosUsd: output.costMicrosUsd }
        : {}),
    });
    return {
      ran: true,
      reason: "parse-error",
      operationsApplied: 0,
      operations: [],
      ...(output.costMicrosUsd !== undefined
        ? { costMicrosUsd: output.costMicrosUsd }
        : {}),
    };
  }

  const applied: AppliedOperation[] = operations.map((op) =>
    applyConsolidationOperation(op, allowed),
  );
  const appliedCount = applied.filter(
    (a) => a.ok && a.action !== "ignore",
  ).length;
  memoryProcessorStore.reconcile(runId, "success", clock(), {
    operationsApplied: appliedCount,
    ...(output.costMicrosUsd !== undefined
      ? { costMicrosUsd: output.costMicrosUsd }
      : {}),
  });
  return {
    ran: true,
    operationsApplied: appliedCount,
    operations: applied,
    ...(output.costMicrosUsd !== undefined
      ? { costMicrosUsd: output.costMicrosUsd }
      : {}),
  };
}

function applyConsolidationOperation(
  op: ProcessorOperation,
  allowed: Map<string, MemoryCard>,
): AppliedOperation {
  if (op.action === "ignore") return { action: "ignore", ok: true };
  if (op.action === "create")
    return {
      action: "create",
      ok: false,
      rejected: "consolidation cannot create",
    };
  const target = op.targetId ? allowed.get(op.targetId) : undefined;
  if (!target)
    return {
      action: op.action,
      ok: false,
      rejected: "unknown or out-of-set target",
    };
  const provenance = { sourceKind: "consolidation" as const };
  switch (op.action) {
    case "reinforce": {
      const r = reinforceMemory(target.id, op.reason);
      return r.ok
        ? { action: "reinforce", ok: true, cardId: target.id }
        : { action: "reinforce", ok: false, rejected: r.reason };
    }
    case "archive": {
      const r = archiveMemory(target.id, target.revision, op.reason);
      return r.ok
        ? { action: "archive", ok: true, cardId: target.id }
        : { action: "archive", ok: false, rejected: r.reason };
    }
    case "replace": {
      if (!op.text)
        return { action: "replace", ok: false, rejected: "missing text" };
      // Inherit kind/scope/temporal from the target — consolidation never escalates scope.
      const r = supersedeMemory(target.id, target.revision, {
        text: op.text,
        ...(op.reason !== undefined ? { reason: op.reason } : {}),
        provenance,
      });
      return r.ok
        ? { action: "replace", ok: true, cardId: r.replacement.id }
        : {
            action: "replace",
            ok: false,
            rejected:
              r.reason === "invalid"
                ? `${r.error.field}: ${r.error.message}`
                : r.reason,
          };
    }
    default:
      return {
        action: op.action,
        ok: false,
        rejected: "unsupported in consolidation",
      };
  }
}
