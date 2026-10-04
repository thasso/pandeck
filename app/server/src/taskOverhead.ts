/**
 * Task 299: what Task bookkeeping costs a session, measured from real sessions.
 *
 * The sub-epic ([Task-260](pa://task/260)) removed provider round trips, so the
 * unit of the answer is PROVIDER CALLS and the input those calls made the
 * provider process — not tool-output bytes, which are the cheap part. This
 * module is the instrument behind `pnpm run measure:tasks`; `docs/tasks.md`
 * holds the numbers it produced and the decisions they justified.
 *
 * ## What one Task call costs
 *
 * A tool call always forces a CONTINUATION call: the model cannot end its turn
 * on a tool use, so the whole conversation is sent again to consume the result.
 * A turn whose tool calls are ALL `task_*` is bookkeeping-only — the work would
 * have proceeded without it — so its continuation is the marginal cost, and it
 * is charged here as one round trip plus the continuation's input. That input
 * is reported twice: PROCESSED (`input + cacheRead + cacheWrite` — everything
 * the provider read) and NEW (`input + cacheWrite` — what a cache hit did not
 * cover). Both belong in the answer: the processed figure is what the round
 * trip made the provider walk, the new figure is what it actually paid for. A
 * turn that mixes a Task call into real tool work costs no extra round trip; it
 * is counted as a call but not as a round trip, which is exactly the batching
 * win the epic was after.
 *
 * The removed Planner → Implementer → Reviewer tools (Task-264) are `task_*`
 * too, so they are counted apart as `workflowCalls`: they inflate the before
 * window for a reason that is a different change.
 *
 * ## Where the per-call record comes from
 *
 * - pi: `DATA_DIR/sessions/<id>/native.jsonl` — one assistant message per
 *   provider call, each carrying its own usage. Complete.
 * - Claude with a CLI transcript: the `<providerSessionId>.jsonl` under
 *   `~/.claude/projects`, joined through `session_index.provider_session_id`
 *   and its per-project directory. Sidechain (subagent)
 *   lines are skipped: they are a different conversation with its own budget.
 * - Claude without one: `DATA_DIR/claude-sdk/<id>.json` collapses a whole turn
 *   into ONE assistant entry, so calls can be counted but round trips cannot.
 *   Those sessions report `providerCalls: undefined` and are excluded from the
 *   round-trip and token aggregates rather than guessed at; every aggregate
 *   carries the session count it was computed over.
 *
 * ## Windows, not a single before/after moment
 *
 * The slices landed over one day, so a session started between the first and
 * the last saw a mixture. Sessions before {@link TASK_SURFACE_BEFORE_END_MS}
 * are `before`, sessions after {@link TASK_SURFACE_AFTER_START_MS} are `after`,
 * and everything in between is reported as `transition` and left out of the
 * comparison.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentType } from "@assistant/shared";
import { readClaudeSdkRecord } from "./claudeSdk/claudeSdkRecords.ts";
import { DATA_DIR } from "./config.ts";
import { MCP_SERVER_NAME } from "./mcp/names.ts";
import { eagerToolNamesFor, toolGroupsFor } from "./tools/catalog.ts";

/**
 * `0b13cc5c` — the first slice that changed what an agent sees (the status
 * suggestion). A session started before this saw the audited surface.
 */
const TASK_SURFACE_BEFORE_END_MS = Date.parse("2026-08-01T10:45:25+02:00");

/**
 * `c6c6f180` — the last slice that changed the Task surface (the rules moved
 * into the tool descriptions). A session started after this saw all of it.
 */
const TASK_SURFACE_AFTER_START_MS = Date.parse("2026-08-01T20:42:11+02:00");

/** Planning's eager Task tool figure, in bytes, kept as the stated baseline. */
export const PLANNING_EAGER_TASK_BYTES = 7357;

type OverheadHarness = "pi" | "claude-sdk";

type OverheadWindow = "before" | "transition" | "after";

/** Where a session's calls (and, when available, its usage) were read from. */
type OverheadSource = "pi-native" | "claude-transcript" | "claude-store";

