/**
 * The apply half of `jira_mutate_issue` (Task-1463): sends the approved items'
 * writes and reports per-item results and a summary.
 *
 * Boundary-clean, so the gateway's edge may import it
 * (`workerBoundary.test.ts`): server state arrives as `JiraApplyDeps`. A
 * rejected write surfaces as `JiraWriteHttpError`, the code's own text as
 * `JiraMutationError`, and a row or step error is `deps.describeError` of
 * either. Every request carries `deps.signal` when there is one; an abort
 * propagates as itself, never as a row error, and nothing is sent after it.
 * Without a signal every call keeps the exact argument list the local
 * executor always sent.
 */
import type {
  JiraIssueLinkChangeDisplay,
  JiraIssueMutationFieldChangeDisplay,
  JiraIssueMutationItemDisplay,
} from "@assistant/shared/jiraMutation";
import { markdownToAdf } from "./atlassian/adfFromMarkdown.ts";
import {
  jiraDelete,
  jiraPost,
  jiraPut,
  type JiraConfig,
} from "./jiraClient.ts";
import type { JiraFieldMap } from "./jiraFields.ts";
import { jiraIssueUrl } from "./jiraMutate.ts";
import { JiraMutationError, jiraWrite } from "./jiraMutationErrors.ts";
import { executeJiraRankItem } from "./jiraRank.ts";
import { signalTail, stopIfAborted } from "./jiraRead.ts";
import { executeJiraSprintItem, jiraSprintResultText } from "./jiraSprint.ts";
import type { ApplyHooks, WriteScope } from "./writeScope.ts";

/** What apply needs besides the config and the approved items. */
export interface JiraApplyDeps extends ApplyHooks {
  /** Carried by every request; an abort propagates unwrapped and unrecorded. */
  signal?: AbortSignal | undefined;
  fieldMap(): Promise<JiraFieldMap>;
  /** The text a failure becomes as a row or step error. */
  describeError(err: unknown): string;
  /** Checked before each item: text stops that item and every later one, which get it as their error and send nothing. */
  stopBefore?(): string | undefined;
}

/**
 * Apply each approved item in order, recording per-item results on the items
 * themselves. Throws `JiraMutationError` when no item succeeded.
 */
export async function applyJiraMutationItems(
  config: JiraConfig,
  items: JiraIssueMutationItemDisplay[],
  deps: JiraApplyDeps,
): Promise<{ succeeded: number; resultSummary: string; resultUrl?: string }> {
  let succeeded = 0;
  for (const [index, item] of items.entries()) {
    stopIfAborted(deps.signal);
    deps.startItem?.(index);
    const stop = deps.stopBefore?.();
    if (stop) {
      for (const rest of items.slice(index)) rest.error = stop;
      break;
    }
    try {
      await executeJiraMutationItem(config, item, deps);
      // executeJiraMutationItem sets resultIssueUrl for create/comment; for edit fill it in here.
      if (!item.resultIssueUrl)
        item.resultIssueUrl =
          item.issueUrl ?? jiraIssueUrl(config, item.issueKey);
      delete item.error;
      succeeded += 1;
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      item.error = deps.describeError(err);
    }
  }
  if (succeeded === 0)
    throw new JiraMutationError(
      `All ${items.length} Jira change(s) failed: ${items
        .map((item) => item.error)
        .filter(Boolean)
        .join("; ")}`,
    );
  const failed = items.length - succeeded;
  const warned = items.filter((item) => item.warning).length;
  const created = items
    .filter((item) => item.operation === "create" && item.resultIssueKey)
    .map((item) => item.resultIssueKey);
  const base = created.length
    ? `Applied ${succeeded} change(s) (created ${created.join(", ")})`
    : `Applied ${succeeded} change(s)`;
  // Ranking's whole point is the resulting sequence, so report what Jira shows now.
  const orderings = items
    .filter((item) => item.operation === "rank" && item.rankResultOrder?.length)
    .map((item) => `order now ${item.rankResultOrder!.join(" → ")}`);
  // Sprint dates are the point of a sprint edit, so report what Jira holds now.
  const sprints = items.map(jiraSprintResultText).filter(Boolean);
  const diagnostics = [
    failed ? `${failed} failed` : "",
    warned ? `${warned} warning(s)` : "",
    ...orderings,
    ...sprints,
  ].filter(Boolean);
  const resultIssueUrl = items.find(
    (item) => item.resultIssueUrl,
  )?.resultIssueUrl;
  return {
    succeeded,
    resultSummary: diagnostics.length
      ? `${base}; ${diagnostics.join("; ")}`
      : base,
    ...(resultIssueUrl != null ? { resultUrl: resultIssueUrl } : {}),
  };
}

