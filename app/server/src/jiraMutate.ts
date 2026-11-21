/**
 * The prepare half of `jira_mutate_issue` (Task-1463): validates proposals
 * against Jira and stages them as approval items, sending no write.
 *
 * Boundary-clean, so the gateway's edge may import it
 * (`workerBoundary.test.ts`): server state arrives as `JiraMutationDeps`, the
 * code's own refusals are `JiraMutationError`, a failed read stays the
 * transport's `AtlassianHttpError`, and every request carries `deps.signal`
 * when there is one. Without a signal every call keeps the exact argument list
 * the local tool always sent. The local tool (`tools/jira/jiraTools.ts`) wraps
 * it with its settings, caches and approval card; the apply half is
 * `jiraMutateApply.ts`.
 */
import type {
  JiraIssueLinkChangeDisplay,
  JiraIssueMutationFieldChangeDisplay,
  JiraIssueMutationItemDisplay,
} from "@assistant/shared/jiraMutation";
import {
  jiraBaseUrl,
  jiraGet,
  normalizeIssueInput,
  type JiraConfig,
} from "./jiraClient.ts";
import {
  resolveIssueLinkType,
  type JiraFieldMap,
  type JiraIssueLinkType,
} from "./jiraFields.ts";
import { JiraMutationError } from "./jiraMutationErrors.ts";
import { assertIssuePermission } from "./jiraPermissions.ts";
import { buildJiraRankItem, type JiraRankItemInput } from "./jiraRank.ts";
import {
  normalizeStringList,
  signalOptions,
  signalTail,
  stopIfAborted,
  truncate,
  unique,
  valueToText,
  type JiraIssueResponse,
} from "./jiraRead.ts";
import { resolveJiraFieldInputs } from "./jiraSearch.ts";
import { buildJiraSprintItem, type JiraSprintItemInput } from "./jiraSprint.ts";

/** What prepare needs besides the config and its input. */
export interface JiraMutationDeps {
  /** Carried by every request; prepare stops before each item once it aborts, and never wraps the abort. */
  signal?: AbortSignal | undefined;
  fieldMap(): Promise<JiraFieldMap>;
  /** Read at most once per prepare call. */
  issueLinkTypes(): Promise<JiraIssueLinkType[]>;
  /** Display names for user-valued changes; presentation only. Without it the account ids show as themselves. */
  userNames?(accountIds: string[]): Promise<Map<string, string> | undefined>;
  /** The text a failed read becomes inside the code's own message. */
  describeError(err: unknown): string;
  /** Whether a failed read is one of these HTTP statuses. */
  matchesHttpStatus(err: unknown, statuses: readonly number[]): boolean;
}

export const JIRA_MUTATE_ISSUE_DESCRIPTION =
  "Prepare Jira proposals — create tickets/sub-tasks, edit fields and Markdown-formatted content, add Markdown comments, and add/remove native issue links. CommonMark/GFM is converted to Atlassian Document Format. This tool never writes immediately: it validates and persists a pending approval record with an approval button. Set item.operation to edit (default), create, comment, rank, or sprint; rank reorders a backlog through Jira's Agile ranking API (before/after another issue, or top/bottom of a board backlog or a parent's children) instead of writing the opaque rank field; sprint edits a sprint's name, dates or goal, which no issue field reaches. Use it only when the user explicitly asks to change, transition, assign, label, link, create, comment on, or reorder an issue, or to edit a sprint, and ask rather than prepare a proposal when the target issue or value is ambiguous. On create, prefer a project that aligns with our own work — consult the Project Registry when unsure and confirm project and issue type with the user; never set the Cost Center, which Jira automation derives from the ticket.";

export type JiraMutationParams = {
  render?: boolean;
  items?: JiraMutationItemInput[];
};

