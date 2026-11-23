/**
 * The `jira_mutate_issue` result contract (Task-1463 P6a, P6-F1): the only
 * definition of what apply may change on an item, and how the edge reports
 * it and Pandeck merges it.
 *
 * Every field is in one class. Input fields travel in the proposal and never
 * in a record. Pure result fields ({@link JIRA_RESULT_FIELDS}) are never in a
 * proposal; a record carries them present or absent, and the merge sets a
 * present one and deletes an absent one, as the local executor does. The
 * dual-use `issueKey` stays in the proposal as is (a create's is `""`); its
 * created key travels as the record's `createdIssueKey`, and only that sets
 * it, so no generic delete can reach it.
 *
 * Boundary-clean: only the shared types, the rule kit and the codec
 * (`workerBoundary.test.ts`).
 */
import type {
  JiraIssueLinkChangeDisplay,
  JiraIssueMutationItemDisplay,
  JiraIssueRankStepDisplay,
  JiraSprintUpdateDisplay,
} from "@assistant/shared/jiraMutation";
import {
  ARRAY_MAX,
  arrayOf,
  closed,
  nullable,
  opt,
  req,
  type Check,
} from "./mutationCheckRules.ts";
import {
  ERROR_FALLBACK,
  ITEM_ERROR_MAX,
  ITEM_WARNING_MAX,
  WARNING_FALLBACK,
  blankNestedErrors,
  boundedText,
  cutNestedErrors,
  effects,
  encodeNested,
  formatted,
  isNestedResults,
  mergeNested,
  siteUrl,
  type Effects,
  type NestedResults,
  type ResultVetting,
} from "./mutationResultCodec.ts";

/** Every pure result field, by the type that holds it. */
export const JIRA_RESULT_FIELDS = {
  item: [
    "resultIssueKey",
    "resultIssueUrl",
    "warning",
    "error",
    "rankResultOrder",
  ],
  linkChanges: ["resultOk", "error"],
  rankSteps: ["resultOk", "error"],
  sprint: ["result"],
} as const satisfies {
  item: readonly (keyof JiraIssueMutationItemDisplay)[];
  linkChanges: readonly (keyof JiraIssueLinkChangeDisplay)[];
  rankSteps: readonly (keyof JiraIssueRankStepDisplay)[];
  sprint: readonly (keyof JiraSprintUpdateDisplay)[];
};

type SprintResult = NonNullable<JiraSprintUpdateDisplay["result"]>;

/** What apply did to one sent item. */
export interface JiraResultRecord {
  effects: Effects;
  resultIssueKey?: string | null;
  /** A create's new key, equal to `resultIssueKey`; only for a create. */
  createdIssueKey?: string;
  resultIssueUrl?: string | null;
  warning?: string;
  error?: string;
  rankResultOrder?: string[];
  /** Present exactly when the sent item has `linkChanges`, aligned with them. */
  linkChanges?: NestedResults;
  /** Present exactly when the sent item has `rankSteps`, aligned with them. */
  rankSteps?: NestedResults;
  sprintResult?: SprintResult;
}

/** The item as a proposal: a copy without pure result fields. `issueKey` stays. */
export function jiraProposalOf(
  item: JiraIssueMutationItemDisplay,
): JiraIssueMutationItemDisplay {
  const proposal = structuredClone(item);
  for (const key of JIRA_RESULT_FIELDS.item) delete proposal[key];
  for (const change of proposal.linkChanges ?? [])
    for (const key of JIRA_RESULT_FIELDS.linkChanges) delete change[key];
  for (const step of proposal.rankSteps ?? [])
    for (const key of JIRA_RESULT_FIELDS.rankSteps) delete step[key];
  if (proposal.sprint)
    for (const key of JIRA_RESULT_FIELDS.sprint) delete proposal.sprint[key];
  return proposal;
}

/** Whether `sent` is a create that has no key yet. */
function isKeylessCreate(sent: JiraIssueMutationItemDisplay): boolean {
  return sent.operation === "create" && sent.issueKey === "";
}

/**
 * The identifier a link must be backed by: a create's vetted result key, a
 * sprint item's sprint id, else the sent issue key. A present but unsafe
 * result key never falls back to another identifier.
 */
function urlBacking(
  sent: JiraIssueMutationItemDisplay,
  record: JiraResultRecord,
  vet: ResultVetting,
): string | undefined {
  if (sent.operation === "create")
    return typeof record.resultIssueKey === "string"
      ? record.resultIssueKey
      : undefined;
  if (sent.operation === "sprint") {
    const id = sent.sprint?.sprintId;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0
      ? String(id)
      : undefined;
  }
  return vet.identifier(sent.issueKey, "jiraKey");
}

