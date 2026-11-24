import type { ApprovalCard } from "@assistant/shared";
import { defineAgentTool } from "../../mcp/tool.ts";
import { getJiraToolConfig } from "../../jiraSettings.ts";
import {
  createApproval,
  proposalSnapshot,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import {
  JIRA_ISSUE_BASE_FIELDS,
  clampMaxComments,
  fetchJiraComments,
  jiraGet,
  normalizeIssueInput,
  normalizeJiraIssue,
} from "../../jiraClient.ts";
import { resolveFieldName } from "../../jiraFields.ts";
import { getJiraIssueLinkTypes } from "../../jiraIssueLinkTypeCache.ts";
import {
  getCustomFieldProfile,
  getJiraFieldMap,
  updateCustomFieldProfile,
  type JiraCustomFieldProfile,
} from "../../jiraFieldCache.ts";
import {
  JIRA_LOOKUP_DESCRIPTION,
  lookupParamsSchema,
  runJiraLookup,
  type LookupParams,
} from "../../jiraLookup.ts";
import {
  JIRA_MUTATE_ISSUE_DESCRIPTION,
  buildJiraMutationItems,
  mutateIssueParamsSchema,
  type JiraMutationParams,
} from "../../jiraMutate.ts";
import { applyJiraMutationItems } from "../../jiraMutateApply.ts";
import {
  isEmptyValue,
  unique,
  valueToText,
  type JiraFieldSchema,
  type JiraIssueResponse,
} from "../../jiraRead.ts";
import {
  JIRA_SEARCH_ISSUES_DESCRIPTION,
  normalizeJql,
  runJiraSearchIssues,
  searchIssuesParamsSchema,
  type SearchIssuesParams,
} from "../../jiraSearch.ts";
import { errorText } from "../../errors.ts";
import { resolveUserNames } from "../../jiraUsers.ts";
import {
  JIRA_MUTATE_ISSUE_LABEL,
  jiraMutationTitle,
  jiraProposalSummary,
  jiraProposalText,
} from "./jiraProposalCard.ts";
type CustomFieldMode = "none" | "known" | "selected" | "discoverNonEmpty";

type GetIssueParams = {
  issue: string;
  includeDescription?: boolean;
  includeComments?: boolean;
  maxComments?: number;
  customFields?: CustomFieldMode;
  customFieldNames?: string[];
  includeRawCustomFieldValues?: boolean;
};

/** Unified discovery params for jira_lookup; each field applies to specific kinds. */

type NormalizedCustomField = {
  id: string;
  name: string;
  schemaType: string | null;
  customType: string | null;
  valueText: string | null;
  rawValue?: unknown;
};

const TECHNICAL_FIELD_NAME_RE =
  /^(Rank|Development|\[CHART\] Time in Status)$/i;
const TECHNICAL_CUSTOM_TYPES = new Set([
  "com.pyxis.greenhopper.jira:gh-lexo-rank",
  "com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf",
  "com.atlassian.jira.ext.charting:timeinstatus",
]);

const getIssueParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["issue"],
  properties: {
    issue: {
      type: "string",
      description: "Jira issue key or id, for example OPS-73.",
    },
    includeDescription: {
      type: "boolean",
      description:
        "Include the issue description as plain text. Defaults to true.",
    },
    includeComments: {
      type: "boolean",
      description: "Include recent issue comments. Defaults to false.",
    },
    maxComments: {
      type: "number",
      description:
        "Maximum comments to return when includeComments is true. Defaults to 10, maximum 50.",
    },
    customFields: {
      type: "string",
      enum: ["none", "known", "selected", "discoverNonEmpty"],
      description:
        "Custom-field retrieval mode. none is lean. known uses a cached project/issue-type profile. selected fetches customFieldNames. discoverNonEmpty intentionally fetches all fields once, returns non-empty useful custom fields, and updates the profile cache.",
    },
    customFieldNames: {
      type: "array",
      items: { type: "string" },
      description:
        "Custom field names or ids to fetch when customFields is selected, for example Story Points, Team, or customfield_10004.",
    },
    includeRawCustomFieldValues: {
      type: "boolean",
      description:
        "Include raw custom-field JSON values. Defaults to false to keep output small.",
    },
  },
} as const;

