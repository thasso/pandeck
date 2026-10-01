import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  DelegationObligationProjection,
  SubagentDelegationSummary,
} from "@assistant/shared";
import { getDb, withDbTransaction } from "./index.ts";
import { nextId } from "./sequences.ts";
import { sessionStore } from "./sessionStore.ts";

export type SubagentInitiator = "human" | "agent";
export type SubagentRunStatus =
  | "pending"
  | "running"
  | "awaiting-parent"
  | "submitted"
  | "unreported"
  | "failed"
  | "stopped"
  | "lost";
export type SubagentExecutionPhase =
  | "pending-dispatch"
  | "predecessor-wait"
  | "provider-admitted"
  | "nudge-reserved"
  | "nudge-admitted"
  | "result-accepted"
  | "stop-requested"
  | "safe-idle"
  | "watchdog"
  | "awaiting-parent";
export type SubagentWatchdogState =
  "unused" | "reserved" | "admitted" | "completed";
export type SubagentUsageState = "current" | "final";
export type SubagentUsageCompleteness = "partial" | "complete";
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const ACTIVE_STATUSES = new Set<SubagentRunStatus>([
  "pending",
  "running",
  "awaiting-parent",
]);
const TERMINAL_STATUSES = new Set<SubagentRunStatus>([
  "submitted",
  "unreported",
  "failed",
  "stopped",
  "lost",
]);
const RESULT_SUMMARY_MAX_CHARS = 4_000;
const REASON_MAX_CHARS = 2_000;
const JSON_MAX_CHARS = 64_000;

export interface SubagentUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros?: number;
}

export interface FrozenSubagentProfile {
  roleName: string;
  baseRole: string;
  provider: string;
  modelId: string;
  credentialProfileId: string;
  accountSource: string;
  degradedPinReason?: string;
  defaultThinking: string;
  hardMaxThinking: string;
  executionProfileId: string;
  contractId: string;
  contractVersion: number;
}

export interface SubagentThreadLinkage {
  worktreeId?: string;
  cwd?: string;
  taskId?: number;
  projectId?: string;
  worktreeRelation?: string;
  worktreeProvenance?: JsonValue;
}

export interface SubagentThread {
  id: string;
  parentSessionId: string;
  sessionId: string;
  peerConversationId: string;
  profile: FrozenSubagentProfile;
  linkage: SubagentThreadLinkage;
  usage: SubagentUsageTotals;
  usageCompletionId?: string;
  inheritedArchivedAt?: number;
  inheritedSettledAt?: number;
  createdAt: number;
  updatedAt: number;
  activityAt: number;
  revision: number;
}

export interface AcceptedSubagentResult {
  reportedStatus: string;
  summary: string;
  payload: JsonValue;
  hostFacts: JsonValue;
  acceptedAt: number;
}

export interface SubagentRun {
  id: string;
  threadId: string;
  sequence: number;
  initiatedBy: SubagentInitiator;
  triggeringPeerPromptId?: string;
  requiredResponse?: {
    messageId: string;
    state: "outstanding" | "answered";
    answerMessageId?: string;
  };
  optionalResultCorrelationId?: string;
  contractId: string;
  contractVersion: number;
  actualThinking: string;
  governingLeaseId?: string;
  predecessorTurnId?: string;
  reviewTarget?: JsonValue;
  status: SubagentRunStatus;
  activePhase?: SubagentExecutionPhase;
  executionQuiescent: boolean;
  watchdogState: SubagentWatchdogState;
  watchdogTriggerCompletionId?: string;
  watchdogAdmittedCompletionId?: string;
  watchdogCompletedCompletionId?: string;
  acceptedResult?: AcceptedSubagentResult;
  stopRequestedAt?: number;
  stopRequestReason?: string;
  quiescenceCompletionId?: string;
  quiescentAt?: number;
  terminalReason?: string;
  terminalVerdict?: string;
  openingUsage: SubagentUsageTotals;
  usageDelta: SubagentUsageTotals;
  usageState: SubagentUsageState;
  usageCompleteness: SubagentUsageCompleteness;
  usageCompletionId?: string;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
  resultMessageId?: string;
  revision: number;
}

export interface SubagentRevisionRow {
  id: string;
  revision: number;
  member: boolean;
}

export interface SubagentStateChange {
  threadIds: string[];
  runIds: string[];
  parentSessionIds: string[];
}

export interface CreateSubagentThreadInput {
  id?: string;
  parentSessionId: string;
  sessionId: string;
  profile: FrozenSubagentProfile;
  linkage?: SubagentThreadLinkage;
}

export interface CreateSubagentRunInput {
  id?: string;
  initiatedBy: SubagentInitiator;
  actualThinking: string;
  triggeringPeerPromptId?: string;
  optionalResultCorrelationId?: string;
  governingLeaseId?: string;
  predecessorTurnId?: string;
  reviewTarget?: JsonValue;
  phase?: "pending-dispatch" | "predecessor-wait";
}

export interface AcceptInitialSubagentInput {
  thread: CreateSubagentThreadInput;
  run: CreateSubagentRunInput;
  parentLimit: number;
  now?: number;
}

export interface AcceptContinuationInput {
  threadId: string;
  run: CreateSubagentRunInput;
  parentLimit: number;
  now?: number;
}

export class SubagentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentValidationError";
  }
}

export class SubagentCapacityError extends Error {
  readonly parentSessionId: string;
  readonly limit: number;
  constructor(parentSessionId: string, limit: number) {
    super(
      `parent session ${parentSessionId} already has ${limit} active subagent run(s)`,
    );
    this.name = "SubagentCapacityError";
    this.parentSessionId = parentSessionId;
    this.limit = limit;
  }
}

export class SubagentImmutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentImmutableError";
  }
}

interface ThreadRow {
  id: string;
  parent_session_id: string;
  session_id: string;
  peer_conversation_id: string;
  role_name: string;
  base_role: string;
  worktree_id: string | null;
  cwd: string | null;
  task_id: number | null;
  project_id: string | null;
  worktree_relation: string | null;
  worktree_provenance_json: string | null;
  provider: string;
  model_id: string;
  credential_profile_id: string;
  account_source: string;
  degraded_pin_reason: string | null;
  default_thinking: string;
  hard_max_thinking: string;
  execution_profile_id: string;
  contract_id: string;
  contract_version: number;
  usage_input_tokens: number;
  usage_output_tokens: number;
  usage_cache_read_tokens: number;
  usage_cache_write_tokens: number;
  usage_cost_micros: number | null;
  usage_completion_id: string | null;
  inherited_archived_at_ms: number | null;
  inherited_settled_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  activity_at_ms: number;
  revision: number;
  is_member: number;
  deleted_at_ms: number | null;
}

interface RunRow {
  id: string;
  thread_id: string;
  thread_seq: number;
  initiated_by: SubagentInitiator;
  triggering_peer_prompt_id: string | null;
  required_response_message_id: string | null;
  required_response_state: "none" | "outstanding" | "answered";
  required_response_answer_message_id: string | null;
  optional_result_correlation_id: string | null;
  contract_id: string;
  contract_version: number;
  actual_thinking: string;
  governing_lease_id: string | null;
  predecessor_turn_id: string | null;
  review_target_json: string | null;
  status: SubagentRunStatus;
  active_phase: SubagentExecutionPhase | null;
  execution_quiescent: number;
  watchdog_state: SubagentWatchdogState;
  watchdog_trigger_completion_id: string | null;
  watchdog_admitted_completion_id: string | null;
  watchdog_completed_completion_id: string | null;
  accepted_reported_status: string | null;
  accepted_summary: string | null;
  accepted_payload_json: string | null;
  accepted_host_facts_json: string | null;
  result_accepted_at_ms: number | null;
  stop_requested_at_ms: number | null;
  stop_request_reason: string | null;
  quiescence_completion_id: string | null;
  quiescent_at_ms: number | null;
  terminal_reason: string | null;
  terminal_verdict: string | null;
  opening_input_tokens: number;
  opening_output_tokens: number;
  opening_cache_read_tokens: number;
  opening_cache_write_tokens: number;
  opening_cost_micros: number | null;
  delta_input_tokens: number;
  delta_output_tokens: number;
  delta_cache_read_tokens: number;
  delta_cache_write_tokens: number;
  delta_cost_micros: number | null;
  usage_state: SubagentUsageState;
  usage_completeness: SubagentUsageCompleteness;
  usage_completion_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  terminal_at_ms: number | null;
  result_message_id: string | null;
  revision: number;
  is_member: number;
  deleted_at_ms: number | null;
}

