/**
 * The gateway's writes in client mode (Task-1463 P6b): one `AgentTool` per
 * accepted `WRITE_TOOLS` entry (`remoteTools.ts`), the LOCAL tool by name, label,
 * description, schema and search hint. A call proposes with the gateway's
 * `tools.prepare`, which writes nothing, checks the answer with P6a's closed
 * proposal validators and the Atlassian site pattern, and raises the local
 * approval card with the server-only context {@link GATEWAY_CONTEXT}. Only
 * that kind's executor applies it, through the gateway; it never reaches
 * local credentials.
 *
 * Before the call `execute` rechecks the connection, the product's toggle and
 * that the latest listing still offers the name as a two-phase write. Every
 * refusal here says nothing was written, which holds because prepare never
 * writes: the claim is the client's own, never the edge's wording, which may
 * have been cut (P6a L-a). The tool's `sideEffects` is the catalog's
 * classification of its name (`remoteWrite`).
 *
 * Imports no catalog, tool group or local tool module
 * (`architecture.test.ts`).
 */
import {
  CONFLUENCE_MUTATE_PAGE_DESCRIPTION,
  confluenceMutateParamsSchema,
} from "../../confluenceMutate.ts";
import { checkConfluencePageItems } from "../../confluenceMutationCheck.ts";
import {
  JIRA_MUTATE_ISSUE_DESCRIPTION,
  mutateIssueParamsSchema,
} from "../../jiraMutate.ts";
import { checkJiraIssueItems } from "../../jiraMutationCheck.ts";
import type { AgentTool, ToolCallContext, ToolResult } from "../../mcp/tool.ts";
import { createApproval } from "../../pendingApprovals.ts";
import {
  RemoteToolRefusal,
  remoteProductEnabled,
  remoteToolDispatchable,
  remoteToolPort,
  remoteToolsConnected,
  type RemotePrepareAnswer,
  type RemoteProduct,
  type RemoteWriteDescriptor,
  type RemoteWriteName,
} from "../../remoteTools.ts";
import {
  CONFLUENCE_MUTATE_PAGE_LABEL,
  CONFLUENCE_MUTATE_PAGE_SEARCH_HINT,
  confluenceMutationTitle,
  confluenceProposalSummary,
  confluenceProposalText,
} from "../confluence/confluenceProposalCard.ts";
import {
  JIRA_MUTATE_ISSUE_LABEL,
  jiraMutationTitle,
  jiraProposalSummary,
  jiraProposalText,
} from "../jira/jiraProposalCard.ts";

/**
 * The approval context of a card the gateway prepared: its executor applies
 * it with `tools.apply` and never locally (`pendingApprovals.ts` routes).
 */
export const GATEWAY_CONTEXT = { via: "gateway" } as const;

/**
 * The edge's SSRF site pattern, a copy: `gatewayTools/atlassian.ts` `SITE_RE`
 * is edge code this server may not import (`workerBoundary.test.ts`), and
 * `remoteWrites.test.ts` fails when the two texts differ (D3).
 */
const ATLASSIAN_SITE_RE = /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/;

const NOTHING_WRITTEN = "Nothing was written.";
/** The link's decoder cuts an edge message here; a cut one gets "…". */
const EDGE_MESSAGE_MAX = 500;

const UNEXPECTED_ANSWER =
  "The gateway answered something this server can't show as a proposal; nothing was prepared.";
const UNREACHABLE = `The credential gateway is unreachable. ${NOTHING_WRITTEN}`;
const NO_TOOLS = `The credential gateway runs no tools. ${NOTHING_WRITTEN}`;
const NOT_OFFERED = `The gateway no longer offers this change. ${NOTHING_WRITTEN}`;
const TIMED_OUT = `The gateway did not prepare the change in time. ${NOTHING_WRITTEN}`;
const CANCELLED = `The call was cancelled. ${NOTHING_WRITTEN}`;
/** A product's toggle is off. */
const DISABLED: Record<RemoteProduct, string> = {
  jira: `Jira tools are disabled. Enable them in Settings → Jira. ${NOTHING_WRITTEN}`,
  slack: `Slack tools are disabled. Enable them in Settings → Slack. ${NOTHING_WRITTEN}`,
  confluence: `Confluence tools are disabled. Enable them in Settings → Confluence. ${NOTHING_WRITTEN}`,
};

/**
 * An edge message with the client's own claim: "…" where the link cut it,
 * then "Nothing was written." unless it already ends so.
 */
function withNothingWritten(message: string): string {
  const shown =
    message.length >= EDGE_MESSAGE_MAX ? `${message}…` : message.trimEnd();
  return /nothing was written\.$/i.test(shown)
    ? shown
    : `${shown} ${NOTHING_WRITTEN}`;
}

