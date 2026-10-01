/**
 * The one flat worklog row shape every Tempo read tool reports on, plus the
 * grouping/CSV helpers over it. Rows are built from a raw Tempo worklog and
 * whatever Jira metadata is available; a missing join leaves nulls, never a
 * guess.
 */
import { csvLine } from "../../csv.ts";
import { jiraIssueUrl } from "../../jiraClient.ts";
import type { TempoIssueMeta } from "./tempoJiraJoin.ts";
import {
  extractActivity,
  worklogIdOf,
  type TempoWorklog,
} from "./tempoWorklogFetch.ts";

export interface TempoReportRow {
  worklogId: string;
  issueId: string;
  issueKey: string | null;
  issueSummary: string | null;
  issueType: string | null;
  issueUrl: string | null;
  projectKey: string | null;
  labels: string[];
  /** Extra Jira fields by id, flattened to display strings. */
  fields: Record<string, string>;
  date: string;
  startTime: string | null;
  seconds: number;
  billableSeconds: number | null;
  authorAccountId: string | null;
  authorName: string | null;
  description: string;
  activity: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The Tempo-only half of a row, as persisted by the export before any join. */
export type TempoExportRow = Pick<
  TempoReportRow,
  | "worklogId"
  | "issueId"
  | "date"
  | "startTime"
  | "seconds"
  | "billableSeconds"
  | "authorAccountId"
  | "description"
  | "activity"
  | "createdAt"
  | "updatedAt"
>;

export function exportRowOf(worklog: TempoWorklog): TempoExportRow {
  return {
    worklogId: worklogIdOf(worklog),
    issueId: worklog.issue?.id !== undefined ? String(worklog.issue.id) : "",
    date: worklog.startDate ?? "",
    startTime: worklog.startTime ?? null,
    seconds: worklog.timeSpentSeconds ?? 0,
    billableSeconds: worklog.billableSeconds ?? null,
    authorAccountId: worklog.author?.accountId ?? null,
    description: worklog.description ?? "",
    activity: extractActivity(worklog),
    createdAt: typeof worklog.createdAt === "string" ? worklog.createdAt : null,
    updatedAt: typeof worklog.updatedAt === "string" ? worklog.updatedAt : null,
  };
}

export interface JoinSources {
  issues: Map<string, TempoIssueMeta>;
  users: Map<string, string>;
  jiraHost: string | null;
}

/** Join Jira metadata onto an export row; absent metadata stays null. */
export function reportRowOf(
  row: TempoExportRow,
  join: JoinSources,
): TempoReportRow {
  const meta = join.issues.get(row.issueId);
  const issueKey = meta?.key ?? null;
  return {
    ...row,
    issueKey,
    issueSummary: meta?.summary ?? null,
    issueType: meta?.issueType ?? null,
    issueUrl:
      issueKey && join.jiraHost ? jiraIssueUrl(join.jiraHost, issueKey) : null,
    projectKey: meta?.projectKey ?? null,
    labels: meta?.labels ?? [],
    fields: meta?.fields ?? {},
    authorName:
      (row.authorAccountId && join.users.get(row.authorAccountId)) || null,
  };
}

const GROUP_DIMENSIONS = [
  "issue",
  "project",
  "author",
  "date",
  "month",
  "activity",
  "issueType",
] as const;
export type GroupDimension =
  (typeof GROUP_DIMENSIONS)[number] | `customfield_${number}`;

export function parseGroupBy(raw: unknown): GroupDimension[] {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const dims: GroupDimension[] = [];
  for (const item of list) {
    const value = String(item).trim();
    if (
      (GROUP_DIMENSIONS as readonly string[]).includes(value) ||
      /^customfield_\d+$/.test(value)
    )
      dims.push(value as GroupDimension);
    else
      throw new Error(
        `Unknown groupBy dimension "${value}". Use ${GROUP_DIMENSIONS.join(", ")} or a customfield_<id>.`,
      );
  }
  return dims.length ? [...new Set(dims)] : ["issue"];
}

export interface TotalsRow extends Record<string, unknown> {
  seconds: number;
  duration: string;
  count: number;
}

/** Group rows by the requested dimensions; each output row carries its key columns. */
export function aggregateRows(
  rows: TempoReportRow[],
  groupBy: GroupDimension[],
): TotalsRow[] {
  const buckets = new Map<string, TotalsRow>();
  for (const row of rows) {
    const columns: Record<string, unknown> = {};
    for (const dim of groupBy)
      Object.assign(columns, dimensionColumns(row, dim));
    const key = JSON.stringify(Object.values(columns));
    const current = buckets.get(key) ?? {
      ...columns,
      seconds: 0,
      duration: "0m",
      count: 0,
    };
    current.seconds += row.seconds;
    current.count += 1;
    buckets.set(key, current);
  }
  return [...buckets.values()]
    .map((row) => ({ ...row, duration: formatDuration(row.seconds) }))
    .sort((a, b) => b.seconds - a.seconds || b.count - a.count);
}

function dimensionColumns(
  row: TempoReportRow,
  dim: GroupDimension,
): Record<string, unknown> {
  switch (dim) {
    case "issue":
      return {
        issueId: row.issueId,
        issueKey: row.issueKey,
        issueSummary: row.issueSummary,
        issueUrl: row.issueUrl,
      };
    case "project":
      return { projectKey: row.projectKey };
    case "author":
      return {
        authorAccountId: row.authorAccountId,
        authorName: row.authorName,
      };
    case "date":
      return { date: row.date };
    case "month":
      return { month: row.date.slice(0, 7) };
    case "activity":
      return { activity: row.activity };
    case "issueType":
      return { issueType: row.issueType };
    default:
      return { [dim]: row.fields[dim] ?? null };
  }
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/** Column order of the persisted worklog CSV; extra Jira fields append after. */
const CSV_BASE_COLUMNS = [
  "worklogId",
  "date",
  "startTime",
  "seconds",
  "hours",
  "billableSeconds",
  "issueId",
  "issueKey",
  "issueSummary",
  "issueType",
  "projectKey",
  "labels",
  "issueUrl",
  "authorAccountId",
  "authorName",
  "activity",
  "description",
  "createdAt",
  "updatedAt",
] as const;

export function rowsToCsv(
  rows: TempoReportRow[],
  extraFields: string[],
  fieldLabels: Record<string, string> = {},
): string {
  const header = [
    ...CSV_BASE_COLUMNS,
    ...extraFields.map((id) => fieldLabels[id] ?? id),
  ];
  const lines = [csvLine(header)];
  for (const row of rows) {
    const cells: unknown[] = [
      row.worklogId,
      row.date,
      row.startTime,
      row.seconds,
      (row.seconds / 3600).toFixed(4),
      row.billableSeconds,
      row.issueId,
      row.issueKey,
      row.issueSummary,
      row.issueType,
      row.projectKey,
      row.labels.join("; "),
      row.issueUrl,
      row.authorAccountId,
      row.authorName,
      row.activity,
      row.description,
      row.createdAt,
      row.updatedAt,
      ...extraFields.map((id) => row.fields[id] ?? ""),
    ];
    lines.push(csvLine(cells));
  }
  return `${lines.join("\n")}\n`;
}