function present(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized)
    throw new SubagentValidationError(`${name} must not be blank`);
  return normalized;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new SubagentValidationError(
      `${name} must be a positive safe integer`,
    );
  return value;
}

function nonnegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new SubagentValidationError(
      `${name} must be a non-negative safe integer`,
    );
  return value;
}

function bounded(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function acceptedResultSummary(value: string): string {
  const text = value.trim();
  if (text.length > RESULT_SUMMARY_MAX_CHARS)
    throw new SubagentValidationError(
      `accepted result summary exceeds ${RESULT_SUMMARY_MAX_CHARS} characters`,
    );
  return text;
}

function encodeJson(value: JsonValue | undefined, name: string): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json.length > JSON_MAX_CHARS)
    throw new SubagentValidationError(
      `${name} exceeds ${JSON_MAX_CHARS} characters`,
    );
  return json;
}

function decodeJson(value: string, name: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new Error(
      `${name} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function usageFrom(
  prefix: "usage" | "opening" | "delta",
  row: ThreadRow | RunRow,
): SubagentUsageTotals {
  const source = row as unknown as Record<string, number | null>;
  const usage: SubagentUsageTotals = {
    inputTokens: source[`${prefix}_input_tokens`] ?? 0,
    outputTokens: source[`${prefix}_output_tokens`] ?? 0,
    cacheReadTokens: source[`${prefix}_cache_read_tokens`] ?? 0,
    cacheWriteTokens: source[`${prefix}_cache_write_tokens`] ?? 0,
  };
  const cost = source[`${prefix}_cost_micros`];
  if (cost !== null && cost !== undefined) usage.costMicros = cost;
  return usage;
}

function validateUsage(usage: SubagentUsageTotals, name: string): void {
  nonnegativeSafeInteger(usage.inputTokens, `${name}.inputTokens`);
  nonnegativeSafeInteger(usage.outputTokens, `${name}.outputTokens`);
  nonnegativeSafeInteger(usage.cacheReadTokens, `${name}.cacheReadTokens`);
  nonnegativeSafeInteger(usage.cacheWriteTokens, `${name}.cacheWriteTokens`);
  if (usage.costMicros !== undefined)
    nonnegativeSafeInteger(usage.costMicros, `${name}.costMicros`);
}

function usageArgs(
  usage: SubagentUsageTotals,
): [number, number, number, number, number | null] {
  validateUsage(usage, "usage");
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.costMicros ?? null,
  ];
}

function usageEqual(a: SubagentUsageTotals, b: SubagentUsageTotals): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens &&
    a.costMicros === b.costMicros
  );
}

function assertUsageNotDecreased(
  next: SubagentUsageTotals,
  previous: SubagentUsageTotals,
  name: string,
): void {
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    if (next[key] < previous[key])
      throw new SubagentValidationError(`${name}.${key} cannot decrease`);
  }
  if (
    previous.costMicros !== undefined &&
    (next.costMicros === undefined || next.costMicros < previous.costMicros)
  )
    throw new SubagentValidationError(
      `${name}.costMicros cannot decrease or disappear`,
    );
}

function usageDeltaFromBaseline(
  cumulative: SubagentUsageTotals,
  opening: SubagentUsageTotals,
): SubagentUsageTotals {
  assertUsageNotDecreased(cumulative, opening, "cumulative");
  const delta: SubagentUsageTotals = {
    inputTokens: cumulative.inputTokens - opening.inputTokens,
    outputTokens: cumulative.outputTokens - opening.outputTokens,
    cacheReadTokens: cumulative.cacheReadTokens - opening.cacheReadTokens,
    cacheWriteTokens: cumulative.cacheWriteTokens - opening.cacheWriteTokens,
  };
  if (cumulative.costMicros !== undefined)
    delta.costMicros = cumulative.costMicros - (opening.costMicros ?? 0);
  return delta;
}

function threadFromRow(row: ThreadRow): SubagentThread {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    sessionId: row.session_id,
    peerConversationId: row.peer_conversation_id,
    profile: {
      roleName: row.role_name,
      baseRole: row.base_role,
      provider: row.provider,
      modelId: row.model_id,
      credentialProfileId: row.credential_profile_id,
      accountSource: row.account_source,
      ...(row.degraded_pin_reason
        ? { degradedPinReason: row.degraded_pin_reason }
        : {}),
      defaultThinking: row.default_thinking,
      hardMaxThinking: row.hard_max_thinking,
      executionProfileId: row.execution_profile_id,
      contractId: row.contract_id,
      contractVersion: row.contract_version,
    },
    linkage: {
      ...(row.worktree_id ? { worktreeId: row.worktree_id } : {}),
      ...(row.cwd ? { cwd: row.cwd } : {}),
      ...(row.task_id !== null ? { taskId: row.task_id } : {}),
      ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.worktree_relation
        ? { worktreeRelation: row.worktree_relation }
        : {}),
      ...(row.worktree_provenance_json
        ? {
            worktreeProvenance: decodeJson(
              row.worktree_provenance_json,
              `thread ${row.id} worktree provenance`,
            ),
          }
        : {}),
    },
    usage: usageFrom("usage", row),
    ...(row.usage_completion_id
      ? { usageCompletionId: row.usage_completion_id }
      : {}),
    ...(row.inherited_archived_at_ms !== null
      ? { inheritedArchivedAt: row.inherited_archived_at_ms }
      : {}),
    ...(row.inherited_settled_at_ms !== null
      ? { inheritedSettledAt: row.inherited_settled_at_ms }
      : {}),
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    activityAt: row.activity_at_ms,
    revision: row.revision,
  };
}

function runFromRow(row: RunRow): SubagentRun {
  const requiredResponse =
    row.required_response_message_id && row.required_response_state !== "none"
      ? {
          messageId: row.required_response_message_id,
          state: row.required_response_state,
          ...(row.required_response_answer_message_id
            ? { answerMessageId: row.required_response_answer_message_id }
            : {}),
        }
      : undefined;
  const acceptedResult =
    row.result_accepted_at_ms !== null
      ? {
          reportedStatus: row.accepted_reported_status!,
          summary: row.accepted_summary!,
          payload: decodeJson(
            row.accepted_payload_json!,
            `run ${row.id} accepted payload`,
          ),
          hostFacts: decodeJson(
            row.accepted_host_facts_json!,
            `run ${row.id} accepted host facts`,
          ),
          acceptedAt: row.result_accepted_at_ms,
        }
      : undefined;
  return {
    id: row.id,
    threadId: row.thread_id,
    sequence: row.thread_seq,
    initiatedBy: row.initiated_by,
    ...(row.triggering_peer_prompt_id
      ? { triggeringPeerPromptId: row.triggering_peer_prompt_id }
      : {}),
    ...(requiredResponse ? { requiredResponse } : {}),
    ...(row.optional_result_correlation_id
      ? { optionalResultCorrelationId: row.optional_result_correlation_id }
      : {}),
    contractId: row.contract_id,
    contractVersion: row.contract_version,
    actualThinking: row.actual_thinking,
    ...(row.governing_lease_id
      ? { governingLeaseId: row.governing_lease_id }
      : {}),
    ...(row.predecessor_turn_id
      ? { predecessorTurnId: row.predecessor_turn_id }
      : {}),
    ...(row.review_target_json
      ? {
          reviewTarget: decodeJson(
            row.review_target_json,
            `run ${row.id} review target`,
          ),
        }
      : {}),
    status: row.status,
    ...(row.active_phase ? { activePhase: row.active_phase } : {}),
    executionQuiescent: Boolean(row.execution_quiescent),
    watchdogState: row.watchdog_state,
    ...(row.watchdog_trigger_completion_id
      ? { watchdogTriggerCompletionId: row.watchdog_trigger_completion_id }
      : {}),
    ...(row.watchdog_admitted_completion_id
      ? { watchdogAdmittedCompletionId: row.watchdog_admitted_completion_id }
      : {}),
    ...(row.watchdog_completed_completion_id
      ? { watchdogCompletedCompletionId: row.watchdog_completed_completion_id }
      : {}),
    ...(acceptedResult ? { acceptedResult } : {}),
    ...(row.stop_requested_at_ms !== null
      ? { stopRequestedAt: row.stop_requested_at_ms }
      : {}),
    ...(row.stop_request_reason
      ? { stopRequestReason: row.stop_request_reason }
      : {}),
    ...(row.quiescence_completion_id
      ? { quiescenceCompletionId: row.quiescence_completion_id }
      : {}),
    ...(row.quiescent_at_ms !== null
      ? { quiescentAt: row.quiescent_at_ms }
      : {}),
    ...(row.terminal_reason ? { terminalReason: row.terminal_reason } : {}),
    ...(row.terminal_verdict ? { terminalVerdict: row.terminal_verdict } : {}),
    openingUsage: usageFrom("opening", row),
    usageDelta: usageFrom("delta", row),
    usageState: row.usage_state,
    usageCompleteness: row.usage_completeness,
    ...(row.usage_completion_id
      ? { usageCompletionId: row.usage_completion_id }
      : {}),
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    ...(row.terminal_at_ms !== null ? { terminalAt: row.terminal_at_ms } : {}),
    ...(row.result_message_id
      ? { resultMessageId: row.result_message_id }
      : {}),
    revision: row.revision,
  };
}

function rawThread(id: string, includeDeleted = false): ThreadRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM subagent_threads WHERE id = ?${includeDeleted ? "" : " AND is_member = 1"}`,
    )
    .get(id) as ThreadRow | undefined;
}