async function executeJiraMutationItem(
  config: JiraConfig,
  item: JiraIssueMutationItemDisplay,
  deps: JiraApplyDeps,
): Promise<void> {
  if (item.operation === "create") {
    const mutation = await buildExecutionFieldPayload(deps, item.fieldChanges);
    const fields: Record<string, unknown> = {
      project: { key: item.createProjectKey },
      issuetype: { name: item.createIssueType },
      summary: item.createSummary,
      ...mutation.fields,
    };
    if (item.createDescription)
      fields.description = markdownToAdf(item.createDescription);
    const created = await jiraWrite(
      () =>
        jiraPost<{ key?: string }>(
          config,
          "/rest/api/3/issue",
          {
            fields,
            ...(Object.keys(mutation.update).length
              ? { update: mutation.update }
              : {}),
          },
          ...signalTail(deps.signal),
        ),
      deps,
    );
    if (!created.key)
      throw new JiraMutationError(
        "Jira did not return a key for the created issue.",
      );
    item.resultIssueKey = created.key;
    item.issueKey = created.key;
    item.resultIssueUrl = jiraIssueUrl(config, created.key);
    const linkErrors = await executeLinkChanges(config, item, deps);
    // Clearing matters: a re-executed card must not keep a stale warning.
    if (linkErrors.length > 0)
      item.warning = `Issue created, but ${linkErrors.join("; ")}`;
    else delete item.warning;
    return;
  }

  if (item.operation === "rank") {
    await executeJiraRankItem(config, item, deps);
    return;
  }

  if (item.operation === "sprint") {
    await executeJiraSprintItem(config, item, deps);
    return;
  }

  if (item.operation === "comment") {
    if (!item.commentBody) throw new JiraMutationError("Missing comment body.");
    const body = markdownToAdf(item.commentBody);
    await jiraWrite(
      () =>
        jiraPost(
          config,
          `/rest/api/3/issue/${encodeURIComponent(item.issueKey)}/comment`,
          { body },
          ...signalTail(deps.signal),
        ),
      deps,
    );
    item.resultIssueUrl = item.issueUrl ?? jiraIssueUrl(config, item.issueKey);
    return;
  }

  const linkErrors = await executeLinkChanges(config, item, deps);
  const { fields, update } = await buildExecutionFieldPayload(
    deps,
    item.fieldChanges,
  );
  if (item.targetTransitionId) {
    const transitionId = item.targetTransitionId;
    await jiraWrite(
      () =>
        jiraPost(
          config,
          `/rest/api/3/issue/${encodeURIComponent(item.issueKey)}/transitions`,
          {
            transition: { id: transitionId },
            ...(Object.keys(fields).length ? { fields } : {}),
            ...(Object.keys(update).length ? { update } : {}),
          },
          ...signalTail(deps.signal),
        ),
      deps,
    );
  } else if (Object.keys(fields).length || Object.keys(update).length) {
    await jiraWrite(
      () =>
        jiraPut(
          config,
          `/rest/api/3/issue/${encodeURIComponent(item.issueKey)}`,
          { fields, update },
          ...signalTail(deps.signal),
        ),
      deps,
    );
  }

  if (linkErrors.length > 0) throw new JiraMutationError(linkErrors.join("; "));
}

