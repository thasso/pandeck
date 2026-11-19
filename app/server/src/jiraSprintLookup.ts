/**
 * `jira_lookup kind=sprints` (Task-1439): a board's sprints, or those of a
 * project's boards, shared by Pandeck's local tool and the gateway edge's
 * (`jiraRead.ts`). The approval-gated sprint edit stays in
 * `tools/jira/jiraSprint.ts`.
 */
import { jiraGet, type JiraConfig } from "./jiraClient.ts";
import { JiraReadRefusal, stopIfAborted, withSignal } from "./jiraRead.ts";

export type JiraSprintLookupInput = {
  boardId?: number;
  projectKey?: string;
  query?: string;
  sprintStates?: string[];
  maxResults?: number;
};

export type JiraSprintResponse = {
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
  config: JiraConfig,
  params: JiraSprintLookupInput,
  maxResults: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const states = normalizeSprintStates(params.sprintStates);
  const projectKey = params.projectKey?.trim().toUpperCase() || null;
  const boardId =
    params.boardId === undefined ? null : positiveInteger(params.boardId);
  if (params.boardId !== undefined && boardId === null)
    throw new JiraReadRefusal(
      "sprint_board_invalid",
      "kind=sprints boardId must be a positive integer.",
    );
  if (boardId === null && !projectKey)
    throw new JiraReadRefusal(
      "sprint_scope_missing",
      "kind=sprints requires boardId or projectKey.",
    );

  const { boards, complete: boardsComplete } =
    boardId !== null
      ? { boards: [{ id: boardId }], complete: true }
      : await projectBoards(config, projectKey!, signal);
  const query = params.query?.trim().toLowerCase() ?? "";
  const byId = new Map<number, JiraSprintResponse>();
  const skippedBoards: number[] = [];
  const cappedBoards: number[] = [];
  for (const board of boards) {
    if (typeof board.id !== "number") continue;
    let sprints: JiraSprintResponse[];
    try {
      const read = await boardSprints(config, board.id, states, signal);
      sprints = read.sprints;
      if (!read.complete) cappedBoards.push(board.id);
    } catch (err) {
      // A kanban board answers 400: it has no sprints. A named board is the
      // caller's choice, so its failure is theirs to see.
      if (
        boardId === null &&
        /HTTP 400\b/.test(err instanceof Error ? err.message : String(err))
      ) {
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

export function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/** A capped read, saying whether it reached the end of what Jira holds. */
type CappedRead<T> = { complete: boolean } & T;

async function projectBoards(
  config: JiraConfig,
  projectKey: string,
  signal: AbortSignal | undefined,
): Promise<CappedRead<{ boards: JiraBoardResponse[] }>> {
  const page = await jiraGet<JiraPage<JiraBoardResponse>>(
    config,
    "/rest/agile/1.0/board",
    { projectKeyOrId: projectKey, maxResults: PROJECT_BOARD_LIMIT },
    withSignal(signal),
  );
  const boards = (page.values ?? []).slice(0, PROJECT_BOARD_LIMIT);
  if (boards.length === 0)
    throw new JiraReadRefusal(
      "project_without_board",
      `No Jira board shows project ${projectKey}.`,
    );
  return { boards, complete: page.isLast !== false };
}

async function boardSprints(
  config: JiraConfig,
  boardId: number,
  states: string[],
  signal: AbortSignal | undefined,
): Promise<CappedRead<{ sprints: JiraSprintResponse[] }>> {
  const sprints: JiraSprintResponse[] = [];
  // Advance by what Jira returned: it may serve fewer rows than requested.
  while (sprints.length < SPRINTS_PER_BOARD_LIMIT) {
    stopIfAborted(signal);
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
      withSignal(signal),
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
    throw new JiraReadRefusal(
      "sprint_state_unknown",
      `Unknown sprint state(s) ${unknown.join(", ")}; use ${SPRINT_STATES.join(", ")}.`,
    );
  return states;
}