function rawRun(id: string, includeDeleted = false): RunRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM subagent_runs WHERE id = ?${includeDeleted ? "" : " AND is_member = 1"}`,
    )
    .get(id) as RunRow | undefined;
}

function requireThread(id: string): ThreadRow {
  const row = rawThread(id);
  if (!row)
    throw new SubagentValidationError(`subagent thread ${id} does not exist`);
  return row;
}

function requireRun(id: string): RunRow {
  const row = rawRun(id);
  if (!row)
    throw new SubagentValidationError(`subagent run ${id} does not exist`);
  return row;
}

interface PendingTouches {
  threadIds: Set<string>;
  runIds: Set<string>;
}

let stateChangeNotifier: ((change: SubagentStateChange) => void) | undefined;

/** Task-494 installs the one post-commit fan-out here; no projection read occurs in a transaction. */
export function setSubagentStateChangeNotifier(
  notifier: ((change: SubagentStateChange) => void) | undefined,
): void {
  stateChangeNotifier = notifier;
}

/**
 * Stamp all touched rows from one persisted domain sequence. Run ids
 * automatically pull in their containing thread. This function is transaction
 * internal: callers mutate through `mutation`, which notifies only after COMMIT.
 */
function markSubagentStateChanged(
  db: DatabaseSync,
  pending: PendingTouches,
): SubagentStateChange | undefined {
  const runIds = [...pending.runIds];
  const threadIds = new Set(pending.threadIds);
  if (runIds.length > 0) {
    const rows = db
      .prepare(
        `SELECT DISTINCT thread_id FROM subagent_runs WHERE id IN (${runIds.map(() => "?").join(", ")})`,
      )
      .all(...(runIds as never[])) as Array<{ thread_id: string }>;
    for (const row of rows) threadIds.add(row.thread_id);
  }
  if (threadIds.size === 0 && runIds.length === 0) return undefined;

  const revision = nextId("subagent_revision");
  const updateThread = db.prepare(
    "UPDATE subagent_threads SET revision = ? WHERE id = ?",
  );
  const updateRun = db.prepare(
    "UPDATE subagent_runs SET revision = ? WHERE id = ?",
  );
  for (const id of threadIds) updateThread.run(revision, id);
  for (const id of runIds) updateRun.run(revision, id);

  const ids = [...threadIds].sort();
  const parents =
    ids.length === 0
      ? []
      : (
          db
            .prepare(
              `SELECT DISTINCT parent_session_id FROM subagent_threads WHERE id IN (${ids.map(() => "?").join(", ")})`,
            )
            .all(...(ids as never[])) as Array<{ parent_session_id: string }>
        )
          .map((row) => row.parent_session_id)
          .sort();
  return {
    threadIds: ids,
    runIds: [...new Set(runIds)].sort(),
    parentSessionIds: parents,
  };
}

function mutation<T>(
  fn: (touch: PendingTouches) => T,
  observeChange?: (change: SubagentStateChange) => void,
): T {
  const committed = withDbTransaction(() => {
    const touch: PendingTouches = { threadIds: new Set(), runIds: new Set() };
    const value = fn(touch);
    const change = markSubagentStateChanged(getDb(), touch);
    return { value, change };
  });
  if (committed.change) {
    observeChange?.(committed.change);
    stateChangeNotifier?.(committed.change);
  }
  return committed.value;
}

function touchRun(touch: PendingTouches, id: string): void {
  touch.runIds.add(id);
}

function touchThread(touch: PendingTouches, id: string): void {
  touch.threadIds.add(id);
}

function validateProfile(
  profile: FrozenSubagentProfile,
): FrozenSubagentProfile {
  return {
    roleName: present(profile.roleName, "profile.roleName"),
    baseRole: present(profile.baseRole, "profile.baseRole"),
    provider: present(profile.provider, "profile.provider"),
    modelId: present(profile.modelId, "profile.modelId"),
    credentialProfileId: present(
      profile.credentialProfileId,
      "profile.credentialProfileId",
    ),
    accountSource: present(profile.accountSource, "profile.accountSource"),
    ...(profile.degradedPinReason
      ? {
          degradedPinReason: present(
            profile.degradedPinReason,
            "profile.degradedPinReason",
          ),
        }
      : {}),
    defaultThinking: present(
      profile.defaultThinking,
      "profile.defaultThinking",
    ),
    hardMaxThinking: present(
      profile.hardMaxThinking,
      "profile.hardMaxThinking",
    ),
    executionProfileId: present(
      profile.executionProfileId,
      "profile.executionProfileId",
    ),
    contractId: present(profile.contractId, "profile.contractId"),
    contractVersion: positiveSafeInteger(
      profile.contractVersion,
      "profile.contractVersion",
    ),
  };
}

function requireEligibleSessions(
  parentSessionId: string,
  sessionId: string,
): { inheritedArchivedAt: number | null; inheritedSettledAt: number | null } {
  const rows = getDb()
    .prepare(
      `SELECT id, scope, archived_at_ms, settled_at_ms, deleted_at_ms,
              attention_revision, attention_settled_revision
       FROM session_index WHERE id IN (?, ?)`,
    )
    .all(parentSessionId, sessionId) as Array<{
    id: string;
    scope: string;
    archived_at_ms: number | null;
    settled_at_ms: number | null;
    deleted_at_ms: number | null;
    attention_revision: number;
    attention_settled_revision: number;
  }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parent = byId.get(parentSessionId);
  if (!parent || parent.deleted_at_ms !== null)
    throw new SubagentValidationError(
      `parent session ${parentSessionId} does not exist`,
    );
  if (parent.scope === "subagent")
    throw new SubagentValidationError(
      "a subagent session cannot own another subagent thread",
    );
  if (parent.scope !== "user") {
    const workflowExecutor = getDb()
      .prepare(
        `SELECT 1 FROM workflow_steps
         WHERE executor_kind = 'session' AND executor_id = ? LIMIT 1`,
      )
      .get(parentSessionId);
    if (!workflowExecutor)
      throw new SubagentValidationError(
        `internal session ${parentSessionId} is not a durable workflow executor`,
      );
  }
  const child = byId.get(sessionId);
  if (!child || child.deleted_at_ms !== null)
    throw new SubagentValidationError(
      `subagent session ${sessionId} does not exist`,
    );
  if (child.scope !== "subagent")
    throw new SubagentValidationError(
      `session ${sessionId} must already be claimed with subagent scope`,
    );
  // Settlement is inherited EFFECTIVELY, the same conjunction the session list
  // projects (Task-674): a parent whose settlement an outcome has already
  // superseded is back in the user's working set, so a thread accepted now must
  // not be born claiming it was put down.
  const parentSettled =
    parent.settled_at_ms !== null &&
    parent.attention_revision <= parent.attention_settled_revision;
  return {
    inheritedArchivedAt: parent.archived_at_ms,
    inheritedSettledAt: parentSettled ? parent.settled_at_ms : null,
  };
}

function assertCapacity(parentSessionId: string, limit: number): void {
  positiveSafeInteger(limit, "parentLimit");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
      FROM subagent_runs r
      JOIN subagent_threads t ON t.id = r.thread_id
      WHERE t.parent_session_id = ? AND t.is_member = 1 AND r.is_member = 1
        AND r.status IN ('pending', 'running', 'awaiting-parent')`,
    )
    .get(parentSessionId) as { count: number };
  if (row.count >= limit)
    throw new SubagentCapacityError(parentSessionId, limit);
}