type JiraMutationItemInput = JiraRankItemInput &
  JiraSprintItemInput & {
    clientId?: string;
    /** edit (default) = mutate an existing issue; create = new issue; comment = add a comment; rank = reorder a backlog; sprint = edit a sprint. */
    operation?: "edit" | "create" | "comment" | "rank" | "sprint";
    issue?: string;
    // create:
    projectKey?: string;
    issueType?: string;
    summary?: string;
    description?: string | null;
    // comment:
    commentBody?: string;
    transitionId?: string;
    transitionName?: string;
    targetStatus?: string;
    resolutionName?: string;
    assigneeAccountId?: string | null;
    clearAssignee?: boolean;
    parentIssue?: string | null;
    epicIssue?: string | null;
    labels?: { set?: string[]; add?: string[]; remove?: string[] };
    components?: { set?: string[]; add?: string[]; remove?: string[] };
    fields?: Record<string, unknown>;
    linkChanges?: JiraLinkChangeInput[];
  };

type JiraLinkChangeInput = {
  op: "add" | "remove";
  /** Link type name or id, e.g. "Blocks". Required for op=add; ignored for op=remove (linkId identifies the link). */
  type?: string;
  /** Direction from this issue: outward uses the type's outward phrase (e.g. "blocks"), inward the inward phrase (e.g. "is blocked by"). Required for op=add. */
  direction?: "inward" | "outward";
  /** The other issue's key or id. Required for op=add. */
  issue?: string;
  /** Existing issue link id to remove. Required for op=remove (get it from jira_get_issue issueLinks[].id). */
  linkId?: string;
};

type JiraTransition = {
  id?: string;
  name?: string;
  to?: { id?: string; name?: string; statusCategory?: { name?: string } };
  fallbackResolutionName?: string;
};

type JiraTransitionsResponse = {
  transitions?: JiraTransition[];
};

type JiraEditMetaResponse = {
  fields?: Record<string, { name?: string; required?: boolean }>;
};

type JiraCreateMetaResponse = {
  projects?: Array<{
    key?: string;
    issuetypes?: Array<{
      id?: string;
      name?: string;
      fields?: Record<string, { name?: string; required?: boolean }>;
    }>;
  }>;
};

