/**
 * Full-range Tempo extraction and reporting. `tempo_export_worklogs` walks a
 * date range window by window, checkpoints each window on disk, then joins Jira
 * metadata from a cache that survives a Jira 429 and writes CSV/JSON
 * artifacts the user can download. `tempo_export_report` aggregates a finished
 * export by any dimension without re-reading Tempo.
 */
import {
  defineAgentTool,
  jsonResult,
  type ToolCallContext,
} from "../../mcp/tool.ts";
import { directFileUrlPath } from "../../directFileHttp.ts";
import { errorText } from "../../errors.ts";
import { getJiraFieldMap } from "../../jiraFieldCache.ts";
import type { JiraApiConfig } from "../../jiraClient.ts";
import {
  getTempoToolConfig,
  resolveTempoAuthorAccountId,
  type TempoToolConfig,
} from "../../tempoSettings.ts";
import {
  appendRows,
  assertExportId,
  exportFilePath,
  listExportIds,
  createExportDir,
  readCheckpoint,
  readIssueCache,
  readManifest,
  readRows,
  readUserCache,
  rowsChecksum,
  writeCheckpoint,
  writeExportFile,
  writeIssueCache,
  writeManifest,
  writeReportCsv,
  writeUserCache,
  type ExportCheckpoint,
  type ExportManifest,
} from "./tempoExportStore.ts";
import {
  fetchIssueMetadata,
  resolveTempoFilterIds,
  resolveUserNames,
  type TempoIssueMeta,
} from "./tempoJiraJoin.ts";
import {
  aggregateRows,
  exportRowOf,
  formatDuration,
  parseGroupBy,
  reportRowOf,
  rowsToCsv,
} from "./tempoReportRows.ts";
import { tableToCsv } from "../../csv.ts";
import { fetchAllWorklogs } from "./tempoWorklogFetch.ts";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 31;
const ISSUE_BATCH = 100;
const DEFAULT_REPORT_ROWS = 200;
const MAX_REPORT_ROWS = 2000;
const JIRA_FIELD_RE = /^customfield_\d+$/;

type ExportParams = {
  from?: string;
  to?: string;
  exportId?: string;
  projectKeys?: string[];
  issueKeys?: string[];
  includeAllAuthors?: boolean;
  jiraEnrichment?: boolean;
  jiraFields?: string[];
  windowDays?: number;
};

type ReportParams = {
  exportId?: string;
  groupBy?: string[];
  from?: string;
  to?: string;
  issueKeys?: string[];
  projectKeys?: string[];
  authors?: string[];
  activities?: string[];
  labels?: string[];
  excludeLabels?: string[];
  jiraFields?: string[];
  limit?: number;
  persist?: boolean;
};

const stringList = (description: string) => ({
  type: "array",
  items: { type: "string" },
  description,
});

