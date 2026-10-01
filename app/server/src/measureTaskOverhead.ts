/**
 * `pnpm run measure:tasks` — the Task-299 reduction trace.
 *
 * Prints what Task bookkeeping costs a session in PROVIDER CALLS and processed
 * input, before and after the [Task-260](pa://task/260) slices, plus the
 * lifecycle step table, the eager Task tool bytes and the storage counters the
 * audit in `docs/tasks.md` reports. Reads the live data dir read-only.
 *
 *   DATA_DIR=~/assistant-data pnpm run measure:tasks
 *   pnpm run measure:tasks -- --data-dir ~/assistant-data --json
 *   pnpm run measure:tasks -- --since 2026-07-01        # narrow the before window
 *   pnpm run measure:tasks -- --no-claude-transcripts   # DATA_DIR only
 *
 * The window boundaries default to the first and last slice that changed the
 * surface; override with `--before-end`/`--after-start` (any Date-parsable
 * value) to measure a different change.
 */
import {
  LIFECYCLE_STEPS,
  measureTaskOverhead,
  PLANNING_EAGER_TASK_BYTES,
  type LifecycleCounts,
  type TaskOverheadReport,
  type WindowAggregate,
} from "./taskOverhead.ts";

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const at = process.argv.indexOf(flag);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

function instant(name: string): number | undefined {
  const raw = arg(name);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed))
    throw new Error(`--${name} is not a date this runtime can parse: ${raw}`);
  return parsed;
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function dec(n: number, places = 2): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

function day(ms: number | undefined): string {
  return ms === undefined ? "—" : new Date(ms).toISOString().slice(0, 16) + "Z";
}

/** How a before/after pair reads: the after value, and the change on it. */
function delta(before: number, after: number, places = 2): string {
  if (before === 0) return dec(after, places);
  const pct = ((after - before) / before) * 100;
  return `${dec(after, places)} (${pct >= 0 ? "+" : ""}${dec(pct, 0)}%)`;
}

function windowTable(report: TaskOverheadReport): string {
  const by = (w: string): WindowAggregate =>
    report.windows.find((x) => x.window === w)!;
  const before = by("before");
  const after = by("after");
  const rows: [string, string, string][] = [
    ["Sessions scanned", num(before.sessions), num(after.sessions)],
    [
      "…with a Task attached",
      num(before.taskAttachedSessions),
      num(after.taskAttachedSessions),
    ],
    [
      "…resolving provider calls",
      num(before.measuredSessions),
      num(after.measuredSessions),
    ],
    ["Task tool calls", num(before.taskCalls), num(after.taskCalls)],
    [
      "…of them to the removed workflow tools",
      num(before.workflowCalls),
      num(after.workflowCalls),
    ],
    [
      "Bookkeeping-only round trips",
      num(before.bookkeepingRoundTrips),
      num(after.bookkeepingRoundTrips),
    ],
    [
      "Processed input on those round trips (tokens)",
      num(before.processedInputTokens),
      num(after.processedInputTokens),
    ],
    [
      "…new input, uncovered by a cache hit",
      num(before.newInputTokens),
      num(after.newInputTokens),
    ],
  ];
  const perBefore = before.perAttachedSession;
  const perAfter = after.perAttachedSession;
  const perRows: [string, string, string][] = [
    [
      "Task-attached sessions: calls / round trips",
      `${num(perBefore.sessions)} / ${num(perBefore.measuredSessions)}`,
      `${num(perAfter.sessions)} / ${num(perAfter.measuredSessions)}`,
    ],
    [
      "Task tool calls per session",
      dec(perBefore.taskCalls),
      delta(perBefore.taskCalls, perAfter.taskCalls),
    ],
    [
      "…excluding the removed workflow tools",
      dec(perBefore.taskCalls - perBefore.workflowCalls),
      delta(
        perBefore.taskCalls - perBefore.workflowCalls,
        perAfter.taskCalls - perAfter.workflowCalls,
      ),
    ],
    [
      "Task calls before any real tool work",
      dec(perBefore.preWorkTaskCalls),
      delta(perBefore.preWorkTaskCalls, perAfter.preWorkTaskCalls),
    ],
    [
      "Re-reads of the attached Task itself",
      dec(perBefore.attachedTaskReads),
      delta(perBefore.attachedTaskReads, perAfter.attachedTaskReads),
    ],
    [
      "Bookkeeping round trips per session",
      dec(perBefore.bookkeepingRoundTrips),
      delta(perBefore.bookkeepingRoundTrips, perAfter.bookkeepingRoundTrips),
    ],
    [
      "Processed input per session (tokens)",
      dec(perBefore.processedInputTokens, 0),
      delta(perBefore.processedInputTokens, perAfter.processedInputTokens, 0),
    ],
    [
      "…new input per session (tokens)",
      dec(perBefore.newInputTokens, 0),
      delta(perBefore.newInputTokens, perAfter.newInputTokens, 0),
    ],
  ];
  return [
    "| Measure | Before | After |",
    "| --- | ---: | ---: |",
    ...[...rows, ...perRows].map(
      ([label, b, a]) => `| ${label} | ${b} | ${a} |`,
    ),
  ].join("\n");
}

