/**
 * `confluence_mutate_page` on the edge (Task-1463 P5b): the local tool's
 * schema structure and shared prepare/apply core (`confluenceMutate.ts`,
 * `confluenceMutateApply.ts`), run with the calling user's Atlassian
 * credential. On `/mcp` the harness's own permission prompt approves the call
 * (D-W), so one call prepares and applies at once, through the shared write
 * runner (`writeCall.ts`) with jira_mutate_issue's deadline, budget, fence and
 * stop cutoff. Pandeck's client mode still drops write entries
 * (`remoteTools.ts`).
 *
 * The operation gate runs first, before the credential is read: an upload is
 * refused until the edge can stage bytes (P8), and `delete`/`deleteAttachment`
 * only pass where the gateway's requested Atlassian scope list holds their
 * scope (`confluenceDeleteSwitchFor`), fixed when the edge starts. The first
 * offending item in input order refuses the whole call. Every gate refusal
 * comes before any Atlassian request; semantic and upstream refusals can
 * follow prepare's reads.
 *
 * Deletes go only to the trash, and only for a resource its verification
 * read reported `status: "current"` (`requireCurrentForDelete`, P5a). That is
 * proof from the read, not a conditional DELETE: a change made elsewhere
 * between the read and the DELETE is not caught. The edge adds no guard of its
 * own.
 *
 * The result is a compact projection whose serialized size is bounded by
 * construction. Identifiers and links pass only when vetted for the call's
 * secret on their raw values (`writeResult.ts`). A link is kept only when it
 * is an absolute link on the credential's own site; an off-site link, such as
 * an absolute one `confluenceWebUrl` passes through, is omitted. Bodies and a
 * page's current body are never projected.
 */
import type {
  ConfluenceAttachmentMutationDisplay,
  ConfluencePageMutationItemDisplay,
  ConfluencePageMutationOperation,
} from "@assistant/shared/confluenceMutation";
import type { ConfluenceConfig } from "../atlassian/confluenceClient.ts";
import {
  MAX_MUTATION_ITEMS,
  buildConfluenceMutationItems,
  confluenceMutateParamsSchema,
  type ConfluenceMutateParams,
} from "../confluenceMutate.ts";
import { applyConfluenceMutationItems } from "../confluenceMutateApply.ts";
import { checkConfluencePageItems } from "../confluenceMutationCheck.ts";
import { ConfluenceMutationError } from "../confluenceMutationErrors.ts";
import {
  buildConfluenceResultRecord,
  type ConfluenceResultRecord,
} from "../confluenceMutationResult.ts";
import {
  ERROR_FALLBACK,
  IDENTIFIER_FORMATS,
  WARNING_FALLBACK,
} from "../mutationResultCodec.ts";
import { confluenceConfigOf } from "./atlassian.ts";
import {
  ToolError,
  type AtlassianCredential,
  type AtlassianToolDescriptor,
  type ObjectSchema,
} from "./descriptor.ts";
import { vettingFor } from "./mutationResultVetting.ts";
import {
  runApply,
  runPrepare,
  type ApplyProduct,
  type PrepareProduct,
} from "./twoPhase.ts";
import { REDACTED } from "./upstreamText.ts";
import {
  WRITE_DEADLINE_MS,
  runWrite,
  type WritePhases,
  type WriteProduct,
} from "./writeCall.ts";
import { describeConfluenceWriteFailure } from "./writeFailure.ts";
import {
  RESULT_BUDGET,
  projectText,
  sentResult,
  shrunkToBudget,
  vettedIdentifier,
  vettedUrl,
} from "./writeResult.ts";

export const UPLOAD_UNAVAILABLE =
  "Uploading attachments is not available through this gateway yet; nothing was written to Confluence.";
export const PAGE_DELETE_OFF =
  "Deleting pages is not enabled on this gateway; nothing was written to Confluence.";
export const ATTACHMENT_DELETE_OFF =
  "Deleting attachments is not enabled on this gateway; nothing was written to Confluence.";
export const PREPARE_TOO_LONG_CONFLUENCE =
  "Preparing the changes took too long; nothing was written to Confluence. Send fewer items.";
const NOTHING_WRITTEN = " Nothing was written to Confluence.";

/** Which deletes this edge offers, from its requested scope list (Q1). */
export interface ConfluenceDeleteSwitch {
  page: boolean;
  attachment: boolean;
}

/**
 * The switch for a requested Atlassian scope list: each delete only when its
 * exact, case-sensitive scope is listed. No list means both off.
 */
