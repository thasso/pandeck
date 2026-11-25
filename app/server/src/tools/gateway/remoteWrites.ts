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
 * classification of its name (`classifiedByCatalog`).
 *
 * A Confluence upload (Task-1441 P8a) freezes its sources here first, under
 * one work budget (`remoteUploads.ts`), checking the call's signal and the
 * route before each item and once more before `tools.prepare`. The prepared
 * upload rows must be bound to what was frozen before the card persists;
 * until then any refusal discards the copies this call made.
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
import type { ConfluencePageMutationItemDisplay } from "@assistant/shared";
import {
  RemoteToolRefusal,
  remoteProductEnabled,
  remoteToolDispatchable,
  remoteToolPort,
  remoteToolsConnected,
  type RemotePrepareAnswer,
  type RemoteToolPort,
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
import {
  ATLASSIAN_SITE_RE,
  DISABLED,
  GATEWAY_CONTEXT,
  NOTHING_WRITTEN,
  NOT_OFFERED,
  withNothingWritten,
} from "./remoteWriteRules.ts";
import {
  bindsFrozenUploads,
  discardStaged,
  freezeRemoteUploads,
  type FrozenSources,
} from "./remoteUploads.ts";

const UNEXPECTED_ANSWER =
  "The gateway answered something this server can't show as a proposal; nothing was prepared.";
const UNREACHABLE = `The credential gateway is unreachable. ${NOTHING_WRITTEN}`;
const NO_TOOLS = `The credential gateway runs no tools. ${NOTHING_WRITTEN}`;
const TIMED_OUT = `The gateway did not prepare the change in time. ${NOTHING_WRITTEN}`;
const CANCELLED = `The call was cancelled. ${NOTHING_WRITTEN}`;

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
    /**
     * The proposal, or undefined when the items fail the closed check or
     * are not bound to the call's frozen upload sources.
     */
    proposal(
      site: string,
      items: unknown,
      warnings: string[],
      uploads: Uploads,
    ): Proposal | undefined;
    /** Whether the call may upload (Confluence only). */
    uploads?: true;
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
    uploads: true,
    proposal(site, items, warnings, uploads) {
      if (
        !checkConfluencePageItems(items) ||
        !bindsFrozenUploads(
          uploads.requested,
          uploads.frozen,
          items as ConfluencePageMutationItemDisplay[],
        )
      )
        return undefined;
      return {
        title: confluenceMutationTitle(items),
        summary: confluenceProposalSummary(items, warnings),
        body: { kind: "confluencePage", confluenceHost: site, items },
        text: (card) => confluenceProposalText(items, warnings, card),
      };
    },
  },
};

/** The call's request items and what was frozen for them. */
interface Uploads {
  requested: readonly unknown[];
  frozen: FrozenSources | undefined;
}

/** The remote write tool; its `sideEffects` comes from the catalog. */
export type RemoteWriteAgentTool = AgentTool & { classifiedByCatalog: true };

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
    classifiedByCatalog: true,
    async execute(params, ctx: ToolCallContext): Promise<ToolResult> {
      const signal = ctx.signal ?? new AbortController().signal;
      /** The route, and with a signal that fired, the call's own text. */
      const fence = (): RemoteToolPort => {
        if (signal.aborted) throw new Error(CANCELLED);
        const port = remoteToolPort();
        if (!port || !remoteToolsConnected()) throw new Error(UNREACHABLE);
        if (!remoteProductEnabled(product)) throw new Error(DISABLED[product]);
        if (!remoteToolDispatchable(name, "two-phase"))
          throw new Error(NOT_OFFERED);
        return port;
      };
      fence();
      const requested = Array.isArray(params.items) ? params.items : [];
      const frozen = write.uploads
        ? await freezeRemoteUploads(ctx.session.sessionId, requested, fence)
        : undefined;
      try {
        return await propose(
          frozen ? { ...params, items: frozen.items } : params,
          { requested, frozen },
          fence,
          signal,
          ctx,
        );
      } catch (err) {
        // No card persisted: the copies this call made go (v03 K4).
        if (frozen) discardStaged(ctx.session.sessionId, frozen.stageIds);
        throw err;
      }
    },
  };

  async function propose(
    args: Record<string, unknown>,
    uploads: Uploads,
    fence: () => RemoteToolPort,
    signal: AbortSignal,
    ctx: ToolCallContext,
  ): Promise<ToolResult> {
    const port = fence();
    let answer: RemotePrepareAnswer;
    try {
      answer = await port.prepare(
        name,
        args,
        signal,
        ...(uploads.frozen ? [uploads.frozen.uploads] : []),
      );
    } catch (err) {
      if (err instanceof RemoteToolRefusal && err.code === "undecodable")
        throw new Error(UNEXPECTED_ANSWER);
      if (err instanceof RemoteToolRefusal && err.code === "tools_unavailable")
        throw new Error(NO_TOOLS);
      throw new Error(UNREACHABLE);
    }
    if (!answer.ok) throw new Error(prepareFailureText(name, answer));
    const { site, items, warnings } = answer;
    const built = ATLASSIAN_SITE_RE.test(site)
      ? write.proposal(site, items, warnings, uploads)
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
  }
}