async function buildExecutionFieldPayload(
  deps: Pick<JiraApplyDeps, "fieldMap">,
  changes: JiraIssueMutationFieldChangeDisplay[],
): Promise<{
  fields: Record<string, unknown>;
  update: Record<string, unknown[]>;
}> {
  const fields: Record<string, unknown> = {};
  const update: Record<string, unknown[]> = {};
  for (const change of changes) {
    if (change.fieldId === "status") continue;
    if (change.fieldId === "assignee")
      // Cards staged before `value` carried the account id in `to`.
      fields.assignee =
        change.value !== undefined
          ? change.value
          : change.to === "Unassigned"
            ? null
            : { accountId: change.to };
    else if (change.fieldId === "parent")
      fields.parent = change.to ? { key: change.to } : null;
    else if (change.fieldId === "description")
      fields.description =
        typeof change.value === "string" ? markdownToAdf(change.value) : null;
    else if (change.fieldId === "resolution")
      fields.resolution =
        change.value ?? (change.to ? { name: change.to } : null);
    else if (change.fieldId === "Epic Link") {
      const fieldMap = await deps.fieldMap();
      const epic = [...fieldMap.byId.values()].find((field) =>
        /^(Epic Link|Parent Link)$/i.test(field.name),
      );
      if (!epic?.id)
        throw new JiraMutationError(
          "Could not resolve the Jira Epic Link field.",
        );
      fields[epic.id] = change.to || null;
    } else if (change.fieldId === "labels" || change.fieldId === "components") {
      // Collection add/remove/set operations are reconstructed from the display value prepared above.
      // This keeps the approval payload complete without exposing credentials to the browser.
      applyCollectionUpdate(fields, update, change);
    } else {
      fields[change.fieldId] = change.value ?? change.to;
    }
  }
  return { fields, update };
}

async function executeLinkChanges(
  config: JiraConfig,
  item: JiraIssueMutationItemDisplay,
  deps: JiraApplyDeps,
): Promise<string[]> {
  const errors: string[] = [];
  for (const change of item.linkChanges ?? []) {
    try {
      await executeLinkChange(config, item.issueKey, change, deps);
      change.resultOk = true;
      delete change.error;
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      change.resultOk = false;
      change.error = deps.describeError(err);
      errors.push(
        `${change.op} link ${change.type} ${item.issueKey}↔${change.targetIssueKey || change.linkId}: ${change.error}`,
      );
    }
  }
  return errors;
}

async function executeLinkChange(
  config: JiraConfig,
  subjectKey: string,
  change: JiraIssueLinkChangeDisplay,
  scope: WriteScope,
): Promise<void> {
  const { signal } = scope;
  if (change.op === "remove") {
    if (!change.linkId)
      throw new JiraMutationError("Missing issue link id for removal.");
    const linkId = change.linkId;
    await jiraWrite(
      () =>
        jiraDelete(
          config,
          `/rest/api/3/issueLink/${encodeURIComponent(linkId)}`,
          ...signalTail(signal),
        ),
      scope,
    );
    return;
  }
  // outward: the subject issue "outward"s the target (e.g. subject blocks target).
  const outwardIssue =
    change.direction === "outward" ? subjectKey : change.targetIssueKey;
  const inwardIssue =
    change.direction === "outward" ? change.targetIssueKey : subjectKey;
  await jiraWrite(
    () =>
      jiraPost(
        config,
        "/rest/api/3/issueLink",
        {
          type: { name: change.type },
          inwardIssue: { key: inwardIssue },
          outwardIssue: { key: outwardIssue },
        },
        ...signalTail(signal),
      ),
    scope,
  );
}

function applyCollectionUpdate(
  fields: Record<string, unknown>,
  update: Record<string, unknown[]>,
  change: JiraIssueMutationFieldChangeDisplay,
): void {
  const to = change.to ?? "";
  const fieldId = change.fieldId;
  const wrap = (value: string) =>
    fieldId === "components" ? { name: value } : value;
  const setMatch = to.match(/(?:^|; )set ([^;]+)/);
  if (setMatch) {
    fields[fieldId] = setMatch[1]!.split(/,\s*/).filter(Boolean).map(wrap);
    return;
  }
  const ops: unknown[] = [];
  const addMatch = to.match(/(?:^|; )add ([^;]+)/);
  const removeMatch = to.match(/(?:^|; )remove ([^;]+)/);
  if (addMatch)
    ops.push(
      ...addMatch[1]!
        .split(/,\s*/)
        .filter(Boolean)
        .map((value) => ({ add: wrap(value) })),
    );
  if (removeMatch)
    ops.push(
      ...removeMatch[1]!
        .split(/,\s*/)
        .filter(Boolean)
        .map((value) => ({ remove: wrap(value) })),
    );
  if (ops.length) update[fieldId] = ops;
}