function insertRun(
  thread: ThreadRow,
  input: CreateSubagentRunInput,
  now: number,
): string {
  const active = getDb()
    .prepare(
      `SELECT id FROM subagent_runs WHERE thread_id = ? AND is_member = 1
       AND (status IN ('pending', 'running', 'awaiting-parent') OR execution_quiescent = 0)
       LIMIT 1`,
    )
    .get(thread.id) as { id: string } | undefined;
  if (active)
    throw new SubagentValidationError(
      `subagent thread ${thread.id} already has active run ${active.id}`,
    );
  const id = input.id ?? `sar_${randomUUID()}`;
  const sequence = (
    getDb()
      .prepare(
        "SELECT COALESCE(MAX(thread_seq), 0) + 1 AS sequence FROM subagent_runs WHERE thread_id = ?",
      )
      .get(thread.id) as { sequence: number }
  ).sequence;
  const phase = input.phase ?? "pending-dispatch";
  const actualThinking = present(input.actualThinking, "run.actualThinking");
  const opening = usageFrom("usage", thread);
  getDb()
    .prepare(
      `INSERT INTO subagent_runs (
      id, thread_id, thread_seq, initiated_by,
      triggering_peer_prompt_id, required_response_message_id, required_response_state,
      required_response_answer_message_id, optional_result_correlation_id,
      contract_id, contract_version, actual_thinking, governing_lease_id,
      predecessor_turn_id, review_target_json, status, active_phase, execution_quiescent,
      watchdog_state, opening_input_tokens, opening_output_tokens,
      opening_cache_read_tokens, opening_cache_write_tokens, opening_cost_micros,
      created_at_ms, updated_at_ms, revision, is_member, deleted_at_ms
    ) VALUES (?, ?, ?, ?, ?, NULL, 'none', NULL, ?, ?, ?, ?, ?, ?, ?,
      'pending', ?, 1, 'unused', ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL)`,
    )
    .run(
      id,
      thread.id,
      sequence,
      input.initiatedBy,
      input.triggeringPeerPromptId ?? null,
      input.optionalResultCorrelationId ?? null,
      thread.contract_id,
      thread.contract_version,
      actualThinking,
      input.governingLeaseId ?? null,
      input.predecessorTurnId ?? null,
      encodeJson(input.reviewTarget, "run.reviewTarget"),
      phase,
      ...usageArgs(opening),
      now,
      now,
    );
  return id;
}

/** Atomic initial admission: capacity check, complete frozen thread, and first run. */
function acceptInitial(input: AcceptInitialSubagentInput): {
  thread: SubagentThread;
  run: SubagentRun;
} {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const profile = validateProfile(input.thread.profile);
    const inherited = requireEligibleSessions(
      input.thread.parentSessionId,
      input.thread.sessionId,
    );
    assertCapacity(input.thread.parentSessionId, input.parentLimit);
    const existing = getDb()
      .prepare("SELECT id FROM subagent_threads WHERE session_id = ? LIMIT 1")
      .get(input.thread.sessionId) as { id: string } | undefined;
    if (existing)
      throw new SubagentValidationError(
        `session ${input.thread.sessionId} already belongs to subagent thread ${existing.id}`,
      );
    const id = input.thread.id ?? `sat_${randomUUID()}`;
    const peerConversationId = `subagent-peer:${id}`;
    const linkage = input.thread.linkage ?? {};
    getDb()
      .prepare(
        `INSERT INTO subagent_threads (
        id, parent_session_id, session_id, peer_conversation_id,
        role_name, base_role, worktree_id, cwd, task_id, project_id,
        worktree_relation, worktree_provenance_json,
        provider, model_id, credential_profile_id, account_source, degraded_pin_reason,
        default_thinking, hard_max_thinking, execution_profile_id, contract_id, contract_version,
        inherited_archived_at_ms, inherited_settled_at_ms,
        created_at_ms, updated_at_ms, activity_at_ms, revision, is_member, deleted_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL)`,
      )
      .run(
        id,
        input.thread.parentSessionId,
        input.thread.sessionId,
        peerConversationId,
        profile.roleName,
        profile.baseRole,
        linkage.worktreeId ?? null,
        linkage.cwd ?? null,
        linkage.taskId ?? null,
        linkage.projectId ?? null,
        linkage.worktreeRelation ?? null,
        encodeJson(
          linkage.worktreeProvenance,
          "thread.linkage.worktreeProvenance",
        ),
        profile.provider,
        profile.modelId,
        profile.credentialProfileId,
        profile.accountSource,
        profile.degradedPinReason ?? null,
        profile.defaultThinking,
        profile.hardMaxThinking,
        profile.executionProfileId,
        profile.contractId,
        profile.contractVersion,
        inherited.inheritedArchivedAt,
        inherited.inheritedSettledAt,
        now,
        now,
        now,
      );
    const thread = requireThread(id);
    const runId = insertRun(thread, input.run, now);
    touchThread(touch, id);
    touchRun(touch, runId);
    return {
      thread: threadFromRow(requireThread(id)),
      run: runFromRow(requireRun(runId)),
    };
  });
}

/** Add a fresh run to a dormant thread; terminal rows are never reopened. */
function acceptContinuation(input: AcceptContinuationInput): SubagentRun {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const thread = requireThread(input.threadId);
    assertCapacity(thread.parent_session_id, input.parentLimit);
    const runId = insertRun(thread, input.run, now);
    getDb()
      .prepare(
        "UPDATE subagent_threads SET updated_at_ms = ?, activity_at_ms = ? WHERE id = ?",
      )
      .run(now, now, thread.id);
    touchRun(touch, runId);
    return runFromRow(requireRun(runId));
  });
}

export interface TransitionExecutionInput {
  runId: string;
  expectedStatus?: SubagentRunStatus;
  expectedPhase?: SubagentExecutionPhase;
  status: "pending" | "running";
  phase:
    | "pending-dispatch"
    | "predecessor-wait"
    | "provider-admitted"
    | "safe-idle"
    | "watchdog";
  now?: number;
}

