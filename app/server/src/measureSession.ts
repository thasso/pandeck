/**
 * `pnpm run measure:session` — the Task-254 per-session usage and
 * context-contributor report.
 *
 * Prints, for ONE session, what it spent and what its context was made of:
 * per-turn tokens and cost, processed input against context occupancy, the
 * contributor categories, the largest tool results, the biggest context jumps,
 * and the tool definitions it carried but never called. Same fields as the
 * `session_audit` tool — this surface just prints more of them.
 *
 *   DATA_DIR=~/assistant-data pnpm run measure:session -- <sessionId>
 *   DATA_DIR=~/assistant-data pnpm run measure:session -- <sessionId> --json
 *   pnpm run measure:session -- <sessionId> --data-dir ~/assistant-data --turns 20
 *   pnpm run measure:session -- <sessionId> --entry e42-22f3c714   # drill-down
 *   pnpm run measure:session -- <sessionId> --run 7                # provider call
 *
 * The data dir is opened READ-ONLY; nothing here writes. `--no-claude-transcripts`
 * skips the `~/.claude/projects` join, which is the only read outside DATA_DIR.
 */
import { DATA_DIR } from "./config.ts";
import { catalogAuditInventory } from "./tools/catalog.ts";
import {
  auditSession,
  type AuditUsage,
  type SessionAuditReport,
} from "./sessionAudit.ts";
import { resolveAuditSourceFromDataDir } from "./sessionAuditSources.ts";
import { SessionInspectionError } from "./tools/sessions/sessionInspection.ts";

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const at = process.argv.indexOf(flag);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

