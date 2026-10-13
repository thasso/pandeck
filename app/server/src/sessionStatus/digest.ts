/**
 * The session digest: everything the status agent reads about one session, as
 * Markdown (`docs/session-status.md`).
 *
 * A header with the CURRENT state of what the session touched — its Tasks, the
 * Tasks it created and how they ended, its pull requests and those of the
 * sessions it worked with, who still owes whom a reply — then a timeline of the
 * conversation: the user's prompts and answers, peer messages, each run's final
 * reply, and the state-changing tool calls. Recent runs are kept nearly whole,
 * older ones clipped, and runs with neither a user prompt nor a milestone are
 * collapsed, until the timeline fits its budget.
 *
 * Work often moves on in a Task's own session after the session that planned
 * it goes quiet, which is why the header reads those sessions' latest replies:
 * without them the agent reports the creating session's old plan as open.
 *
 * Everything quoted is redacted (`credentialRedaction.ts`). The log is read as
 * untyped JSON lines, the same way `session_read` reads it.
 */
import { existsSync } from "node:fs";
import { approvalStore } from "../db/approvalStore.ts";
import { outgoing } from "../db/links.ts";
import { peerPromptStore } from "../db/peerPromptStore.ts";
import { pullRequestCardStore } from "../db/pullRequestCardStore.ts";
import { sessionStatusSources } from "../db/sessionStatusSources.ts";
import { sessionStore, type SessionMeta } from "../db/sessionStore.ts";
import { taskStore } from "../db/taskStore.ts";
import { getWorktree } from "../db/worktreeStore.ts";
import { redactCredentials } from "../credentialRedaction.ts";
import { canonicalSessionLogPath } from "../sessionStorage.ts";
import {
  forEachJsonlLine,
  includeOptions,
  readSessionTailWithin,
} from "../tools/sessions/sessionInspection.ts";
import { userTimeZone } from "../userProfile.ts";
import type { PullRequestCard } from "@assistant/shared";

/** The last line of every digest; the agent knows it has read all of it. */
export const DIGEST_END_MARKER = "<!-- end of digest -->";

/** Timeline budget in characters; the header is not counted. */
const TIMELINE_BUDGET_CHARS = 50_000;
/** Runs at the end kept nearly whole. */
const RECENT_RUNS = 8;
/** Runs before those, clipped to a few hundred characters. */
const MIDDLE_RUNS = 30;
/** How much of another session's log tail to read for its latest replies. */
const TAIL_BYTES = 256 * 1024;

/**
 * Tool calls that change state the owner cares about. Everything else
 * (reads, searches, edits) is process, not story.
 */
const KEY_TOOLS = new Set([
  "worktree_create",
  "worktree_commit",
  "worktree_push",
  "worktree_create_pull_request",
  "worktree_ready_pull_request",
  "worktree_retarget_pull_request",
  "worktree_finish_pull_request",
  "worktree_set_base",
  "worktree_remove",
  "session_spawn",
  "session_send_prompt",
  "session_control",
  "session_submit_result",
  "task_manage",
  "ask_questions",
  "github_create_pull_request",
  "github_mutate_issue",
  "github_comment_pull_request",
  "github_review_pull_request",
  "github_watch_pull_request_checks",
  "forgejo_create_pull_request",
  "forgejo_watch_pull_request_checks",
  "jira_mutate_issue",
  "review_set_close",
  "git_publish_tag",
  "kb_write",
  "kb_edit",
]);
/** The only key calls kept for old runs. */
const MILESTONE_TOOLS = new Set([
  "worktree_create_pull_request",
  "worktree_finish_pull_request",
  "session_spawn",
  "github_create_pull_request",
  "forgejo_create_pull_request",
  "task_manage",
  "ask_questions",
]);
const SHELL_TOOLS = new Set(["Bash", "bash"]);
const SHELL_KEEP =
  /\b(git (commit|push|merge|rebase|tag)|gh pr (create|merge))\b/;