export function confluenceDeleteSwitchFor(
  scopes: readonly string[] | undefined,
): ConfluenceDeleteSwitch {
  return {
    page: scopes?.includes("delete:page:confluence") ?? false,
    attachment: scopes?.includes("delete:attachment:confluence") ?? false,
  };
}

const SUMMARY_MAX = 2_000;
const WARNINGS_MAX = 10;
const WARNING_MAX = 300;
const ITEM_ERROR_MAX = 600;
const ITEM_WARNING_MAX = 400;
const TITLE_MAX = 200;
const FILE_NAME_MAX = 200;
const SHRUNK_TEXT_MAX = 200;
const SHRUNK_NAME_MAX = 50;
const VERSION_MAX = 999_999_999;
const WARNING_WITHHELD = "A warning was withheld.";
const ITEM_ERROR_FALLBACK = "The change failed.";
const NAME_WITHHELD = "[withheld]";

const OPERATIONS = [
  "create",
  "edit",
  "comment",
  "delete",
  "uploadAttachment",
  "deleteAttachment",
] as const satisfies readonly ConfluencePageMutationOperation[];

const CONFLUENCE_MUTATE_PAGE_EDGE_DESCRIPTION =
  "Change Confluence pages: create a page, edit one (append, prepend or replace its body, rename it, relabel it), add a footer comment, or move a page or an attachment to the trash. CommonMark/GFM is converted to Atlassian Document Format. This tool writes in one call: the client asks the user to approve it, and Confluence changes as soon as it runs. Use it only when the user explicitly asks to write to Confluence, and ask first when the target page, space or content is ambiguous. Prefer append over replace: replace rebuilds the body from Markdown and destroys the page's macros, layouts and images. uploadAttachment is not available here, and deletes work only where this gateway enables them. Keep batches small. Interrupting the call does not stop it; it may still be writing. After a timeout or interrupt, wait 60 s before reading the pages and before any retry: an early unchanged read does not prove nothing will change.";

const localItems = confluenceMutateParamsSchema.properties.items;
const localItem = localItems.items;

/**
 * The local schema with three prose changes (I1): where the local tool stages
 * an approval card, this one writes. Built by spreading, so the structure is
 * the local one.
 */
const edgeConfluenceMutateParamsSchema = {
  ...confluenceMutateParamsSchema,
  properties: {
    ...confluenceMutateParamsSchema.properties,
    items: {
      ...localItems,
      description: "Confluence changes, applied in this call.",
      items: {
        ...localItem,
        properties: {
          ...localItem.properties,
          placement: {
            ...localItem.properties.placement,
            description:
              "edit only, defaults to append. append/prepend splice the new content into the existing page and keep its macros, layouts and images. replace rewrites the whole body from Markdown and DESTROYS every macro, layout and image on the page — use it only when the user asked to rewrite the page.",
          },
        },
      },
    },
  },
} satisfies ObjectSchema;

/** One row's attachment in the projected result. */
interface ProjectedAttachment {
  fileName: string;
  id?: string;
  version?: number;
}

/** One row of the projected result. */
interface ProjectedItem {
  operation: ConfluencePageMutationOperation;
  pageId: string | null;
  ok: boolean;
  title?: string;
  url?: string;
  version?: number;
  attachment?: ProjectedAttachment;
  warning?: string;
  error?: string;
}

/** The answer of a call that reached apply. */
export interface ProjectedConfluenceResult {
  summary: string;
  url?: string;
  warnings?: string[];
  items: ProjectedItem[];
}

/** A page id as Confluence returned it: whole, vetted, 1-20 digits. */
function vettedPageId(
  raw: unknown,
  credential: AtlassianCredential,
): string | undefined {
  return vettedIdentifier(raw, credential, IDENTIFIER_FORMATS.pageId);
}

/** An attachment id as Confluence returned it: whole, vetted, `att` and 1-20 digits. */
function vettedAttachmentId(
  raw: unknown,
  credential: AtlassianCredential,
): string | undefined {
  return vettedIdentifier(raw, credential, IDENTIFIER_FORMATS.attachmentId);
}

/** A version: an integer 0-999,999,999, else nothing. */
function version(raw: unknown): number | undefined {
  return typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= 0 &&
    raw <= VERSION_MAX
    ? raw
    : undefined;
}

function operationOf(
  item: ConfluencePageMutationItemDisplay,
): ProjectedItem["operation"] {
  const operation = item.operation ?? "edit";
  return (OPERATIONS as readonly string[]).includes(operation)
    ? operation
    : "edit";
}

