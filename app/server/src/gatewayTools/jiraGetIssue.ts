/**
 * `jira_get_issue` on the edge (Task-1397): one issue by key or id, read with
 * the calling user's Atlassian credential. Pandeck's own tool's output shape
 * without its custom-field modes (D4). Read-only, no approval.
 */
import {
  JIRA_ISSUE_BASE_FIELDS,
  fetchJiraComments,
  jiraGet,
  normalizeJiraIssue,
} from "../jiraClient.ts";
import { jiraConfigOf, jiraFailure } from "./atlassian.ts";
import type { ToolDescriptor } from "./descriptor.ts";

const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_COMMENT_CHARS = 4_000;

/** A string cut to `max` characters, and whether it was. */
function capped(
  value: string | null | undefined,
  max: number,
): { value: string | null | undefined; cut: boolean } {
  return typeof value === "string" && value.length > max
    ? { value: value.slice(0, max), cut: true }
    : { value, cut: false };
}

export const jiraGetIssue: ToolDescriptor = {
  name: "jira_get_issue",
  description:
    "Fetch one Jira issue by key or id with your Atlassian account. Read-only. When you mention the issue, render its key as a Markdown link using the returned issueUrl.",
  inputSchema: {
    type: "object",
    properties: {
      issue: {
        type: "string",
        description: "Issue key such as OPS-73, or a numeric issue id.",
        pattern: "^(?:[A-Za-z][A-Za-z0-9_]*-\\d+|\\d+)$",
        maxLength: 120,
      },
      includeDescription: {
        type: "boolean",
        description: "Include the description as text and Markdown.",
        default: true,
      },
      includeComments: {
        type: "boolean",
        description: "Include the newest comments.",
        default: false,
      },
      maxComments: {
        type: "integer",
        description: "How many comments, newest first.",
        minimum: 1,
        maximum: 50,
        default: 10,
      },
    },
    required: ["issue"],
    additionalProperties: false,
  },
  effect: "read",
  actionKey: "jira:read",
  integration: "atlassian",
  async execute(params, ctx) {
    const issue = String(params.issue);
    const includeDescription = params.includeDescription !== false;
    const includeComments = params.includeComments === true;
    const maxComments =
      typeof params.maxComments === "number" ? params.maxComments : 10;
    // Nothing goes upstream before the credential is here.
    const config = jiraConfigOf(await ctx.credential());
    try {
      const raw = await jiraGet<Parameters<typeof normalizeJiraIssue>[0]>(
        config,
        `/rest/api/3/issue/${encodeURIComponent(issue)}`,
        {
          fields: [
            ...JIRA_ISSUE_BASE_FIELDS,
            ...(includeDescription ? ["description"] : []),
          ].join(","),
        },
        { signal: ctx.signal },
      );
      const normalized = normalizeJiraIssue(raw, config.jiraHost, {
        includeDescription,
      });
      const description = capped(normalized.description, MAX_DESCRIPTION_CHARS);
      const markdown = capped(
        normalized.descriptionMarkdown,
        MAX_DESCRIPTION_CHARS,
      );
      const comments =
        includeComments && normalized.key
          ? await fetchJiraComments(config, normalized.key, maxComments, {
              signal: ctx.signal,
            })
          : undefined;
      return {
        jiraHost: config.jiraHost,
        issue: {
          ...normalized,
          ...(includeDescription
            ? {
                description: description.value,
                descriptionMarkdown: markdown.value,
              }
            : {}),
          ...(description.cut || markdown.cut ? { truncated: true } : {}),
          ...(comments
            ? {
                comments: {
                  ...comments,
                  comments: comments.comments.map((comment) => {
                    const body = capped(comment.body, MAX_COMMENT_CHARS);
                    return {
                      ...comment,
                      body: body.value,
                      ...(body.cut ? { truncated: true } : {}),
                    };
                  }),
                },
              }
            : {}),
        },
      };
    } catch (err) {
      jiraFailure(err);
    }
  },
};