/**
 * Whether a link on `record` has the identifier `urlBacking` backs it by:
 * the receiver's side of that rule. Only the credential's own vetting,
 * which the receiver cannot repeat, is left to the edge.
 */
function linkBacked(
  sent: JiraIssueMutationItemDisplay,
  record: JiraResultRecord,
): boolean {
  if (sent.operation === "create")
    return typeof record.resultIssueKey === "string";
  if (sent.operation === "sprint") {
    const id = sent.sprint?.sprintId;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  }
  return jiraKey(sent.issueKey, 0);
}

/** The sprint as Jira returned it, whole, or nothing when any part fails. */
function vettedSprintResult(
  raw: SprintResult,
  vet: ResultVetting,
): SprintResult | undefined {
  const name = vet.identifier(raw.name, "sprintName");
  const instant = (value: string | null): string | null | undefined =>
    value === null ? null : vet.identifier(value, "instant");
  const startDate = instant(raw.startDate);
  const endDate = instant(raw.endDate);
  if (name === undefined || startDate === undefined || endDate === undefined)
    return undefined;
  return { name, startDate, endDate };
}

/**
 * The record of one item after apply. `applied` is the item apply worked
 * on, `sent` a copy taken before; nested results align with `sent`'s
 * arrays. Each identifier and link passes `vet` on its raw value, and each
 * text is vetted and capped.
 */
export function buildJiraResultRecord(
  applied: JiraIssueMutationItemDisplay,
  sent: JiraIssueMutationItemDisplay,
  vet: ResultVetting,
  certified: Effects,
): JiraResultRecord {
  const record: JiraResultRecord = { effects: certified };
  if (applied.resultIssueKey === null) record.resultIssueKey = null;
  else if (applied.resultIssueKey !== undefined)
    record.resultIssueKey =
      vet.identifier(applied.resultIssueKey, "jiraKey") ?? null;
  if (isKeylessCreate(sent) && typeof record.resultIssueKey === "string") {
    const created = vet.identifier(applied.issueKey, "jiraKey");
    if (created === record.resultIssueKey) record.createdIssueKey = created;
  }
  if (applied.resultIssueUrl === null) record.resultIssueUrl = null;
  else if (applied.resultIssueUrl !== undefined) {
    const url = vet.url(applied.resultIssueUrl, urlBacking(sent, record, vet));
    if (url !== undefined) record.resultIssueUrl = url;
  }
  if (typeof applied.warning === "string")
    record.warning = vet.text(
      applied.warning,
      ITEM_WARNING_MAX,
      WARNING_FALLBACK,
    );
  if (typeof applied.error === "string")
    record.error = vet.text(applied.error, ITEM_ERROR_MAX, ERROR_FALLBACK);
  // An order the checker would refuse (over the array cap, or any key
  // unsafe) is left out whole.
  if (applied.rankResultOrder && applied.rankResultOrder.length <= ARRAY_MAX) {
    const order = applied.rankResultOrder.map((key) =>
      vet.identifier(key, "jiraKey"),
    );
    if (order.every((key) => key !== undefined)) record.rankResultOrder = order;
  }
  if (sent.linkChanges)
    record.linkChanges = encodeNested(
      sent.linkChanges.map((_, index) => applied.linkChanges?.[index] ?? {}),
      vet,
    );
  if (sent.rankSteps)
    record.rankSteps = encodeNested(
      sent.rankSteps.map((_, index) => applied.rankSteps?.[index] ?? {}),
      vet,
    );
  const sprintResult = applied.sprint?.result;
  if (sent.sprint && sprintResult) {
    const kept = vettedSprintResult(sprintResult, vet);
    if (kept) record.sprintResult = kept;
  }
  return record;
}

const instant = nullable(formatted("instant"));
const jiraKey = formatted("jiraKey");
const anyNested: Check<NestedResults> = (value): value is NestedResults =>
  typeof value === "object" &&
  value !== null &&
  "ok" in value &&
  typeof value.ok === "string" &&
  isNestedResults(value, value.ok.length);