export const tempoExportWorklogsTool = defineAgentTool<ExportParams>({
  name: "tempo_export_worklogs",
  label: "Tempo: Export Worklogs",
  description:
    "Extract EVERY Tempo worklog in a date range (months or a whole year, all authors by default) into a persisted dataset: worklogs.csv + worklogs.json with date, issue key/id, seconds, author id/name, description and Tempo activity, plus a manifest with row count and an order-independent checksum. Extraction runs window by window with checkpoints; on a failure or timeout call again with the returned exportId to resume without re-reading finished windows. Jira metadata (key, summary, type, labels, project, any customfield_<id>) is joined from a per-export cache and retried on 429; when Jira is unavailable the Tempo rows are still saved (jiraEnrichment: partial) and a re-run with the same exportId completes the join. Aggregate the result with tempo_export_report — do not page the dataset into chat. Read-only against Tempo and Jira.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: {
        type: "string",
        description:
          "Start date YYYY-MM-DD, inclusive. Required unless exportId resumes an existing export.",
      },
      to: {
        type: "string",
        description: "End date YYYY-MM-DD, inclusive.",
      },
      exportId: {
        type: "string",
        description:
          "Resume/refresh an existing export: finishes pending windows, completes the Jira join, rewrites the outputs. Omit to start a new export.",
      },
      projectKeys: stringList(
        "Only worklogs on issues in these Jira projects (keys such as WEB, SDK; numeric project ids also accepted). Applied server-side by Tempo.",
      ),
      issueKeys: stringList(
        "Only worklogs on these issues (keys or numeric ids). Applied server-side by Tempo.",
      ),
      includeAllAuthors: {
        type: "boolean",
        description:
          "Export every visible author (default true). false keeps only the configured Jira user's worklogs.",
      },
      jiraEnrichment: {
        type: "boolean",
        description:
          "Join Jira issue metadata and author display names (default true). false skips Jira entirely; rows then carry issue ids only.",
      },
      jiraFields: stringList(
        "Extra Jira field ids to join and add as CSV columns, e.g. customfield_10050 (Cost Center).",
      ),
      windowDays: {
        type: "number",
        description: "Days per extraction window/checkpoint (1–31, default 7).",
      },
    },
  },
  async execute(params, ctx) {
    const config = await getTempoToolConfig();
    const jiraEnrichment = params.jiraEnrichment !== false;
    // jiraEnrichment=false means NO Jira call at all: not for filters, not for
    // the author, not for field labels.
    const jira = jiraEnrichment ? config.jira : null;
    const notes: string[] = [];

    const checkpoint = params.exportId
      ? resumeCheckpoint(assertExportId(params.exportId))
      : await startCheckpoint(config, jira, params, notes, ctx.signal);
    // The requested fields travel with the export so a resume (documented as
    // "call again with exportId") keeps the columns the first run asked for.
    const jiraFields = [
      ...new Set([
        ...checkpoint.params.jiraFields,
        ...normalizeJiraFields(params.jiraFields),
      ]),
    ];
    if (jiraFields.length !== checkpoint.params.jiraFields.length) {
      checkpoint.params.jiraFields = jiraFields;
      writeCheckpoint(checkpoint);
    }
    if (!params.exportId) {
      const total = checkpoint.windows.length;
      if (total > 1)
        notes.push(
          `Range split into ${total} windows of up to ${windowDaysOf(params)} days.`,
        );
    }

    // Extraction: one window at a time, checkpointed after each.
    const pending = checkpoint.windows.filter((w) => w.status === "pending");
    const onRetry = (info: {
      attempt: number;
      delayMs: number;
      status: number;
    }) =>
      ctx.progress?.(
        progressResult(
          `Tempo answered HTTP ${info.status}; retry ${info.attempt} in ${Math.round(info.delayMs / 1000)}s.`,
        ),
      );
    for (const window of pending) {
      throwIfAborted(ctx.signal);
      ctx.progress?.(
        progressResult(
          `Extracting ${window.from}..${window.to} (${checkpoint.windows.filter((w) => w.status === "done").length}/${checkpoint.windows.length} windows done)`,
        ),
      );
      let worklogs;
      try {
        worklogs = await fetchAllWorklogs({
          apiBaseUrl: config.apiBaseUrl,
          accessToken: config.accessToken,
          from: window.from,
          to: window.to,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          onRetry,
          filter: {
            issueIds: checkpoint.params.issueIds,
            projectIds: checkpoint.params.projectIds,
          },
        });
      } catch (error) {
        throw new Error(
          `Export ${checkpoint.exportId} stopped at window ${window.from}..${window.to}: ${errorText(error)}. Finished windows are checkpointed; call tempo_export_worklogs again with exportId "${checkpoint.exportId}" to resume.`,
        );
      }
      const author = checkpoint.params.authorAccountId;
      const rows = worklogs
        .filter((w) => !author || w.author?.accountId === author)
        .map(exportRowOf);
      appendRows(checkpoint.exportId, rows);
      window.status = "done";
      window.count = rows.length;
      window.seconds = rows.reduce((sum, row) => sum + row.seconds, 0);
      writeCheckpoint(checkpoint);
    }
    checkpoint.status = "extracted";
    writeCheckpoint(checkpoint);

    // Join + outputs.
    const { rows: exportRows, duplicatesRemoved } = readRows(
      checkpoint.exportId,
    );
    const join = await joinJira(
      checkpoint.exportId,
      jira,
      exportRows,
      jiraFields,
      notes,
      ctx,
    );
    const reportRows = exportRows.map((row) => reportRowOf(row, join));
    const fieldLabels = await fieldLabelsFor(jira, jiraFields);
    const csvPath = writeExportFile(
      checkpoint.exportId,
      "csv",
      rowsToCsv(reportRows, jiraFields, fieldLabels),
    );
    const jsonPath = writeExportFile(
      checkpoint.exportId,
      "json",
      `${JSON.stringify(reportRows)}\n`,
    );
    const totalSeconds = reportRows.reduce((sum, row) => sum + row.seconds, 0);
    const unresolved = new Set(
      reportRows.filter((row) => !row.issueKey).map((row) => row.issueId),
    ).size;
    const manifest: ExportManifest = {
      exportId: checkpoint.exportId,
      from: checkpoint.params.from,
      to: checkpoint.params.to,
      params: checkpoint.params,
      rowCount: reportRows.length,
      totalSeconds,
      totalHours: Number((totalSeconds / 3600).toFixed(4)),
      checksum: rowsChecksum(exportRows),
      duplicatesRemoved,
      issueCount: new Set(reportRows.map((row) => row.issueId)).size,
      authorCount: new Set(reportRows.map((row) => row.authorAccountId)).size,
      jiraEnrichment: !jira ? "off" : join.complete ? "on" : "partial",
      unresolvedIssueIds: unresolved,
      extraFields: jiraFields,
      files: {
        csv: csvPath,
        json: jsonPath,
        jsonl: exportFilePath(checkpoint.exportId, "rows"),
        manifest: exportFilePath(checkpoint.exportId, "manifest"),
      },
      completedAt: new Date().toISOString(),
    };
    writeManifest(manifest);
    checkpoint.status = "complete";
    writeCheckpoint(checkpoint);
    if (!jiraEnrichment)
      notes.push("Jira enrichment was disabled; rows carry issue ids only.");
    else if (!config.jira)
      notes.push(
        "Jira integration is off; rows carry issue ids only. Enable Jira and re-run with this exportId to join keys and names.",
      );

    return jsonResult({
      ...manifestSummary(manifest),
      windows: checkpoint.windows.map((w) => ({
        from: w.from,
        to: w.to,
        count: w.count,
        seconds: w.seconds,
      })),
      byProject: aggregateRows(reportRows, ["project"]).slice(0, 50),
      notes,
      next: `Aggregate with tempo_export_report exportId="${manifest.exportId}" (groupBy issue/project/author/date/month/activity/issueType or a customfield id; filters for dates, issues, projects, labels).`,
    });
  },
});