function transitionExecution(
  input: TransitionExecutionInput,
): SubagentRun | undefined {
  return mutation((touch) => {
    const row = requireRun(input.runId);
    if (input.expectedStatus && row.status !== input.expectedStatus)
      return undefined;
    if (input.expectedPhase && row.active_phase !== input.expectedPhase)
      return undefined;
    if (TERMINAL_STATUSES.has(row.status))
      throw new SubagentImmutableError(
        `terminal subagent run ${row.id} cannot transition`,
      );
    if (row.result_accepted_at_ms !== null || row.stop_requested_at_ms !== null)
      throw new SubagentImmutableError(
        `subagent run ${row.id} already has an irreversible terminal decision`,
      );
    const allowed =
      row.status === input.status ||
      (row.status === "pending" && input.status === "running");
    if (!allowed)
      throw new SubagentValidationError(
        `illegal subagent run transition ${row.status} -> ${input.status}`,
      );
    if (
      input.status === "pending" &&
      !["pending-dispatch", "predecessor-wait"].includes(input.phase)
    )
      throw new SubagentValidationError(
        `phase ${input.phase} is not valid while pending`,
      );
    const now = input.now ?? Date.now();
    const enteringExecution = input.phase === "provider-admitted";
    const quiescent = enteringExecution ? 0 : row.execution_quiescent;
    getDb()
      .prepare(
        `UPDATE subagent_runs SET status = ?, active_phase = ?, execution_quiescent = ?,
         quiescence_completion_id = ?, quiescent_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
      )
      .run(
        input.status,
        input.phase,
        quiescent,
        enteringExecution ? null : row.quiescence_completion_id,
        enteringExecution ? null : row.quiescent_at_ms,
        now,
        row.id,
      );
    getDb()
      .prepare(
        "UPDATE subagent_threads SET updated_at_ms = ?, activity_at_ms = ? WHERE id = ?",
      )
      .run(now, now, row.thread_id);
    touchRun(touch, row.id);
    return runFromRow(requireRun(row.id));
  });
}

function awaitParent(
  runId: string,
  messageId: string,
  now = Date.now(),
): SubagentRun {
  return mutation((touch) => {
    const row = requireRun(runId);
    if (row.status !== "running")
      throw new SubagentValidationError(
        `only a running subagent run can await its parent`,
      );
    if (row.result_accepted_at_ms !== null || row.stop_requested_at_ms !== null)
      throw new SubagentImmutableError(
        `subagent run ${runId} already has an irreversible terminal decision`,
      );
    getDb()
      .prepare(
        `UPDATE subagent_runs SET status = 'awaiting-parent', active_phase = 'awaiting-parent',
      execution_quiescent = 1, quiescence_completion_id = NULL, quiescent_at_ms = NULL,
      required_response_message_id = ?, required_response_state = 'outstanding',
      required_response_answer_message_id = NULL, updated_at_ms = ? WHERE id = ?`,
      )
      .run(present(messageId, "messageId"), now, runId);
    touchRun(touch, runId);
    return runFromRow(requireRun(runId));
  });
}

function resumeFromParent(
  runId: string,
  requestMessageId: string,
  answerMessageId: string,
  now = Date.now(),
): SubagentRun | undefined {
  return mutation((touch) => {
    const row = requireRun(runId);
    if (
      row.status !== "awaiting-parent" ||
      row.required_response_state !== "outstanding"
    )
      return undefined;
    if (row.required_response_message_id !== requestMessageId) return undefined;
    getDb()
      .prepare(
        `UPDATE subagent_runs SET status = 'running', active_phase = 'pending-dispatch',
      execution_quiescent = 0, quiescence_completion_id = NULL, quiescent_at_ms = NULL,
      required_response_state = 'answered', required_response_answer_message_id = ?,
      updated_at_ms = ? WHERE id = ?`,
      )
      .run(present(answerMessageId, "answerMessageId"), now, runId);
    touchRun(touch, runId);
    return runFromRow(requireRun(runId));
  });
}

function reserveWatchdog(
  runId: string,
  triggeringCompletionId: string,
  now = Date.now(),
): SubagentRun | undefined {
  return watchdogCas(
    runId,
    "unused",
    "reserved",
    "nudge-reserved",
    "watchdog_trigger_completion_id",
    triggeringCompletionId,
    now,
  );
}

function admitWatchdog(
  runId: string,
  admittedCompletionId: string,
  now = Date.now(),
): SubagentRun | undefined {
  return watchdogCas(
    runId,
    "reserved",
    "admitted",
    "nudge-admitted",
    "watchdog_admitted_completion_id",
    admittedCompletionId,
    now,
  );
}

function completeWatchdog(
  runId: string,
  completedCompletionId: string,
  now = Date.now(),
): SubagentRun | undefined {
  return watchdogCas(
    runId,
    "admitted",
    "completed",
    "safe-idle",
    "watchdog_completed_completion_id",
    completedCompletionId,
    now,
  );
}

function watchdogCas(
  runId: string,
  expected: SubagentWatchdogState,
  next: SubagentWatchdogState,
  phase: SubagentExecutionPhase,
  identityColumn:
    | "watchdog_trigger_completion_id"
    | "watchdog_admitted_completion_id"
    | "watchdog_completed_completion_id",
  completionId: string,
  now: number,
): SubagentRun | undefined {
  return mutation((touch) => {
    const row = requireRun(runId);
    if (row.watchdog_state !== expected) return undefined;
    if (
      row.status !== "running" ||
      row.result_accepted_at_ms !== null ||
      row.stop_requested_at_ms !== null
    )
      return undefined;
    const quiescent = next === "completed" ? 1 : 0;
    const identity = present(completionId, "completionId");
    const result = getDb()
      .prepare(
        `UPDATE subagent_runs SET watchdog_state = ?, active_phase = ?,
      ${identityColumn} = ?, execution_quiescent = ?, quiescence_completion_id = ?,
      quiescent_at_ms = ?, updated_at_ms = ? WHERE id = ? AND watchdog_state = ?`,
      )
      .run(
        next,
        phase,
        identity,
        quiescent,
        quiescent ? identity : null,
        quiescent ? now : null,
        now,
        runId,
        expected,
      );
    if (result.changes === 0) return undefined;
    touchRun(touch, runId);
    return runFromRow(requireRun(runId));
  });
}

export interface AcceptResultInput {
  runId: string;
  reportedStatus: string;
  summary: string;
  payload: JsonValue;
  hostFacts: JsonValue;
  now?: number;
}

/** Result-first CAS. Once this succeeds, Stop can no longer win. */
function acceptResult(input: AcceptResultInput): SubagentRun | undefined {
  return mutation((touch) => {
    const row = requireRun(input.runId);
    if (!ACTIVE_STATUSES.has(row.status)) return undefined;
    if (row.result_accepted_at_ms !== null || row.stop_requested_at_ms !== null)
      return undefined;
    const now = input.now ?? Date.now();
    const result = getDb()
      .prepare(
        `UPDATE subagent_runs SET
      accepted_reported_status = ?, accepted_summary = ?, accepted_payload_json = ?, accepted_host_facts_json = ?,
      result_accepted_at_ms = ?, active_phase = 'result-accepted',
      status = CASE WHEN status = 'awaiting-parent' THEN 'running' ELSE status END,
      required_response_state = CASE WHEN status = 'awaiting-parent' THEN 'none' ELSE required_response_state END,
      required_response_message_id = CASE WHEN status = 'awaiting-parent' THEN NULL ELSE required_response_message_id END,
      required_response_answer_message_id = CASE WHEN status = 'awaiting-parent' THEN NULL ELSE required_response_answer_message_id END,
      updated_at_ms = ?
      WHERE id = ? AND result_accepted_at_ms IS NULL AND stop_requested_at_ms IS NULL
        AND status IN ('pending', 'running', 'awaiting-parent')`,
      )
      .run(
        present(input.reportedStatus, "reportedStatus"),
        acceptedResultSummary(input.summary),
        encodeJson(input.payload, "accepted result payload"),
        encodeJson(input.hostFacts, "accepted result host facts"),
        now,
        now,
        input.runId,
      );
    if (result.changes === 0) return undefined;
    touchRun(touch, input.runId);
    return runFromRow(requireRun(input.runId));
  });
}

/** Stop-first CAS. Once this succeeds, a later valid result is refused. */
function requestStop(
  runId: string,
  reason?: string,
  now = Date.now(),
): SubagentRun | undefined {
  return mutation((touch) => {
    const row = requireRun(runId);
    if (!ACTIVE_STATUSES.has(row.status)) return undefined;
    if (row.result_accepted_at_ms !== null || row.stop_requested_at_ms !== null)
      return undefined;
    const result = getDb()
      .prepare(
        `UPDATE subagent_runs SET stop_requested_at_ms = ?, stop_request_reason = ?,
      active_phase = 'stop-requested',
      status = CASE WHEN status = 'awaiting-parent' THEN 'running' ELSE status END,
      required_response_state = CASE WHEN status = 'awaiting-parent' THEN 'none' ELSE required_response_state END,
      required_response_message_id = CASE WHEN status = 'awaiting-parent' THEN NULL ELSE required_response_message_id END,
      required_response_answer_message_id = CASE WHEN status = 'awaiting-parent' THEN NULL ELSE required_response_answer_message_id END,
      updated_at_ms = ?
      WHERE id = ? AND result_accepted_at_ms IS NULL AND stop_requested_at_ms IS NULL
        AND status IN ('pending', 'running', 'awaiting-parent')`,
      )
      .run(now, bounded(reason, REASON_MAX_CHARS), now, runId);
    if (result.changes === 0) return undefined;
    touchRun(touch, runId);
    return runFromRow(requireRun(runId));
  });
}

function recordQuiescence(
  runId: string,
  completionId: string,
  now = Date.now(),
): SubagentRun {
  return mutation((touch) => {
    const row = requireRun(runId);
    if (TERMINAL_STATUSES.has(row.status))
      throw new SubagentImmutableError(
        `terminal subagent run ${runId} is already quiescent`,
      );
    const identity = present(completionId, "completionId");
    if (row.execution_quiescent && row.quiescence_completion_id === identity)
      return runFromRow(row);
    if (
      row.execution_quiescent &&
      row.quiescence_completion_id &&
      row.quiescence_completion_id !== identity
    )
      throw new SubagentImmutableError(
        `subagent run ${runId} is already quiescent on different completion evidence`,
      );
    getDb()
      .prepare(
        `UPDATE subagent_runs SET execution_quiescent = 1,
      quiescence_completion_id = ?, quiescent_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
      )
      .run(identity, now, now, runId);
    touchRun(touch, runId);
    return runFromRow(requireRun(runId));
  });
}

