/**
 * The prepare half of `confluence_mutate_page` (Task-1463): its schema and
 * description, and the validation that turns requested items into the
 * proposal an approval shows and apply (`confluenceMutateApply.ts`) executes.
 *
 * Boundary-clean, so the gateway's edge may import it
 * (`workerBoundary.test.ts`): server state arrives as `ConfluenceMutationDeps`.
 * The code's own refusals are `ConfluenceMutationError`; a failed read stays
 * the transport's `AtlassianHttpError` or P2's `ConfluenceReadRefusal`. Every
 * read carries `deps.signal` when there is one, and an abort propagates as
 * itself: prepare checks it before each item and after each space lookup,
 * which swallows its own errors.
 */
import type {
  ConfluenceBodyPlacement,
  ConfluencePageMutationItemDisplay,
  ConfluencePageMutationOperation,
} from "@assistant/shared/confluenceMutation";
import {
  confluenceGet,
  fetchPageWithBody,
  normalizeConfluencePage,
  resolveSpaceId,
  type ConfluenceConfig,
  type ConfluencePageResponse,
} from "./atlassian/confluenceClient.ts";
import {
  stageAttachmentChange,
  type FrozenUpload,
  type AttachmentChangeRequest,
} from "./confluenceAttachmentChange.ts";
import {
  ConfluenceMutationError,
  requireCurrentForDelete,
  stopIfAborted,
} from "./confluenceMutationErrors.ts";
import {
  normalizePageInput,
  resolveSpaceSummary,
  stringList,
} from "./confluenceRead.ts";

/** One requested item, as the schema describes it; checked in prepare. */
export type ConfluenceMutateItemParams = {
  operation?: ConfluencePageMutationOperation;
  page?: string;
  spaceKey?: string;
  title?: string;
  newTitle?: string;
  parentPage?: string;
  body?: string;
  placement?: ConfluenceBodyPlacement;
  addLabels?: string[];
  removeLabels?: string[];
  versionMessage?: string;
  attachmentId?: string;
  fileName?: string;
  sourceAttachmentId?: string;
  sourcePath?: string;
};

export type ConfluenceMutateParams = { items?: ConfluenceMutateItemParams[] };

/** Items per call; the edge's result projection is bounded by it (P5b). */
export const MAX_MUTATION_ITEMS = 10;
/** How much of the current page travels to the card purely as edit context. */
const CURRENT_BODY_PREVIEW_CHARS = 4000;

export const confluenceMutateParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      description:
        "Confluence page proposals. Nothing is written until the user approves the card.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: {
            type: "string",
            enum: [
              "create",
              "edit",
              "comment",
              "delete",
              "uploadAttachment",
              "deleteAttachment",
            ],
            description:
              "Defaults to edit. uploadAttachment adds a file to the page, or a new version when the page already has one with that file name; deleteAttachment moves one to the trash.",
          },
          page: {
            type: "string",
            description:
              "Page id or URL. Required for edit, comment and delete, and for an attachment operation that names no attachmentId.",
          },
          spaceKey: { type: "string", description: "Space key for a create." },
          title: {
            type: "string",
            description: "Title of the page to create.",
          },
          newTitle: {
            type: "string",
            description: "edit: rename the page to this title.",
          },
          parentPage: {
            type: "string",
            description:
              "create: parent page id or URL. Omit to create at the space root.",
          },
          body: {
            type: "string",
            description:
              "CommonMark/GFM content, converted to Atlassian Document Format. The page body for create and edit, the comment text for comment. Images become linked alt text: a body cannot embed an attachment.",
          },
          placement: {
            type: "string",
            enum: ["replace", "append", "prepend"],
            description:
              "edit only, defaults to append. append/prepend splice the new content into the existing page and keep its macros, layouts and images. replace rewrites the whole body from Markdown and DESTROYS every macro, layout and image on the page — ask for it only when the user asked to rewrite the page, and tell them what the proposal reports under lossyNodes.",
          },
          addLabels: {
            type: "array",
            items: { type: "string" },
            description: "Labels to add after the page write.",
          },
          removeLabels: {
            type: "array",
            items: { type: "string" },
            description: "Labels to remove after the page write.",
          },
          versionMessage: {
            type: "string",
            description:
              "edit and uploadAttachment: the version comment Confluence records for this change.",
          },
          attachmentId: {
            type: "string",
            description:
              "Attachment operations: the existing attachment to replace with a new version or to delete, from confluence_lookup kind=attachments.",
          },
          fileName: {
            type: "string",
            description:
              "Attachment operations: the file name on the page. uploadAttachment defaults it to the source's name.",
          },
          sourceAttachmentId: {
            type: "string",
            description:
              "uploadAttachment: session attachment id (list_attachments, confluence_download_attachment) whose bytes to upload.",
          },
          sourcePath: {
            type: "string",
            description:
              "uploadAttachment: absolute path of a file on this host to upload, instead of sourceAttachmentId.",
          },
        },
      },
    },
  },
  required: ["items"],
} as const;

