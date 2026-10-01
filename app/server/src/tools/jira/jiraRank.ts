/**
 * Jira Agile backlog ranking for `jira_mutate_issue` (`operation: "rank"`).
 *
 * Rank is Jira's own ordering operation (`PUT /rest/agile/1.0/issue/rank`); the
 * LexoRank value behind it is opaque and is never written as a field. Jira
 * offers no "move to top" call, so a top/bottom request is resolved here
 * against a BOUNDED scope — one board's backlog (or its epics) or one parent's
 * children, read in rank order — and turned into a rank against the issue that
 * currently sits at that end.
 *
 * A batch becomes a CHAIN of single-issue calls: the first issue moves to the
 * requested position, every later issue lands after its predecessor. Jira's
 * multi-issue rank leaves the resulting order of the batch unspecified, while a
 * chain states it; and when a step fails the steps already applied hold the
 * requested relative order instead of reversing it, with the rest left
 * untouched rather than ranked against an issue that never moved.
 */
import type {
  JiraIssueMutationItemDisplay,
  JiraIssueRankPosition,
  JiraIssueRankScopeDisplay,
  JiraIssueRankStepDisplay,
} from "@assistant/shared";
import {
  jiraBaseUrl,
  jiraGet,
  jiraPost,
  jiraPut,
  type JiraApiConfig,
} from "../../jiraClient.ts";
import { errorText } from "../../errors.ts";
import { assertIssuePermission } from "./jiraPermissions.ts";

/** Jira caps one rank call at 50 issues; the chain honours the same ceiling. */
const RANK_MAX_ISSUES = 50;

/** How far into a board backlog or a parent's children an ordering is read. */
const RANK_SCOPE_LIMIT = 100;

export type JiraRankItemInput = {
  rankIssues?: string[];
  rankPosition?: string;
  rankTargetIssue?: string;
  rankBoardId?: number;
  rankParentIssue?: string;
};

type RankIssueMeta = {
  key: string;
  projectKey: string | null;
  issueType: string | null;
  hierarchyLevel: number | null;
  parentKey: string | null;
  summary: string | null;
};

type JiraRankBuildResult = {
  item: JiraIssueMutationItemDisplay;
  warnings: string[];
};

/**
 * Validate a rank request against Jira and stage it as an approval item.
 * Everything Jira can tell us up front — the issues exist, they share a
 * project and a hierarchy level, the board covers them, the parent owns them,
 * and we may schedule them — is checked here so approval cannot stage a rank
 * that is guaranteed to fail.
 */
