/**
 * Jira Agile sprints: approval-gated edits for `jira_mutate_issue`
 * (`operation: "sprint"`). Discovery (`jira_lookup kind=sprints`) lives in
 * `jiraSprintLookup.ts`, shared with the gateway edge.
 *
 * Part of the shared mutation core (Task-1463): boundary-clean, so the edge
 * may import it. Errors are typed (`jiraMutationErrors.ts`), a read's failure
 * is described by the caller's `describeError`, and every request carries the
 * caller's signal when there is one.
 *
 * A sprint is not an issue. Its name, dates and goal live on the board's sprint
 * object (`/rest/agile/1.0/sprint/{id}`), so no issue edit can reach them. The
 * edit is Jira's PARTIAL update — only the changed properties are sent — and it
 * never changes the sprint's state: starting or completing a sprint moves its
 * issues and stays a board action.
 */
import type {
  JiraIssueMutationItemDisplay,
  JiraSprintChangeDisplay,
  JiraSprintField,
} from "@assistant/shared/jiraMutation";
import { AtlassianHttpError } from "./atlassian/atlassianFetch.ts";
import {
  jiraBaseUrl,
  jiraGet,
  jiraPost,
  type JiraConfig,
} from "./jiraClient.ts";
import { JiraMutationError, jiraWrite } from "./jiraMutationErrors.ts";
import { signalTail } from "./jiraRead.ts";
import {
  positiveInteger,
  type JiraSprintResponse,
} from "./jiraSprintLookup.ts";
import type { WriteScope } from "./writeScope.ts";

export type JiraSprintItemInput = {
  sprintId?: number;
  sprintName?: string;
  sprintStartDate?: string;
  sprintEndDate?: string;
  sprintGoal?: string;
};

/** What staging and applying a sprint item need besides the config. */
export interface JiraSprintDeps extends WriteScope {
  /** Carried by every request; an abort is never wrapped. */
  signal?: AbortSignal | undefined;
  describeError(err: unknown): string;
}

/** An offset is required so the instant is unambiguous whatever the server's zone. */
const ISO_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))$/;

const FIELD_LABELS: Record<JiraSprintField, string> = {
  name: "name",
  startDate: "start",
  endDate: "end",
  goal: "goal",
};

/**
 * Validate a sprint edit against the sprint as Jira holds it now and stage it.
 * Only properties that actually change are kept, so the card shows the real
 * difference and the approved write sends nothing else.
 */
export async function buildJiraSprintItem(
  config: JiraConfig,
  clientId: string,
  raw: JiraSprintItemInput,
  deps: JiraSprintDeps,
): Promise<JiraIssueMutationItemDisplay> {
  const sprintId = positiveInteger(raw.sprintId);
  if (sprintId === null)
    throw new JiraMutationError(
      `sprint item ${clientId} requires sprintId; find it with jira_lookup kind=sprints.`,
    );
  if (
    raw.sprintName === undefined &&
    raw.sprintStartDate === undefined &&
    raw.sprintEndDate === undefined &&
    raw.sprintGoal === undefined
  )
    throw new JiraMutationError(
      `sprint item ${clientId} requires at least one of sprintName, sprintStartDate, sprintEndDate or sprintGoal.`,
    );

  const sprint = await fetchSprint(config, sprintId, deps);
  const name = sprint.name ?? `Sprint ${sprintId}`;
  const state = sprint.state ?? "unknown";
  const changes: JiraSprintChangeDisplay[] = [];

  if (raw.sprintName !== undefined) {
    const next = raw.sprintName.trim();
    if (!next)
      throw new JiraMutationError(
        `sprint item ${clientId} sprintName cannot be empty.`,
      );
    if (next !== sprint.name)
      changes.push({ field: "name", from: sprint.name ?? null, to: next });
  }
  const currentStart = normalizeJiraInstant(sprint.startDate);
  const currentEnd = normalizeJiraInstant(sprint.endDate);
  const nextStart =
    raw.sprintStartDate === undefined
      ? currentStart
      : parseSprintDate(clientId, "sprintStartDate", raw.sprintStartDate);
  const nextEnd =
    raw.sprintEndDate === undefined
      ? currentEnd
      : parseSprintDate(clientId, "sprintEndDate", raw.sprintEndDate);
  if (nextStart !== currentStart)
    changes.push({ field: "startDate", from: currentStart, to: nextStart });
  if (nextEnd !== currentEnd)
    changes.push({ field: "endDate", from: currentEnd, to: nextEnd });
  if (raw.sprintGoal !== undefined) {
    const next = raw.sprintGoal.trim();
    const current = sprint.goal?.trim() ?? "";
    if (next !== current)
      changes.push({ field: "goal", from: current || null, to: next || null });
  }

  if (changes.length === 0)
    throw new JiraMutationError(
      `Sprint ${sprintId} "${name}" already has the requested values; there is nothing to change.`,
    );
  const datesChange = changes.some(
    (change) => change.field === "startDate" || change.field === "endDate",
  );
  if (datesChange && state === "closed")
    throw new JiraMutationError(
      `Sprint ${sprintId} "${name}" is closed; Jira does not change a closed sprint's dates.`,
    );
  if (datesChange && nextStart && nextEnd && nextEnd <= nextStart)
    throw new JiraMutationError(
      `sprint item ${clientId} would end the sprint (${nextEnd}) before it starts (${nextStart}).`,
    );

  return {
    clientId,
    issueKey: "",
    operation: "sprint",
    issueUrl: sprintIssuesUrl(config, sprintId),
    fieldChanges: [],
    sprint: {
      sprintId,
      name,
      state,
      ...(typeof sprint.originBoardId === "number"
        ? { boardId: sprint.originBoardId }
        : {}),
      changes,
    },
  };
}