/** What prepare needs besides the config and the requested items. */
export interface ConfluenceMutationDeps {
  /** Carried by every read; an abort propagates unwrapped. */
  signal?: AbortSignal | undefined;
  /**
   * Pins an upload's bytes, called after the page read and before the name
   * lookup. Without it an upload item is refused before any request.
   */
  freezeUpload?(request: AttachmentChangeRequest): Promise<FrozenUpload>;
}

export const CONFLUENCE_MUTATE_PAGE_DESCRIPTION =
  "Prepare Confluence proposals — create a page, edit one (append, prepend or replace its body, rename it, relabel it), add a comment, delete a page, or upload, version or delete a page attachment. The file to upload is copied when the proposal is made, so later changes to it are not uploaded. CommonMark/GFM is converted to Atlassian Document Format. This tool never writes immediately: it validates against the live page and persists a pending approval with an approval button. Use it only when the user explicitly asks to write to Confluence, and ask rather than propose when the target page, space or content is ambiguous. Prefer append over replace: replace rebuilds the body from Markdown and destroys the macros, layouts and images the proposal lists under lossyNodes.";

/**
 * Validate every item against the live site before anything is staged: a
 * missing space, an unreadable page or a placement the page cannot support
 * becomes a tool error now, rather than an approval that can only fail.
 */