export async function buildJiraRankItem(
  config: JiraApiConfig,
  clientId: string,
  raw: JiraRankItemInput,
): Promise<JiraRankBuildResult> {
  const warnings: string[] = [];
  const position = normalizeRankPosition(clientId, raw.rankPosition);
  const requested = normalizeRankIssues(clientId, raw.rankIssues);
  const boardId = normalizeBoardId(clientId, raw.rankBoardId);
  const parentInput = raw.rankParentIssue?.trim()
    ? normalizeKey(raw.rankParentIssue)
    : null;
  const targetInput = raw.rankTargetIssue?.trim()
    ? normalizeKey(raw.rankTargetIssue)
    : null;

  if (position === "before" || position === "after") {
    if (!targetInput)
      throw new Error(
        `rank item ${clientId} with rankPosition=${position} requires rankTargetIssue.`,
      );
    if (parentInput)
      throw new Error(
        `rank item ${clientId} cannot combine rankPosition=${position} with rankParentIssue; the target issue already fixes the position.`,
      );
    if (requested.includes(targetInput))
      throw new Error(
        `rank item ${clientId} cannot rank ${targetInput} relative to itself.`,
      );
  } else {
    if (targetInput)
      throw new Error(
        `rank item ${clientId} cannot combine rankPosition=${position} with rankTargetIssue; use before/after to rank against a specific issue.`,
      );
    if (boardId !== null && parentInput)
      throw new Error(
        `rank item ${clientId} must bound rankPosition=${position} by either rankBoardId or rankParentIssue, not both.`,
      );
    if (boardId === null && !parentInput)
      throw new Error(
        `rank item ${clientId} with rankPosition=${position} requires rankBoardId or rankParentIssue to bound the backlog it moves within.`,
      );
  }

  const metas: RankIssueMeta[] = [];
  for (const key of requested) metas.push(await fetchRankIssue(config, key));
  const targetMeta = targetInput
    ? await fetchRankIssue(config, targetInput)
    : null;
  const all = targetMeta ? [...metas, targetMeta] : metas;

  assertOneProject(all);
  assertOneHierarchyLevel(all);

  const issueKeys = metas.map((meta) => meta.key);
  const projectKey = all.find((meta) => meta.projectKey)?.projectKey ?? null;
  const hierarchyLevel =
    all.find((meta) => meta.hierarchyLevel !== null)?.hierarchyLevel ?? null;

  if (boardId !== null && projectKey)
    await assertBoardCoversProject(config, boardId, projectKey);
  if (parentInput) await assertChildrenOf(config, parentInput, metas);

  for (const meta of all)
    await assertIssuePermission(config, meta.key, "SCHEDULE_ISSUES", "rank");

  let anchorKey = targetMeta?.key ?? null;
  let scope: JiraIssueRankScopeDisplay | null = null;

  if (position === "top" || position === "bottom") {
    scope =
      boardId !== null
        ? { kind: "board", boardId, epics: (hierarchyLevel ?? 0) > 0 }
        : { kind: "parent", parentIssueKey: parentInput! };
    const order = await readScopeOrder(config, scope);
    const ranked = new Set(issueKeys);
    const others = order.filter((key) => !ranked.has(key));
    anchorKey =
      (position === "top" ? others[0] : others[others.length - 1]) ?? null;
    if (!anchorKey && issueKeys.length < 2)
      throw new Error(
        `Jira ${rankScopeLabel(scope)} holds no other issue to rank ${issueKeys[0]} against, so ${position} has nothing to move it past.`,
      );
    if (position === "bottom" && order.length >= RANK_SCOPE_LIMIT)
      warnings.push(
        `${rankScopeLabel(scope)} was read up to ${RANK_SCOPE_LIMIT} issues; "bottom" means the end of that window, not necessarily the end of a longer backlog.`,
      );
  }

  const steps = buildRankSteps(issueKeys, position, anchorKey);
  if (steps.length === 0)
    throw new Error(
      `rank item ${clientId} produced no Jira rank operation to apply.`,
    );

  const first = issueKeys[0]!;
  return {
    item: {
      clientId,
      issueKey: first,
      operation: "rank",
      issueUrl: issueUrl(config, first),
      ...(metas[0]?.summary ? { issueSummary: metas[0].summary } : {}),
      fieldChanges: [],
      rankIssueKeys: issueKeys,
      rankPosition: position,
      rankTargetIssueKey: anchorKey,
      ...(scope ? { rankScope: scope } : {}),
      rankSteps: steps,
    },
    warnings,
  };
}

/**
 * Apply a staged rank chain. Execution stops at the first failed step: every
 * later step ranks against an issue that never moved, so attempting them would
 * scatter the batch instead of leaving the applied prefix intact.
 */