export const tempoExportReportTool = defineAgentTool<ReportParams>({
  name: "tempo_export_report",
  label: "Tempo: Report on Export",
  description:
    "Aggregate a persisted Tempo export (from tempo_export_worklogs) without re-reading Tempo: totals by issue, project, author, date, month, activity, issue type or any joined Jira customfield, optionally restricted to a date sub-range, issue keys, projects, authors, activities or labels — e.g. the exact 2025-dated hours of issues opened in 2024. Missing Jira metadata for requested fields is fetched into the export's cache first. Omit exportId to list available exports. Set persist to also write the full aggregate as a CSV next to the export.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      exportId: {
        type: "string",
        description: "Export to report on; omit to list exports.",
      },
      groupBy: stringList(
        'Dimensions, in order: issue, project, author, date, month, activity, issueType, or a customfield_<id>. Default ["issue"].',
      ),
      from: {
        type: "string",
        description: "Only worklogs dated on/after YYYY-MM-DD.",
      },
      to: {
        type: "string",
        description: "Only worklogs dated on/before YYYY-MM-DD.",
      },
      issueKeys: stringList("Only these issue keys (or numeric ids)."),
      projectKeys: stringList("Only these Jira project keys."),
      authors: stringList(
        "Only these authors: account ids or exact display names.",
      ),
      activities: stringList("Only these Tempo activity (_Account_) keys."),
      labels: stringList(
        "Only issues carrying at least one of these Jira labels.",
      ),
      excludeLabels: stringList(
        "Drop issues carrying any of these Jira labels.",
      ),
      jiraFields: stringList(
        "Jira field ids to make available for groupBy/columns, e.g. customfield_10050; fetched into the cache when missing.",
      ),
      limit: {
        type: "number",
        description: `Aggregate rows to return (default ${DEFAULT_REPORT_ROWS}, max ${MAX_REPORT_ROWS}); the rest is counted, and persist writes all of them.`,
      },
      persist: {
        type: "boolean",
        description:
          "Also write the complete aggregate as report-<n>.csv in the export folder and return its link.",
      },
    },
  },
  async execute(params, ctx) {
    if (!params.exportId?.trim()) return jsonResult({ exports: listExports() });
    const exportId = assertExportId(params.exportId);
    const manifest = readManifest(exportId);
    const checkpoint = readCheckpoint(exportId);
    if (!checkpoint)
      throw new Error(
        `No export "${exportId}". Omit exportId to list exports.`,
      );
    if (checkpoint.status !== "complete")
      throw new Error(
        `Export "${exportId}" is ${checkpoint.status}; finish it with tempo_export_worklogs exportId="${exportId}" first.`,
      );
    const config = await getTempoToolConfig();
    const groupBy = parseGroupBy(params.groupBy);
    const jiraFields = [
      ...new Set([
        ...normalizeJiraFields(params.jiraFields),
        ...groupBy.filter((dim) => JIRA_FIELD_RE.test(dim)),
        ...(manifest?.extraFields ?? []),
      ]),
    ];
    const notes: string[] = [];
    const { rows: exportRows } = readRows(exportId);
    const join = await joinJira(
      exportId,
      config.jira,
      exportRows,
      jiraFields,
      notes,
      ctx,
    );
    let rows = exportRows.map((row) => reportRowOf(row, join));

    const from = params.from ? normalizeDate(params.from, "from") : null;
    const to = params.to ? normalizeDate(params.to, "to") : null;
    const issueKeys = upperSet(params.issueKeys);
    const projectKeys = upperSet(params.projectKeys);
    const authors = new Set(
      (params.authors ?? []).map((a) => a.trim()).filter(Boolean),
    );
    const activities = upperSet(params.activities);
    const labels = new Set(
      (params.labels ?? []).map((l) => l.trim()).filter(Boolean),
    );
    const excludeLabels = new Set(
      (params.excludeLabels ?? []).map((l) => l.trim()).filter(Boolean),
    );
    rows = rows.filter(
      (row) =>
        (!from || row.date >= from) &&
        (!to || row.date <= to) &&
        (!issueKeys.size ||
          issueKeys.has(row.issueKey ?? "") ||
          issueKeys.has(row.issueId)) &&
        (!projectKeys.size || projectKeys.has(row.projectKey ?? "")) &&
        (!authors.size ||
          authors.has(row.authorAccountId ?? "") ||
          authors.has(row.authorName ?? "")) &&
        (!activities.size ||
          activities.has((row.activity ?? "").toUpperCase())) &&
        (!labels.size || row.labels.some((l) => labels.has(l))) &&
        (!excludeLabels.size || !row.labels.some((l) => excludeLabels.has(l))),
    );
    if (issueKeys.size) {
      const seen = new Set(
        rows.flatMap((row) => [row.issueKey ?? "", row.issueId]),
      );
      const missing = [...issueKeys].filter((key) => !seen.has(key));
      if (missing.length)
        notes.push(
          `No worklogs matched ${missing.length} requested issue(s): ${missing.join(", ")}.`,
        );
    }

    const totals = aggregateRows(rows, groupBy);
    const limit = clamp(
      params.limit ?? DEFAULT_REPORT_ROWS,
      1,
      MAX_REPORT_ROWS,
    );
    const totalSeconds = rows.reduce((sum, row) => sum + row.seconds, 0);
    let reportCsv: { path: string; url: string } | undefined;
    if (params.persist) {
      const path = writeReportCsv(exportId, tableToCsv(totals));
      reportCsv = { path, url: fileUrl(path, true) };
    }
    return jsonResult({
      exportId,
      groupBy,
      filters: {
        from,
        to,
        issueKeys: [...issueKeys],
        projectKeys: [...projectKeys],
        authors: [...authors],
        activities: [...activities],
        labels: [...labels],
        excludeLabels: [...excludeLabels],
      },
      jiraEnrichment: !config.jira ? "off" : join.complete ? "on" : "partial",
      worklogCount: rows.length,
      totalSeconds,
      total: formatDuration(totalSeconds),
      totalHours: Number((totalSeconds / 3600).toFixed(4)),
      groupCount: totals.length,
      rows: totals.slice(0, limit),
      truncated: totals.length > limit,
      ...(reportCsv ? { reportCsv } : {}),
      notes,
    });
  },
});