export interface FinalizeRunInput {
  runId: string;
  status: "submitted" | "unreported" | "failed" | "stopped" | "lost";
  reason?: string;
  verdict?: string;
  resultMessageId?: string;
  now?: number;
}

function finalizeRun(input: FinalizeRunInput): SubagentRun {
  return mutation((touch) => {
    const row = requireRun(input.runId);
    if (TERMINAL_STATUSES.has(row.status))
      throw new SubagentImmutableError(
        `terminal subagent run ${row.id} cannot be rewritten`,
      );
    if (!row.execution_quiescent || !row.quiescence_completion_id)
      throw new SubagentValidationError(
        `subagent run ${row.id} has no durable quiescence evidence`,
      );
    if (row.result_accepted_at_ms !== null && input.status !== "submitted")
      throw new SubagentImmutableError(
        "an accepted result wins terminalization as submitted",
      );
    if (row.stop_requested_at_ms !== null && input.status !== "stopped")
      throw new SubagentImmutableError(
        "an accepted stop request wins terminalization as stopped",
      );
    if (row.result_accepted_at_ms === null && input.status === "submitted")
      throw new SubagentValidationError(
        "submitted terminalization requires an accepted result",
      );
    if (row.stop_requested_at_ms === null && input.status === "stopped")
      throw new SubagentValidationError(
        "stopped terminalization requires an accepted stop request",
      );
    if (input.status === "submitted" && !input.resultMessageId)
      throw new SubagentValidationError(
        "submitted terminalization requires resultMessageId",
      );
    const now = input.now ?? Date.now();
    getDb()
      .prepare(
        `UPDATE subagent_runs SET status = ?, active_phase = NULL,
      required_response_message_id = NULL, required_response_state = 'none',
      required_response_answer_message_id = NULL,
      terminal_reason = ?, terminal_verdict = ?, terminal_at_ms = ?, result_message_id = ?, updated_at_ms = ?
      WHERE id = ?`,
      )
      .run(
        input.status,
        bounded(input.reason, REASON_MAX_CHARS),
        bounded(input.verdict, REASON_MAX_CHARS),
        now,
        input.resultMessageId
          ? present(input.resultMessageId, "resultMessageId")
          : null,
        now,
        row.id,
      );
    touchRun(touch, row.id);
    return runFromRow(requireRun(row.id));
  });
}

export interface UpdateRunGovernanceInput {
  runId: string;
  governingLeaseId?: string | null;
  predecessorTurnId?: string | null;
  reviewTarget?: JsonValue | null;
  now?: number;
}

function updateRunGovernance(input: UpdateRunGovernanceInput): SubagentRun {
  return mutation((touch) => {
    const row = requireRun(input.runId);
    if (TERMINAL_STATUSES.has(row.status))
      throw new SubagentImmutableError(
        `terminal subagent run ${row.id} cannot be rewritten`,
      );
    const lease =
      input.governingLeaseId === undefined
        ? row.governing_lease_id
        : input.governingLeaseId;
    const predecessor =
      input.predecessorTurnId === undefined
        ? row.predecessor_turn_id
        : input.predecessorTurnId;
    const review =
      input.reviewTarget === undefined
        ? row.review_target_json
        : input.reviewTarget === null
          ? null
          : encodeJson(input.reviewTarget, "reviewTarget");
    if (
      lease === row.governing_lease_id &&
      predecessor === row.predecessor_turn_id &&
      review === row.review_target_json
    )
      return runFromRow(row);
    const now = input.now ?? Date.now();
    getDb()
      .prepare(
        `UPDATE subagent_runs SET governing_lease_id = ?, predecessor_turn_id = ?,
      review_target_json = ?, updated_at_ms = ? WHERE id = ?`,
      )
      .run(lease, predecessor, review, now, row.id);
    touchRun(touch, row.id);
    return runFromRow(requireRun(row.id));
  });
}

export interface UpdateThreadLinkageInput {
  threadId: string;
  worktreeId?: string | null;
  cwd?: string | null;
  taskId?: number | null;
  projectId?: string | null;
  worktreeRelation?: string | null;
  worktreeProvenance?: JsonValue | null;
  now?: number;
}

function updateThreadLinkage(input: UpdateThreadLinkageInput): SubagentThread {
  return mutation((touch) => {
    const row = requireThread(input.threadId);
    const value = <T>(
      next: T | null | undefined,
      previous: T | null,
    ): T | null => (next === undefined ? previous : next);
    const worktreeId = value(input.worktreeId, row.worktree_id);
    const cwd = value(input.cwd, row.cwd);
    const taskId = value(input.taskId, row.task_id);
    const projectId = value(input.projectId, row.project_id);
    const relation = value(input.worktreeRelation, row.worktree_relation);
    const provenance =
      input.worktreeProvenance === undefined
        ? row.worktree_provenance_json
        : input.worktreeProvenance === null
          ? null
          : encodeJson(input.worktreeProvenance, "worktreeProvenance");
    const now = input.now ?? Date.now();
    getDb()
      .prepare(
        `UPDATE subagent_threads SET worktree_id = ?, cwd = ?, task_id = ?, project_id = ?,
      worktree_relation = ?, worktree_provenance_json = ?, updated_at_ms = ?, activity_at_ms = ? WHERE id = ?`,
      )
      .run(
        worktreeId,
        cwd,
        taskId,
        projectId,
        relation,
        provenance,
        now,
        now,
        row.id,
      );
    touchThread(touch, row.id);
    return threadFromRow(requireThread(row.id));
  });
}

function setParentLifecycle(
  parentSessionId: string,
  lifecycle: { archivedAt?: number | null; settledAt?: number | null },
  now = Date.now(),
): SubagentThread[] {
  return mutation((touch) => {
    const rows = getDb()
      .prepare(
        "SELECT * FROM subagent_threads WHERE parent_session_id = ? AND is_member = 1",
      )
      .all(parentSessionId) as unknown as ThreadRow[];
    const sessionIds = [parentSessionId, ...rows.map((row) => row.session_id)];
    // sessionStore remains the sole owner of session_index lifecycle/read
    // semantics. These calls share mutation's transaction, so the root,
    // descendants, inherited projection, and revisions still commit atomically.
    for (const sessionId of sessionIds) {
      if (lifecycle.archivedAt !== undefined)
        sessionStore.setArchived(
          sessionId,
          lifecycle.archivedAt !== null,
          lifecycle.archivedAt ?? now,
        );
      if (lifecycle.settledAt !== undefined)
        sessionStore.setSettled(
          sessionId,
          lifecycle.settledAt !== null,
          lifecycle.settledAt ?? now,
        );
    }

    for (const row of rows) {
      const archivedAt =
        lifecycle.archivedAt === undefined
          ? row.inherited_archived_at_ms
          : lifecycle.archivedAt;
      const settledAt =
        lifecycle.settledAt === undefined
          ? row.inherited_settled_at_ms
          : lifecycle.settledAt;
      if (
        archivedAt === row.inherited_archived_at_ms &&
        settledAt === row.inherited_settled_at_ms
      )
        continue;
      getDb()
        .prepare(
          `UPDATE subagent_threads SET inherited_archived_at_ms = ?, inherited_settled_at_ms = ?,
        updated_at_ms = ? WHERE id = ?`,
        )
        .run(archivedAt, settledAt, now, row.id);
      touchThread(touch, row.id);
    }
    return rows.map((row) => threadFromRow(requireThread(row.id)));
  });
}