/**
 * The Task lifecycle an audited session walked: read → `doing` → comment →
 * `done` → corrective `todo`. Steps are counted per OPERATION, not per call, so
 * a batched closeout shows the same steps at a fraction of the calls.
 */
export const LIFECYCLE_STEPS = [
  "read",
  "start",
  "comment",
  "done",
  "handback",
  "create",
  "describe",
  "workflow",
  "other",
] as const;

export type LifecycleStep = (typeof LIFECYCLE_STEPS)[number];

export type LifecycleCounts = Record<LifecycleStep, number>;

interface SessionOverhead {
  sessionId: string;
  harness: OverheadHarness;
  agentType: string;
  createdAtMs: number;
  window: OverheadWindow;
  /** A Task was attached to this session (`links`: session → context → task). */
  taskAttached: boolean;
  attachedTaskId: string | undefined;
  source: OverheadSource;
  /** Undefined when the source collapses turns and cannot resolve calls. */
  providerCalls: number | undefined;
  taskCalls: number;
  /** Calls to the removed Planner → Implementer → Reviewer family (Task-264). */
  workflowCalls: number;
  callsByTool: Record<string, number>;
  lifecycle: LifecycleCounts;
  /**
   * Task calls made BEFORE the session's first non-Task tool call — the
   * "read the Task the attachment already carries, then start" opening that
   * [Task-296](pa://task/296) set out to reach zero.
   */
  preWorkTaskCalls: number | undefined;
  /** `task_read` calls naming the attached Task itself, at any point. */
  attachedTaskReads: number;
  /** Turns whose tool calls were all `task_*`; each forces one continuation. */
  bookkeepingRoundTrips: number | undefined;
  /** Everything the provider read on the continuations actually recorded. */
  processedInputTokens: number | undefined;
  /** The part of it no cache hit covered (`input + cacheWrite`). */
  newInputTokens: number | undefined;
  /** How many of those continuations the transcript still holds. */
  attributedContinuations: number | undefined;
}

export interface WindowAggregate {
  window: OverheadWindow;
  sessions: number;
  taskAttachedSessions: number;
  sessionsWithTaskCalls: number;
  /** Sessions whose source resolves provider calls (the round-trip cohort). */
  measuredSessions: number;
  taskCalls: number;
  workflowCalls: number;
  callsByTool: Record<string, number>;
  lifecycle: LifecycleCounts;
  bookkeepingRoundTrips: number;
  providerCalls: number;
  processedInputTokens: number;
  newInputTokens: number;
  /**
   * Per Task-attached session in this window. Call counts average over EVERY
   * Task-attached session (`sessions`); the round-trip, ordering and token
   * figures average only over those whose source resolves provider calls
   * (`measuredSessions`), because for the rest they do not exist.
   */
  perAttachedSession: {
    sessions: number;
    measuredSessions: number;
    taskCalls: number;
    workflowCalls: number;
    attachedTaskReads: number;
    lifecycle: LifecycleCounts;
    preWorkTaskCalls: number;
    bookkeepingRoundTrips: number;
    processedInputTokens: number;
    newInputTokens: number;
  };
}

export interface TaskToolCost {
  tool: string;
  harness: "pi" | "claude";
  nameChars: number;
  descriptionChars: number;
  schemaChars: number;
  chars: number;
}

interface StorageCounters {
  tasks: number;
  tasksByCreator: Record<string, number>;
  medianLifetimeMinutes: Record<string, number | undefined>;
  comments: number;
  commentsByAuthorKind: Record<string, number>;
  tasksWithOneComment: number;
  commentedTasks: number;
  commentedTasksMultiSession: number;
  statusEventsByActor: Record<string, number>;
  /**
   * Agent `doing → todo` writes. Before the suggestion slice these were the
   * corrective SECOND call the epic set out to remove; after it, the same event
   * is the move a `done` suggestion makes on its own (Task-293), so the two
   * windows do not mean the same thing and are never summed.
   */
  agentDoingToTodo: { before: number; transition: number; after: number };
  statusSuggestionsPending: number;
}