/** The record's shape, its links on `site`. */
function recordShape(site: string): Check<JiraResultRecord> {
  return closed<JiraResultRecord>({
    effects: req(effects),
    resultIssueKey: opt(nullable(jiraKey)),
    createdIssueKey: opt(jiraKey),
    resultIssueUrl: opt(nullable(siteUrl(site))),
    warning: opt(boundedText(ITEM_WARNING_MAX)),
    error: opt(boundedText(ITEM_ERROR_MAX)),
    rankResultOrder: opt(arrayOf(jiraKey)),
    linkChanges: opt(anyNested),
    rankSteps: opt(anyNested),
    sprintResult: opt(
      closed<SprintResult>({
        name: req(formatted("sprintName")),
        startDate: req(instant),
        endDate: req(instant),
      }),
    ),
  });
}

/** Present exactly when the sent array is, with its length. */
function alignedWith(
  nested: NestedResults | undefined,
  sent: readonly unknown[] | undefined,
): boolean {
  if (sent === undefined) return nested === undefined;
  return nested !== undefined && isNestedResults(nested, sent.length);
}

/**
 * Whether `record` is a valid record for `sent` from an edge on `site`:
 * closed, typed, formatted and capped; nested results aligned with the sent
 * arrays; a sprint result only for a sprint item; a created key only for a
 * keyless create, equal to its result key.
 */
export function checkJiraResult(
  record: unknown,
  sent: JiraIssueMutationItemDisplay,
  site: string,
): record is JiraResultRecord {
  if (!recordShape(site)(record, 0)) return false;
  if (
    record.createdIssueKey !== undefined &&
    (!isKeylessCreate(sent) || record.createdIssueKey !== record.resultIssueKey)
  )
    return false;
  if (record.sprintResult !== undefined && sent.sprint === undefined)
    return false;
  if (typeof record.resultIssueUrl === "string" && !linkBacked(sent, record))
    return false;
  return (
    alignedWith(record.linkChanges, sent.linkChanges) &&
    alignedWith(record.rankSteps, sent.rankSteps)
  );
}

/**
 * Writes a checked record onto the card's item: each pure result field set
 * when present and deleted when absent; `issueKey` set only by a created key
 * on a keyless create, never deleted. `trimmed` says the answer's nested
 * error texts may have been emptied.
 */
export function mergeJiraResult(
  card: JiraIssueMutationItemDisplay,
  record: JiraResultRecord,
  trimmed: boolean,
): void {
  if (record.resultIssueKey === undefined) delete card.resultIssueKey;
  else card.resultIssueKey = record.resultIssueKey;
  if (record.resultIssueUrl === undefined) delete card.resultIssueUrl;
  else card.resultIssueUrl = record.resultIssueUrl;
  if (record.warning === undefined) delete card.warning;
  else card.warning = record.warning;
  if (record.error === undefined) delete card.error;
  else card.error = record.error;
  if (record.rankResultOrder === undefined) delete card.rankResultOrder;
  else card.rankResultOrder = [...record.rankResultOrder];
  if (
    isKeylessCreate(card) &&
    record.createdIssueKey !== undefined &&
    record.createdIssueKey === record.resultIssueKey
  )
    card.issueKey = record.createdIssueKey;
  if (card.linkChanges && record.linkChanges)
    mergeNested(card.linkChanges, record.linkChanges, trimmed);
  if (card.rankSteps && record.rankSteps)
    mergeNested(card.rankSteps, record.rankSteps, trimmed);
  if (card.sprint) {
    if (record.sprintResult === undefined) delete card.sprint.result;
    else card.sprint.result = { ...record.sprintResult };
  }
}

/**
 * The shrink stages, in order, each only while `fits` says the answer is
 * still over its budget: nested error texts cut to 120, then emptied, then
 * every `rankResultOrder` left out. No stage changes an `ok` character, an
 * error's presence, an item-level text or an identifier. Answers whether any
 * stage ran (`trimmed`).
 */
export function shrinkJiraResults(
  records: JiraResultRecord[],
  fits: () => boolean,
  vet: ResultVetting,
): boolean {
  const nested = () =>
    records.flatMap((record) =>
      [record.linkChanges, record.rankSteps].filter(
        (results): results is NestedResults => results !== undefined,
      ),
    );
  const stages = [
    () => {
      for (const results of nested()) cutNestedErrors(results, vet);
    },
    () => {
      for (const results of nested()) blankNestedErrors(results);
    },
    () => {
      for (const record of records) delete record.rankResultOrder;
    },
  ];
  let trimmed = false;
  for (const stage of stages) {
    if (fits()) break;
    stage();
    trimmed = true;
  }
  return trimmed;
}
