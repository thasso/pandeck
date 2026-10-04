/** Deferred-tool benchmark and retrospective used by `pnpm run measure:tools`. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentType } from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import { toolGroupsFor } from "./tools/catalog.ts";
import { rankToolSearch } from "./tools/findTools.ts";
import { toolDefinitionChars } from "./tools/toolExposure.ts";

const PERSONAS: AgentType[] = [
  "assistant",
  "personal-assistant",
  "developer",
  "workshop",
];
const CLAUDE_MCP_PREFIX = "mcp__pa__";
/**
 * Historical Task-264 definition accounting, measured at d799f0d5^ using the
 * same name + description + JSON-schema formula as current catalog tools.
 * Keep the per-tool evidence visible so a re-measurement cannot silently
 * replace one opaque aggregate.
 */
const REMOVED_TASK_WORKFLOW_DEFINITION_CHARS = {
  task_workflow_read: 265,
  task_plan_write: 502,
  task_plan_review: 1_026,
  task_review_submit: 1_193,
  task_workflow_summarize: 377,
} as const;

export interface ToolMeasurementReport {
  generatedAt: string;
  static: Array<{
    persona: AgentType;
    totalTools: number;
    eagerTools: number;
    eagerDefinitionChars: number;
    deferredTools: number;
    deferredDefinitionChars: number;
    /** First-request definition chars avoided by deferring this tier. */
    initialSavingsDefinitionChars: number;
    groups: Array<{ id: string; tools: number; definitionChars: number }>;
  }>;
  removedWorkflow: { definitionChars: number; note: string };
  retrospective: {
    files: number;
    activationEvents: number;
    loadedNames: number;
    calledAfterLoad: number;
    precision: number;
    activationDefinitionChars: number;
    unusedDefinitionChars: number;
  };
  cache: {
    providerCalls: number;
    hits: number;
    misses: number;
    hitRate: number;
  };
  payloadProbe: {
    file?: string;
    captures: number;
    meanPrefixRatio: number;
    fullDivergences: number;
    note?: string;
  };
  scoringExamples: Array<{
    query: string;
    top: Array<{ name: string; group: string; score: number }>;
  }>;
}

export function measureTools(
  options: {
    dataDir?: string;
    claudeProjectsDir?: string;
    payloadProbeFile?: string;
  } = {},
): ToolMeasurementReport {
  const dataDir = options.dataDir ?? DATA_DIR;
  const staticRows = PERSONAS.map((persona) => {
    const groups = toolGroupsFor(persona);
    const groupRows = groups.map((group) => ({
      id: group.id,
      tools: group.tools.length,
      definitionChars: group.tools.reduce(
        (sum, tool) => sum + toolDefinitionChars(tool),
        0,
      ),
    }));
    const eager = groups.filter((group) => group.loading === "eager");
    const deferred = groups.filter((group) => group.loading === "deferred");
    return {
      persona,
      totalTools: groups.flatMap((group) => group.tools).length,
      eagerTools: eager.flatMap((group) => group.tools).length,
      eagerDefinitionChars: eager
        .flatMap((group) => group.tools)
        .reduce((sum, tool) => sum + toolDefinitionChars(tool), 0),
      deferredTools: deferred.flatMap((group) => group.tools).length,
      deferredDefinitionChars: deferred
        .flatMap((group) => group.tools)
        .reduce((sum, tool) => sum + toolDefinitionChars(tool), 0),
      initialSavingsDefinitionChars: deferred
        .flatMap((group) => group.tools)
        .reduce((sum, tool) => sum + toolDefinitionChars(tool), 0),
      groups: groupRows,
    };
  });

  const appLogs = appSessionLogs(join(dataDir, "sessions"));
  const claudeRoot =
    options.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
  const claudeLogs = filesEnding(claudeRoot, ".jsonl");
  const activity = [...appLogs, ...claudeLogs].map(readActivity);
  const loadedNames = activity.reduce((sum, row) => sum + row.loaded, 0);
  const calledAfterLoad = activity.reduce((sum, row) => sum + row.used, 0);
  const providerCalls = activity.reduce(
    (sum, row) => sum + row.providerCalls,
    0,
  );
  const hits = activity.reduce((sum, row) => sum + row.cacheHits, 0);
  const definitionByName = definitionMap();
  const activationDefinitionChars = activity.reduce(
    (sum, row) =>
      sum +
      row.loadedToolNames.reduce(
        (fileSum, name) => fileSum + (definitionByName.get(name) ?? 0),
        0,
      ),
    0,
  );
  const unusedDefinitionChars = activity.reduce(
    (sum, row) =>
      sum +
      row.unusedNames.reduce(
        (fileSum, name) => fileSum + (definitionByName.get(name) ?? 0),
        0,
      ),
    0,
  );

  const probeFile =
    options.payloadProbeFile ??
    process.env.ASSISTANT_TOOL_PAYLOAD_PROBE_FILE?.trim();
  const probeRows = probeFile ? readJsonLines(probeFile) : [];
  const ratios = probeRows
    .map((row) => numberField(row, "prefixRatio"))
    .filter((value): value is number => value !== undefined);

  return {
    generatedAt: new Date().toISOString(),
    static: staticRows,
    removedWorkflow: {
      definitionChars: Object.values(
        REMOVED_TASK_WORKFLOW_DEFINITION_CHARS,
      ).reduce((sum, chars) => sum + chars, 0),
      note: "Historical Task-264 task-workflow family (five tools on developer/workshop), measured at d799f0d5^; excluded from current discovery savings.",
    },
    retrospective: {
      files: activity.length,
      activationEvents: activity.reduce((sum, row) => sum + row.events, 0),
      loadedNames,
      calledAfterLoad,
      precision: loadedNames > 0 ? calledAfterLoad / loadedNames : 0,
      activationDefinitionChars,
      unusedDefinitionChars,
    },
    cache: {
      providerCalls,
      hits,
      misses: Math.max(0, providerCalls - hits),
      hitRate: providerCalls > 0 ? hits / providerCalls : 0,
    },
    payloadProbe: {
      ...(probeFile ? { file: probeFile } : {}),
      captures: probeRows.length,
      meanPrefixRatio:
        ratios.length > 0
          ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length
          : 0,
      fullDivergences: ratios.filter((ratio) => ratio === 0).length,
      ...(!probeFile
        ? {
            note: "Set ASSISTANT_TOOL_PAYLOAD_PROBE_FILE and run real pi turns to capture content-free payload prefix divergence metrics.",
          }
        : {}),
    },
    scoringExamples: [
      "read another session transcript",
      "look at what another agent session did",
      "find and inspect relevant information",
    ].map((query) => ({
      query,
      top: rankToolSearch("developer", query).slice(0, 8),
    })),
  };
}