export interface TaskOverheadReport {
  dataDir: string;
  claudeProjectsDir: string | undefined;
  beforeEndMs: number;
  afterStartMs: number;
  earliestSessionMs: number | undefined;
  latestSessionMs: number | undefined;
  sessions: SessionOverhead[];
  windows: WindowAggregate[];
  coverage: {
    sessions: number;
    piWithTranscript: number;
    piWithoutTranscript: number;
    claudeWithTranscript: number;
    claudeStoreOnly: number;
    claudeUnreadable: number;
  };
  eagerTaskTools: TaskToolCost[];
  eagerTaskCharsByHarness: Record<"pi" | "claude", number>;
  storage: StorageCounters | undefined;
}

export interface TaskOverheadOptions {
  dataDir?: string;
  /** Claude CLI transcript root; `undefined` disables the join entirely. */
  claudeProjectsDir?: string | undefined;
  beforeEndMs?: number;
  afterStartMs?: number;
  /** Ignore sessions created before this instant. */
  sinceMs?: number;
  /** The persona whose eager tool block is measured. */
  agentType?: AgentType;
}

const TASK_TOOL_PREFIX = "task_";
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** The removed Planner → Implementer → Reviewer family (Task-264). */
const WORKFLOW_TOOL_PREFIXES = [
  "task_workflow",
  "task_plan",
  "task_review",
  "task_role",
];

function emptyLifecycle(): LifecycleCounts {
  return Object.fromEntries(
    LIFECYCLE_STEPS.map((step) => [step, 0]),
  ) as LifecycleCounts;
}

function addLifecycle(into: LifecycleCounts, from: LifecycleCounts): void {
  for (const step of LIFECYCLE_STEPS) into[step] += from[step];
}

function bareToolName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

function isTaskTool(name: string): boolean {
  return bareToolName(name).startsWith(TASK_TOOL_PREFIX);
}

function isWorkflowTool(name: string): boolean {
  const tool = bareToolName(name);
  return WORKFLOW_TOOL_PREFIXES.some((prefix) => tool.startsWith(prefix));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The lifecycle steps one Task tool call performed. A `task_manage` call is
 * read through its operations, so the batching the epic bought is visible as
 * "same steps, fewer calls" rather than as steps disappearing.
 */
export function lifecycleStepsOf(
  name: string,
  input: unknown,
): LifecycleStep[] {
  const tool = bareToolName(name);
  if (isWorkflowTool(tool)) return ["workflow"];
  if (tool === "task_read") return ["read"];
  // The deleted stand-alone comment tool (Task-294 folded it into task_manage).
  if (tool === "task_comment") return ["comment"];
  if (tool !== "task_manage") return ["other"];

  const args = asRecord(input);
  const rawOps = Array.isArray(args.operations) ? args.operations : [args];
  const steps: LifecycleStep[] = [];
  for (const raw of rawOps) {
    const op = asRecord(raw);
    const kind = typeof op.operation === "string" ? op.operation : "";
    if (typeof op.comment === "string" && op.comment.trim())
      steps.push("comment");
    if (kind === "comment") {
      // The bare comment op; its body may ride `comment` or `body`.
      if (!steps.includes("comment")) steps.push("comment");
      continue;
    }
    if (kind === "create") {
      steps.push("create");
      continue;
    }
    const status = typeof op.status === "string" ? op.status : "";
    if (status === "doing") steps.push("start");
    else if (status === "done") steps.push("done");
    else if (status === "todo") steps.push("handback");
    if (
      Array.isArray(op.descriptionEdits) ||
      typeof op.description === "string"
    )
      steps.push("describe");
    if (steps.length === 0) steps.push("other");
  }
  return steps.length > 0 ? steps : ["other"];
}

/** One provider call: what it asked for, and what the provider read for it. */
interface ProviderCall {
  taskTools: { name: string; input: unknown }[];
  otherToolCalls: number;
  processedInputTokens: number;
  newInputTokens: number;
}

interface CallScan {
  calls: ProviderCall[];
  /** False when the source collapses turns and cannot resolve calls. */
  resolvesCalls: boolean;
}

function readJsonl(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A half-written last line during a live session is not a measurement error.
    }
  }
  return out;
}