function intArg(name: string): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed))
    throw new Error(`--${name} must be a number (got "${raw}").`);
  return parsed;
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function cost(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s - m * 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m - h * 60}m`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function usageCells(usage: AuditUsage): string {
  return [
    num(usage.processedInputTokens),
    num(usage.uncachedInputTokens),
    num(usage.cacheReadTokens),
    num(usage.cacheWriteTokens),
    num(usage.outputTokens),
    cost(usage.costUSD),
  ].join(" | ");
}

function header(report: SessionAuditReport): string[] {
  const s = report.session;
  return [
    `# Session audit — ${s.title || s.sessionId}`,
    "",
    `- session: \`${s.sessionId}\``,
    `- harness/persona: ${s.harness} / ${s.persona}${s.model ? ` (${s.model}${s.thinkingLevel ? `, thinking ${s.thinkingLevel}` : ""})` : ""}`,
    `- started: ${s.createdAt} — last update: ${s.updatedAt}`,
    ...(s.attachedTaskId ? [`- attached Task: ${s.attachedTaskId}`] : []),
    ...(s.promptConditions
      ? [
          `- frozen prompt conditions: ${Object.entries(s.promptConditions)
            .map(([key, on]) => `${key}=${on ? "on" : "off"}`)
            .join(", ")}`,
        ]
      : []),
    `- log: \`${report.sources.log.path}\` (${report.sources.log.lines} entries, ${bytes(report.sources.log.bytes)})`,
    `- provider calls: ${report.sources.providerCalls.source}${
      report.sources.providerCalls.resolvesCalls
        ? ` (\`${report.sources.providerCalls.path}\`)`
        : " — not resolvable"
    }`,
    "",
  ];
}

function totalsSection(report: SessionAuditReport): string[] {
  const t = report.totals;
  const lines = [
    "## Totals",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| turns | ${num(t.turns)} |`,
    `| assistant runs (log) | ${num(t.assistantRuns)} |`,
    `| provider calls | ${t.providerCalls === undefined ? "unresolved" : num(t.providerCalls)}${
      t.providerCallsUnattributed
        ? ` (${num(t.providerCallsUnattributed)} unattributed to a turn)`
        : ""
    } |`,
    `| tool calls | ${num(t.toolCalls)} |`,
    `| tool results (failed) | ${num(t.toolResults)} (${num(t.failedToolResults)}) |`,
    `| failed/aborted turns | ${num(t.failedRuns)} |`,
    `| compactions | ${num(t.compactions)} |`,
    `| processed input (billed) | ${num(t.processedInputTokens)} |`,
    `| uncached input | ${num(t.uncachedInputTokens)} |`,
    `| cache read | ${num(t.cacheReadTokens)} |`,
    `| cache write | ${num(t.cacheWriteTokens)} |`,
    `| output | ${num(t.outputTokens)} |`,
    ...(t.reasoningTokens !== undefined
      ? [`| reasoning (provider transcript) | ${num(t.reasoningTokens)} |`]
      : []),
    `| cost | ${cost(t.costUSD)} |`,
    `| latest context occupancy | ${
      t.latestContext.tokens === undefined
        ? "unknown"
        : `${num(t.latestContext.tokens)}${t.latestContext.window ? ` / ${num(t.latestContext.window)} (${t.latestContext.percent?.toFixed(1)}%)` : ""}${
            t.latestContext.basis === "prompt-token-sum"
              ? " (prompt-token sum, not a harness snapshot)"
              : ""
          }`
    } |`,
    `| elapsed | ${duration(t.elapsedMs)} |`,
    `| generation time | ${t.generationMs === undefined ? "not recorded" : duration(t.generationMs)} |`,
    `| transcript bytes | ${bytes(t.transcriptBytes)} |`,
    `| tool-result bytes | ${bytes(t.toolResultBytes)} |`,
    "",
    "Processed input is summed over every request; context occupancy is one",
    "prompt-side snapshot. They are different quantities and never added.",
    "",
  ];
  if (report.providerCallTotals) {
    const p = report.providerCallTotals;
    lines.push(
      `Provider transcript over ${num(p.calls)} calls: ${num(p.processedInputTokens)} processed in, ` +
        `${num(p.outputTokens)} out${p.reasoningTokens ? `, ${num(p.reasoningTokens)} reasoning` : ""}` +
        `${p.costReported ? `, ${cost(p.costUSD)}` : " (no cost in this transcript)"}.`,
      "",
    );
  }
  if (report.persisted) {
    const p = report.persisted;
    const accumulation = p.costAccumulation
      ? ` Cost reconciles under the ${p.costAccumulation} accumulation.`
      : "";
    lines.push(
      p.agrees
        ? `Totals agree exactly with the persisted session stats (${p.comparedFields.join(", ")}).${accumulation}`
        : `⚠️ Totals DIFFER from the persisted session stats (compared: ${p.comparedFields.join(", ")}): ${p.differences
            .map(
              (d) =>
                `${d.field} ${num(d.report)} vs ${num(d.persisted)} (${d.delta > 0 ? "+" : ""}${num(d.delta)})`,
            )
            .join(", ")}`,
      "",
    );
  }
  return lines;
}

function contributorsSection(report: SessionAuditReport): string[] {
  return [
    "## Context contributors",
    "",
    "| Category | Chars | est. tokens | Share | Items | Basis |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...report.contributors.map(
      (row) =>
        `| ${row.category} | ${num(row.chars)} | ${
          row.estTokens === 0 && row.chars > 0 ? "n/a" : num(row.estTokens)
        } | ${row.estTokens === 0 && row.chars > 0 ? "—" : pct(row.share)} | ${num(row.items)} | ${row.basis} |`,
    ),
    "",
    `Estimated total ${num(report.calibration.estimatedTotalTokens)} tokens. ` +
      `First request estimated at ${num(report.calibration.estimatedFirstRequestTokens)} tokens` +
      (report.calibration.measuredFirstRequestTokens !== undefined
        ? `, measured ${num(report.calibration.measuredFirstRequestTokens)} (ratio ${report.calibration.ratio}).`
        : " (no per-call transcript to measure against)."),
    "",
    report.calibration.note,
    "",
  ];
}

