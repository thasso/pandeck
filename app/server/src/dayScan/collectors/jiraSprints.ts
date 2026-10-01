import {
  getJiraCredsIfAvailable,
  isJiraConfigured,
} from "../../jiraSettings.ts";
import { jiraGet, type JiraApiConfig } from "../../jiraClient.ts";
import type {
  CollectorOutput,
  DayCollectContext,
  DaySourceCollector,
  DaySourceFact,
} from "../types.ts";

const MAX_BOARDS = 30;
const MAX_SPRINTS = 60;
const GOAL_CHARS = 400;

interface Board {
  id?: number;
  name?: string;
  type?: string;
  location?: { projectKey?: string; projectName?: string };
}
interface BoardPage {
  values?: Board[];
  isLast?: boolean;
  startAt?: number;
  maxResults?: number;
  total?: number;
}
interface Sprint {
  id?: number;
  name?: string;
  state?: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  originBoardId?: number;
}
interface SprintPage {
  values?: Sprint[];
  isLast?: boolean;
}

/**
 * One active sprint → one fact. Semantics (plan § later signals): the ACTIVE
 * sprint STATE, not change — the current goal and window, so synthesis can lead
 * with "what this sprint is for". No per-person data. The goal text is untrusted
 * source content, bounded here and again by the synthesis link/length caps.
 */
export function sprintFact(
  sprint: Sprint,
  board: Board | undefined,
  observedAt: string,
): DaySourceFact {
  const goal = (sprint.goal ?? "").trim();
  return {
    id: `jira-sprint:${sprint.id}`,
    kind: "sprint",
    occurredAt: sprint.startDate ?? null,
    observedAt,
    title: sprint.name ?? `Sprint ${sprint.id}`,
    links: [],
    data: {
      sprintId: sprint.id ?? null,
      state: sprint.state ?? null,
      goal: goal ? goal.slice(0, GOAL_CHARS) : null,
      startDate: sprint.startDate ?? null,
      endDate: sprint.endDate ?? null,
      boardId: board?.id ?? sprint.originBoardId ?? null,
      boardName: board?.name ?? null,
      projectKey: board?.location?.projectKey ?? null,
    },
    tags: ["sprint-goal", "attention"],
  };
}

async function listBoards(
  config: JiraApiConfig,
): Promise<{ boards: Board[]; complete: boolean }> {
  const boards: Board[] = [];
  let startAt = 0;
  while (boards.length < MAX_BOARDS) {
    const page = await jiraGet<BoardPage>(config, "/rest/agile/1.0/board", {
      startAt,
      maxResults: 50,
      type: "scrum",
    });
    const values = page.values ?? [];
    boards.push(...values);
    startAt += values.length;
    if (page.isLast === true || values.length === 0)
      return { boards, complete: true };
  }
  return { boards, complete: false };
}

/**
 * Active-sprint goals across the user's scrum boards (plan § Data sources —
 * "active sprint goals"). Uses the Agile REST API; degrades gracefully (a board
 * with sprints disabled returns an error, which is skipped, not fatal).
 */
export const jiraSprintsCollector: DaySourceCollector = {
  key: "jira-sprints",
  label: "Jira sprints",
  readiness() {
    return isJiraConfigured()
      ? { ready: true }
      : {
          ready: false,
          reason: "unconfigured",
          detail: "Jira is not configured",
        };
  },
  async collect(ctx: DayCollectContext): Promise<CollectorOutput> {
    const config = getJiraCredsIfAvailable();
    if (!config) throw new Error("Jira credentials unavailable");
    const observedAt = new Date().toISOString();

    const { boards, complete: boardsComplete } = await listBoards(config);
    const byBoard = new Map<number, Board>();
    for (const board of boards)
      if (typeof board.id === "number") byBoard.set(board.id, board);

    const seen = new Map<number, DaySourceFact>();
    let sprintListingComplete = true;
    for (const board of boards) {
      if (typeof board.id !== "number") continue;
      if (seen.size >= MAX_SPRINTS) {
        sprintListingComplete = false;
        break;
      }
      try {
        const page = await jiraGet<SprintPage>(
          config,
          `/rest/agile/1.0/board/${board.id}/sprint`,
          { state: "active", maxResults: 50 },
        );
        if (page.isLast === false) sprintListingComplete = false;
        for (const sprint of page.values ?? []) {
          if (typeof sprint.id !== "number" || seen.has(sprint.id)) continue;
          seen.set(
            sprint.id,
            sprintFact(sprint, byBoard.get(board.id), observedAt),
          );
        }
      } catch {
        // A board without a sprint backlog (kanban/simplified) errors on the
        // sprint endpoint; skip it rather than failing the whole source.
      }
    }

    ctx.cache.writeJson(ctx.date, "jira-sprints-raw", {
      boards: boards.length,
      sprints: seen.size,
    });
    const complete = boardsComplete && sprintListingComplete;
    return {
      result: complete ? "complete" : "partial",
      facts: [...seen.values()],
      completeness: {
        boards: boards.length,
        boardsComplete,
        activeSprints: seen.size,
        sprintListingComplete,
      },
      ...(complete
        ? {}
        : {
            notes: [
              "Sprint/board listing was capped; some active sprints may be missing.",
            ],
          }),
    };
  },
};