/** The page id a row reports: the written one, else the one it targeted. */
function rawPageId(item: ConfluencePageMutationItemDisplay): unknown {
  return item.resultPageId ?? item.pageId;
}

function projectAttachment(
  attachment: ConfluenceAttachmentMutationDisplay,
  credential: AtlassianCredential,
): ProjectedAttachment {
  const id = vettedAttachmentId(
    attachment.resultId ?? attachment.existingId,
    credential,
  );
  const written = version(attachment.resultVersion);
  return {
    fileName: projectText(
      typeof attachment.fileName === "string" ? attachment.fileName : "",
      credential,
      FILE_NAME_MAX,
      NAME_WITHHELD,
    ),
    ...(id !== undefined ? { id } : {}),
    ...(written !== undefined ? { version: written } : {}),
  };
}

function projectItem(
  item: ConfluencePageMutationItemDisplay,
  credential: AtlassianCredential,
): ProjectedItem {
  const pageId = vettedPageId(rawPageId(item), credential);
  const url = vettedUrl(item.resultPageUrl, pageId, credential);
  // A rename reports the page's new title.
  const title =
    typeof item.newTitle === "string" && item.newTitle !== ""
      ? item.newTitle
      : item.title;
  const written = version(item.resultVersion);
  return {
    operation: operationOf(item),
    pageId: pageId ?? null,
    ok: typeof item.error !== "string",
    ...(typeof title === "string" && title !== ""
      ? { title: projectText(title, credential, TITLE_MAX, NAME_WITHHELD) }
      : {}),
    ...(url !== undefined ? { url } : {}),
    ...(written !== undefined ? { version: written } : {}),
    ...(item.attachment
      ? { attachment: projectAttachment(item.attachment, credential) }
      : {}),
    ...(typeof item.warning === "string"
      ? {
          warning: projectText(
            item.warning,
            credential,
            ITEM_WARNING_MAX,
            WARNING_WITHHELD,
          ),
        }
      : {}),
    ...(typeof item.error === "string"
      ? {
          error: projectText(
            item.error,
            credential,
            ITEM_ERROR_MAX,
            ITEM_ERROR_FALLBACK,
          ),
        }
      : {}),
  };
}

/**
 * The applied items as the caller's answer: every string capped and vetted,
 * ids and links vetted on their raw values. At most `MAX_MUTATION_ITEMS` rows
 * of these caps serialize to about 44,450 characters, under `budget`; a
 * shrink guard keeps the result within it in Confluence's order, never
 * removing a row's operation, page id, outcome or error.
 */