export const jiraGetIssueTool = defineAgentTool<GetIssueParams>({
  name: "jira_get_issue",
  label: "Jira: Get Issue",
  description:
    "Fetch one Jira issue by key or id from the Atlassian API. Read-only. When you mention the issue, render its key as a Markdown link using the returned issueUrl.",
  parameters: getIssueParamsSchema,
  async execute(params) {
    const issue = normalizeIssueInput(params.issue);
    const includeDescription = params.includeDescription !== false;
    const includeComments = params.includeComments === true;
    const maxComments = clampMaxComments(params.maxComments);
    const customFieldMode = normalizeCustomFieldMode(params.customFields);
    const includeRawCustomFieldValues =
      params.includeRawCustomFieldValues === true;
    const config = getJiraToolConfig();

    const baseFields = [
      ...JIRA_ISSUE_BASE_FIELDS,
      ...(includeDescription ? ["description"] : []),
    ];
    const customResult = await fetchIssueWithCustomFields({
      config,
      issue,
      baseFields,
      mode: customFieldMode,
      customFieldNames: params.customFieldNames ?? [],
      includeRawCustomFieldValues,
    });

    const normalized = normalizeJiraIssue(
      customResult.rawIssue,
      config.jiraHost,
      { includeDescription },
    );
    const comments =
      includeComments && normalized.key
        ? await fetchJiraComments(config, normalized.key, maxComments)
        : null;

    const payload = {
      jiraHost: config.jiraHost,
      issue: {
        ...normalized,
        customFieldMode,
        customFieldProfile: customResult.profileSummary,
        customFields: customResult.customFields,
        ...(customResult.suppressedTechnicalCustomFields.length > 0
          ? {
              suppressedTechnicalCustomFields:
                customResult.suppressedTechnicalCustomFields,
            }
          : {}),
        ...(comments ? { comments } : {}),
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

const jiraSearchIssuesTool = defineAgentTool<SearchIssuesParams>({
  name: "jira_search_issues",
  label: "Jira: Search Issues",
  description: JIRA_SEARCH_ISSUES_DESCRIPTION,
  parameters: searchIssuesParamsSchema,
  async execute(params, ctx) {
    // An empty or overlong JQL is refused before the settings are read.
    normalizeJql(params.jql);
    const config = getJiraToolConfig();
    const payload = await runJiraSearchIssues(config, params, {
      signal: ctx.signal,
      fieldMap: () => getJiraFieldMap(config),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

export const jiraLookupTool = defineAgentTool<LookupParams>({
  name: "jira_lookup",
  label: "Jira: Lookup",
  description: JIRA_LOOKUP_DESCRIPTION,
  parameters: lookupParamsSchema,
  async execute(params, ctx) {
    const config = getJiraToolConfig();
    const payload = await runJiraLookup(config, params, {
      signal: ctx.signal,
      fieldMap: () => getJiraFieldMap(config),
      issueLinkTypes: () => getJiraIssueLinkTypes(config),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

/**
 * @payload JiraIssueMutationDisplay
 * @purpose Structured approval proposal/result for Jira creates, Markdown content, fields, transitions, comments, and native links.
 * @renderWhen The tool always returns a bounded approval payload; agents should use it only after explicit user intent to prepare Jira writes.
 * @bounds Up to 10 issue updates; Jira execution is deferred until the user approves in the client UI.
 * @client Render as a mutation-capable approval card with clear pending/executed/failed state and persisted result entry ids.
 */
export const jiraMutateIssueTool = defineAgentTool<JiraMutationParams>({
  name: "jira_mutate_issue",
  label: JIRA_MUTATE_ISSUE_LABEL,
  description: JIRA_MUTATE_ISSUE_DESCRIPTION,
  parameters: mutateIssueParamsSchema,
  async execute(params, ctx) {
    const config = getJiraToolConfig();
    const { items, warnings } = await buildJiraMutationItems(
      config,
      params.items ?? [],
      {
        fieldMap: () => getJiraFieldMap(config),
        issueLinkTypes: () => getJiraIssueLinkTypes(config),
        // Today's naming read with the tool call's signal; the other prepare
        // reads carry none locally.
        userNames: (accountIds) =>
          proposalSnapshot(
            () => resolveUserNames(config, accountIds, ctx.signal),
            ctx.signal,
          ),
        describeError: errorText,
        matchesHttpStatus: jiraMessageMatchesHttpStatus,
      },
    );
    const title = jiraMutationTitle(items);
    const summary = jiraProposalSummary(items, warnings);
    const card = createApproval({
      sessionId: ctx.session.sessionId,
      kind: "jiraIssue",
      title,
      ...(summary ? { summary: summary } : {}),
      sourceToolCallId: ctx.toolCallId,
      body: { kind: "jiraIssue", jiraHost: config.jiraHost, items },
    });
    const text = jiraProposalText(items, warnings, card);
    return { content: [{ type: "text", text }], terminate: true };
  },
});

/** Execute an approved Jira issue mutation: apply each item, recording per-item results. */
registerApprovalExecutor("jiraIssue", {
  async execute(card: ApprovalCard) {
    if (card.body.kind !== "jiraIssue")
      throw new Error("Mismatched approval body for jiraIssue.");
    const config = getJiraToolConfig();
    const { resultSummary, resultUrl } = await applyJiraMutationItems(
      config,
      card.body.items,
      {
        fieldMap: () => getJiraFieldMap(config),
        describeError: errorText,
      },
    );
    return { resultSummary, ...(resultUrl != null ? { resultUrl } : {}) };
  },
});

/**
 * The local tool's read classification: by the status its error message
 * names, as the rank checks always matched it, so an error of any type that
 * says `HTTP 404` still counts. The edge decides by `AtlassianHttpError.status`.
 */
export function jiraMessageMatchesHttpStatus(
  err: unknown,
  statuses: readonly number[],
): boolean {
  return new RegExp(`HTTP (?:${statuses.join("|")})\\b`).test(errorText(err));
}

export const assistantJiraTools = [
  jiraGetIssueTool,
  jiraSearchIssuesTool,
  jiraLookupTool,
  jiraMutateIssueTool,
];

async function fetchIssueWithCustomFields({
  config,
  issue,
  baseFields,
  mode,
  customFieldNames,
  includeRawCustomFieldValues,
}: {
  config: ReturnType<typeof getJiraToolConfig>;
  issue: string;
  baseFields: string[];
  mode: CustomFieldMode;
  customFieldNames: string[];
  includeRawCustomFieldValues: boolean;
}): Promise<{
  rawIssue: JiraIssueResponse;
  customFields: NormalizedCustomField[];
  suppressedTechnicalCustomFields: NormalizedCustomField[];
  profileSummary: Record<string, unknown> | null;
}> {
  if (mode === "discoverNonEmpty") {
    const rawIssue = await jiraGet<JiraIssueResponse>(
      config,
      `/rest/api/3/issue/${encodeURIComponent(issue)}`,
      {
        fields: "*all",
        expand: "names,schema",
      },
    );
    const normalized = normalizeCustomFields(rawIssue, {
      includeEmpty: false,
      includeRaw: includeRawCustomFieldValues,
      suppressTechnical: !includeRawCustomFieldValues,
    });
    const profile = learnProfile(
      config.jiraHost,
      rawIssue,
      normalized.customFields,
    );
    return {
      rawIssue,
      customFields: normalized.customFields,
      suppressedTechnicalCustomFields:
        normalized.suppressedTechnicalCustomFields,
      profileSummary: profile ? summarizeProfile(profile, "updated") : null,
    };
  }

  if (mode === "selected") {
    const selectedIds = await resolveSelectedCustomFieldIds(
      config,
      customFieldNames,
    );
    const rawIssue = await jiraGet<JiraIssueResponse>(
      config,
      `/rest/api/3/issue/${encodeURIComponent(issue)}`,
      {
        fields: [...baseFields, ...selectedIds].join(","),
        expand: "names,schema",
      },
    );
    const normalized = normalizeCustomFields(rawIssue, {
      includeEmpty: true,
      includeRaw: includeRawCustomFieldValues,
      onlyFieldIds: new Set(selectedIds),
      suppressTechnical: false,
    });
    return {
      rawIssue,
      customFields: normalized.customFields,
      suppressedTechnicalCustomFields: [],
      profileSummary: {
        mode: "selected",
        requested: customFieldNames,
        resolvedFieldIds: selectedIds,
      },
    };
  }

  const rawIssue = await jiraGet<JiraIssueResponse>(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issue)}`,
    {
      fields: baseFields.join(","),
    },
  );

  if (mode === "known") {
    const projectKey = rawIssue.fields?.project?.key ?? null;
    const issueTypeId = rawIssue.fields?.issuetype?.id ?? null;
    const profile = getCustomFieldProfile(
      config.jiraHost,
      projectKey,
      issueTypeId,
    );
    if (!profile || profile.fields.length === 0) {
      return {
        rawIssue,
        customFields: [],
        suppressedTechnicalCustomFields: [],
        profileSummary: {
          mode: "known",
          found: false,
          projectKey,
          issueTypeId,
          guidance:
            "Use customFields=discoverNonEmpty once for a representative issue to learn this project/issue-type profile.",
        },
      };
    }

    const fieldIds = profile.fields.map((field) => field.id);
    const rawCustom = await jiraGet<JiraIssueResponse>(
      config,
      `/rest/api/3/issue/${encodeURIComponent(rawIssue.key ?? issue)}`,
      {
        fields: fieldIds.join(","),
        expand: "names,schema",
      },
    );
    const normalized = normalizeCustomFields(rawCustom, {
      includeEmpty: false,
      includeRaw: includeRawCustomFieldValues,
      onlyFieldIds: new Set(fieldIds),
      suppressTechnical: true,
    });
    return {
      rawIssue,
      customFields: normalized.customFields,
      suppressedTechnicalCustomFields:
        normalized.suppressedTechnicalCustomFields,
      profileSummary: summarizeProfile(profile, "used"),
    };
  }

  return {
    rawIssue,
    customFields: [],
    suppressedTechnicalCustomFields: [],
    profileSummary: null,
  };
}

async function resolveSelectedCustomFieldIds(
  config: ReturnType<typeof getJiraToolConfig>,
  customFieldNames: string[],
): Promise<string[]> {
  const names = customFieldNames.map((name) => name.trim()).filter(Boolean);
  if (names.length === 0)
    throw new Error(
      "customFieldNames must contain at least one custom field name or id when customFields is selected.",
    );
  const directIds = names.filter((name) => /^customfield_\d+$/.test(name));
  const nameLookups = names.filter((name) => !/^customfield_\d+$/.test(name));
  if (nameLookups.length === 0) return unique(directIds);

  const fieldMap = await getJiraFieldMap(config);
  const resolved = [...directIds];
  const missing: string[] = [];
  for (const name of nameLookups) {
    const field = resolveFieldName(fieldMap, name);
    if (!field?.id || !field.custom) missing.push(name);
    else resolved.push(field.id);
  }
  if (missing.length > 0)
    throw new Error(
      `Could not resolve custom field name(s): ${missing.join(", ")}. Try using customfield_ ids or run discovery first.`,
    );
  return unique(resolved);
}

function normalizeCustomFields(
  issue: JiraIssueResponse,
  options: {
    includeEmpty: boolean;
    includeRaw: boolean;
    suppressTechnical: boolean;
    onlyFieldIds?: Set<string>;
  },
): {
  customFields: NormalizedCustomField[];
  suppressedTechnicalCustomFields: NormalizedCustomField[];
} {
  const out: NormalizedCustomField[] = [];
  const suppressed: NormalizedCustomField[] = [];
  const fields = issue.fields ?? {};
  for (const [id, value] of Object.entries(fields)) {
    if (!id.startsWith("customfield_")) continue;
    if (options.onlyFieldIds && !options.onlyFieldIds.has(id)) continue;
    if (!options.includeEmpty && isEmptyValue(value)) continue;
    const item = normalizeCustomField(
      id,
      value,
      issue.names,
      issue.schema,
      options.includeRaw,
    );
    if (options.suppressTechnical && isTechnicalCustomField(item))
      suppressed.push(item);
    else out.push(item);
  }
  return {
    customFields: out.sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    ),
    suppressedTechnicalCustomFields: suppressed.sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    ),
  };
}

function normalizeCustomField(
  id: string,
  value: unknown,
  names: Record<string, string> | undefined,
  schema: Record<string, JiraFieldSchema> | undefined,
  includeRaw: boolean,
): NormalizedCustomField {
  const fieldSchema = schema?.[id];
  return {
    id,
    name: names?.[id] ?? id,
    schemaType: fieldSchema?.type ?? null,
    customType: fieldSchema?.custom ?? null,
    valueText: valueToText(value),
    ...(includeRaw ? { rawValue: value } : {}),
  };
}

function learnProfile(
  jiraHost: string,
  issue: JiraIssueResponse,
  customFields: NormalizedCustomField[],
): JiraCustomFieldProfile | null {
  const projectKey = issue.fields?.project?.key;
  const issueTypeId = issue.fields?.issuetype?.id;
  if (!projectKey || !issueTypeId) return null;
  return updateCustomFieldProfile(jiraHost, {
    projectKey,
    issueTypeId,
    issueTypeName: issue.fields?.issuetype?.name ?? null,
    learnedFromIssue: issue.key ?? null,
    fields: customFields
      .filter((field) => !isTechnicalCustomField(field))
      .map((field) => ({
        id: field.id,
        name: field.name,
        schemaType: field.schemaType,
        customType: field.customType,
      })),
  });
}

function summarizeProfile(
  profile: JiraCustomFieldProfile,
  action: "used" | "updated",
) {
  return {
    mode: "known",
    action,
    found: true,
    projectKey: profile.projectKey,
    issueTypeId: profile.issueTypeId,
    issueTypeName: profile.issueTypeName,
    learnedAt: profile.learnedAt,
    learnedFromIssue: profile.learnedFromIssue,
    fieldCount: profile.fields.length,
  };
}

function isTechnicalCustomField(field: NormalizedCustomField): boolean {
  return (
    TECHNICAL_FIELD_NAME_RE.test(field.name) ||
    Boolean(field.customType && TECHNICAL_CUSTOM_TYPES.has(field.customType))
  );
}

function normalizeCustomFieldMode(value: unknown): CustomFieldMode {
  if (value === undefined || value === null) return "none";
  if (
    value === "none" ||
    value === "known" ||
    value === "selected" ||
    value === "discoverNonEmpty"
  )
    return value;
  throw new Error(
    "customFields must be one of: none, known, selected, discoverNonEmpty.",
  );
}
