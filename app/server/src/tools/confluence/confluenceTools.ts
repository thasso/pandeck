/**
 * Confluence agent tools: CQL search, page reads, discovery lookups,
 * attachment downloads, and approval-gated page and attachment writes. The
 * reads run `../../confluenceRead.ts` and the writes the shared mutation core
 * (`../../confluenceMutate.ts`, `../../confluenceMutateApply.ts`,
 * `../../confluenceAttachmentChange.ts`); this module adds the settings, the
 * session attachment store and the approval card.
 *
 * The write path deliberately does NOT round-trip a page through Markdown.
 * `markdownToAdf` can only produce the nodes Markdown has, so rebuilding a
 * whole page from its Markdown rendering would delete every macro, layout and
 * embedded image on it. Append and prepend therefore splice new ADF into the
 * page's existing ADF, and `replace` — the only destructive placement — has to
 * be asked for by name and says on the approval card what it would drop.
 */
import type { ApprovalCard } from "@assistant/shared";
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import { getConfluenceToolConfig } from "../../confluenceSettings.ts";
import {
  createApproval,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import {
  confluenceMutationTitle,
  confluenceProposalSummary,
  confluenceProposalText,
} from "./confluenceProposalCard.ts";
import type { ConfluenceApiConfig } from "../../atlassian/confluenceClient.ts";
import {
  fetchAttachment,
  findAttachmentByName,
  normalizeAttachmentId,
} from "../../confluenceAttachmentChange.ts";
import {
  CONFLUENCE_MUTATE_PAGE_DESCRIPTION,
  buildConfluenceMutationItems,
  confluenceMutateParamsSchema,
  type ConfluenceMutateParams,
} from "../../confluenceMutate.ts";
import { applyConfluenceMutationItems } from "../../confluenceMutateApply.ts";
import {
  CONFLUENCE_GET_PAGE_DESCRIPTION,
  CONFLUENCE_GET_PAGE_SCHEMA,
  CONFLUENCE_LOOKUP_DESCRIPTION,
  CONFLUENCE_LOOKUP_SCHEMA,
  CONFLUENCE_SEARCH_DESCRIPTION,
  CONFLUENCE_SEARCH_SCHEMA,
  clamp,
  normalizeAttachment,
  normalizePageInput,
  runConfluenceGetPage,
  runConfluenceLookup,
  runConfluenceSearch,
  type ConfluenceAttachmentResponse,
  type ConfluenceGetPageParams,
  type ConfluenceLookupParams,
  type ConfluenceSearchParams,
} from "../../confluenceRead.ts";
import { errorText } from "../../errors.ts";
import { stageSessionAttachment } from "../../sessionAttachments.ts";
import {
  MAX_ATTACHMENT_BYTES,
  downloadAttachment,
  freezeUploadSource,
  readStagedBytes,
} from "./confluenceAttachments.ts";

// --------------------------------------------------------------------------
// Reads: the shared runs in confluenceRead.ts, printed pretty
// --------------------------------------------------------------------------

export const confluenceSearchTool = defineAgentTool<ConfluenceSearchParams>({
  name: "confluence_search",
  label: "Confluence: Search",
  description: CONFLUENCE_SEARCH_DESCRIPTION,
  searchHint:
    "confluence wiki page search cql space documentation runbook notes",
  parameters: CONFLUENCE_SEARCH_SCHEMA,
  async execute(params, ctx) {
    return jsonResult(
      await runConfluenceSearch(getConfluenceToolConfig(), params, {
        signal: ctx.signal,
      }),
    );
  },
});

export const confluenceGetPageTool = defineAgentTool<ConfluenceGetPageParams>({
  name: "confluence_get_page",
  label: "Confluence: Get Page",
  description: CONFLUENCE_GET_PAGE_DESCRIPTION,
  searchHint:
    "confluence wiki page read body markdown comments labels attachments",
  parameters: CONFLUENCE_GET_PAGE_SCHEMA,
  async execute(params, ctx) {
    return jsonResult(
      await runConfluenceGetPage(getConfluenceToolConfig(), params, {
        signal: ctx.signal,
      }),
    );
  },
});

export const confluenceLookupTool = defineAgentTool<ConfluenceLookupParams>({
  name: "confluence_lookup",
  label: "Confluence: Lookup",
  description: CONFLUENCE_LOOKUP_DESCRIPTION,
  searchHint:
    "confluence spaces space key page tree children labels attachments comments replies discovery paging cursor",
  parameters: CONFLUENCE_LOOKUP_SCHEMA,
  async execute(params, ctx) {
    return jsonResult(
      await runConfluenceLookup(getConfluenceToolConfig(), params, {
        signal: ctx.signal,
      }),
    );
  },
});

// --------------------------------------------------------------------------
// confluence_download_attachment
// --------------------------------------------------------------------------

type DownloadParams = {
  attachmentId?: string;
  page?: string;
  fileName?: string;
  maxBytes?: number;
};

const DEFAULT_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export const confluenceDownloadAttachmentTool = defineAgentTool<DownloadParams>(
  {
    name: "confluence_download_attachment",
    label: "Confluence: Download Attachment",
    description:
      "Download one Confluence page attachment into this session's attachment store. The bytes never enter your context: the result names a session attachment id and its path on this host. Inspect it with read_attachment, convert_pdf or convert_xlsx, copy it into the KB with kb_write (sourceAttachmentId), or change the file and upload it back with confluence_mutate_page operation=uploadAttachment.",
    searchHint:
      "confluence attachment download file image pdf spreadsheet fetch",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        attachmentId: {
          type: "string",
          description:
            "Attachment id from confluence_lookup kind=attachments, e.g. att123456.",
        },
        page: {
          type: "string",
          description: "Page id or URL, with fileName instead of attachmentId.",
        },
        fileName: {
          type: "string",
          description: "Exact attachment file name on page.",
        },
        maxBytes: {
          type: "number",
          description: `Largest file downloaded. Defaults to ${DEFAULT_DOWNLOAD_BYTES} bytes, at most ${MAX_ATTACHMENT_BYTES}.`,
        },
      },
    },
    async execute(params, ctx) {
      const config = getConfluenceToolConfig();
      const raw = await resolveAttachmentInput(config, params, ctx.signal);
      const maxBytes = clamp(
        params.maxBytes,
        DEFAULT_DOWNLOAD_BYTES,
        1,
        MAX_ATTACHMENT_BYTES,
      );
      const downloaded = await downloadAttachment(
        config,
        raw,
        maxBytes,
        ctx.signal,
      );
      const staged = stageSessionAttachment(ctx.session.sessionId, {
        name: raw.title || raw.id || "attachment",
        mimeType: raw.mediaType ?? downloaded.contentType ?? "",
        bytes: downloaded.bytes,
        source: "confluence",
      });
      return jsonResult({
        status: "saved_attachment",
        pageId: raw.pageId ?? null,
        attachment: normalizeAttachment(raw, config.host),
        sessionAttachment: {
          id: staged.id,
          name: staged.name,
          mimeType: staged.mimeType,
          size: staged.size,
          path: staged.path,
        },
      });
    },
  },
);