export function projectConfluenceResult(
  applied: {
    items: readonly ConfluencePageMutationItemDisplay[];
    warnings: readonly string[];
    succeeded: number;
    resultSummary: string;
    resultUrl?: string | undefined;
  },
  credential: AtlassianCredential,
  budget = RESULT_BUDGET,
): ProjectedConfluenceResult {
  const rows = applied.items.slice(0, MAX_MUTATION_ITEMS);
  const failed = applied.items.length - applied.succeeded;
  const counts = `Applied ${applied.succeeded} change(s); ${failed} failed.`;
  const items = rows.map((item) => projectItem(item, credential));
  // The root link is backed by the first row that wrote it, and only by
  // that row's vetted page id.
  const source = rows.find(
    (item) =>
      applied.resultUrl !== undefined &&
      item.resultPageUrl === applied.resultUrl,
  );
  const url = vettedUrl(
    applied.resultUrl,
    source ? vettedPageId(rawPageId(source), credential) : undefined,
    credential,
  );
  const warnings = applied.warnings
    .slice(0, WARNINGS_MAX)
    .map((warning) =>
      projectText(warning, credential, WARNING_MAX, WARNING_WITHHELD),
    );
  if (applied.warnings.length > WARNINGS_MAX)
    warnings.push(
      projectText(
        `${applied.warnings.length - WARNINGS_MAX} more warning(s) omitted.`,
        credential,
        WARNING_MAX,
        REDACTED,
      ),
    );
  const result: ProjectedConfluenceResult = {
    summary: projectText(
      applied.resultSummary,
      credential,
      SUMMARY_MAX,
      counts,
    ),
    ...(url !== undefined ? { url } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    items,
  };
  const kept = shrunkToBudget(
    result,
    budget,
    confluenceShrinkStages(applied.warnings.length, credential),
  );
  return withheldUnlessSafe(kept, credential);
}

/**
 * Confluence's shrink stages, in order (C6 O2): the warnings to one fixed
 * entry; row texts to 200; titles and file names to 50; a fixed minimal row
 * of operation, page id, outcome and error.
 */
function confluenceShrinkStages(
  warningCount: number,
  credential: AtlassianCredential,
): ((result: ProjectedConfluenceResult) => void)[] {
  return [
    (result) => {
      if (result.warnings)
        result.warnings = [
          projectText(
            `${warningCount} warning(s) omitted.`,
            credential,
            WARNING_MAX,
            REDACTED,
          ),
        ];
    },
    (result) => {
      for (const item of result.items) {
        if (item.warning !== undefined)
          item.warning = projectText(
            item.warning,
            credential,
            SHRUNK_TEXT_MAX,
            WARNING_WITHHELD,
          );
        if (item.error !== undefined)
          item.error = projectText(
            item.error,
            credential,
            SHRUNK_TEXT_MAX,
            ITEM_ERROR_FALLBACK,
          );
      }
    },
    (result) => {
      for (const item of result.items) {
        if (item.title !== undefined)
          item.title = projectText(
            item.title,
            credential,
            SHRUNK_NAME_MAX,
            NAME_WITHHELD,
          );
        if (item.attachment)
          item.attachment.fileName = projectText(
            item.attachment.fileName,
            credential,
            SHRUNK_NAME_MAX,
            NAME_WITHHELD,
          );
      }
    },
    (result) => {
      result.items = result.items.map(({ operation, pageId, ok, error }) => ({
        operation,
        pageId,
        ok,
        ...(error !== undefined ? { error } : {}),
      }));
    },
  ];
}

/** When not even the rows' outcomes can be shown without the credential. */
export const CONFLUENCE_RESULT_WITHHELD =
  "The changes ran, but their result cannot be shown without revealing the credential; check the pages before retrying.";

/**
 * The last check of the answer as it is sent, as `jira_mutate_issue` does it
 * (`sentResult`, R3): when the serialized result holds a secret form that no
 * single field held, only the rows' outcomes remain, and failing that the
 * fixed text.
 */
function withheldUnlessSafe(
  kept: ProjectedConfluenceResult,
  credential: AtlassianCredential,
): ProjectedConfluenceResult {
  return sentResult(
    kept,
    credential,
    (sent) => ({
      summary: REDACTED,
      items: sent.items.map(({ operation, ok }) => ({
        operation,
        pageId: null,
        ok,
      })),
    }),
    CONFLUENCE_RESULT_WITHHELD,
  );
}

/**
 * The gate (AC4): each item's operation (`edit` when absent), in input
 * order; the first one this edge does not offer refuses the whole call. It
 * also runs on `tools.apply`'s items before their check, so it reads any
 * value: a non-string operation is left to the check.
 */
function gate(items: unknown, deletes: ConfluenceDeleteSwitch): void {
  if (!Array.isArray(items)) return;
  for (const item of items as unknown[]) {
    const raw: unknown =
      typeof item === "object" && item !== null
        ? (item as { operation?: unknown }).operation
        : undefined;
    const operation = raw ?? "edit";
    if (operation === "uploadAttachment")
      throw new ToolError(UPLOAD_UNAVAILABLE);
    if (operation === "delete" && !deletes.page)
      throw new ToolError(PAGE_DELETE_OFF);
    if (operation === "deleteAttachment" && !deletes.attachment)
      throw new ToolError(ATTACHMENT_DELETE_OFF);
  }
}

type ConfluencePrepared = Awaited<
  ReturnType<typeof buildConfluenceMutationItems>
>;
type ConfluenceApplied = Awaited<
  ReturnType<typeof applyConfluenceMutationItems>
>;

/** Confluence's texts, config and D-W2 mapper for the shared runner. */
const CONFLUENCE_WRITE: WriteProduct<ConfluenceConfig> = {
  prepareTooLong: PREPARE_TOO_LONG_CONFLUENCE,
  nothingWritten: NOTHING_WRITTEN,
  prepareRefusalFallback: `Confluence refused the change.${NOTHING_WRITTEN}`,
  allFailedFallback: "Every Confluence change failed.",
  configOf: confluenceConfigOf,
  describeError: describeConfluenceWriteFailure,
  isAllFailed: (err): err is ConfluenceMutationError =>
    err instanceof ConfluenceMutationError,
};

/**
 * One call's phases: prepare's reads on its own signal, with no upload seam;
 * apply on the call's signal, with no staged bytes.
 */
function confluencePhases(
  items: ConfluenceMutateParams["items"],
): (
  config: ConfluenceConfig,
  credential: AtlassianCredential,
) => WritePhases<ConfluencePrepared, ConfluenceApplied> {
  return (config, credential) => ({
    prepare(signal) {
      return buildConfluenceMutationItems(config, items ?? [], { signal });
    },
    apply(prepared, signal, stopBefore) {
      return applyConfluenceMutationItems(config, prepared.items, {
        signal,
        describeError: (err) =>
          describeConfluenceWriteFailure(err, credential, [signal]),
        stopBefore,
      });
    },
  });
}

/**
 * The descriptor for an edge whose deletes are `deletes`. The listing is the
 * same whatever the switch; only a call's gate reads it.
 */
export function confluenceMutatePageTool(
  deletes: ConfluenceDeleteSwitch,
): AtlassianToolDescriptor {
  return {
    name: "confluence_mutate_page",
    description: CONFLUENCE_MUTATE_PAGE_EDGE_DESCRIPTION,
    inputSchema: edgeConfluenceMutateParamsSchema,
    effect: "write",
    actionKey: "confluence:write",
    integration: "atlassian",
    maxResultChars: 60_000,
    deadlineMs: WRITE_DEADLINE_MS,
    async execute(params, ctx) {
      const requested = params as ConfluenceMutateParams;
      // Before the credential, so a refused call reads and sends nothing.
      gate(requested.items, deletes);
      const { credential, prepared, applied } = await runWrite(
        ctx,
        CONFLUENCE_WRITE,
        confluencePhases(requested.items),
      );
      return projectConfluenceResult(
        {
          items: prepared.items,
          warnings: prepared.warnings,
          succeeded: applied.succeeded,
          resultSummary: applied.resultSummary,
          resultUrl: applied.resultUrl,
        },
        credential,
      );
    },
    phases: {
      prepare(params, ctx) {
        const { items } = params as ConfluenceMutateParams;
        gate(items, deletes);
        return runPrepare(ctx, CONFLUENCE_PREPARE(items));
      },
      apply(request, ctx) {
        gate(request.items, deletes);
        return runApply(ctx, CONFLUENCE_APPLY, request);
      },
    },
  };
}

/** Confluence's prepare for `tools.prepare`: the one-call prepare, on its own. */
const CONFLUENCE_PREPARE = (
  items: ConfluenceMutateParams["items"],
): PrepareProduct<ConfluenceConfig, ConfluencePageMutationItemDisplay> => ({
  ...CONFLUENCE_WRITE,
  prepare: (config, credential, signal) =>
    confluencePhases(items)(config, credential).prepare(signal),
  check: checkConfluencePageItems,
});

/**
 * A record with every text fixed and no identifier or link: what
 * `tools.apply` sends when the full records would carry a secret form once
 * joined. Versions are numbers and stay.
 */
export function confluenceOutcomeOf(
  record: ConfluenceResultRecord,
): ConfluenceResultRecord {
  const { attachment } = record;
  return {
    effects: record.effects,
    ...(record.resultPageId !== undefined ? { resultPageId: null } : {}),
    ...(record.resultPageUrl === null ? { resultPageUrl: null } : {}),
    ...(record.resultVersion !== undefined
      ? { resultVersion: record.resultVersion }
      : {}),
    ...(record.warning !== undefined ? { warning: WARNING_FALLBACK } : {}),
    ...(record.error !== undefined ? { error: ERROR_FALLBACK } : {}),
    ...(attachment
      ? {
          attachment: {
            ...(attachment.resultId !== undefined ? { resultId: null } : {}),
            ...(attachment.resultVersion !== undefined
              ? { resultVersion: attachment.resultVersion }
              : {}),
          },
        }
      : {}),
  };
}

/** Confluence's apply for `tools.apply`: the shared apply and its contract. */
const CONFLUENCE_APPLY: ApplyProduct<
  ConfluenceConfig,
  ConfluencePageMutationItemDisplay,
  ConfluenceResultRecord
> = {
  ...CONFLUENCE_WRITE,
  check: checkConfluencePageItems,
  apply: (config, credential, items, deps) =>
    applyConfluenceMutationItems(config, items, {
      ...deps,
      describeError: (err) =>
        describeConfluenceWriteFailure(err, credential, [deps.signal]),
    }),
  vetting: vettingFor,
  record: buildConfluenceResultRecord,
  // Item results are small and only the attachment nests: no stage to run.
  shrink: () => false,
  outcomeOf: confluenceOutcomeOf,
};