type Json = Record<string, unknown>;

interface Run {
  start: string | undefined;
  items: RunItem[];
  replies: string[];
  aborted: boolean;
}

type RunItem =
  | { kind: "user"; entry: Json }
  | { kind: "note"; text: string }
  | { kind: "tool"; name: string; input: Json; result: string | undefined };

type Tier = "full" | "middle" | "old";

interface TierLimits {
  prompt: number;
  reply: number;
  call: number;
}

/* --------------------------------- text ---------------------------------- */

/**
 * Redact, drop Markdown headings (a quoted reply's `## …` would read as a
 * digest section) and clip, saying how much was cut.
 */
function clip(text: string | undefined, limit: number): string {
  const clean = redactCredentials(text ?? "")
    .replace(/^#{1,6} +/gm, "")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit).trimEnd()} […+${clean.length - limit} chars]`;
}

function oneLine(text: string | undefined, limit: number): string {
  return clip((text ?? "").replace(/\s+/g, " "), limit);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: Json) =>
      block?.type === "text"
        ? String(block.text ?? "")
        : block?.type === "image"
          ? "[image]"
          : "",
    )
    .filter(Boolean)
    .join("\n");
}

function asJson(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/* --------------------------------- time ---------------------------------- */

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: userTimeZone(),
    ...options,
  });
}