export async function buildConfluenceMutationItems(
  config: ConfluenceConfig,
  requested: ConfluenceMutateItemParams[],
  deps: ConfluenceMutationDeps,
): Promise<{ items: ConfluencePageMutationItemDisplay[]; warnings: string[] }> {
  const { signal } = deps;
  if (requested.length === 0)
    throw new ConfluenceMutationError(
      "At least one Confluence mutation item is required.",
    );
  if (requested.length > MAX_MUTATION_ITEMS)
    throw new ConfluenceMutationError(
      `At most ${MAX_MUTATION_ITEMS} Confluence mutation items are supported per approval.`,
    );
  const items: ConfluencePageMutationItemDisplay[] = [];
  const warnings: string[] = [];
  for (const [index, raw] of requested.entries()) {
    stopIfAborted(signal);
    const operation = raw.operation ?? "edit";
    const clientId = `cfl_${index}`;
    const addLabels = stringList(raw.addLabels);
    const removeLabels = stringList(raw.removeLabels);
    const labels = {
      ...(addLabels.length ? { labelsAdded: addLabels } : {}),
      ...(removeLabels.length ? { labelsRemoved: removeLabels } : {}),
    };

    if (operation === "create") {
      const spaceKey = raw.spaceKey?.trim();
      if (!spaceKey)
        throw new ConfluenceMutationError("create needs a spaceKey.");
      if (!raw.title?.trim())
        throw new ConfluenceMutationError("create needs a title.");
      if (!raw.body?.trim())
        throw new ConfluenceMutationError("create needs a body.");
      const space = await resolveSpaceId(
        config,
        spaceKey,
        signal ? { signal } : {},
      );
      let parentId: string | null = null;
      let parentTitle: string | null = null;
      if (raw.parentPage?.trim()) {
        const parent = await confluenceGet<ConfluencePageResponse>(
          config,
          `/wiki/api/v2/pages/${encodeURIComponent(normalizePageInput(raw.parentPage))}`,
          undefined,
          signal ? { signal } : {},
        );
        parentId = parent.id ?? null;
        parentTitle = parent.title ?? null;
      }
      items.push({
        clientId,
        operation,
        title: raw.title.trim(),
        spaceKey: space.key,
        spaceName: space.name,
        parentId,
        parentTitle,
        body: raw.body,
        ...labels,
      });
      continue;
    }

    if (operation === "uploadAttachment" || operation === "deleteAttachment") {
      if (addLabels.length || removeLabels.length)
        throw new ConfluenceMutationError(
          `${operation} does not change labels; propose them as a separate edit.`,
        );
      const staged = await stageAttachmentChange(
        config,
        operation,
        {
          ...(raw.page?.trim() ? { pageId: normalizePageInput(raw.page) } : {}),
          ...(raw.attachmentId ? { attachmentId: raw.attachmentId } : {}),
          ...(raw.fileName ? { fileName: raw.fileName } : {}),
          ...(raw.sourceAttachmentId
            ? { sourceAttachmentId: raw.sourceAttachmentId }
            : {}),
          ...(raw.sourcePath ? { sourcePath: raw.sourcePath } : {}),
        },
        {
          signal,
          ...(deps.freezeUpload ? { freezeUpload: deps.freezeUpload } : {}),
        },
      );
      const page = normalizeConfluencePage(staged.page, config.host);
      const space = await resolveSpaceSummary(config, page.spaceId, signal);
      stopIfAborted(signal);
      items.push({
        clientId,
        operation,
        pageId: page.id,
        pageUrl: page.url,
        title: page.title,
        spaceKey: space?.key ?? null,
        spaceName: space?.name ?? null,
        attachment: staged.attachment,
        ...(operation === "uploadAttachment" && raw.versionMessage?.trim()
          ? { versionMessage: raw.versionMessage.trim() }
          : {}),
      });
      if (staged.warning) warnings.push(staged.warning);
      continue;
    }

    const pageId = normalizePageInput(raw.page);
    const page = await fetchPageWithBody(
      config,
      pageId,
      signal ? { signal } : {},
    );
    const space = await resolveSpaceSummary(config, page.spaceId, signal);
    stopIfAborted(signal);
    // A proposal against an existing page is only safe because it can be
    // compared to the version it was built from. Without one there is nothing
    // to compare at execution, so refuse here rather than stage a write that
    // would silently overwrite whatever the page became.
    if (operation !== "comment" && page.version === null)
      throw new ConfluenceMutationError(
        `Confluence reported no version for page ${pageId}, so a ${operation} cannot be proposed safely. Re-read the page with confluence_get_page and try again.`,
      );
    const base: ConfluencePageMutationItemDisplay = {
      clientId,
      operation,
      pageId: page.id,
      pageUrl: page.url,
      title: page.title,
      spaceKey: space?.key ?? null,
      spaceName: space?.name ?? null,
      ...(page.version !== null ? { baseVersion: page.version } : {}),
      ...labels,
    };

    if (operation === "comment") {
      if (!raw.body?.trim())
        throw new ConfluenceMutationError("comment needs a body.");
      items.push({ ...base, body: raw.body });
      continue;
    }
    if (operation === "delete") {
      requireCurrentForDelete(page.status, `Page ${pageId}`);
      items.push(base);
      warnings.push(
        `${page.title || pageId} would be moved to the trash, along with its comments`,
      );
      continue;
    }

    const placement = raw.placement ?? "append";
    const hasBody = Boolean(raw.body?.trim());
    if (
      !hasBody &&
      !raw.newTitle?.trim() &&
      addLabels.length === 0 &&
      removeLabels.length === 0
    )
      throw new ConfluenceMutationError(
        "edit needs a body, a newTitle, or a label change; nothing was requested.",
      );
    if (
      hasBody &&
      placement !== "replace" &&
      page.bodySource !== "atlas_doc_format"
    )
      throw new ConfluenceMutationError(
        `${page.title || pageId} stores its body in the legacy storage format, which cannot be spliced. Re-read it with confluence_get_page and propose placement="replace" with the full intended body, after confirming the rewrite with the user.`,
      );
    if (hasBody && placement === "replace" && page.lossyNodes.length > 0)
      warnings.push(
        `replacing ${page.title || pageId} drops its ${page.lossyNodes.join(", ")} node(s)`,
      );
    items.push({
      ...base,
      ...(raw.newTitle?.trim() ? { newTitle: raw.newTitle.trim() } : {}),
      ...(hasBody ? { body: raw.body, placement } : {}),
      ...(page.markdown
        ? {
            currentBody:
              page.markdown.length > CURRENT_BODY_PREVIEW_CHARS
                ? `${page.markdown.slice(0, CURRENT_BODY_PREVIEW_CHARS)}…`
                : page.markdown,
          }
        : {}),
      ...(page.lossyNodes.length ? { lossyNodes: page.lossyNodes } : {}),
      ...(raw.versionMessage?.trim()
        ? { versionMessage: raw.versionMessage.trim() }
        : {}),
    });
  }
  return { items, warnings };
}