/** pi writes one assistant message per provider call, with its own usage. */
function scanPiNative(path: string): CallScan {
  const calls: ProviderCall[] = [];
  for (const entry of readJsonl(path)) {
    const record = asRecord(entry);
    if (record.type !== "message") continue;
    const message = asRecord(record.message);
    if (message.role !== "assistant") continue;
    const usage = asRecord(message.usage);
    const call: ProviderCall = {
      taskTools: [],
      otherToolCalls: 0,
      processedInputTokens:
        Number(usage.input ?? 0) +
        Number(usage.cacheRead ?? 0) +
        Number(usage.cacheWrite ?? 0),
      newInputTokens: Number(usage.input ?? 0) + Number(usage.cacheWrite ?? 0),
    };
    for (const raw of Array.isArray(message.content) ? message.content : []) {
      const block = asRecord(raw);
      if (block.type !== "toolCall") continue;
      const name = typeof block.name === "string" ? block.name : "";
      if (isTaskTool(name))
        call.taskTools.push({
          name: bareToolName(name),
          input: block.arguments,
        });
      else call.otherToolCalls += 1;
    }
    calls.push(call);
  }
  return { calls, resolvesCalls: true };
}

/**
 * The Claude CLI transcript: one `assistant` line per provider response, keyed
 * by `requestId` so a response split across lines counts once.
 */
function scanClaudeTranscript(path: string): CallScan {
  const calls: ProviderCall[] = [];
  const byRequest = new Map<string, ProviderCall>();
  for (const entry of readJsonl(path)) {
    const record = asRecord(entry);
    if (record.type !== "assistant" || record.isSidechain === true) continue;
    const message = asRecord(record.message);
    const usage = asRecord(message.usage);
    const requestId =
      typeof record.requestId === "string" ? record.requestId : undefined;
    let call = requestId ? byRequest.get(requestId) : undefined;
    if (!call) {
      call = {
        taskTools: [],
        otherToolCalls: 0,
        processedInputTokens:
          Number(usage.input_tokens ?? 0) +
          Number(usage.cache_creation_input_tokens ?? 0) +
          Number(usage.cache_read_input_tokens ?? 0),
        newInputTokens:
          Number(usage.input_tokens ?? 0) +
          Number(usage.cache_creation_input_tokens ?? 0),
      };
      calls.push(call);
      if (requestId) byRequest.set(requestId, call);
    }
    for (const raw of Array.isArray(message.content) ? message.content : []) {
      const block = asRecord(raw);
      if (block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      if (isTaskTool(name))
        call.taskTools.push({ name: bareToolName(name), input: block.input });
      else call.otherToolCalls += 1;
    }
  }
  return { calls, resolvesCalls: true };
}

/**
 * The app's own Claude store. Its assistant entries are whole TURNS, so the
 * calls are all there but their round trips are not recoverable — every block
 * lands in one pseudo-call that the aggregates then refuse to charge.
 */
function scanClaudeStore(entries: readonly unknown[]): CallScan {
  const call: ProviderCall = {
    taskTools: [],
    otherToolCalls: 0,
    processedInputTokens: 0,
    newInputTokens: 0,
  };
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (entry.role !== "assistant") continue;
    for (const rawBlock of Array.isArray(entry.content) ? entry.content : []) {
      const block = asRecord(rawBlock);
      if (block.type !== "toolCall") continue;
      const name = typeof block.name === "string" ? block.name : "";
      if (isTaskTool(name))
        call.taskTools.push({ name: bareToolName(name), input: block.input });
      else call.otherToolCalls += 1;
    }
  }
  return { calls: [call], resolvesCalls: false };
}