export const assistantTempoExportTools = [
  tempoExportWorklogsTool,
  tempoExportReportTool,
];

/* ----------------------------------------------------------------------- */

async function startCheckpoint(
  config: TempoToolConfig,
  jira: JiraApiConfig | null,
  params: ExportParams,
  notes: string[],
  signal: AbortSignal | undefined,
): Promise<ExportCheckpoint> {
  if (!params.from) throw new Error("from is required to start a new export.");
  const from = normalizeDate(params.from, "from");
  const to = normalizeDate(params.to ?? params.from, "to");
  if (to < from)
    throw new Error(`to (${to}) must be on or after from (${from}).`);
  const projectKeys = [...upperSet(params.projectKeys)];
  const issueKeys = [...upperSet(params.issueKeys)];
  const includeAllAuthors = params.includeAllAuthors !== false;

  let authorAccountId: string | null = null;
  if (!includeAllAuthors) {
    if (config.authorAccountId) authorAccountId = config.authorAccountId;
    else if (jira) authorAccountId = await resolveTempoAuthorAccountId(config);
    else
      throw new Error(
        "includeAllAuthors=false needs the Jira integration with enrichment on (or a cached author id) to know your account. Enable Jira, leave jiraEnrichment on, or export all authors.",
      );
  }
  const projectIds = await resolveTempoFilterIds(
    jira,
    projectKeys,
    "project",
    signal,
    notes,
  );
  const issueIds = await resolveTempoFilterIds(
    jira,
    issueKeys,
    "issue",
    signal,
    notes,
  );

  const windowDays = windowDaysOf(params);
  const checkpoint: ExportCheckpoint = {
    exportId: createExportDir(from, to),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    params: {
      from,
      to,
      projectKeys,
      issueKeys,
      includeAllAuthors,
      authorAccountId,
      projectIds,
      issueIds,
      jiraFields: normalizeJiraFields(params.jiraFields),
    },
    windows: splitWindows(from, to, windowDays).map((w) => ({
      ...w,
      status: "pending",
      count: 0,
      seconds: 0,
    })),
    status: "extracting",
  };
  writeCheckpoint(checkpoint);
  return checkpoint;
}