function lifecycleTable(report: TaskOverheadReport): string {
  const before = report.windows.find((w) => w.window === "before")!;
  const after = report.windows.find((w) => w.window === "after")!;
  const per = (counts: LifecycleCounts, step: string): string =>
    dec(counts[step as keyof LifecycleCounts]);
  return [
    "| Lifecycle step | Before, per Task-attached session | After |",
    "| --- | ---: | ---: |",
    ...LIFECYCLE_STEPS.map(
      (step) =>
        `| ${step} | ${per(before.perAttachedSession.lifecycle, step)} | ${per(
          after.perAttachedSession.lifecycle,
          step,
        )} |`,
    ),
  ].join("\n");
}

function toolCallTable(report: TaskOverheadReport): string {
  const before = report.windows.find((w) => w.window === "before")!;
  const after = report.windows.find((w) => w.window === "after")!;
  const tools = [
    ...new Set([
      ...Object.keys(before.callsByTool),
      ...Object.keys(after.callsByTool),
    ]),
  ].sort();
  return [
    "| Tool | Before | After |",
    "| --- | ---: | ---: |",
    ...tools.map(
      (tool) =>
        `| \`${tool}\` | ${num(before.callsByTool[tool] ?? 0)} | ${num(
          after.callsByTool[tool] ?? 0,
        )} |`,
    ),
  ].join("\n");
}

function eagerTable(report: TaskOverheadReport): string {
  const rows = report.eagerTaskTools.map(
    (row) =>
      `| \`${row.tool}\` | ${row.harness} | ${num(row.nameChars)} | ${num(
        row.descriptionChars,
      )} | ${num(row.schemaChars)} | ${num(row.chars)} |`,
  );
  const { pi, claude } = report.eagerTaskCharsByHarness;
  return [
    "| Tool | Harness | Name | Description | Schema | Total |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...rows,
    `| **all** | pi | | | | **${num(pi)}** |`,
    `| **all** | claude | | | | **${num(claude)}** |`,
    "",
    `Planning baseline: ${num(PLANNING_EAGER_TASK_BYTES)} B per session.`,
  ].join("\n");
}