/** Index every Claude CLI transcript by its provider session id. */
function indexClaudeTranscripts(root: string): Map<string, string> {
  const index = new Map<string, string>();
  if (!existsSync(root)) return index;
  for (const dir of readdirSync(root)) {
    const path = join(root, dir);
    try {
      if (!statSync(path).isDirectory()) continue;
      for (const file of readdirSync(path)) {
        if (!file.endsWith(".jsonl")) continue;
        index.set(file.slice(0, -".jsonl".length), join(path, file));
      }
    } catch {
      // An unreadable project dir is not worth failing a measurement over.
    }
  }
  return index;
}

function summarize(
  scan: CallScan,
  base: Omit<
    SessionOverhead,
    | "providerCalls"
    | "taskCalls"
    | "workflowCalls"
    | "callsByTool"
    | "lifecycle"
    | "preWorkTaskCalls"
    | "attachedTaskReads"
    | "bookkeepingRoundTrips"
    | "processedInputTokens"
    | "newInputTokens"
    | "attributedContinuations"
  >,
): SessionOverhead {
  const callsByTool: Record<string, number> = {};
  const lifecycle = emptyLifecycle();
  let taskCalls = 0;
  let workflowCalls = 0;
  let preWork = 0;
  let attachedReads = 0;
  let realWorkStarted = false;
  let roundTrips = 0;
  let processed = 0;
  let newInput = 0;
  let attributed = 0;

  scan.calls.forEach((call, index) => {
    for (const { name, input } of call.taskTools) {
      taskCalls += 1;
      if (isWorkflowTool(name)) workflowCalls += 1;
      if (!realWorkStarted) preWork += 1;
      if (
        bareToolName(name) === "task_read" &&
        base.attachedTaskId !== undefined &&
        String(asRecord(input).id ?? "") === base.attachedTaskId
      )
        attachedReads += 1;
      callsByTool[name] = (callsByTool[name] ?? 0) + 1;
      for (const step of lifecycleStepsOf(name, input)) lifecycle[step] += 1;
    }
    if (call.otherToolCalls > 0) realWorkStarted = true;
    if (!scan.resolvesCalls) return;
    if (call.taskTools.length === 0 || call.otherToolCalls > 0) return;
    // Bookkeeping-only turn: it bought one continuation and nothing else.
    roundTrips += 1;
    const next = scan.calls[index + 1];
    if (next) {
      processed += next.processedInputTokens;
      newInput += next.newInputTokens;
      attributed += 1;
    }
  });

  return {
    ...base,
    providerCalls: scan.resolvesCalls ? scan.calls.length : undefined,
    taskCalls,
    workflowCalls,
    callsByTool,
    lifecycle,
    // A collapsed store keeps no call order, so "before real work" is unknowable.
    preWorkTaskCalls: scan.resolvesCalls ? preWork : undefined,
    attachedTaskReads: attachedReads,
    bookkeepingRoundTrips: scan.resolvesCalls ? roundTrips : undefined,
    processedInputTokens: scan.resolvesCalls ? processed : undefined,
    newInputTokens: scan.resolvesCalls ? newInput : undefined,
    attributedContinuations: scan.resolvesCalls ? attributed : undefined,
  };
}