/** `Mon 2026-10-12 20:19` in the user's timezone. */
function stamp(value: number | string | undefined): string {
  if (value === undefined) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = Object.fromEntries(
    formatter({
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** `Mon 12 Oct`, the day an activity happened in the user's timezone. */
function day(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return formatter({ weekday: "short", day: "numeric", month: "short" }).format(
    date,
  );
}

/* ---------------------------------- log ---------------------------------- */

function readLogRows(sessionId: string): Json[] {
  const path = canonicalSessionLogPath(sessionId);
  if (!existsSync(path)) return [];
  const rows: Json[] = [];
  forEachJsonlLine(path, 0, (line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object") rows.push(parsed as Json);
    } catch {
      // A torn or foreign line is skipped, as every log reader does.
    }
    return "continue";
  });
  return rows;
}

/** The newest assistant replies of another session, read from its log tail. */
function latestReplies(sessionId: string, count: number): string[] {
  const path = canonicalSessionLogPath(sessionId);
  if (!existsSync(path)) return [];
  const records = readSessionTailWithin(
    path,
    TAIL_BYTES,
    count * 4,
    includeOptions({}),
  );
  return records
    .filter(
      (record) =>
        record.role === "assistant" &&
        record.blockKind === "text" &&
        record.text.trim(),
    )
    .slice(-count)
    .map((record) => record.text);
}

function toolName(name: unknown): string {
  return String(name ?? "").replace(/^mcp__pa__/, "");
}

function isKeyCall(name: string, input: Json): boolean {
  if (KEY_TOOLS.has(name)) return true;
  return SHELL_TOOLS.has(name) && SHELL_KEEP.test(str(input.command) ?? "");
}

function buildRuns(rows: Json[]): Run[] {
  const results = new Map<string, string>();
  for (const row of rows)
    if (row.type === "message" && row.role === "toolResult")
      results.set(String(row.toolCallId), textOf(row.content));
  const runs: Run[] = [];
  let current: Run | undefined;
  for (const row of rows) {
    const type = row.type;
    if (type === "run.started" || !current) {
      current = {
        start: str(row.createdAt),
        items: [],
        replies: [],
        aborted: false,
      };
      runs.push(current);
      if (type === "run.started") continue;
    }
    if (type === "run.aborted") current.aborted = true;
    else if (type === "command.result") {
      if (asJson(row.card).kind === "compaction")
        current.items.push({
          kind: "note",
          text: "context was compacted here",
        });
    } else if (type === "provider.notice" && row.severity === "error")
      current.items.push({
        kind: "note",
        text: `provider error: ${oneLine(str(row.message), 200)}`,
      });
    else if (type === "message" && row.role === "user")
      current.items.push({ kind: "user", entry: row });
    else if (type === "message" && row.role === "assistant") {
      for (const block of Array.isArray(row.content) ? row.content : []) {
        const b = asJson(block);
        if (b.type === "text" && str(b.text)?.trim())
          current.replies.push(String(b.text));
        else if (b.type === "toolCall") {
          const name = toolName(b.name);
          const input = asJson(b.input);
          if (isKeyCall(name, input))
            current.items.push({
              kind: "tool",
              name,
              input,
              result: results.get(String(b.toolCallId)),
            });
        }
      }
    }
  }
  return runs.filter((run) => run.items.length > 0 || run.replies.length > 0);
}

/* ------------------------------- timeline -------------------------------- */

function origin(entry: Json): Json {
  return asJson(entry.origin);
}

/** A prompt or answer the owner gave: a candidate decision. */
function isUserDecision(entry: Json): boolean {
  const o = origin(entry);
  return (
    o.kind === "human" ||
    o.source === "agent-question-response" ||
    o.source === "approval-decision"
  );
}

/** The answers inside an `ask_questions` response, without its wrapper text. */
function questionAnswers(text: string, limit: number): string {
  const start = text.indexOf("{");
  let payload: Json = {};
  try {
    payload = start >= 0 ? asJson(JSON.parse(text.slice(start))) : {};
  } catch {
    return oneLine(text, limit);
  }
  const answers = Array.isArray(payload.answers) ? payload.answers : [];
  const parts = answers.map((raw) => {
    const answer = asJson(raw);
    const chosen = (
      Array.isArray(answer.choiceLabels) ? answer.choiceLabels : []
    ).join(", ");
    const typed = str(answer.text)?.trim() ?? "";
    const reply =
      [chosen, typed].filter(Boolean).join("; ") ||
      String(answer.disposition ?? "");
    return `“${String(answer.title ?? "")}” → ${reply}`;
  });
  return oneLine(parts.join(" | ") || String(payload.status ?? ""), limit);
}

function userLine(entry: Json, limit: number): string {
  const o = origin(entry);
  const peer = asJson(entry.peerPrompt);
  if (peer.direction === "received")
    return `**Peer message from “${String(peer.senderTitle ?? "another session")}” (\`${String(peer.peerSessionId ?? "")}\`):** ${clip(str(peer.message), limit)}`;
  const source = o.source;
  if (source === "background-completion") {
    const updates = asJson(o.presentation).updates;
    const desc = (Array.isArray(updates) ? updates : [])
      .map((u: Json) => `${String(u.label ?? "")}: ${String(u.status ?? "")}`)
      .join("; ");
    return `**System:** background job finished — ${oneLine(desc, 300)}`;
  }
  if (source === "agent-question-response")
    return `**User answered questions:** ${questionAnswers(textOf(entry.content), Math.max(limit, 600))}`;
  if (source === "approval-decision") {
    const text = textOf(entry.content)
      .replace(/^\[approval decision\]/, "")
      .trim();
    return `**User approval decision:** ${oneLine(text, Math.max(limit, 300))}`;
  }
  if (o.kind === "human")
    return `**User:** ${clip(textOf(entry.content), limit)}`;
  return `**${String(o.kind ?? "system")}/${String(source ?? "")}:** ${clip(textOf(entry.content), Math.min(limit, 400))}`;
}

function toolLine(
  name: string,
  input: Json,
  result: string | undefined,
  callLimit: number,
): string | undefined {
  const res = result ? oneLine(result, 220) : "(no result)";
  if (SHELL_TOOLS.has(name))
    return `- \`${name}\`: \`${oneLine(str(input.command), 200)}\` → ${res}`;
  if (name === "session_send_prompt")
    return `- sent peer message to \`${String(input.targetSessionId ?? "")}\`: ${oneLine(str(input.prompt), callLimit)}`;
  if (name === "session_spawn") {
    if (input.operation === "profiles") return undefined;
    const sessions = Array.isArray(input.sessions) ? input.sessions : [];
    const titles = sessions
      .map((s: Json) => `“${String(s.title ?? "")}”`)
      .join(", ");
    return `- session_spawn ${String(input.operation ?? "")}: ${titles} → ${res}`;
  }
  if (name === "worktree_commit" || name === "worktree_create_pull_request")
    return `- ${name}: ${oneLine(str(input.context) ?? str(input.title), callLimit)} → ${res}`;
  if (name === "ask_questions") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const titles = questions.map((q: Json) => String(q.title ?? "")).join("; ");
    return `- asked the user: ${oneLine(str(input.title), 100)} — ${oneLine(titles, callLimit)}`;
  }
  if (name === "task_manage") {
    const operations = Array.isArray(input.operations) ? input.operations : [];
    const ops = operations
      .map((op: Json) =>
        [op.operation, op.id, op.title, op.status]
          .filter((part) => part !== undefined && part !== "")
          .join(" "),
      )
      .join("; ");
    return `- task_manage: ${oneLine(ops, callLimit)} → ${res}`;
  }
  return `- ${name}: ${oneLine(JSON.stringify(input), callLimit)} → ${res}`;
}

function hasUserDecisionOrMilestone(run: Run): boolean {
  return run.items.some(
    (item) =>
      (item.kind === "user" && isUserDecision(item.entry)) ||
      (item.kind === "tool" && MILESTONE_TOOLS.has(item.name)),
  );
}

function renderTimeline(
  runs: Run[],
  recent: number,
  middle: number,
  old: { prompt: number; reply: number },
): string[] {
  const out = ["", "## Timeline (oldest first; older runs are clipped harder)"];
  const fullFrom = Math.max(0, runs.length - recent);
  const middleFrom = Math.max(0, runs.length - recent - middle);
  const skipped: number[] = [];
  const flushSkipped = () => {
    if (skipped.length === 0) return;
    out.push(
      "",
      `_Runs ${skipped[0]! + 1}–${skipped[skipped.length - 1]! + 1}: ${skipped.length} run(s) of agent/peer/background traffic with no user prompt or milestone, omitted._`,
    );
    skipped.length = 0;
  };
  runs.forEach((run, index) => {
    if (index < middleFrom && !hasUserDecisionOrMilestone(run)) {
      skipped.push(index);
      return;
    }
    flushSkipped();
    const tier: Tier =
      index >= fullFrom ? "full" : index >= middleFrom ? "middle" : "old";
    const limits: TierLimits =
      tier === "full"
        ? { prompt: 2500, reply: 3000, call: 400 }
        : tier === "middle"
          ? { prompt: 500, reply: 500, call: 160 }
          : { prompt: old.prompt, reply: old.reply, call: 100 };
    out.push(
      "",
      `### Run ${index + 1}/${runs.length} — ${stamp(run.start)}${run.aborted ? " (aborted)" : ""}`,
    );
    for (const item of run.items) {
      if (item.kind === "user") {
        const limit =
          tier === "old" && !isUserDecision(item.entry) ? 120 : limits.prompt;
        const line = userLine(item.entry, limit);
        out.push(tier === "old" ? line.replace(/\s+/g, " ") : line);
      } else if (item.kind === "note") out.push(`- _${item.text}_`);
      else {
        if (tier === "old" && !MILESTONE_TOOLS.has(item.name)) continue;
        const line = toolLine(item.name, item.input, item.result, limits.call);
        if (line)
          out.push(tier === "old" ? oneLine(line, limits.call + 140) : line);
      }
    }
    if (run.replies.length > 0 && limits.reply > 0) {
      if (tier === "full")
        for (const reply of run.replies.slice(0, -1))
          out.push(`- _agent said:_ ${oneLine(reply, 200)}`);
      const last = run.replies[run.replies.length - 1]!;
      out.push(
        `**Agent (final reply of run):** ${tier === "old" ? oneLine(last, limits.reply) : clip(last, limits.reply)}`,
      );
    }
  });
  flushSkipped();
  return out;
}

/**
 * Shrink the timeline until it fits: fewer middle runs, then fewer whole
 * runs. Old runs never lose their last short reply: a bare "yes, do that" is
 * not a decision the reader can place without the question it answered. The
 * last stage may still exceed the budget; it is the floor.
 */
function fittedTimeline(runs: Run[], budget: number): string {
  const stages: Array<[number, number, { prompt: number; reply: number }]> = [
    [RECENT_RUNS, MIDDLE_RUNS, { prompt: 200, reply: 160 }],
    [RECENT_RUNS, MIDDLE_RUNS / 2, { prompt: 200, reply: 160 }],
    [RECENT_RUNS, MIDDLE_RUNS / 4, { prompt: 200, reply: 160 }],
    [RECENT_RUNS, MIDDLE_RUNS / 4, { prompt: 140, reply: 120 }],
    [5, MIDDLE_RUNS / 4, { prompt: 140, reply: 120 }],
    [3, MIDDLE_RUNS / 4, { prompt: 140, reply: 120 }],
  ];
  let text = "";
  for (const [recent, middle, old] of stages) {
    text = renderTimeline(runs, recent, Math.floor(middle), old).join("\n");
    if (text.length <= budget) break;
  }
  return text;
}

/* -------------------------------- header --------------------------------- */

function activityLines(meta: SessionMeta, rows: Json[], runs: Run[]): string[] {
  const days: string[] = [];
  for (const row of rows)
    if (row.type === "run.started") {
      const d = day(str(row.createdAt));
      if (d && !days.includes(d)) days.push(d);
    }
  const usage = sessionStore.getUsageTotals(meta.id);
  const cost =
    usage?.costMicros !== undefined && usage.costMicros > 0
      ? ` · provider-reported cost ${(usage.costMicros / 1e6).toFixed(2)} ${usage.currency}`
      : "";
  const out = [
    `- Activity: ${runs.length} runs on ${days.length} day(s) (${days.join(", ")})${cost}`,
  ];
  const pasted = rows.filter((row) => {
    if (row.type !== "message" || row.role !== "user") return false;
    if (origin(row).kind !== "human") return false;
    const text = textOf(row.content);
    return redactCredentials(text) !== text;
  }).length;
  if (pasted > 0)
    out.push(
      `- Credentials pasted by the user: ${pasted} prompt(s) (redacted below)`,
    );
  return out;
}

function linkedObjectLines(sessionId: string): string[] {
  return outgoing({ type: "session", id: sessionId }).map((link) => {
    let label = link.toId;
    if (link.toType === "worktree") {
      const worktree = getWorktree(link.toId);
      if (worktree)
        label = `branch \`${worktree.branch}\` → \`${worktree.baseBranch}\` (${worktree.status})`;
    } else if (link.toType === "task") {
      const task = taskStore.get(Number(link.toId));
      if (task) label = `Task-${task.id} “${task.title}” (${task.status})`;
    }
    return `- ${link.relation}: ${label}`;
  });
}

function prLines(card: PullRequestCard, suffix = "", brief = false): string[] {
  const out = [
    `- ${card.status}: #${card.number ?? "?"} “${card.title}” \`${card.headBranch}\` → \`${card.baseBranch}\` ${card.url ?? ""} (updated ${stamp(card.updatedAt)})${suffix}`,
  ];
  const summary = card.body?.[0]?.trim().replace(/^#+[^\n]*\n/, "");
  if (summary)
    out.push(`  - Description: ${oneLine(summary, brief ? 200 : 400)}`);
  if (brief && card.status === "merged") return out;
  for (const warning of card.warnings.slice(0, 3))
    out.push(`  - Caveat: ${oneLine(warning, 200)}`);
  return out;
}

/** Sessions linked to a Task other than `exclude`, oldest first. */
function taskSessions(taskId: number, exclude: string): SessionMeta[] {
  return taskStore
    .sessionsFor(taskId)
    .filter((id) => id !== exclude)
    .map((id) => sessionStore.get(id))
    .filter((meta): meta is SessionMeta => meta !== undefined)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function createdTaskLines(sessionId: string): string[] {
  const ids = sessionStatusSources.tasksCreatedBy(sessionId);
  if (ids.length === 0) return [];
  const out = [
    "",
    "## Tasks created by this session (current state; work may have continued elsewhere)",
  ];
  for (const id of ids) {
    const task = taskStore.get(id);
    if (!task) continue;
    out.push(
      `- Task-${task.id} “${task.title}”: ${task.status} (updated ${stamp(task.updatedAt)})`,
    );
    const sessions = taskSessions(task.id, sessionId);
    for (const meta of sessions)
      out.push(
        `  - worked on in “${meta.title}” (\`${meta.id}\`, last activity ${stamp(meta.updatedAt)})`,
      );
    const newest = sessions.reduce<SessionMeta | undefined>(
      (best, meta) => (!best || meta.updatedAt > best.updatedAt ? meta : best),
      undefined,
    );
    const latest = newest ? latestReplies(newest.id, 1)[0] : undefined;
    if (newest && latest)
      out.push(
        `  - Latest outcome, from “${newest.title}”: ${oneLine(latest, 500)}`,
      );
  }
  return out;
}

/** PRs opened by the sessions working on this session's Tasks, or by its children. */
function relatedPrLines(sessionId: string): string[] {
  const sources = new Map<string, string>();
  for (const id of sessionStatusSources.tasksCreatedBy(sessionId))
    for (const meta of taskSessions(id, sessionId))
      if (!sources.has(meta.id)) sources.set(meta.id, `Task-${id}`);
  for (const edge of sessionStatusSources.linkEdges(sessionId))
    if (edge.direction === "child" && !sources.has(edge.otherSessionId))
      sources.set(edge.otherSessionId, "spawned by this session");
  const cards: Array<{ card: PullRequestCard; via: string; id: string }> = [];
  for (const [id, via] of sources)
    for (const { card } of pullRequestCardStore.forSession(id))
      cards.push({ card, via, id });
  if (cards.length === 0) return [];
  cards.sort((a, b) => a.card.createdAt - b.card.createdAt);
  return [
    "",
    "## Pull requests opened by related sessions (Tasks this session created, its children)",
    ...cards.flatMap(({ card, via, id }) =>
      prLines(card, ` — via ${via}, session \`${id}\``, true),
    ),
  ];
}

interface Related {
  relation: Set<string>;
  sent: number;
  received: number;
}

/**
 * Every session this one spawned, was spawned or forked by, or exchanged peer
 * messages with. "Owes a reply" is the server's own rule
 * (`peerPromptStore.outstandingRepliesBySender`), the one the session list
 * shows, so a helper whose report arrived another way is not flagged.
 */
function relatedSessionLines(meta: SessionMeta, now: number): string[] {
  const related = new Map<string, Related>();
  const entry = (id: string): Related => {
    let value = related.get(id);
    if (!value) {
      value = { relation: new Set(), sent: 0, received: 0 };
      related.set(id, value);
    }
    return value;
  };
  for (const edge of sessionStatusSources.linkEdges(meta.id))
    entry(edge.otherSessionId).relation.add(
      edge.direction === "child"
        ? `${edge.relation} by this session`
        : `${edge.relation} this session`,
    );
  for (const peer of peerPromptStore.summarizeByParticipant(meta.id)) {
    const value = entry(peer.peerSessionId);
    value.sent += peer.sent;
    value.received += peer.received;
  }
  if (related.size === 0) return [];
  const owing = peerPromptStore.outstandingRepliesBySender(now);
  const owedToUs = new Set(owing.get(meta.id) ?? []);
  const rows = [...related]
    .map(([id, value]) => ({ value, other: sessionStore.get(id) }))
    .filter(
      (row): row is { value: Related; other: SessionMeta } =>
        row.other !== undefined && row.other.scope === "user",
    )
    .sort((a, b) => a.other.updatedAt - b.other.updatedAt);
  const out = ["", "## Sessions this one worked with (current state)"];
  for (const { value, other } of rows) {
    const owes: string[] = [];
    if (owedToUs.has(other.id)) owes.push("still owes this session a reply");
    if ((owing.get(other.id) ?? []).includes(meta.id))
      owes.push("this session still owes it a reply");
    const relation = [...value.relation].sort().join(", ") || "peer";
    out.push(
      `- “${other.title}” (\`${other.id}\`, ${other.model ?? "unknown model"}) — ${relation}; messages sent ${value.sent}, received ${value.received}; last activity ${stamp(other.updatedAt)}${other.archivedAt ? " · archived" : ""}${owes.length ? ` · ${owes.join("; ")}` : ""}`,
    );
    // A session still moving after this one went quiet is where the current
    // state lives: show more of it.
    const active = other.updatedAt > meta.updatedAt || owes.length > 0;
    const replies = latestReplies(other.id, active ? 2 : 1);
    for (const reply of replies)
      out.push(
        `  - ${active ? "Recent reply" : "Its last reply"}: ${oneLine(reply, active ? 500 : 140)}`,
      );
  }
  return out;
}

function headerLines(
  meta: SessionMeta,
  rows: Json[],
  runs: Run[],
  now: number,
): string[] {
  const out = [
    `# Session digest: ${meta.title}`,
    "",
    `- Digest generated: ${stamp(now)}`,
    `- Session id: \`${meta.id}\``,
    `- Persona: ${meta.agentType} · runtime: ${meta.harness} ${meta.provider ?? ""}/${meta.model ?? ""}`,
    ...activityLines(meta, rows, runs),
    `- Created: ${stamp(meta.createdAt)} · last activity: ${stamp(meta.updatedAt)}`,
    ...(meta.archivedAt ? [`- Archived: ${stamp(meta.archivedAt)}`] : []),
    ...linkedObjectLines(meta.id),
  ];
  const prs = pullRequestCardStore.forSession(meta.id);
  if (prs.length > 0)
    out.push(
      "",
      "## Pull requests opened from this session (current state)",
      ...prs.flatMap(({ card }) => prLines(card)),
    );
  const pending = approvalStore.pendingForSession(meta.id);
  if (pending.length > 0)
    out.push(
      "",
      "## Approvals waiting for the user",
      ...pending.map(({ card }) =>
        `- ${card.title}: ${card.summary ?? ""}`.trimEnd(),
      ),
    );
  out.push(
    ...createdTaskLines(meta.id),
    ...relatedPrLines(meta.id),
    ...relatedSessionLines(meta, now),
  );
  return out;
}

/* --------------------------------- entry --------------------------------- */

/**
 * The digest for one session. `meta` must be a live user session; the caller
 * resolves it.
 */
export function buildSessionDigest(
  meta: SessionMeta,
  now = Date.now(),
): string {
  const rows = readLogRows(meta.id);
  const runs = buildRuns(rows);
  const header = redactCredentials(
    headerLines(meta, rows, runs, now).join("\n"),
  );
  const timeline = redactCredentials(
    fittedTimeline(runs, TIMELINE_BUDGET_CHARS),
  );
  return `${header}\n${timeline}\n\n${DIGEST_END_MARKER}\n`;
}