function definitionMap(): Map<string, number> {
  const map = new Map<string, number>();
  for (const persona of PERSONAS)
    for (const group of toolGroupsFor(persona))
      for (const tool of group.tools)
        map.set(tool.name, toolDefinitionChars(tool));
  return map;
}

interface Activity {
  events: number;
  loaded: number;
  used: number;
  loadedToolNames: string[];
  unusedNames: string[];
  providerCalls: number;
  cacheHits: number;
}

function readActivity(file: string): Activity {
  const rows = readJsonLines(file);
  const loadAt = new Map<string, number>();
  const calls = new Map<string, number[]>();
  let events = 0;
  let providerCalls = 0;
  let cacheHits = 0;
  rows.forEach((row, index) => {
    const loaded = loadedNames(row);
    if (loaded.length > 0) events += 1;
    for (const name of loaded) if (!loadAt.has(name)) loadAt.set(name, index);
    for (const name of calledNames(row)) {
      const positions = calls.get(name) ?? [];
      positions.push(index);
      calls.set(name, positions);
    }
    for (const usage of usageObjects(row)) {
      providerCalls += 1;
      if (cacheRead(usage) > 0) cacheHits += 1;
    }
  });
  const usedNames = [...loadAt].filter(([name, at]) =>
    (calls.get(name) ?? []).some((position) => position > at),
  );
  return {
    events,
    loaded: loadAt.size,
    used: usedNames.length,
    loadedToolNames: [...loadAt.keys()],
    unusedNames: [...loadAt.keys()].filter(
      (name) => !usedNames.some(([used]) => used === name),
    ),
    providerCalls,
    cacheHits,
  };
}

function loadedNames(value: unknown): string[] {
  const names = new Set<string>();
  walk(value, (record) => {
    if (Array.isArray(record.addedToolNames))
      for (const name of record.addedToolNames)
        if (typeof name === "string") names.add(bareName(name));
    if (
      (record.type === "tool_reference" || record.type === "toolReference") &&
      typeof (record.tool_name ?? record.toolName ?? record.name) === "string"
    )
      names.add(
        bareName(String(record.tool_name ?? record.toolName ?? record.name)),
      );
    const toolName = record.toolName ?? record.name;
    if (toolName === "find_tools" && Array.isArray(record.content))
      for (const block of record.content) {
        const text =
          isRecord(block) && typeof block.text === "string"
            ? block.text
            : undefined;
        if (!text) continue;
        try {
          const payload = JSON.parse(text) as { loaded?: unknown };
          if (Array.isArray(payload.loaded))
            for (const name of payload.loaded)
              if (typeof name === "string") names.add(bareName(name));
        } catch {
          // Non-JSON tool output.
        }
      }
  });
  return [...names];
}

function calledNames(value: unknown): string[] {
  const names = new Set<string>();
  walk(value, (record) => {
    if (
      (record.type === "toolCall" || record.type === "tool_use") &&
      typeof record.name === "string"
    )
      names.add(bareName(record.name));
  });
  return [...names];
}

function usageObjects(value: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  walk(value, (record) => {
    const usage = record.usage;
    if (isRecord(usage)) rows.push(usage);
  });
  return rows;
}

function cacheRead(usage: Record<string, unknown>): number {
  const details = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : undefined;
  return Number(
    usage.cacheRead ??
      usage.cacheReadTokens ??
      usage.cache_read_input_tokens ??
      details?.cached_tokens ??
      0,
  );
}

function walk(
  value: unknown,
  visit: (record: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  if (!isRecord(value)) return;
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

function readJsonLines(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          const value = JSON.parse(line) as unknown;
          return isRecord(value) ? value : {};
        } catch {
          return {};
        }
      });
  } catch {
    return [];
  }
}

function appSessionLogs(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const native = join(dir, "native.jsonl");
    const canonical = join(dir, "log.jsonl");
    if (existsSync(native)) out.push(native);
    else if (existsSync(canonical)) out.push(canonical);
  }
  return out;
}
function filesEnding(root: string, suffix: string): string[] {
  return files(root, (file) => file.endsWith(suffix));
}
function files(root: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) visit(path);
      else if (accept(name)) out.push(path);
    }
  };
  visit(root);
  return out;
}
function bareName(name: string): string {
  return name.startsWith(CLAUDE_MCP_PREFIX)
    ? name.slice(CLAUDE_MCP_PREFIX.length)
    : name;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  return typeof record[key] === "number" ? record[key] : undefined;
}