function aggregate(
  window: OverheadWindow,
  sessions: SessionOverhead[],
): WindowAggregate {
  const callsByTool: Record<string, number> = {};
  const lifecycle = emptyLifecycle();
  const attachedLifecycle = emptyLifecycle();
  let taskCalls = 0;
  let workflowCalls = 0;
  let roundTrips = 0;
  let providerCalls = 0;
  let processed = 0;
  let newInput = 0;
  let measured = 0;
  let attachedSessions = 0;
  let attachedMeasured = 0;
  let attachedTaskCalls = 0;
  let attachedWorkflowCalls = 0;
  let attachedReads = 0;
  let attachedPreWork = 0;
  let attachedRoundTrips = 0;
  let attachedProcessed = 0;
  let attachedNewInput = 0;

  for (const session of sessions) {
    taskCalls += session.taskCalls;
    workflowCalls += session.workflowCalls;
    for (const [tool, count] of Object.entries(session.callsByTool))
      callsByTool[tool] = (callsByTool[tool] ?? 0) + count;
    addLifecycle(lifecycle, session.lifecycle);
    const resolved = session.providerCalls !== undefined;
    if (resolved) {
      measured += 1;
      providerCalls += session.providerCalls ?? 0;
      roundTrips += session.bookkeepingRoundTrips ?? 0;
      processed += session.processedInputTokens ?? 0;
      newInput += session.newInputTokens ?? 0;
    }
    if (!session.taskAttached) continue;
    // Counting calls needs no per-call record, so it uses every attached
    // session; only the round-trip and token halves need the narrower cohort.
    attachedSessions += 1;
    attachedTaskCalls += session.taskCalls;
    attachedWorkflowCalls += session.workflowCalls;
    attachedReads += session.attachedTaskReads;
    addLifecycle(attachedLifecycle, session.lifecycle);
    if (!resolved) continue;
    attachedMeasured += 1;
    attachedPreWork += session.preWorkTaskCalls ?? 0;
    attachedRoundTrips += session.bookkeepingRoundTrips ?? 0;
    attachedProcessed += session.processedInputTokens ?? 0;
    attachedNewInput += session.newInputTokens ?? 0;
  }

  const perAttached = (total: number): number =>
    attachedSessions > 0 ? total / attachedSessions : 0;
  const perMeasured = (total: number): number =>
    attachedMeasured > 0 ? total / attachedMeasured : 0;
  const perLifecycle = emptyLifecycle();
  for (const step of LIFECYCLE_STEPS)
    perLifecycle[step] = perAttached(attachedLifecycle[step]);

  return {
    window,
    sessions: sessions.length,
    taskAttachedSessions: attachedSessions,
    sessionsWithTaskCalls: sessions.filter((s) => s.taskCalls > 0).length,
    measuredSessions: measured,
    taskCalls,
    workflowCalls,
    callsByTool,
    lifecycle,
    bookkeepingRoundTrips: roundTrips,
    providerCalls,
    processedInputTokens: processed,
    newInputTokens: newInput,
    perAttachedSession: {
      sessions: attachedSessions,
      measuredSessions: attachedMeasured,
      taskCalls: perAttached(attachedTaskCalls),
      workflowCalls: perAttached(attachedWorkflowCalls),
      attachedTaskReads: perAttached(attachedReads),
      lifecycle: perLifecycle,
      preWorkTaskCalls: perMeasured(attachedPreWork),
      bookkeepingRoundTrips: perMeasured(attachedRoundTrips),
      processedInputTokens: perMeasured(attachedProcessed),
      newInputTokens: perMeasured(attachedNewInput),
    },
  };
}

/**
 * The eager Task tools' share of a session's first request, in the same
 * accounting as `pnpm run measure:prompts` (wire name + description + schema),
 * per harness — the two differ by the `mcp__pa__` prefix and by nothing else
 * since the pi-only guidance fields were deleted (Task-282).
 */
export function eagerTaskToolCosts(
  agentType: AgentType = "developer",
): TaskToolCost[] {
  const eager = eagerToolNamesFor(agentType);
  const tools = toolGroupsFor(agentType)
    .flatMap((group) => group.tools)
    .filter((tool) => eager.has(tool.name) && isTaskTool(tool.name));
  const rows: TaskToolCost[] = [];
  for (const harness of ["pi", "claude"] as const) {
    for (const tool of tools) {
      const wireName =
        harness === "claude" ? `${MCP_PREFIX}${tool.name}` : tool.name;
      const nameChars = wireName.length;
      const descriptionChars = tool.description.length;
      const schemaChars = JSON.stringify(tool.parameters).length;
      rows.push({
        tool: tool.name,
        harness,
        nameChars,
        descriptionChars,
        schemaChars,
        chars: nameChars + descriptionChars + schemaChars,
      });
    }
  }
  return rows;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function countBy(
  rows: Record<string, unknown>[],
  key: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] ?? "unknown");
    out[value] = (out[value] ?? 0) + Number(row.c ?? 1);
  }
  return out;
}