export interface RecordSubagentUsageInput {
  threadId: string;
  runId: string;
  completionId: string;
  /** Authoritative cumulative snapshot derived from finalized durable entries. */
  cumulative: SubagentUsageTotals;
  state: SubagentUsageState;
  completeness: SubagentUsageCompleteness;
  now?: number;
}

/** Replace mirrors from one authoritative completion snapshot; never increment callbacks. */
function recordUsage(input: RecordSubagentUsageInput): {
  thread: SubagentThread;
  run: SubagentRun;
} {
  return mutation((touch) => {
    const thread = requireThread(input.threadId);
    const run = requireRun(input.runId);
    if (run.thread_id !== thread.id)
      throw new SubagentValidationError(
        `run ${run.id} does not belong to thread ${thread.id}`,
      );
    const completionId = present(input.completionId, "completionId");
    validateUsage(input.cumulative, "cumulative");
    const delta = usageDeltaFromBaseline(
      input.cumulative,
      usageFrom("opening", run),
    );
    validateUsage(delta, "delta");
    const oldCumulative = usageFrom("usage", thread);
    const oldDelta = usageFrom("delta", run);
    if (
      thread.usage_completion_id === completionId &&
      run.usage_completion_id === completionId
    ) {
      if (
        !usageEqual(oldCumulative, input.cumulative) ||
        !usageEqual(oldDelta, delta) ||
        run.usage_state !== input.state ||
        run.usage_completeness !== input.completeness
      )
        throw new SubagentImmutableError(
          `completion ${completionId} was already recorded with different usage`,
        );
      return { thread: threadFromRow(thread), run: runFromRow(run) };
    }
    if (run.usage_state === "final")
      throw new SubagentImmutableError(`run ${run.id} already has final usage`);
    assertUsageNotDecreased(input.cumulative, oldCumulative, "cumulative");
    assertUsageNotDecreased(delta, oldDelta, "delta");
    const now = input.now ?? Date.now();
    getDb()
      .prepare(
        `UPDATE subagent_threads SET usage_input_tokens = ?, usage_output_tokens = ?,
      usage_cache_read_tokens = ?, usage_cache_write_tokens = ?, usage_cost_micros = ?,
      usage_completion_id = ?, updated_at_ms = ?, activity_at_ms = ? WHERE id = ?`,
      )
      .run(...usageArgs(input.cumulative), completionId, now, now, thread.id);
    getDb()
      .prepare(
        `UPDATE subagent_runs SET delta_input_tokens = ?, delta_output_tokens = ?,
      delta_cache_read_tokens = ?, delta_cache_write_tokens = ?, delta_cost_micros = ?,
      usage_completion_id = ?, usage_state = ?, usage_completeness = ?, updated_at_ms = ? WHERE id = ?`,
      )
      .run(
        ...usageArgs(delta),
        completionId,
        input.state,
        input.completeness,
        now,
        run.id,
      );
    touchRun(touch, run.id);
    return {
      thread: threadFromRow(requireThread(thread.id)),
      run: runFromRow(requireRun(run.id)),
    };
  });
}

/** Task-490 extension point: only an already inactive parent tree can be tombstoned. */
function tombstoneParentTree(
  parentSessionId: string,
  now = Date.now(),
): SubagentStateChange {
  let captured: SubagentStateChange | undefined;
  mutation(
    (touch) => {
      const threads = getDb()
        .prepare(
          "SELECT id FROM subagent_threads WHERE parent_session_id = ? AND is_member = 1",
        )
        .all(parentSessionId) as Array<{ id: string }>;
      if (threads.length === 0) return;
      const ids = threads.map((row) => row.id);
      const active = getDb()
        .prepare(
          `SELECT id FROM subagent_runs WHERE thread_id IN (${ids.map(() => "?").join(", ")})
        AND is_member = 1 AND (status IN ('pending','running','awaiting-parent') OR execution_quiescent = 0) LIMIT 1`,
        )
        .get(...(ids as never[])) as { id: string } | undefined;
      if (active)
        throw new SubagentValidationError(
          `parent tree still has active subagent run ${active.id}`,
        );
      const runs = getDb()
        .prepare(
          `SELECT id FROM subagent_runs WHERE thread_id IN (${ids.map(() => "?").join(", ")}) AND is_member = 1`,
        )
        .all(...(ids as never[])) as Array<{ id: string }>;
      getDb()
        .prepare(
          `UPDATE subagent_runs SET is_member = 0, deleted_at_ms = ?, initiated_by = NULL,
        triggering_peer_prompt_id = NULL, required_response_message_id = NULL, required_response_state = 'none',
        required_response_answer_message_id = NULL, optional_result_correlation_id = NULL,
        contract_id = NULL, contract_version = NULL, actual_thinking = NULL, governing_lease_id = NULL,
        predecessor_turn_id = NULL, review_target_json = NULL,
        accepted_reported_status = NULL, accepted_summary = NULL, accepted_payload_json = NULL,
        accepted_host_facts_json = NULL, result_accepted_at_ms = NULL,
        stop_request_reason = NULL, terminal_reason = NULL, terminal_verdict = NULL
        WHERE thread_id IN (${ids.map(() => "?").join(", ")}) AND is_member = 1`,
        )
        .run(now, ...(ids as never[]));
      getDb()
        .prepare(
          `UPDATE subagent_threads SET is_member = 0, deleted_at_ms = ?, peer_conversation_id = NULL,
        role_name = NULL, base_role = NULL, worktree_id = NULL, cwd = NULL, task_id = NULL, project_id = NULL,
        worktree_relation = NULL, worktree_provenance_json = NULL,
        provider = NULL, model_id = NULL, credential_profile_id = NULL, account_source = NULL,
        degraded_pin_reason = NULL, default_thinking = NULL, hard_max_thinking = NULL,
        execution_profile_id = NULL, contract_id = NULL, contract_version = NULL,
        usage_completion_id = NULL WHERE parent_session_id = ? AND is_member = 1`,
        )
        .run(now, parentSessionId);
      for (const row of threads) touchThread(touch, row.id);
      for (const row of runs) touchRun(touch, row.id);
    },
    (change) => {
      captured = change;
    },
  );
  return captured ?? { threadIds: [], runIds: [], parentSessionIds: [] };
}