function resumeCheckpoint(exportId: string): ExportCheckpoint {
  const checkpoint = readCheckpoint(exportId);
  if (!checkpoint)
    throw new Error(
      `No export "${exportId}" to resume. Omit exportId to start a new export, or call tempo_export_report without exportId to list exports.`,
    );
  return checkpoint;
}

function splitWindows(
  from: string,
  to: string,
  days: number,
): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  let cursor = from;
  while (cursor <= to) {
    const end = addDays(cursor, days - 1);
    out.push({ from: cursor, to: end < to ? end : to });
    cursor = addDays(cursor, days);
  }
  return out;
}

function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function windowDaysOf(params: ExportParams): number {
  return clamp(
    Math.floor(params.windowDays ?? DEFAULT_WINDOW_DAYS),
    1,
    MAX_WINDOW_DAYS,
  );
}

interface JoinResult {
  issues: Map<string, TempoIssueMeta>;
  users: Map<string, string>;
  jiraHost: string | null;
  complete: boolean;
}

/**
 * Fill the export's issue/user caches for whatever is still missing, batch by
 * batch, persisting after each so a 429 mid-way loses nothing. A failure is
 * reported in `notes` and the join is marked incomplete, never thrown: the
 * Tempo rows are already safe on disk.
 */
async function joinJira(
  exportId: string,
  jira: JiraApiConfig | null,
  rows: Array<{ issueId: string; authorAccountId: string | null }>,
  jiraFields: string[],
  notes: string[],
  ctx: ToolCallContext,
): Promise<JoinResult> {
  const issues = readIssueCache(exportId);
  const users = readUserCache(exportId);
  if (!jira) return { issues, users, jiraHost: null, complete: false };
  let complete = true;
  const missingIssues = [
    ...new Set(
      rows
        .map((row) => row.issueId)
        .filter((id) => id && !hasFields(issues.get(id), jiraFields)),
    ),
  ];
  try {
    for (let index = 0; index < missingIssues.length; index += ISSUE_BATCH) {
      throwIfAborted(ctx.signal);
      const batch = missingIssues.slice(index, index + ISSUE_BATCH);
      ctx.progress?.(
        progressResult(
          `Joining Jira metadata ${index + batch.length}/${missingIssues.length} issues`,
        ),
      );
      const fetched = await fetchIssueMetadata(
        jira,
        batch,
        jiraFields,
        ctx.signal,
      );
      for (const meta of fetched.values()) {
        const previous = issues.get(meta.id);
        const merged = previous
          ? { ...meta, fields: { ...previous.fields, ...meta.fields } }
          : meta;
        issues.set(merged.id, merged);
        issues.set(merged.key, merged);
      }
      writeIssueCache(exportId, issues);
    }
    const missingUsers = [
      ...new Set(
        rows
          .map((row) => row.authorAccountId)
          .filter((id): id is string => Boolean(id) && !users.has(id!)),
      ),
    ];
    if (missingUsers.length) {
      const names = await resolveUserNames(jira, missingUsers, ctx.signal);
      for (const [id, name] of names) users.set(id, name);
      writeUserCache(exportId, users);
    }
  } catch (error) {
    if (isAbort(error)) throw error;
    complete = false;
    notes.push(
      `Jira join incomplete: ${errorText(error)}. Cached metadata was kept; run again with exportId "${exportId}" to finish the join.`,
    );
  }
  return { issues, users, jiraHost: jira.jiraHost, complete };
}