async function resolveAttachmentInput(
  config: ConfluenceApiConfig,
  params: DownloadParams,
  signal: AbortSignal | undefined,
): Promise<ConfluenceAttachmentResponse> {
  if (params.attachmentId?.trim())
    return fetchAttachment(
      config,
      normalizeAttachmentId(params.attachmentId),
      signal,
    );
  const fileName = params.fileName?.trim();
  if (!fileName)
    throw new Error("Pass an attachmentId, or a page with its fileName.");
  const pageId = normalizePageInput(params.page);
  const found = await findAttachmentByName(config, pageId, fileName, signal);
  if (!found)
    throw new Error(
      `Page ${pageId} has no attachment named "${fileName}". List them with confluence_lookup kind=attachments.`,
    );
  return found;
}

// --------------------------------------------------------------------------
// confluence_mutate_page
// --------------------------------------------------------------------------

/**
 * @purpose Structured approval proposal/result for Confluence page creates, edits, comments and deletes.
 * @renderWhen The tool always returns a bounded approval payload; agents should use it only after explicit user intent to write to Confluence.
 * @client Render as a mutation-capable approval card showing the Markdown body, the placement, and what a replace would drop.
 */
export const confluenceMutatePageTool = defineAgentTool<ConfluenceMutateParams>(
  {
    name: "confluence_mutate_page",
    label: "Confluence: Prepare Page Changes",
    description: CONFLUENCE_MUTATE_PAGE_DESCRIPTION,
    searchHint:
      "confluence create page edit page write comment delete label wiki upload attachment file",
    parameters: confluenceMutateParamsSchema,
    async execute(params, ctx) {
      const config = getConfluenceToolConfig();
      const sessionId = ctx.session.sessionId;
      const { items, warnings } = await buildConfluenceMutationItems(
        config,
        params.items ?? [],
        {
          signal: ctx.signal,
          freezeUpload: (request) => freezeUploadSource(sessionId, request),
        },
      );
      const title = confluenceMutationTitle(items);
      const summary = confluenceProposalSummary(items, warnings);
      const card = createApproval({
        sessionId: ctx.session.sessionId,
        kind: "confluencePage",
        title,
        ...(summary ? { summary } : {}),
        sourceToolCallId: ctx.toolCallId,
        body: { kind: "confluencePage", confluenceHost: config.host, items },
      });
      const text = confluenceProposalText(items, warnings, card);
      return { content: [{ type: "text", text }], terminate: true };
    },
  },
);

/** Execute an approved Confluence proposal: apply each item, recording per-item results. */
registerApprovalExecutor("confluencePage", {
  async execute(card: ApprovalCard) {
    if (card.body.kind !== "confluencePage")
      throw new Error("Mismatched approval body for confluencePage.");
    const { resultSummary, resultUrl } = await applyConfluenceMutationItems(
      getConfluenceToolConfig(),
      card.body.items,
      {
        describeError: errorText,
        stagedBytes: (attachment) =>
          readStagedBytes(card.sessionId, attachment),
      },
    );
    return { resultSummary, ...(resultUrl ? { resultUrl } : {}) };
  },
});

export const assistantConfluenceTools = [
  confluenceSearchTool,
  confluenceGetPageTool,
  confluenceLookupTool,
  confluenceDownloadAttachmentTool,
  confluenceMutatePageTool,
];