/** A prepare the edge refused, in text that says nothing was written. */
function prepareFailureText(
  name: string,
  failure: Extract<RemotePrepareAnswer, { ok: false }>,
): string {
  switch (failure.code) {
    case "tool_error":
    case "invalid_params":
      return withNothingWritten(
        failure.message || `${name} failed on the gateway.`,
      );
    case "unknown_tool":
      return NOT_OFFERED;
    case "result_too_large":
      return withNothingWritten("The gateway's proposal is too large.");
    case "timeout":
      return TIMED_OUT;
    case "cancelled":
      return CANCELLED;
    case "failed":
      return withNothingWritten(`${name} failed on the gateway.`);
  }
}

type Card = ReturnType<typeof createApproval>;

/** A checked proposal's card fields and tool text, from the local leaves. */
interface Proposal {
  title: string;
  summary: string;
  body: Parameters<typeof createApproval>[0]["body"];
  text(card: Card): string;
}

/** What each write builds its card from: the local tool's definition and text. */
const WRITES: Record<
  RemoteWriteName,
  {
    label: string;
    description: string;
    searchHint?: string;
    parameters: Record<string, unknown>;
    /** The proposal, or undefined when the items fail the closed check. */
    proposal(
      site: string,
      items: unknown,
      warnings: string[],
    ): Proposal | undefined;
  }
> = {
  jira_mutate_issue: {
    label: JIRA_MUTATE_ISSUE_LABEL,
    description: JIRA_MUTATE_ISSUE_DESCRIPTION,
    parameters: mutateIssueParamsSchema,
    proposal(site, items, warnings) {
      if (!checkJiraIssueItems(items)) return undefined;
      return {
        title: jiraMutationTitle(items),
        summary: jiraProposalSummary(items, warnings),
        body: { kind: "jiraIssue", jiraHost: site, items },
        text: (card) => jiraProposalText(items, warnings, card),
      };
    },
  },
  confluence_mutate_page: {
    label: CONFLUENCE_MUTATE_PAGE_LABEL,
    description: CONFLUENCE_MUTATE_PAGE_DESCRIPTION,
    searchHint: CONFLUENCE_MUTATE_PAGE_SEARCH_HINT,
    parameters: confluenceMutateParamsSchema,
    proposal(site, items, warnings) {
      if (!checkConfluencePageItems(items)) return undefined;
      return {
        title: confluenceMutationTitle(items),
        summary: confluenceProposalSummary(items, warnings),
        body: { kind: "confluencePage", confluenceHost: site, items },
        text: (card) => confluenceProposalText(items, warnings, card),
      };
    },
  },
};

/** The remote write tool; its `sideEffects` comes from the catalog. */
export type RemoteWriteAgentTool = AgentTool & { remoteWrite: true };

/** The agent tool for an accepted gateway write. */
export function remoteWriteTool(
  descriptor: RemoteWriteDescriptor,
): RemoteWriteAgentTool {
  // The name and kind from the accepted listing, never from an answer.
  const { name, product, kind } = descriptor;
  const write = WRITES[name];
  return {
    name,
    label: write.label,
    description: write.description,
    parameters: write.parameters,
    ...(write.searchHint ? { searchHint: write.searchHint } : {}),
    remoteWrite: true,
    async execute(params, ctx: ToolCallContext): Promise<ToolResult> {
      const port = remoteToolPort();
      if (!port || !remoteToolsConnected()) throw new Error(UNREACHABLE);
      if (!remoteProductEnabled(product)) throw new Error(DISABLED[product]);
      if (!remoteToolDispatchable(name, "two-phase"))
        throw new Error(NOT_OFFERED);
      let answer: RemotePrepareAnswer;
      try {
        answer = await port.prepare(
          name,
          params,
          ctx.signal ?? new AbortController().signal,
        );
      } catch (err) {
        if (err instanceof RemoteToolRefusal && err.code === "undecodable")
          throw new Error(UNEXPECTED_ANSWER);
        if (
          err instanceof RemoteToolRefusal &&
          err.code === "tools_unavailable"
        )
          throw new Error(NO_TOOLS);
        throw new Error(UNREACHABLE);
      }
      if (!answer.ok) throw new Error(prepareFailureText(name, answer));
      const { site, items, warnings } = answer;
      const built = ATLASSIAN_SITE_RE.test(site)
        ? write.proposal(site, items, warnings)
        : undefined;
      if (!built) throw new Error(UNEXPECTED_ANSWER);
      const card = createApproval({
        sessionId: ctx.session.sessionId,
        kind,
        title: built.title,
        ...(built.summary ? { summary: built.summary } : {}),
        sourceToolCallId: ctx.toolCallId,
        body: built.body,
        context: { ...GATEWAY_CONTEXT },
      });
      return {
        content: [{ type: "text", text: built.text(card) }],
        terminate: true,
      };
    },
  };
}