function hasFields(
  meta: TempoIssueMeta | undefined,
  fields: string[],
): boolean {
  return Boolean(meta) && fields.every((field) => field in meta!.fields);
}

async function fieldLabelsFor(
  jira: JiraApiConfig | null,
  fields: string[],
): Promise<Record<string, string>> {
  if (!jira || fields.length === 0) return {};
  try {
    const map = await getJiraFieldMap(jira);
    return Object.fromEntries(
      fields.map((id) => {
        const name = map.byId.get(id)?.name;
        return [id, name ? `${name} (${id})` : id];
      }),
    );
  } catch {
    return {};
  }
}

function listExports(): Array<Record<string, unknown>> {
  return listExportIds().map((exportId) => {
    const manifest = readManifest(exportId);
    const checkpoint = readCheckpoint(exportId);
    return manifest
      ? manifestSummary(manifest)
      : {
          exportId,
          status: checkpoint?.status ?? "unknown",
          from: checkpoint?.params.from ?? null,
          to: checkpoint?.params.to ?? null,
          windowsDone:
            checkpoint?.windows.filter((w) => w.status === "done").length ?? 0,
          windows: checkpoint?.windows.length ?? 0,
        };
  });
}

function manifestSummary(manifest: ExportManifest): Record<string, unknown> {
  return {
    exportId: manifest.exportId,
    status: "complete",
    from: manifest.from,
    to: manifest.to,
    projectKeys: manifest.params.projectKeys,
    issueKeys: manifest.params.issueKeys,
    includeAllAuthors: manifest.params.includeAllAuthors,
    rowCount: manifest.rowCount,
    totalSeconds: manifest.totalSeconds,
    totalHours: manifest.totalHours,
    total: formatDuration(manifest.totalSeconds),
    checksum: manifest.checksum,
    duplicatesRemoved: manifest.duplicatesRemoved,
    issueCount: manifest.issueCount,
    authorCount: manifest.authorCount,
    jiraEnrichment: manifest.jiraEnrichment,
    unresolvedIssueIds: manifest.unresolvedIssueIds,
    extraFields: manifest.extraFields,
    files: {
      csv: { path: manifest.files.csv, url: fileUrl(manifest.files.csv, true) },
      json: {
        path: manifest.files.json,
        url: fileUrl(manifest.files.json, true),
      },
      manifest: {
        path: manifest.files.manifest,
        url: fileUrl(manifest.files.manifest, false),
      },
    },
    completedAt: manifest.completedAt,
  };
}

function fileUrl(path: string, download: boolean): string {
  return `${directFileUrlPath(path)}${download ? "?download=1" : ""}`;
}

function progressResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function normalizeJiraFields(raw: string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of raw ?? []) {
    const id = value.trim();
    if (!id) continue;
    if (!JIRA_FIELD_RE.test(id))
      throw new Error(
        `jiraFields entries must be field ids like customfield_10050; got "${value}". Use jira_lookup to find the id of a field name.`,
      );
    out.push(id);
  }
  return [...new Set(out)];
}

function upperSet(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? []).map((v) => v.trim().toUpperCase()).filter(Boolean),
  );
}

function normalizeDate(value: string, name: string): string {
  if (!ISO_DATE_RE.test(value))
    throw new Error(`${name} must be a YYYY-MM-DD date.`);
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("The tool call was aborted.");
    error.name = "AbortError";
    throw error;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