function storageTable(report: TaskOverheadReport): string {
  const s = report.storage;
  if (!s) return "_No `app.sqlite3` in this data dir._";
  const creators = Object.entries(s.tasksByCreator)
    .map(([kind, count]) => `${kind} ${num(count)}`)
    .join(", ");
  const lifetimes = Object.entries(s.medianLifetimeMinutes)
    .map(([kind, mins]) => `${kind} ${mins === undefined ? "—" : dec(mins, 0)}`)
    .join(", ");
  const comments = Object.entries(s.commentsByAuthorKind)
    .map(([kind, count]) => `${kind} ${num(count)}`)
    .join(", ");
  const actors = Object.entries(s.statusEventsByActor)
    .map(([kind, count]) => `${kind} ${num(count)}`)
    .join(", ");
  return [
    "| Measure | Value |",
    "| --- | --- |",
    `| Tasks (undeleted) | ${num(s.tasks)} — ${creators} |`,
    `| Median lifetime create→done (min) | ${lifetimes} |`,
    `| Comments | ${num(s.comments)} — ${comments} |`,
    `| Tasks with exactly one comment | ${num(s.tasksWithOneComment)} of ${num(
      s.commentedTasks,
    )} commented |`,
    `| Commented Tasks touched by >1 session | ${num(
      s.commentedTasksMultiSession,
    )} |`,
    `| Status events | ${actors} |`,
    `| Agent \`doing → todo\` before / after | ${num(
      s.agentDoingToTodo.before,
    )} corrective / ${num(
      s.agentDoingToTodo.after,
    )} as the \`done\` suggestion's own move |`,
    `| Tasks with a pending status suggestion | ${num(
      s.statusSuggestionsPending,
    )} |`,
  ].join("\n");
}

function main(): void {
  const dataDirValue = arg("data-dir");
  const beforeEndMsValue = instant("before-end");
  const afterStartMsValue = instant("after-start");
  const sinceMsValue = instant("since");
  const report = measureTaskOverhead({
    ...(dataDirValue !== undefined ? { dataDir: dataDirValue } : {}),
    claudeProjectsDir: process.argv.includes("--no-claude-transcripts")
      ? ""
      : arg("claude-projects"),
    ...(sinceMsValue !== undefined ? { sinceMs: sinceMsValue } : {}),
    ...(beforeEndMsValue !== undefined
      ? { beforeEndMs: beforeEndMsValue }
      : {}),
    ...(afterStartMsValue !== undefined
      ? { afterStartMs: afterStartMsValue }
      : {}),
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const transition = report.windows.find((w) => w.window === "transition")!;
  console.log("# Task bookkeeping overhead\n");
  console.log(`- data dir: \`${report.dataDir}\``);
  console.log(
    `- Claude CLI transcripts: ${
      report.claudeProjectsDir
        ? `\`${report.claudeProjectsDir}\``
        : "not joined"
    }`,
  );
  console.log(
    `- sessions: ${num(report.coverage.sessions)} readable, ${day(
      report.earliestSessionMs,
    )} → ${day(report.latestSessionMs)}`,
  );
  console.log(
    `- coverage: pi ${num(report.coverage.piWithTranscript)} (${num(
      report.coverage.piWithoutTranscript,
    )} without a transcript), Claude ${num(
      report.coverage.claudeWithTranscript,
    )} per-call + ${num(
      report.coverage.claudeStoreOnly,
    )} calls-only + ${num(report.coverage.claudeUnreadable)} unreadable`,
  );
  console.log(
    `- windows: before < ${day(report.beforeEndMs)} ≤ transition (${num(
      transition.sessions,
    )} sessions, excluded) < ${day(report.afterStartMs)} ≤ after`,
  );

  console.log("\n## Provider calls and processed input\n");
  console.log(windowTable(report));
  console.log(
    "\nA round trip is charged only for a turn whose tool calls were ALL `task_*`:",
  );
  console.log(
    "a Task call batched into real tool work forces no extra provider call.",
  );
  console.log("\n## Lifecycle steps per Task-attached session\n");
  console.log(lifecycleTable(report));
  console.log("\n## Calls by tool\n");
  console.log(toolCallTable(report));
  console.log("\n## Eager Task tool block (characters)\n");
  console.log(eagerTable(report));
  console.log("\n## Storage counters\n");
  console.log(storageTable(report));
}

main();
