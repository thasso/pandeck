/**
 * Jira Agile sprints: discovery for `jira_lookup` (`kind: "sprints"`) and
 * approval-gated edits for `jira_mutate_issue` (`operation: "sprint"`).
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
} from "@assistant/shared";
import {
  jiraBaseUrl,
  jiraGet,
  jiraPost,
  type JiraApiConfig,
} from "../../jiraClient.ts";
import { errorText } from "../../errors.ts";

export type JiraSprintItemInput = {
  sprintId?: number;
  sprintName?: string;
  sprintStartDate?: string;
  sprintEndDate?: string;
  sprintGoal?: string;
};

export type JiraSprintLookupInput = {
  boardId?: number;
  projectKey?: string;
  query?: string;
  sprintStates?: string[];
  maxResults?: number;
};

type JiraSprintResponse = {
  id?: number;
  state?: string;
  name?: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  originBoardId?: number;
  goal?: string;
};

type JiraBoardResponse = { id?: number; name?: string; type?: string };

type JiraPage<T> = { values?: T[]; isLast?: boolean };

const SPRINT_STATES = ["future", "active", "closed"] as const;
const DEFAULT_SPRINT_STATES = ["active", "future"];
const SPRINT_PAGE_SIZE = 50;
/** How many sprints one board is read to; closed sprints accumulate without end. */
const SPRINTS_PER_BOARD_LIMIT = 500;
const PROJECT_BOARD_LIMIT = 10;

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
 * Read the sprints of one board, or of every board on a project, with the ids
 * and current dates a sprint edit needs. Active and future sprints by default;
 * closed sprints list newest first within what was read.
 *
 * Both reads are capped (boards per project, sprints per board). A capped read
 * is never reported as exhaustive: the payload names what was cut and how to
 * narrow the request, because a missing sprint must not look like no sprint.
 */
export async function lookupSprints(
  config: JiraApiConfig,
  params: JiraSprintLookupInput,
  maxResults: number,
): Promise<Record<string, unknown>> {
  const states = normalizeSprintStates(params.sprintStates);
  const projectKey = params.projectKey?.trim().toUpperCase() || null;
  const boardId =
    params.boardId === undefined ? null : positiveInteger(params.boardId);
  if (params.boardId !== undefined && boardId === null)
    throw new Error("kind=sprints boardId must be a positive integer.");
  if (boardId === null && !projectKey)
    throw new Error("kind=sprints requires boardId or projectKey.");

  const { boards, complete: boardsComplete } =
    boardId !== null
      ? { boards: [{ id: boardId }], complete: true }
      : await projectBoards(config, projectKey!);
  const query = params.query?.trim().toLowerCase() ?? "";
  const byId = new Map<number, JiraSprintResponse>();
  const skippedBoards: number[] = [];
  const cappedBoards: number[] = [];
  for (const board of boards) {
    if (typeof board.id !== "number") continue;
    let sprints: JiraSprintResponse[];
    try {
      const read = await boardSprints(config, board.id, states);
      sprints = read.sprints;
      if (!read.complete) cappedBoards.push(board.id);
    } catch (err) {
      // A kanban board answers 400: it has no sprints. A named board is the
      // caller's choice, so its failure is theirs to see.
      if (boardId === null && /HTTP 400\b/.test(errorText(err))) {
        skippedBoards.push(board.id);
        continue;
      }
      throw err;
    }
    for (const sprint of sprints)
      if (typeof sprint.id === "number" && !byId.has(sprint.id))
        byId.set(sprint.id, sprint);
  }
  const matched = [...byId.values()]
    .filter(
      (sprint) => !query || (sprint.name ?? "").toLowerCase().includes(query),
    )
    .sort(compareSprints);
  const sprints = matched.slice(0, maxResults).map(compactSprint);
  const notes = [
    boardsComplete
      ? ""
      : `More than ${PROJECT_BOARD_LIMIT} boards show ${projectKey}; only the first ${PROJECT_BOARD_LIMIT} were read. Pass boardId to read a specific board.`,
    cappedBoards.length
      ? `Board(s) ${cappedBoards.join(", ")} hold more than ${SPRINTS_PER_BOARD_LIMIT} sprints in these states; only the first ${SPRINTS_PER_BOARD_LIMIT} Jira returns (oldest first) were read, so later sprints may be missing. Narrow sprintStates.`
      : "",
  ].filter(Boolean);
  return {
    kind: "sprints",
    jiraHost: config.jiraHost,
    ...(boardId !== null ? { boardId } : { projectKey }),
    ...(boardId === null
      ? {
          boards: boards.map((board) => ({
            id: board.id,
            name: board.name,
            type: board.type,
          })),
        }
      : {}),
    ...(skippedBoards.length ? { boardsWithoutSprints: skippedBoards } : {}),
    ...(boardsComplete ? {} : { boardsTruncated: true }),
    ...(cappedBoards.length ? { sprintReadCappedOnBoards: cappedBoards } : {}),
    states,
    returned: sprints.length,
    totalMatched: matched.length,
    exhausted: sprints.length >= matched.length && notes.length === 0,
    ...(notes.length ? { note: notes.join(" ") } : {}),
    sprints,
  };
}