function parentUsageTotals(parentSessionId: string): SubagentUsageTotals {
  const own = sessionStore.getUsageTotals(parentSessionId);
  const child = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(usage_input_tokens), 0) AS input_tokens,
         COALESCE(SUM(usage_output_tokens), 0) AS output_tokens,
         COALESCE(SUM(usage_cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(usage_cache_write_tokens), 0) AS cache_write_tokens,
         SUM(usage_cost_micros) AS cost_micros
       FROM subagent_threads
       WHERE parent_session_id = ? AND is_member = 1`,
    )
    .get(parentSessionId) as {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_micros: number | null;
  };
  const totals: SubagentUsageTotals = {
    inputTokens: (own?.inputTokens ?? 0) + child.input_tokens,
    outputTokens: (own?.outputTokens ?? 0) + child.output_tokens,
    cacheReadTokens: (own?.cacheReadTokens ?? 0) + child.cache_read_tokens,
    cacheWriteTokens: (own?.cacheWriteTokens ?? 0) + child.cache_write_tokens,
  };
  if (own?.costMicros !== undefined || child.cost_micros !== null)
    totals.costMicros = (own?.costMicros ?? 0) + (child.cost_micros ?? 0);
  validateUsage(totals, "parent usage totals");
  return totals;
}

/** One grouped read for the frequently rebuilt parent session-list projection. */
function delegationSummaries(): Map<string, SubagentDelegationSummary> {
  const rows = getDb()
    .prepare(
      `SELECT t.parent_session_id, r.status, r.active_phase, COUNT(*) AS count
       FROM subagent_runs r
       JOIN subagent_threads t ON t.id = r.thread_id
       WHERE t.is_member = 1 AND r.is_member = 1
         AND r.status IN ('pending', 'running', 'awaiting-parent')
       GROUP BY t.parent_session_id, r.status, r.active_phase`,
    )
    .all() as Array<{
    parent_session_id: string;
    status: SubagentRunStatus;
    active_phase: SubagentExecutionPhase;
    count: number;
  }>;
  const summaries = new Map<string, SubagentDelegationSummary>();
  for (const row of rows) {
    const summary = summaries.get(row.parent_session_id) ?? {
      activeCount: 0,
      startingCount: 0,
      workingCount: 0,
      awaitingParentCount: 0,
    };
    summary.activeCount += row.count;
    if (row.status === "awaiting-parent")
      summary.awaitingParentCount += row.count;
    else if (
      row.status === "pending" ||
      row.active_phase === "predecessor-wait" ||
      row.active_phase === "pending-dispatch"
    )
      summary.startingCount += row.count;
    else summary.workingCount += row.count;
    summaries.set(row.parent_session_id, summary);
  }
  return summaries;
}

/** Durable immediate-parent facts used by settlement and workflow completion. */
function delegationObligations(
  parentSessionId: string,
): DelegationObligationProjection {
  const active = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
       FROM subagent_runs r
       JOIN subagent_threads t ON t.id = r.thread_id
       WHERE t.parent_session_id = ? AND t.is_member = 1 AND r.is_member = 1
         AND r.status IN ('pending', 'running', 'awaiting-parent')`,
    )
    .get(parentSessionId) as { count: number };
  const unadmitted = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
       FROM subagent_runs r
       JOIN subagent_threads t ON t.id = r.thread_id
       WHERE t.parent_session_id = ? AND t.is_member = 1 AND r.is_member = 1
         AND r.result_accepted_at_ms IS NOT NULL AND r.result_message_id IS NULL`,
    )
    .get(parentSessionId) as { count: number };
  const managed = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT worktree_id) AS count
       FROM subagent_threads
       WHERE parent_session_id = ? AND is_member = 1
         AND worktree_id IS NOT NULL AND worktree_relation = 'managed'`,
    )
    .get(parentSessionId) as { count: number };
  return {
    activeRunCount: active.count,
    unadmittedResultCount: unadmitted.count,
    ownedManagedWorktreeCount: managed.count,
  };
}

function getThread(id: string): SubagentThread | undefined {
  const row = rawThread(id);
  return row ? threadFromRow(row) : undefined;
}

function getThreadBySessionId(sessionId: string): SubagentThread | undefined {
  const row = getDb()
    .prepare(
      "SELECT * FROM subagent_threads WHERE session_id = ? AND is_member = 1",
    )
    .get(sessionId) as ThreadRow | undefined;
  return row ? threadFromRow(row) : undefined;
}

function getRun(id: string, includeDeleted = false): SubagentRun | undefined {
  const row = rawRun(id, includeDeleted);
  return row ? runFromRow(row) : undefined;
}

function latestRun(threadId: string): SubagentRun | undefined {
  const row = getDb()
    .prepare(
      "SELECT * FROM subagent_runs WHERE thread_id = ? AND is_member = 1 ORDER BY thread_seq DESC LIMIT 1",
    )
    .get(threadId) as RunRow | undefined;
  return row ? runFromRow(row) : undefined;
}

function activeRun(threadId: string): SubagentRun | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM subagent_runs WHERE thread_id = ? AND is_member = 1
       AND status IN ('pending', 'running', 'awaiting-parent')
       ORDER BY thread_seq DESC LIMIT 1`,
    )
    .get(threadId) as RunRow | undefined;
  return row ? runFromRow(row) : undefined;
}

function listThreads(
  options: {
    parentSessionId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
): SubagentThread[] {
  const limit = Math.min(
    200,
    positiveSafeInteger(options.limit ?? 50, "limit"),
  );
  const offset = options.offset ?? 0;
  nonnegativeSafeInteger(offset, "offset");
  const clauses = ["is_member = 1"];
  const params: unknown[] = [];
  if (options.parentSessionId) {
    clauses.push("parent_session_id = ?");
    params.push(options.parentSessionId);
  }
  if (options.search) {
    clauses.push(
      `(role_name LIKE ? ESCAPE '\\' OR session_id LIKE ? ESCAPE '\\'
        OR COALESCE(project_id, '') LIKE ? ESCAPE '\\'
        OR COALESCE(worktree_id, '') LIKE ? ESCAPE '\\')`,
    );
    const escaped = options.search.replace(/[\\%_]/g, "\\$&");
    const needle = `%${escaped}%`;
    params.push(needle, needle, needle, needle);
  }
  params.push(limit, offset);
  const rows = getDb()
    .prepare(
      `SELECT * FROM subagent_threads WHERE ${clauses.join(" AND ")}
    ORDER BY activity_at_ms DESC, id LIMIT ? OFFSET ?`,
    )
    .all(...(params as never[])) as unknown as ThreadRow[];
  return rows.map(threadFromRow);
}

function listRuns(
  threadId: string,
  options: { limit?: number; beforeSequence?: number } = {},
): SubagentRun[] {
  requireThread(threadId);
  const limit = Math.min(
    200,
    positiveSafeInteger(options.limit ?? 50, "limit"),
  );
  const clauses = ["thread_id = ?", "is_member = 1"];
  const params: unknown[] = [threadId];
  if (options.beforeSequence !== undefined) {
    positiveSafeInteger(options.beforeSequence, "beforeSequence");
    clauses.push("thread_seq < ?");
    params.push(options.beforeSequence);
  }
  params.push(limit);
  const rows = getDb()
    .prepare(
      `SELECT * FROM subagent_runs WHERE ${clauses.join(" AND ")}
    ORDER BY thread_seq DESC LIMIT ?`,
    )
    .all(...(params as never[])) as unknown as RunRow[];
  return rows.map(runFromRow);
}

function threadRevisions(): SubagentRevisionRow[] {
  return (
    getDb()
      .prepare("SELECT id, revision, is_member FROM subagent_threads")
      .all() as Array<{
      id: string;
      revision: number;
      is_member: number;
    }>
  ).map((row) => ({
    id: row.id,
    revision: row.revision,
    member: Boolean(row.is_member),
  }));
}

function runRevisions(threadId?: string): SubagentRevisionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, revision, is_member FROM subagent_runs${threadId ? " WHERE thread_id = ?" : ""}`,
    )
    .all(...(threadId ? [threadId] : [])) as Array<{
    id: string;
    revision: number;
    is_member: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    member: Boolean(row.is_member),
  }));
}

/** Kept beside the facade so architecture tests can require coverage for every write seam. */
export const SUBAGENT_PUBLIC_WRITE_PATHS = [
  "acceptInitial",
  "acceptContinuation",
  "transitionExecution",
  "awaitParent",
  "resumeFromParent",
  "reserveWatchdog",
  "admitWatchdog",
  "completeWatchdog",
  "acceptResult",
  "requestStop",
  "recordQuiescence",
  "finalizeRun",
  "updateRunGovernance",
  "updateThreadLinkage",
  "setParentLifecycle",
  "recordUsage",
  "tombstoneParentTree",
] as const;

export const subagentStore = {
  acceptInitial,
  acceptContinuation,
  transitionExecution,
  awaitParent,
  resumeFromParent,
  reserveWatchdog,
  admitWatchdog,
  completeWatchdog,
  acceptResult,
  requestStop,
  recordQuiescence,
  finalizeRun,
  updateRunGovernance,
  updateThreadLinkage,
  setParentLifecycle,
  recordUsage,
  tombstoneParentTree,
  getThread,
  getThreadBySessionId,
  getRun,
  latestRun,
  activeRun,
  listThreads,
  listRuns,
  parentUsageTotals,
  delegationSummaries,
  delegationObligations,
  threadRevisions,
  runRevisions,
};