/**
 * Apply an approved sprint item: one partial update carrying only its changes.
 *
 * A 2xx is not proof: Jira silently ignores date changes on a closed sprint,
 * and a sprint can close between staging and approval. So every change is
 * checked against the sprint Jira returns — none landed is a failure, some
 * landed is a warning naming the rest — and that sprint is recorded as the
 * result either way, so the card and summary state what Jira holds.
 */
export async function executeJiraSprintItem(
  config: JiraConfig,
  item: JiraIssueMutationItemDisplay,
  deps: JiraSprintDeps,
): Promise<void> {
  const sprint = item.sprint;
  if (!sprint) throw new JiraMutationError("Missing sprint update.");
  // A re-executed card must not keep the previous run's outcome.
  delete item.warning;
  delete item.resultIssueUrl;
  const body: Record<string, string> = {};
  for (const change of sprint.changes) body[change.field] = change.to ?? "";
  const updated = await jiraWrite(
    () =>
      jiraPost<JiraSprintResponse | undefined>(
        config,
        `/rest/agile/1.0/sprint/${sprint.sprintId}`,
        body,
        ...signalTail(deps.signal),
      ),
    deps,
  );
  const observed =
    typeof updated?.id === "number"
      ? updated
      : await fetchSprint(config, sprint.sprintId, deps);
  sprint.result = {
    name: observed.name ?? sprint.name,
    startDate: normalizeJiraInstant(observed.startDate),
    endDate: normalizeJiraInstant(observed.endDate),
  };
  const ignored = sprint.changes.filter(
    (change) => !changeLanded(change, observed),
  );
  if (ignored.length > 0) {
    const fields = ignored.map((change) => FIELD_LABELS[change.field]);
    const reason =
      observed.state === "closed"
        ? "; the sprint is closed, and Jira ignores date changes on a closed sprint"
        : "";
    const kept = `Jira kept the sprint's ${fields.join(", ")} unchanged${reason}.`;
    if (ignored.length === sprint.changes.length)
      throw new JiraMutationError(kept);
    item.warning = kept;
  }
  item.resultIssueUrl = sprintIssuesUrl(config, sprint.sprintId);
}

/** Whether the sprint Jira returned holds the value a change asked for. */
function changeLanded(
  change: JiraSprintChangeDisplay,
  observed: JiraSprintResponse,
): boolean {
  switch (change.field) {
    case "name":
      return observed.name === change.to;
    case "goal":
      return (observed.goal?.trim() ?? "") === (change.to ?? "");
    case "startDate":
    case "endDate":
      return normalizeJiraInstant(observed[change.field]) === change.to;
  }
}

/** Short label for one sprint item, as the approval summary lists it. */
export function jiraSprintItemLabel(
  item: JiraIssueMutationItemDisplay,
): string {
  const sprint = item.sprint;
  if (!sprint) return "sprint";
  const fields = sprint.changes.map((change) => FIELD_LABELS[change.field]);
  return `sprint ${sprint.name} (${fields.join(", ")})`;
}

/** What Jira reported for an executed sprint item, for the approval summary. */
export function jiraSprintResultText(
  item: JiraIssueMutationItemDisplay,
): string | null {
  const result = item.sprint?.result;
  if (!result) return null;
  return `${result.name} now ${result.startDate ?? "unset"} – ${result.endDate ?? "unset"}`;
}

async function fetchSprint(
  config: JiraConfig,
  sprintId: number,
  deps: JiraSprintDeps,
): Promise<JiraSprintResponse> {
  try {
    return await jiraGet<JiraSprintResponse>(
      config,
      `/rest/agile/1.0/sprint/${sprintId}`,
      ...signalTail(deps.signal),
    );
  } catch (err) {
    if (deps.signal?.aborted) throw err;
    // By Jira's status, never by the message, which quotes Jira's body.
    if (
      err instanceof AtlassianHttpError &&
      (err.status === 403 || err.status === 404)
    )
      throw new JiraMutationError(
        `Jira sprint ${sprintId} could not be read: ${deps.describeError(err)} Find the sprint id with jira_lookup kind=sprints.`,
      );
    throw err;
  }
}

function parseSprintDate(
  clientId: string,
  field: string,
  value: string,
): string {
  const text = value.trim();
  const match = ISO_DATE_TIME_RE.exec(text);
  // Date.parse rolls an impossible day over (Feb 30 → Mar 2), so the calendar
  // and clock fields are checked before the instant is trusted.
  const ms =
    match && isRealDateTime(match.slice(1).map((part) => Number(part ?? 0)))
      ? Date.parse(text)
      : Number.NaN;
  if (Number.isNaN(ms))
    throw new JiraMutationError(
      `sprint item ${clientId} ${field} must be a real ISO 8601 date-time with an offset, e.g. 2026-10-13T09:00:00+02:00; got "${value}".`,
    );
  return new Date(ms).toISOString();
}

function isRealDateTime([
  year,
  month,
  day,
  hour,
  minute,
  second,
  offsetHour,
  offsetMinute,
]: number[]): boolean {
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day &&
    hour! <= 23 &&
    minute! <= 59 &&
    second! <= 59 &&
    offsetHour! <= 23 &&
    offsetMinute! <= 59
  );
}

/** Jira's own timestamps, normalized like parsed input so equal instants compare equal. */
function normalizeJiraInstant(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/** The sprint's issues in Jira's search: the one sprint view every site serves. */
function sprintIssuesUrl(config: JiraConfig, sprintId: number): string {
  return `${jiraBaseUrl(config.jiraHost)}/issues/?jql=${encodeURIComponent(`sprint = ${sprintId}`)}`;
}