function turnsSection(report: SessionAuditReport): string[] {
  if (report.turns.length === 0) return [];
  return [
    "## Turns",
    "",
    "| # | origin | calls | tools | processed in | uncached | cache read | cache write | out | cost | context | Δ | tool bytes | active tools |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.turns.map((turn) => {
      const flags = [
        turn.hiddenPrompt ? "hidden" : "",
        turn.compacted ? "compacted" : "",
        turn.failure ? "failed" : "",
      ]
        .filter(Boolean)
        .join("/");
      return `| ${turn.index} | ${turn.origin ?? "—"}${flags ? ` (${flags})` : ""} | ${
        turn.providerCalls ?? "—"
      } | ${turn.toolCalls} | ${usageCells(turn.usage)} | ${
        turn.contextAfter === undefined ? "—" : num(turn.contextAfter)
      } | ${
        turn.contextDelta === undefined
          ? "—"
          : `${turn.contextDelta > 0 ? "+" : ""}${num(turn.contextDelta)}`
      } | ${bytes(turn.toolResultBytes)} | ${turn.activeToolCount} (${num(turn.activeToolEstTokens)}t) |`;
    }),
    ...(report.bounds.turnsOmitted > 0
      ? [
          "",
          `${report.bounds.turnsOmitted} earlier turn(s) omitted by --turns.`,
        ]
      : []),
    "",
  ];
}

function toolResultsSection(report: SessionAuditReport): string[] {
  if (report.largestToolResults.length === 0) return [];
  return [
    "## Largest tool results",
    "",
    "| Tool | Turn | Bytes | est. tokens | Entry |",
    "| --- | ---: | ---: | ---: | --- |",
    ...report.largestToolResults.map(
      (row) =>
        `| ${row.toolName}${row.isError ? " (error)" : ""} | ${row.turn} | ${bytes(row.bytes)} | ${num(row.estTokens)} | \`${row.entryId}\` |`,
    ),
    "",
  ];
}

function jumpsSection(report: SessionAuditReport): string[] {
  if (report.contextJumps.length === 0) return [];
  return [
    "## Biggest context jumps",
    "",
    "| At | Scope | Turn | From | To | Δ | After tool calls | Preceding output |",
    "| ---: | --- | ---: | ---: | ---: | ---: | --- | ---: |",
    ...report.contextJumps.map(
      (row) =>
        `| ${row.at} | ${row.scope} | ${row.turn} | ${num(row.fromTokens)} | ${num(row.toTokens)} | +${num(row.deltaTokens)} | ${
          row.precededBy.join(", ") || "—"
        } | ${num(row.precedingOutputTokens)} |`,
    ),
    "",
  ];
}

function toolsSection(report: SessionAuditReport): string[] {
  const t = report.tools;
  const foreign = Object.entries(t.callsNotInThisCatalog)
    .sort((a, b) => b[1] - a[1])
    .map(([name, calls]) => `${name} ×${calls}`)
    .join(", ");
  return [
    "## Tools",
    "",
    `- eager at session start: ${t.eagerCount} definitions, ${num(t.eagerDefChars)} chars (~${num(t.eagerDefEstTokens)} tokens)`,
    `- activated later: ${t.activatedCount} definitions, ${num(t.activatedDefChars)} chars`,
    `- loaded but never called: ${t.unusedCount} definitions, ${num(t.unusedDefChars)} chars (~${num(t.unusedDefEstTokens)} tokens)`,
    ...(foreign
      ? [
          `- called but NOT in this catalog (harness builtins + renamed/removed app tools): ${foreign}`,
        ]
      : []),
    "",
    "| Tool | Group | Loading | Loaded | Calls | Def chars |",
    "| --- | --- | --- | --- | ---: | ---: |",
    ...t.rows.map(
      (row) =>
        `| ${row.name} | ${row.group} | ${row.loading} | ${row.loaded}${row.activatedInTurn ? ` (turn ${row.activatedInTurn})` : ""} | ${row.calls} | ${num(row.defChars)} |`,
    ),
    "",
  ];
}

function eventsSection(report: SessionAuditReport): string[] {
  if (report.events.length === 0) return [];
  return [
    "## Events",
    "",
    ...report.events.map(
      (event) => `- turn ${event.turn} — **${event.kind}**: ${event.detail}`,
    ),
    "",
  ];
}