/** The storage half of the audit — the queries `docs/tasks.md` used to hold. */
function readStorage(
  db: DatabaseSync,
  beforeEndMs: number,
  afterStartMs: number,
): StorageCounters {
  const rows = (sql: string): Record<string, unknown>[] =>
    db.prepare(sql).all() as unknown as Record<string, unknown>[];

  const byCreator = rows(
    "select created_by, count(*) c from tasks where deleted_at_ms is null group by created_by",
  );
  const lifetimes = rows(
    `select created_by, (completed_at_ms - created_at_ms)/60000.0 mins from tasks
       where deleted_at_ms is null and completed_at_ms is not null`,
  );
  const byAuthorKind = rows(
    "select author_kind, count(*) c from task_comments group by author_kind",
  );
  const perTask = rows(
    "select task_id, count(*) c, count(distinct author_session_id) s from task_comments group by task_id",
  );
  const byActor = rows(
    "select actor_kind, count(*) c from task_status_events group by actor_kind",
  );
  const doingToTodo = (
    db
      .prepare(
        `select at_ms from task_status_events
           where actor_kind='agent' and from_status='doing' and to_status='todo'`,
      )
      .all() as unknown as { at_ms: number }[]
  ).map((row) => Number(row.at_ms));
  const pending = rows(
    "select count(*) c from tasks where deleted_at_ms is null and status_suggestion_at_ms is not null",
  );

  const lifetimeByCreator: Record<string, number | undefined> = {};
  for (const creator of new Set(lifetimes.map((r) => String(r.created_by))))
    lifetimeByCreator[creator] = median(
      lifetimes
        .filter((r) => String(r.created_by) === creator)
        .map((r) => Number(r.mins)),
    );

  const commentsByAuthorKind = countBy(byAuthorKind, "author_kind");
  return {
    tasks: Object.values(countBy(byCreator, "created_by")).reduce(
      (n, c) => n + c,
      0,
    ),
    tasksByCreator: countBy(byCreator, "created_by"),
    medianLifetimeMinutes: lifetimeByCreator,
    comments: Object.values(commentsByAuthorKind).reduce((n, c) => n + c, 0),
    commentsByAuthorKind,
    tasksWithOneComment: perTask.filter((r) => Number(r.c) === 1).length,
    commentedTasks: perTask.length,
    commentedTasksMultiSession: perTask.filter((r) => Number(r.s) > 1).length,
    statusEventsByActor: countBy(byActor, "actor_kind"),
    agentDoingToTodo: {
      before: doingToTodo.filter((at) => at < beforeEndMs).length,
      transition: doingToTodo.filter(
        (at) => at >= beforeEndMs && at < afterStartMs,
      ).length,
      after: doingToTodo.filter((at) => at >= afterStartMs).length,
    },
    statusSuggestionsPending: Number(pending[0]?.c ?? 0),
  };
}

interface SessionRow {
  id: string;
  harness: string;
  agent_type: string;
  created_at_ms: number;
  provider_session_id: string | null;
}

/**
 * Measure the Task overhead of every session the data dir still holds. The
 * user's live database is opened READ-ONLY; nothing here writes.
 */