export async function executeJiraRankItem(
  config: JiraApiConfig,
  item: JiraIssueMutationItemDisplay,
): Promise<void> {
  const steps = item.rankSteps ?? [];
  if (steps.length === 0) throw new Error("Missing Jira rank operations.");
  const applied: string[] = [];
  let failure: string | null = null;
  for (const [index, step] of steps.entries()) {
    try {
      await rankOne(config, step);
      step.resultOk = true;
      delete step.error;
      applied.push(step.issueKey);
    } catch (err) {
      step.resultOk = false;
      step.error = errorText(err);
      for (const later of steps.slice(index + 1)) {
        delete later.resultOk;
        delete later.error;
      }
      const skipped = steps.slice(index + 1).map((later) => later.issueKey);
      failure = [
        `Ranking ${step.issueKey} ${step.placement} ${step.relativeToIssueKey} failed: ${step.error}.`,
        applied.length
          ? `Applied: ${applied.join(", ")}.`
          : "No rank operation was applied.",
        skipped.length ? `Not attempted: ${skipped.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ");
      break;
    }
  }
  const observed = await observeRankOrder(config, item);
  if (observed) item.rankResultOrder = observed;
  else delete item.rankResultOrder;
  if (failure) throw new Error(failure);
}

/** One `PUT /rest/agile/1.0/issue/rank`, surfacing Jira's per-issue 207 shape. */
async function rankOne(
  config: JiraApiConfig,
  step: JiraIssueRankStepDisplay,
): Promise<void> {
  const response = await jiraPut<{
    entries?: Array<{ issueId?: number; status?: number; errors?: string[] }>;
  }>(config, "/rest/agile/1.0/issue/rank", {
    issues: [step.issueKey],
    ...(step.placement === "before"
      ? { rankBeforeIssue: step.relativeToIssueKey }
      : { rankAfterIssue: step.relativeToIssueKey }),
  });
  // A multi-status reply is a 2xx: the failure only shows up per entry.
  const failed = (response?.entries ?? []).filter(
    (entry) => typeof entry.status === "number" && entry.status >= 400,
  );
  if (failed.length > 0)
    throw new Error(
      failed
        .map((entry) => entry.errors?.join("; ") || `HTTP ${entry.status}`)
        .join("; "),
    );
}

/** Chain the batch: the head takes the requested position, the tail follows it. */
function buildRankSteps(
  issueKeys: string[],
  position: JiraIssueRankPosition,
  anchorKey: string | null,
): JiraIssueRankStepDisplay[] {
  const steps: JiraIssueRankStepDisplay[] = [];
  if (anchorKey)
    steps.push({
      issueKey: issueKeys[0]!,
      placement:
        position === "before" || position === "top" ? "before" : "after",
      relativeToIssueKey: anchorKey,
    });
  for (let index = 1; index < issueKeys.length; index += 1)
    steps.push({
      issueKey: issueKeys[index]!,
      placement: "after",
      relativeToIssueKey: issueKeys[index - 1]!,
    });
  return steps;
}

/**
 * The ordering Jira reports once the chain has run: the bounded scope for a
 * top/bottom move, otherwise just the issues involved, in rank order. Best
 * effort — a failed read leaves the item without an observed order rather than
 * turning a successful rank into a failure.
 */
async function observeRankOrder(
  config: JiraApiConfig,
  item: JiraIssueMutationItemDisplay,
): Promise<string[] | null> {
  const ranked = item.rankIssueKeys ?? [];
  try {
    if (item.rankScope) return await readScopeOrder(config, item.rankScope);
    const keys = [
      ...ranked,
      ...(item.rankTargetIssueKey ? [item.rankTargetIssueKey] : []),
    ];
    if (keys.length === 0) return null;
    return await searchRankOrder(
      config,
      `key in (${keys.map((key) => `"${key}"`).join(", ")}) ORDER BY Rank ASC`,
    );
  } catch {
    return null;
  }
}

/** Read one bounded scope in Jira's own rank order. */
async function readScopeOrder(
  config: JiraApiConfig,
  scope: JiraIssueRankScopeDisplay,
): Promise<string[]> {
  if (scope.kind === "parent")
    return searchRankOrder(
      config,
      `parent = "${scope.parentIssueKey}" ORDER BY Rank ASC`,
    );
  // The board backlog endpoint answers with the board's own ordering, but it
  // only carries issues at the standard level; epics are their own ranked list.
  if (scope.epics) {
    const response = await jiraGet<{ values?: Array<{ key?: string }> }>(
      config,
      `/rest/agile/1.0/board/${scope.boardId}/epic`,
      { maxResults: RANK_SCOPE_LIMIT },
    );
    return (response.values ?? [])
      .map((epic) => epic.key)
      .filter((key): key is string => Boolean(key));
  }
  const response = await jiraGet<{ issues?: Array<{ key?: string }> }>(
    config,
    `/rest/agile/1.0/board/${scope.boardId}/backlog`,
    { maxResults: RANK_SCOPE_LIMIT, fields: "key" },
  );
  return (response.issues ?? [])
    .map((issue) => issue.key)
    .filter((key): key is string => Boolean(key));
}

async function searchRankOrder(
  config: JiraApiConfig,
  jql: string,
): Promise<string[]> {
  const response = await jiraPost<{ issues?: Array<{ key?: string }> }>(
    config,
    "/rest/api/3/search/jql",
    { jql, maxResults: RANK_SCOPE_LIMIT, fields: ["key"] },
    undefined,
    { retry: true },
  );
  return (response.issues ?? [])
    .map((issue) => issue.key)
    .filter((key): key is string => Boolean(key));
}

async function fetchRankIssue(
  config: JiraApiConfig,
  key: string,
): Promise<RankIssueMeta> {
  let issue: {
    key?: string;
    fields?: Record<string, any>;
  };
  try {
    issue = await jiraGet(
      config,
      `/rest/api/3/issue/${encodeURIComponent(key)}`,
      { fields: "summary,project,issuetype,parent" },
    );
  } catch (err) {
    const message = errorText(err);
    if (/HTTP 40(4|3)\b/.test(message))
      throw new Error(
        `Jira issue ${key} could not be read for ranking: ${message}`,
      );
    throw err;
  }
  const fields = issue.fields ?? {};
  return {
    key: issue.key ?? key,
    projectKey: fields.project?.key ?? null,
    issueType: fields.issuetype?.name ?? null,
    hierarchyLevel:
      typeof fields.issuetype?.hierarchyLevel === "number"
        ? fields.issuetype.hierarchyLevel
        : null,
    parentKey: fields.parent?.key ?? null,
    summary: typeof fields.summary === "string" ? fields.summary : null,
  };
}

/** Rank lives on one project's board; ranking across projects has no meaning. */
function assertOneProject(metas: RankIssueMeta[]): void {
  const seen = new Map<string, string>();
  for (const meta of metas)
    if (meta.projectKey && !seen.has(meta.projectKey))
      seen.set(meta.projectKey, meta.key);
  if (seen.size > 1)
    throw new Error(
      `Jira ranks issues within one project's backlog, but ${[...seen]
        .map(([project, key]) => `${key} (${project})`)
        .join(" and ")} are in different projects.`,
    );
}

/** Epics, stories and sub-tasks are separately ranked lists in Jira. */
function assertOneHierarchyLevel(metas: RankIssueMeta[]): void {
  const seen = new Map<number, RankIssueMeta>();
  for (const meta of metas)
    if (meta.hierarchyLevel !== null && !seen.has(meta.hierarchyLevel))
      seen.set(meta.hierarchyLevel, meta);
  if (seen.size > 1)
    throw new Error(
      `Jira ranks each hierarchy level separately, but ${[...seen.values()]
        .map(
          (meta) =>
            `${meta.key} (${meta.issueType ?? hierarchyLabel(meta.hierarchyLevel)})`,
        )
        .join(" and ")} sit at different levels.`,
    );
}

/** How a bounded scope reads in an error or warning sentence. */
function rankScopeLabel(scope: JiraIssueRankScopeDisplay): string {
  return scope.kind === "board"
    ? `board ${scope.boardId} ${scope.epics ? "epic list" : "backlog"}`
    : `${scope.parentIssueKey}'s children`;
}

function hierarchyLabel(level: number | null): string {
  if (level === null) return "unknown level";
  if (level < 0) return "sub-task level";
  if (level === 0) return "standard level";
  return "epic level";
}

async function assertBoardCoversProject(
  config: JiraApiConfig,
  boardId: number,
  projectKey: string,
): Promise<void> {
  let response: { values?: Array<{ key?: string }> };
  try {
    response = await jiraGet(
      config,
      `/rest/agile/1.0/board/${boardId}/project`,
      { maxResults: 50 },
    );
  } catch (err) {
    const message = errorText(err);
    if (/HTTP 40(0|3|4)\b/.test(message))
      throw new Error(
        `Jira board ${boardId} could not be read: ${message} Use a board id you can see in Jira.`,
      );
    throw err;
  }
  const keys = (response.values ?? [])
    .map((project) => project.key)
    .filter((key): key is string => Boolean(key));
  if (keys.length > 0 && !keys.includes(projectKey))
    throw new Error(
      `Jira board ${boardId} does not cover project ${projectKey} (it covers ${keys.join(", ")}), so its backlog cannot rank these issues.`,
    );
}

async function assertChildrenOf(
  config: JiraApiConfig,
  parentKey: string,
  metas: RankIssueMeta[],
): Promise<void> {
  const parent = await fetchRankIssue(config, parentKey);
  const strays = metas.filter((meta) => meta.parentKey !== parent.key);
  if (strays.length > 0)
    throw new Error(
      `${strays
        .map((meta) => `${meta.key} (parent ${meta.parentKey ?? "none"})`)
        .join(
          ", ",
        )} ${strays.length === 1 ? "is not a child" : "are not children"} of ${parent.key}, so they cannot be ordered within it.`,
    );
}

function normalizeRankPosition(
  clientId: string,
  value: string | undefined,
): JiraIssueRankPosition {
  if (
    value === "before" ||
    value === "after" ||
    value === "top" ||
    value === "bottom"
  )
    return value;
  throw new Error(
    `rank item ${clientId} requires rankPosition: before, after, top, or bottom.`,
  );
}

function normalizeRankIssues(
  clientId: string,
  value: string[] | undefined,
): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(
      `rank item ${clientId} requires rankIssues: the issue keys to move, in the order they should end up.`,
    );
  if (value.length > RANK_MAX_ISSUES)
    throw new Error(
      `rank item ${clientId} lists ${value.length} issues; Jira ranks at most ${RANK_MAX_ISSUES} at a time.`,
    );
  const keys = value.map((entry) => normalizeKey(entry));
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key))
      throw new Error(
        `rank item ${clientId} lists ${key} twice, so the requested order is ambiguous.`,
      );
    seen.add(key);
  }
  return keys;
}

function normalizeBoardId(
  clientId: string,
  value: number | undefined,
): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(
      `rank item ${clientId} rankBoardId must be a positive Jira board id.`,
    );
  return value;
}

function normalizeKey(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error("A rank issue must be a Jira issue key or id.");
  if (trimmed.length > 120)
    throw new Error("A rank issue is too long to be a Jira issue key or id.");
  return trimmed.toUpperCase();
}

function issueUrl(config: JiraApiConfig, issueKey: string): string {
  return `${jiraBaseUrl(config.jiraHost)}/browse/${encodeURIComponent(issueKey)}`;
}