function drilldownSection(report: SessionAuditReport): string[] {
  const d = report.drilldown;
  if (!d) return [];
  if (!d.found)
    return ["## Drill-down", "", `\`${d.target}\` was not found.`, ""];
  return [
    "## Drill-down",
    "",
    `\`${d.target}\`${d.role ? ` — ${d.role}` : ""}${d.turn ? `, turn ${d.turn}` : ""}${d.at ? `, ${d.at}` : ""}`,
    "",
    ...(d.usage
      ? [
          `usage: ${num(d.usage.processedInputTokens)} processed in, ${num(d.usage.outputTokens)} out, ${cost(d.usage.costUSD)}`,
          "",
        ]
      : []),
    ...(d.blocks
      ? [
          "| Block | Name | Chars | est. tokens |",
          "| --- | --- | ---: | ---: |",
          ...d.blocks.map(
            (block, index) =>
              `| ${index}: ${block.kind} | ${block.name ?? "—"} | ${num(block.chars)} | ${num(block.estTokens)} |`,
          ),
          "",
        ]
      : []),
    ...(d.toolCalls?.length
      ? [`tool calls: ${d.toolCalls.join(", ")}`, ""]
      : []),
    "Bodies are deliberately not printed; use `session_read` for content.",
    "",
  ];
}

function footer(report: SessionAuditReport): string[] {
  return [
    "## Method and gaps",
    "",
    ...report.assumptions.map((line) => `- ${line}`),
    ...report.unavailable.map((line) => `- NOT AVAILABLE: ${line}`),
    ...report.warnings.map((line) => `- ⚠️ ${line}`),
    "",
  ];
}

function render(report: SessionAuditReport): string {
  return [
    ...header(report),
    ...totalsSection(report),
    ...contributorsSection(report),
    ...turnsSection(report),
    ...toolResultsSection(report),
    ...jumpsSection(report),
    ...toolsSection(report),
    ...eventsSection(report),
    ...drilldownSection(report),
    ...footer(report),
  ].join("\n");
}

function main(): void {
  const positional = process.argv
    .slice(2)
    .filter((value) => !value.startsWith("--"));
  const flagValues = new Set(
    ["data-dir", "turns", "top", "entry", "run"].flatMap((name) => {
      const at = process.argv.indexOf(`--${name}`);
      return at >= 0 && at + 1 < process.argv.length
        ? [process.argv[at + 1]!]
        : [];
    }),
  );
  const sessionId = positional.find((value) => !flagValues.has(value));
  if (!sessionId) {
    console.error(
      "usage: measure:session -- <sessionId> [--json] [--data-dir <dir>] [--turns <n>] [--top <n>] [--entry <entryId>] [--run <n>] [--no-claude-transcripts]",
    );
    process.exitCode = 2;
    return;
  }

  const dataDir = arg("data-dir") ?? DATA_DIR;
  const top = intArg("top");
  const entryId = arg("entry");
  const providerRun = intArg("run");
  const source = resolveAuditSourceFromDataDir(sessionId, dataDir, {
    ...(process.argv.includes("--no-claude-transcripts")
      ? { claudeProjectsDir: undefined }
      : {}),
  });
  const report = auditSession(source, {
    inventory: catalogAuditInventory,
    ...(intArg("turns") !== undefined ? { maxTurns: intArg("turns")! } : {}),
    ...(top !== undefined
      ? { topToolResults: top, topContextJumps: top, topTools: top }
      : {}),
    ...(entryId !== undefined || providerRun !== undefined
      ? {
          drilldown: {
            ...(entryId !== undefined ? { entryId } : {}),
            ...(providerRun !== undefined ? { providerRun } : {}),
          },
        }
      : {}),
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(render(report));
  if (report.persisted && !report.persisted.agrees) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  if (err instanceof SessionInspectionError) {
    console.error(err.message);
    process.exitCode = 2;
  } else throw err;
}