/**
 * Validate a sprint edit against the sprint as Jira holds it now and stage it.
 * Only properties that actually change are kept, so the card shows the real
 * difference and the approved write sends nothing else.
 */
export async function buildJiraSprintItem(
  config: JiraApiConfig,
  clientId: string,
  raw: JiraSprintItemInput,
): Promise<JiraIssueMutationItemDisplay> {
  const sprintId = positiveInteger(raw.sprintId);
  if (sprintId === null)
    throw new Error(
      `sprint item ${clientId} requires sprintId; find it with jira_lookup kind=sprints.`,
    );
  if (
    raw.sprintName === undefined &&
    raw.sprintStartDate === undefined &&
    raw.sprintEndDate === undefined &&
    raw.sprintGoal === undefined
  )
    throw new Error(
      `sprint item ${clientId} requires at least one of sprintName, sprintStartDate, sprintEndDate or sprintGoal.`,
    );

  const sprint = await fetchSprint(config, sprintId);
  const name = sprint.name ?? `Sprint ${sprintId}`;
  const state = sprint.state ?? "unknown";
  const changes: JiraSprintChangeDisplay[] = [];

  if (raw.sprintName !== undefined) {
    const next = raw.sprintName.trim();
    if (!next)
      throw new Error(`sprint item ${clientId} sprintName cannot be empty.`);
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
    throw new Error(
      `Sprint ${sprintId} "${name}" already has the requested values; there is nothing to change.`,
    );
  const datesChange = changes.some(
    (change) => change.field === "startDate" || change.field === "endDate",
  );
  if (datesChange && state === "closed")
    throw new Error(
      `Sprint ${sprintId} "${name}" is closed; Jira does not change a closed sprint's dates.`,
    );
  if (datesChange && nextStart && nextEnd && nextEnd <= nextStart)
    throw new Error(
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
  config: JiraApiConfig,
  item: JiraIssueMutationItemDisplay,
): Promise<void> {
  const sprint = item.sprint;
  if (!sprint) throw new Error("Missing sprint update.");
  // A re-executed card must not keep the previous run's outcome.
  delete item.warning;
  delete item.resultIssueUrl;
  const body: Record<string, string> = {};
  for (const change of sprint.changes) body[change.field] = change.to ?? "";
  const updated = await jiraPost<JiraSprintResponse | undefined>(
    config,
    `/rest/agile/1.0/sprint/${sprint.sprintId}`,
    body,
  );
  const observed =
    typeof updated?.id === "number"
      ? updated
      : await fetchSprint(config, sprint.sprintId);
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
    if (ignored.length === sprint.changes.length) throw new Error(kept);
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
  config: JiraApiConfig,
  sprintId: number,
): Promise<JiraSprintResponse> {
  try {
    return await jiraGet<JiraSprintResponse>(
      config,
      `/rest/agile/1.0/sprint/${sprintId}`,
    );
  } catch (err) {
    const message = errorText(err);
    if (/HTTP 40(3|4)\b/.test(message))
      throw new Error(
        `Jira sprint ${sprintId} could not be read: ${message} Find the sprint id with jira_lookup kind=sprints.`,
      );
    throw err;
  }
}

/** A capped read, saying whether it reached the end of what Jira holds. */
type CappedRead<T> = { complete: boolean } & T;

async function projectBoards(
  config: JiraApiConfig,
  projectKey: string,
): Promise<CappedRead<{ boards: JiraBoardResponse[] }>> {
  const page = await jiraGet<JiraPage<JiraBoardResponse>>(
    config,
    "/rest/agile/1.0/board",
    { projectKeyOrId: projectKey, maxResults: PROJECT_BOARD_LIMIT },
  );
  const boards = (page.values ?? []).slice(0, PROJECT_BOARD_LIMIT);
  if (boards.length === 0)
    throw new Error(`No Jira board shows project ${projectKey}.`);
  return { boards, complete: page.isLast !== false };
}

async function boardSprints(
  config: JiraApiConfig,
  boardId: number,
  states: string[],
): Promise<CappedRead<{ sprints: JiraSprintResponse[] }>> {
  const sprints: JiraSprintResponse[] = [];
  // Advance by what Jira returned: it may serve fewer rows than requested.
  while (sprints.length < SPRINTS_PER_BOARD_LIMIT) {
    const page = await jiraGet<JiraPage<JiraSprintResponse>>(
      config,
      `/rest/agile/1.0/board/${boardId}/sprint`,
      {
        state: states.join(","),
        startAt: sprints.length,
        maxResults: Math.min(
          SPRINT_PAGE_SIZE,
          SPRINTS_PER_BOARD_LIMIT - sprints.length,
        ),
      },
    );
    const values = page.values ?? [];
    sprints.push(...values);
    if (page.isLast !== false || values.length === 0)
      return { sprints, complete: true };
  }
  return { sprints, complete: false };
}

/** Active first, then future in board order, then closed newest first. */
function compareSprints(a: JiraSprintResponse, b: JiraSprintResponse): number {
  const rank = (state: string | undefined) =>
    state === "active" ? 0 : state === "future" ? 1 : 2;
  const byState = rank(a.state) - rank(b.state);
  if (byState !== 0 || a.state !== "closed") return byState;
  // Jira's dates carry offsets, so only the instant orders them; undated last.
  const aEnd = instantMs(a.endDate);
  const bEnd = instantMs(b.endDate);
  if (aEnd === bEnd) return 0;
  if (aEnd === null) return 1;
  if (bEnd === null) return -1;
  return bEnd - aEnd;
}

function instantMs(value: string | undefined): number | null {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

function compactSprint(sprint: JiraSprintResponse): Record<string, unknown> {
  return {
    id: sprint.id,
    name: sprint.name,
    state: sprint.state,
    startDate: sprint.startDate ?? null,
    endDate: sprint.endDate ?? null,
    ...(sprint.state === "closed" && sprint.completeDate
      ? { completeDate: sprint.completeDate }
      : {}),
    ...(sprint.goal?.trim() ? { goal: sprint.goal.trim() } : {}),
    ...(typeof sprint.originBoardId === "number"
      ? { boardId: sprint.originBoardId }
      : {}),
  };
}

function normalizeSprintStates(value: string[] | undefined): string[] {
  if (!value?.length) return DEFAULT_SPRINT_STATES;
  const states = [...new Set(value.map((state) => state.trim().toLowerCase()))];
  const unknown = states.filter(
    (state) => !(SPRINT_STATES as readonly string[]).includes(state),
  );
  if (unknown.length > 0)
    throw new Error(
      `Unknown sprint state(s) ${unknown.join(", ")}; use ${SPRINT_STATES.join(", ")}.`,
    );
  return states;
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
    throw new Error(
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

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/** The sprint's issues in Jira's search: the one sprint view every site serves. */
function sprintIssuesUrl(config: JiraApiConfig, sprintId: number): string {
  return `${jiraBaseUrl(config.jiraHost)}/issues/?jql=${encodeURIComponent(`sprint = ${sprintId}`)}`;
}