export function measureTaskOverhead(
  options: TaskOverheadOptions = {},
): TaskOverheadReport {
  const dataDir = options.dataDir ?? DATA_DIR;
  const beforeEndMs = options.beforeEndMs ?? TASK_SURFACE_BEFORE_END_MS;
  const afterStartMs = options.afterStartMs ?? TASK_SURFACE_AFTER_START_MS;
  const claudeProjectsDir =
    options.claudeProjectsDir === undefined
      ? join(homedir(), ".claude", "projects")
      : options.claudeProjectsDir;
  const transcripts = claudeProjectsDir
    ? indexClaudeTranscripts(claudeProjectsDir)
    : new Map<string, string>();

  const dbPath = join(dataDir, "app.sqlite3");
  const sessions: SessionOverhead[] = [];
  const coverage = {
    sessions: 0,
    piWithTranscript: 0,
    piWithoutTranscript: 0,
    claudeWithTranscript: 0,
    claudeStoreOnly: 0,
    claudeUnreadable: 0,
  };
  let storage: StorageCounters | undefined;
  let earliest: number | undefined;
  let latest: number | undefined;

  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      storage = readStorage(db, beforeEndMs, afterStartMs);
      // The Task a session opened on: `linkSessionToObject` writes exactly one
      // `initial-context` edge per attachment.
      const attached = new Map(
        (
          db
            .prepare(
              `select from_id id, to_id task_id from links
                 where from_type='session' and relation='context' and to_type='task'`,
            )
            .all() as unknown as { id: string; task_id: string }[]
        ).map((row) => [row.id, row.task_id]),
      );
      const rows = db
        .prepare(
          `select id, harness, agent_type, created_at_ms, provider_session_id
             from session_index
             where deleted_at_ms is null and created_at_ms >= ?
             order by created_at_ms`,
        )
        .all(options.sinceMs ?? 0) as unknown as SessionRow[];

      for (const row of rows) {
        const harness: OverheadHarness =
          row.harness === "pi" ? "pi" : "claude-sdk";
        const scanned = scanSession(row, harness, dataDir, transcripts);
        if (!scanned) {
          if (harness === "pi") coverage.piWithoutTranscript += 1;
          else coverage.claudeUnreadable += 1;
          continue;
        }
        if (harness === "pi") coverage.piWithTranscript += 1;
        else if (scanned.source === "claude-transcript")
          coverage.claudeWithTranscript += 1;
        else coverage.claudeStoreOnly += 1;
        coverage.sessions += 1;
        earliest = Math.min(earliest ?? row.created_at_ms, row.created_at_ms);
        latest = Math.max(latest ?? row.created_at_ms, row.created_at_ms);
        sessions.push(
          summarize(scanned.scan, {
            sessionId: row.id,
            harness,
            agentType: row.agent_type,
            createdAtMs: row.created_at_ms,
            window:
              row.created_at_ms < beforeEndMs
                ? "before"
                : row.created_at_ms >= afterStartMs
                  ? "after"
                  : "transition",
            taskAttached: attached.has(row.id),
            attachedTaskId: attached.get(row.id),
            source: scanned.source,
          }),
        );
      }
    } finally {
      db.close();
    }
  }

  const eagerTaskTools = eagerTaskToolCosts(options.agentType ?? "developer");
  const eagerTaskCharsByHarness = { pi: 0, claude: 0 };
  for (const row of eagerTaskTools)
    eagerTaskCharsByHarness[row.harness] += row.chars;

  return {
    dataDir,
    claudeProjectsDir: claudeProjectsDir || undefined,
    beforeEndMs,
    afterStartMs,
    earliestSessionMs: earliest,
    latestSessionMs: latest,
    sessions,
    windows: (["before", "transition", "after"] as const).map((window) =>
      aggregate(
        window,
        sessions.filter((session) => session.window === window),
      ),
    ),
    coverage,
    eagerTaskTools,
    eagerTaskCharsByHarness,
    storage,
  };
}

function scanSession(
  row: SessionRow,
  harness: OverheadHarness,
  dataDir: string,
  transcripts: Map<string, string>,
): { scan: CallScan; source: OverheadSource } | undefined {
  try {
    if (harness === "pi") {
      const path = join(dataDir, "sessions", row.id, "native.jsonl");
      if (!existsSync(path)) return undefined;
      return { scan: scanPiNative(path), source: "pi-native" };
    }
    const transcript = row.provider_session_id
      ? transcripts.get(row.provider_session_id)
      : undefined;
    if (transcript)
      return {
        scan: scanClaudeTranscript(transcript),
        source: "claude-transcript",
      };
    const store = readClaudeSdkRecord(join(dataDir, "claude-sdk"), row.id);
    if (!store) return undefined;
    return {
      scan: scanClaudeStore(store.record.entries),
      source: "claude-store",
    };
  } catch {
    // A session whose transcript cannot be read is reported as uncovered.
    return undefined;
  }
}