export const mutateIssueParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description:
        "Jira issue mutation proposals. No writes happen until explicit user approval in the UI.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          clientId: { type: "string" },
          operation: {
            type: "string",
            enum: ["edit", "create", "comment", "rank", "sprint"],
            description:
              "edit (default): transition/field/link an existing issue. create: create a new issue. comment: add a comment to an issue. rank: reorder issues in a backlog using Jira's Agile ranking API. sprint: change a sprint's name, start/end dates or goal (never its state).",
          },
          issue: {
            type: "string",
            description:
              "Jira issue key or id, for example NEB-441. Required for edit and comment.",
          },
          projectKey: {
            type: "string",
            description:
              "create: project key for the new issue, e.g. OPS. Consider the Project Registry to align with our own projects.",
          },
          issueType: {
            type: "string",
            description:
              "create: issue type name for the new issue, e.g. Task.",
          },
          summary: {
            type: "string",
            description:
              "create: required summary/title. edit: set a new summary.",
          },
          description: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description:
              "create/edit: Markdown description converted to Atlassian Document Format. Set null on edit to clear it. Supports CommonMark/GFM headings, emphasis, links, lists/tasks, quotes, code, rules, tables, images-as-linked-alt-text, and footnotes.",
          },
          commentBody: {
            type: "string",
            description:
              "comment: Markdown body converted to Atlassian Document Format (same CommonMark/GFM support as description).",
          },
          transitionId: {
            type: "string",
            description: "Exact Jira transition id if already known.",
          },
          transitionName: {
            type: "string",
            description:
              "Transition name to apply, for example Discontinued or Done.",
          },
          targetStatus: {
            type: "string",
            description:
              "Desired target status name; matched against available transition target statuses.",
          },
          resolutionName: {
            type: "string",
            description:
              "Resolution to set while transitioning, for example Discontinued. Useful for requests like close as Discontinued.",
          },
          assigneeAccountId: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Set assignee by Jira accountId, or null to unassign.",
          },
          clearAssignee: {
            type: "boolean",
            description: "Unassign the issue.",
          },
          parentIssue: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description:
              "Set parent issue key/id, or null to clear parent where Jira permits.",
          },
          epicIssue: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description:
              "Set epic using the Epic Link field when available, or null to clear it.",
          },
          labels: {
            type: "object",
            additionalProperties: false,
            properties: {
              set: { type: "array", items: { type: "string" } },
              add: { type: "array", items: { type: "string" } },
              remove: { type: "array", items: { type: "string" } },
            },
          },
          components: {
            type: "object",
            additionalProperties: false,
            properties: {
              set: { type: "array", items: { type: "string" } },
              add: { type: "array", items: { type: "string" } },
              remove: { type: "array", items: { type: "string" } },
            },
          },
          fields: {
            type: "object",
            description:
              "Advanced field updates keyed by Jira field id or name. Values are sent as Jira REST field values after approval.",
          },
          rankIssues: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 50,
            description:
              "rank: issue keys to move, listed in the order they should end up. They must share one project and one hierarchy level (epics rank apart from stories, stories apart from sub-tasks).",
          },
          rankPosition: {
            type: "string",
            enum: ["before", "after", "top", "bottom"],
            description:
              "rank: where the issues land. before/after need rankTargetIssue; top/bottom need rankBoardId or rankParentIssue to bound the backlog they move within.",
          },
          rankTargetIssue: {
            type: "string",
            description:
              "rank: the issue rankPosition=before/after places the first ranked issue against.",
          },
          rankBoardId: {
            type: "integer",
            description:
              "rank: Jira Agile board id. Bounds top/bottom (the board's backlog, or its epic list when ranking epics) and, with before/after, checks the board covers the issues.",
          },
          rankParentIssue: {
            type: "string",
            description:
              "rank: parent issue key whose children bound top/bottom. Every ranked issue must already be a child of it.",
          },
          sprintId: {
            type: "integer",
            description:
              "sprint: Jira sprint id, from jira_lookup kind=sprints or an issue's sprint field.",
          },
          sprintName: {
            type: "string",
            description: "sprint: new sprint name.",
          },
          sprintStartDate: {
            type: "string",
            description:
              "sprint: new start as an ISO 8601 date-time with offset, e.g. 2026-10-13T09:00:00+02:00.",
          },
          sprintEndDate: {
            type: "string",
            description:
              "sprint: new end as an ISO 8601 date-time with offset; must be after the start.",
          },
          sprintGoal: {
            type: "string",
            description: "sprint: new sprint goal; an empty string clears it.",
          },
          linkChanges: {
            type: "array",
            description:
              "Issue link relationships to add or remove for this issue. Use jira_lookup (kind=issueLinkTypes) for exact type names, and jira_get_issue issueLinks[].id for removals.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["op"],
              properties: {
                op: {
                  type: "string",
                  enum: ["add", "remove"],
                  description:
                    "add creates a link; remove deletes an existing link by linkId.",
                },
                type: {
                  type: "string",
                  description:
                    "Link type name or id, e.g. Blocks. Required for op=add.",
                },
                direction: {
                  type: "string",
                  enum: ["inward", "outward"],
                  description:
                    "Direction from this issue: outward uses the type's outward phrase (e.g. 'blocks'); inward uses the inward phrase (e.g. 'is blocked by'). Required for op=add.",
                },
                issue: {
                  type: "string",
                  description:
                    "The other issue's key or id. Required for op=add.",
                },
                linkId: {
                  type: "string",
                  description:
                    "Existing issue link id to remove (from jira_get_issue issueLinks[].id). Required for op=remove.",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

/** The browse URL of an issue on the configured site. */
export function jiraIssueUrl(config: JiraConfig, issueKey: string): string {
  return `${jiraBaseUrl(config.jiraHost)}/browse/${encodeURIComponent(issueKey)}`;
}

export async function buildJiraMutationItems(
  config: JiraConfig,
  input: JiraMutationItemInput[],
  deps: JiraMutationDeps,
): Promise<{ items: JiraIssueMutationItemDisplay[]; warnings: string[] }> {
  if (!Array.isArray(input) || input.length === 0)
    throw new JiraMutationError(
      "At least one Jira issue mutation item is required.",
    );
  if (input.length > 10)
    throw new JiraMutationError(
      "At most 10 Jira issue mutation items are supported per approval.",
    );
  const warnings: string[] = [];
  const items: JiraIssueMutationItemDisplay[] = [];
  let linkTypesPromise: Promise<JiraIssueLinkType[]> | undefined;
  const loadLinkTypes = () => (linkTypesPromise ??= deps.issueLinkTypes());
  for (let index = 0; index < input.length; index += 1) {
    stopIfAborted(deps.signal);
    const raw = input[index]!;
    const operation = raw.operation ?? "edit";
    const clientId = raw.clientId?.trim() || `item-${index + 1}`;

    if (operation === "create") {
      const projectKey = raw.projectKey?.trim();
      const issueType = raw.issueType?.trim();
      const summary = raw.summary?.trim();
      if (!projectKey)
        throw new JiraMutationError(
          `create item ${clientId} requires projectKey.`,
        );
      if (!issueType)
        throw new JiraMutationError(
          `create item ${clientId} requires issueType.`,
        );
      if (!summary)
        throw new JiraMutationError(
          `create item ${clientId} requires summary.`,
        );
      const description = normalizeOptionalMarkdown(raw.description);
      const fieldChanges: JiraIssueMutationFieldChangeDisplay[] = [];
      addKnownFieldChange(fieldChanges, raw, { fields: {} });
      await addAdvancedFieldChanges(deps, fieldChanges, raw.fields, {});
      await assertCreateFieldsAvailable(
        config,
        projectKey,
        issueType,
        description,
        fieldChanges,
        deps.signal,
      );
      const linkChanges = await buildLinkChanges(
        config,
        "new issue",
        raw.linkChanges ?? [],
        loadLinkTypes,
      );
      await assertLinkPermissions(config, null, linkChanges, deps.signal);
      const parentIssue = raw.parentIssue
        ? normalizeIssueInput(raw.parentIssue).toUpperCase()
        : null;
      items.push({
        clientId,
        issueKey: "",
        operation: "create",
        createProjectKey: projectKey.toUpperCase(),
        createIssueType: issueType,
        createSummary: summary,
        ...(description ? { createDescription: description } : {}),
        ...(parentIssue ? { createParentIssue: parentIssue } : {}),
        fieldChanges,
        ...(linkChanges.length > 0 ? { linkChanges } : {}),
      });
      continue;
    }

    if (operation === "rank") {
      const built = await buildJiraRankItem(config, clientId, raw, deps);
      items.push(built.item);
      warnings.push(...built.warnings);
      continue;
    }

    if (operation === "sprint") {
      items.push(await buildJiraSprintItem(config, clientId, raw, deps));
      continue;
    }

    if (operation === "comment") {
      if (!raw.issue?.trim())
        throw new JiraMutationError(`comment item ${clientId} requires issue.`);
      const body = normalizeOptionalMarkdown(raw.commentBody);
      if (!body)
        throw new JiraMutationError(
          `comment item ${clientId} requires commentBody.`,
        );
      const key = normalizeIssueInput(raw.issue).toUpperCase();
      await assertIssuePermission(
        config,
        key,
        "ADD_COMMENTS",
        "comment on",
        deps.signal,
      );
      items.push({
        clientId,
        issueKey: key,
        operation: "comment",
        issueUrl: jiraIssueUrl(config, key),
        commentBody: body,
        fieldChanges: [],
      });
      continue;
    }

    if (!raw.issue?.trim())
      throw new JiraMutationError(`edit item ${clientId} requires issue.`);
    const issue = normalizeIssueInput(raw.issue).toUpperCase();
    const current = await jiraGet<JiraIssueResponse>(
      config,
      `/rest/api/3/issue/${encodeURIComponent(issue)}`,
      {
        fields: "summary,description,status,assignee,labels,components,parent",
        expand: "names",
      },
      ...signalOptions(deps.signal),
    );
    const key = current.key ?? issue;
    const fieldChanges: JiraIssueMutationFieldChangeDisplay[] = [];
    const transition = await resolveRequestedTransition(
      config,
      key,
      raw,
      deps.signal,
    );
    if (transition) {
      fieldChanges.push({
        fieldId: "status",
        label: "Status",
        from: current.fields?.status?.name ?? null,
        to: transition.to?.name ?? transition.name ?? null,
        operation: "transition",
      });
      const resolutionName =
        raw.resolutionName?.trim() || transition.fallbackResolutionName;
      if (resolutionName)
        fieldChanges.push({
          fieldId: "resolution",
          label: "Resolution",
          from: valueToText(current.fields?.resolution),
          to: resolutionName,
          operation: "set",
          value: { name: resolutionName },
        });
    }
    addKnownFieldChange(fieldChanges, raw, current);
    if (Object.prototype.hasOwnProperty.call(raw, "summary")) {
      const summary = raw.summary?.trim();
      if (!summary)
        throw new JiraMutationError(
          `edit item ${clientId} summary must not be empty.`,
        );
      fieldChanges.push({
        fieldId: "summary",
        label: "Summary",
        from: valueToText(current.fields?.summary),
        to: summary,
        operation: "set",
        value: summary,
      });
    }
    if (Object.prototype.hasOwnProperty.call(raw, "description")) {
      const description = normalizeOptionalMarkdown(raw.description);
      fieldChanges.push({
        fieldId: "description",
        label: "Description",
        from: valueToText(current.fields?.description),
        to: description ? truncate(description) : null,
        operation: "set",
        value: description ?? null,
      });
    }
    await addAdvancedFieldChanges(
      deps,
      fieldChanges,
      raw.fields,
      current.fields ?? {},
    );
    await assertEditableContentFields(config, key, fieldChanges, deps.signal);
    const linkChanges = await buildLinkChanges(
      config,
      key,
      raw.linkChanges ?? [],
      loadLinkTypes,
    );
    await assertLinkPermissions(config, key, linkChanges, deps.signal);
    if (!transition && fieldChanges.length === 0 && linkChanges.length === 0)
      throw new JiraMutationError(
        `No transition, field update, or link change was requested for ${key}.`,
      );
    items.push({
      clientId,
      issueKey: key,
      operation: "edit",
      issueId: current.id ?? null,
      issueUrl: jiraIssueUrl(config, key),
      issueSummary: current.fields?.summary ?? null,
      currentStatus: current.fields?.status?.name ?? null,
      targetTransitionId: transition?.id ?? null,
      targetTransitionName: transition?.name ?? null,
      targetStatus: transition?.to?.name ?? null,
      fieldChanges,
      ...(linkChanges.length > 0 ? { linkChanges } : {}),
    });
  }
  stopIfAborted(deps.signal);
  await nameUserFieldChanges(items, deps);
  return { items, warnings: unique(warnings) };
}

/** Account ids a user-valued change writes: `{ accountId }` or a list of them. */
function userAccountIds(value: unknown): string[] | null {
  const values = Array.isArray(value) ? value : [value];
  const ids = values.map((entry) =>
    entry && typeof entry === "object" && "accountId" in entry
      ? (entry as { accountId?: unknown }).accountId
      : undefined,
  );
  return ids.length > 0 && ids.every((id) => typeof id === "string" && id)
    ? (ids as string[])
    : null;
}

/** Shows user-valued changes by display name; the account ids stay in `value` for the write. */
async function nameUserFieldChanges(
  items: JiraIssueMutationItemDisplay[],
  deps: JiraMutationDeps,
): Promise<void> {
  if (!deps.userNames) return;
  const changes = items
    .flatMap((item) => item.fieldChanges)
    .map((change) => ({ change, ids: userAccountIds(change.value) }))
    .filter(
      (
        entry,
      ): entry is {
        change: JiraIssueMutationFieldChangeDisplay;
        ids: string[];
      } => entry.ids !== null,
    );
  if (changes.length === 0) return;
  // A name is presentation only: an unresolvable id still stages, shown as itself.
  const names = await deps.userNames(changes.flatMap((entry) => entry.ids));
  for (const { change, ids } of changes)
    change.to = ids.map((id) => names?.get(id) ?? id).join(", ");
}

async function buildLinkChanges(
  config: JiraConfig,
  subjectKey: string,
  input: JiraLinkChangeInput[],
  loadLinkTypes: () => Promise<JiraIssueLinkType[]>,
): Promise<JiraIssueLinkChangeDisplay[]> {
  if (!Array.isArray(input) || input.length === 0) return [];
  const changes: JiraIssueLinkChangeDisplay[] = [];
  for (const raw of input) {
    if (raw.op !== "add" && raw.op !== "remove")
      throw new JiraMutationError(
        `Link change op must be "add" or "remove" for ${subjectKey}.`,
      );
    if (raw.op === "remove") {
      const linkId = raw.linkId?.trim();
      if (!linkId)
        throw new JiraMutationError(
          `Link removal for ${subjectKey} requires linkId (from jira_get_issue issueLinks[].id).`,
        );
      changes.push({
        op: "remove",
        type: raw.type?.trim() || "link",
        direction: raw.direction === "inward" ? "inward" : "outward",
        relationship: "unlink",
        targetIssueKey: raw.issue
          ? normalizeIssueInput(raw.issue).toUpperCase()
          : "",
        targetIssueUrl: raw.issue
          ? jiraIssueUrl(config, normalizeIssueInput(raw.issue).toUpperCase())
          : null,
        linkId,
      });
      continue;
    }
    const typeName = raw.type?.trim();
    if (!typeName)
      throw new JiraMutationError(
        `Link creation for ${subjectKey} requires a link type (see jira_lookup kind=issueLinkTypes).`,
      );
    if (raw.direction !== "inward" && raw.direction !== "outward")
      throw new JiraMutationError(
        `Link creation for ${subjectKey} requires direction "inward" or "outward".`,
      );
    if (!raw.issue?.trim())
      throw new JiraMutationError(
        `Link creation for ${subjectKey} requires the other issue key or id.`,
      );
    const linkType = resolveIssueLinkType(await loadLinkTypes(), typeName);
    if (!linkType)
      throw new JiraMutationError(
        `Unknown Jira issue link type "${typeName}". Use jira_lookup (kind=issueLinkTypes) for exact names.`,
      );
    const target = normalizeIssueInput(raw.issue).toUpperCase();
    changes.push({
      op: "add",
      type: linkType.name,
      direction: raw.direction,
      relationship:
        raw.direction === "outward" ? linkType.outward : linkType.inward,
      targetIssueKey: target,
      targetIssueUrl: jiraIssueUrl(config, target),
    });
  }
  return changes;
}

async function assertCreateFieldsAvailable(
  config: JiraConfig,
  projectKey: string,
  issueType: string,
  description: string | undefined,
  changes: JiraIssueMutationFieldChangeDisplay[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const requested = [
    ...(description ? [{ fieldId: "description", label: "Description" }] : []),
    ...changes.filter(
      (change) => change.fieldId !== "parent" && change.fieldId !== "Epic Link",
    ),
  ];
  if (requested.length === 0) return;
  const meta = await jiraGet<JiraCreateMetaResponse>(
    config,
    "/rest/api/3/issue/createmeta",
    {
      projectKeys: projectKey,
      issuetypeNames: issueType,
      expand: "projects.issuetypes.fields",
    },
    ...signalOptions(signal),
  );
  const type = meta.projects
    ?.flatMap((project) => project.issuetypes ?? [])
    .find(
      (candidate) => candidate.name?.toLowerCase() === issueType.toLowerCase(),
    );
  if (!type)
    throw new JiraMutationError(
      `Jira did not return create-screen metadata for ${projectKey} ${issueType}.`,
    );
  const unavailable = requested
    .filter((change) => !type.fields?.[change.fieldId])
    .map((change) => change.label);
  if (unavailable.length > 0) {
    throw new JiraMutationError(
      `${unavailable.join(", ")} cannot be set while creating ${projectKey} ${issueType}: ${unavailable.length === 1 ? "the field is" : "the fields are"} not available on this Jira create screen.`,
    );
  }
}

async function assertEditableContentFields(
  config: JiraConfig,
  issueKey: string,
  changes: JiraIssueMutationFieldChangeDisplay[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const requested = changes.filter(
    (change) =>
      change.fieldId === "summary" || change.fieldId === "description",
  );
  if (requested.length === 0) return;
  const meta = await jiraGet<JiraEditMetaResponse>(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/editmeta`,
    ...signalTail(signal),
  );
  const unavailable = requested
    .filter((change) => !meta.fields?.[change.fieldId])
    .map((change) => change.label);
  if (unavailable.length > 0) {
    throw new JiraMutationError(
      `${unavailable.join(", ")} cannot be edited on ${issueKey}: ${unavailable.length === 1 ? "the field is" : "the fields are"} not available on this issue's Jira edit screen.`,
    );
  }
}

async function assertLinkPermissions(
  config: JiraConfig,
  subjectKey: string | null,
  changes: JiraIssueLinkChangeDisplay[],
  signal: AbortSignal | undefined,
): Promise<void> {
  if (changes.length === 0) return;
  const issues = unique([
    ...(subjectKey ? [subjectKey] : []),
    ...changes
      .filter((change) => change.op === "add")
      .map((change) => change.targetIssueKey)
      .filter(Boolean),
  ]);
  for (const issue of issues)
    await assertIssuePermission(config, issue, "LINK_ISSUES", "link", signal);
}

async function resolveRequestedTransition(
  config: JiraConfig,
  issueKey: string,
  raw: JiraMutationItemInput,
  signal: AbortSignal | undefined,
): Promise<JiraTransition | null> {
  const wantedId = raw.transitionId?.trim();
  const wantedName = raw.transitionName?.trim();
  const wantedStatus = raw.targetStatus?.trim();
  if (!wantedId && !wantedName && !wantedStatus && !raw.resolutionName?.trim())
    return null;
  const response = await jiraGet<JiraTransitionsResponse>(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    { expand: "transitions.fields" },
    ...signalOptions(signal),
  );
  const transitions = response.transitions ?? [];
  const normalizedName = (wantedName ?? "").toLowerCase();
  const normalizedStatus = (wantedStatus ?? "").toLowerCase();
  const match =
    transitions.find((transition) => wantedId && transition.id === wantedId) ??
    transitions.find(
      (transition) =>
        normalizedName && transition.name?.toLowerCase() === normalizedName,
    ) ??
    transitions.find(
      (transition) =>
        normalizedStatus &&
        transition.to?.name?.toLowerCase() === normalizedStatus,
    ) ??
    (raw.resolutionName?.trim()
      ? findClosedTransition(transitions)
      : undefined);
  if (match?.id) return match;

  const closedFallback =
    wantedName && !wantedStatus && !wantedId
      ? findClosedTransition(transitions)
      : undefined;
  if (closedFallback?.id)
    return {
      ...closedFallback,
      ...(wantedName !== undefined
        ? { fallbackResolutionName: wantedName }
        : {}),
    };

  const choices = transitions
    .map(
      (transition) =>
        `${transition.id ?? "?"}:${transition.name ?? "?"}${transition.to?.name ? ` -> ${transition.to.name}` : ""}`,
    )
    .join(", ");
  throw new JiraMutationError(
    `Requested transition is not available for ${issueKey}. Available transitions: ${choices || "none"}`,
  );
}

function findClosedTransition(
  transitions: JiraTransition[],
): JiraTransition | undefined {
  return transitions.find(
    (transition) =>
      /^(closed|done)$/i.test(transition.to?.name ?? "") ||
      /^(closed|done)$/i.test(transition.name ?? ""),
  );
}

function addKnownFieldChange(
  changes: JiraIssueMutationFieldChangeDisplay[],
  raw: JiraMutationItemInput,
  current: JiraIssueResponse,
): void {
  const fields = current.fields ?? {};
  if (
    raw.clearAssignee ||
    Object.prototype.hasOwnProperty.call(raw, "assigneeAccountId")
  ) {
    const accountId =
      raw.clearAssignee || raw.assigneeAccountId === null
        ? null
        : raw.assigneeAccountId?.trim();
    if (accountId === "" || accountId === undefined)
      throw new JiraMutationError(
        "assigneeAccountId must be a Jira accountId; use null to unassign.",
      );
    changes.push({
      fieldId: "assignee",
      label: "Assignee",
      from: valueToText(fields.assignee),
      to: accountId ?? "Unassigned",
      operation: "set",
      value: accountId ? { accountId } : null,
    });
  }
  if (Object.prototype.hasOwnProperty.call(raw, "parentIssue"))
    changes.push({
      fieldId: "parent",
      label: "Parent",
      from: valueToText(fields.parent),
      to: normalizeOptionalIssue(raw.parentIssue),
      operation: "set",
    });
  if (Object.prototype.hasOwnProperty.call(raw, "epicIssue"))
    changes.push({
      fieldId: "Epic Link",
      label: "Epic",
      from: null,
      to: normalizeOptionalIssue(raw.epicIssue),
      operation: "set",
    });
  addCollectionChange(changes, "labels", "Labels", fields.labels, raw.labels);
  addCollectionChange(
    changes,
    "components",
    "Components",
    fields.components,
    raw.components,
  );
}

async function addAdvancedFieldChanges(
  deps: Pick<JiraMutationDeps, "fieldMap">,
  changes: JiraIssueMutationFieldChangeDisplay[],
  fields: Record<string, unknown> | undefined,
  currentFields: Record<string, unknown>,
): Promise<void> {
  const rawFieldNames = Object.keys(fields ?? {});
  if (rawFieldNames.length === 0) return;
  const resolution = resolveJiraFieldInputs(
    await deps.fieldMap(),
    rawFieldNames,
  );
  if (resolution.unresolved.length > 0)
    throw new JiraMutationError(
      `Could not resolve Jira field(s): ${resolution.unresolved.join(", ")}`,
    );
  for (
    let fieldIndex = 0;
    fieldIndex < resolution.requested.length;
    fieldIndex += 1
  ) {
    const requested = resolution.requested[fieldIndex]!;
    const fieldId = resolution.apiFieldIds[fieldIndex] ?? requested;
    const rawValue = fields?.[rawFieldNames[fieldIndex]!];
    changes.push({
      fieldId,
      label: requested,
      from: valueToText(currentFields[fieldId]) ?? null,
      to: valueToText(rawValue) ?? null,
      operation: "set",
      value: rawValue,
    });
  }
}

function addCollectionChange(
  changes: JiraIssueMutationFieldChangeDisplay[],
  fieldId: string,
  label: string,
  current: unknown,
  patch: { set?: string[]; add?: string[]; remove?: string[] } | undefined,
): void {
  if (!patch) return;
  const set = normalizeStringList(patch.set);
  const add = normalizeStringList(patch.add);
  const remove = normalizeStringList(patch.remove);
  if (set.length === 0 && add.length === 0 && remove.length === 0) return;
  const parts = [
    set.length ? `set ${set.join(", ")}` : "",
    add.length ? `add ${add.join(", ")}` : "",
    remove.length ? `remove ${remove.join(", ")}` : "",
  ].filter(Boolean);
  changes.push({
    fieldId,
    label,
    from: valueToText(current),
    to: parts.join("; "),
    operation: set.length ? "set" : "update",
  });
}

function normalizeOptionalMarkdown(
  value: string | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  const normalized = value.replace(/\r\n?/g, "\n");
  return normalized.trim() ? normalized : undefined;
}

function normalizeOptionalIssue(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return normalizeIssueInput(value).toUpperCase();
}
