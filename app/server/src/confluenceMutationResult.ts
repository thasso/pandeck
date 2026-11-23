/**
 * The `confluence_mutate_page` result contract (Task-1463 P6a, P6-F1), as
 * `jiraMutationResult.ts` is for Jira: the pure result fields
 * ({@link CONFLUENCE_RESULT_FIELDS}) are never in a proposal; a record
 * carries them present or absent, and the merge sets a present one and
 * deletes an absent one. Confluence has no dual-use field.
 *
 * Boundary-clean: only the shared types, the rule kit and the codec
 * (`workerBoundary.test.ts`).
 */
import type {
  ConfluenceAttachmentMutationDisplay,
  ConfluencePageMutationItemDisplay,
} from "@assistant/shared/confluenceMutation";
import {
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
  boundedText,
  effects,
  formatted,
  siteUrl,
  version,
  vettedVersion,
  type Effects,
  type ResultVetting,
} from "./mutationResultCodec.ts";

/** Every pure result field, by the type that holds it. */
export const CONFLUENCE_RESULT_FIELDS = {
  item: ["resultPageId", "resultPageUrl", "resultVersion", "warning", "error"],
  attachment: ["resultId", "resultVersion"],
} as const satisfies {
  item: readonly (keyof ConfluencePageMutationItemDisplay)[];
  attachment: readonly (keyof ConfluenceAttachmentMutationDisplay)[];
};

interface AttachmentResult {
  resultId?: string | null;
  resultVersion?: number | null;
}

/** What apply did to one sent item. */
export interface ConfluenceResultRecord {
  effects: Effects;
  resultPageId?: string | null;
  resultPageUrl?: string | null;
  resultVersion?: number | null;
  warning?: string;
  error?: string;
  /** Present exactly when the sent item has an attachment. */
  attachment?: AttachmentResult;
}

/** The item as a proposal: a copy without pure result fields. */
export function confluenceProposalOf(
  item: ConfluencePageMutationItemDisplay,
): ConfluencePageMutationItemDisplay {
  const proposal = structuredClone(item);
  for (const key of CONFLUENCE_RESULT_FIELDS.item) delete proposal[key];
  if (proposal.attachment)
    for (const key of CONFLUENCE_RESULT_FIELDS.attachment)
      delete proposal.attachment[key];
  return proposal;
}

/** A raw id as a record keeps it: `null` as is, a clean one whole, else `null`. */
function vettedId(
  raw: string | null,
  kind: "pageId" | "attachmentId",
  vet: ResultVetting,
): string | null {
  return raw === null ? null : (vet.identifier(raw, kind) ?? null);
}

/**
 * The record of one item after apply. `applied` is the item apply worked
 * on, `sent` a copy taken before. A page link is backed by the vetted result
 * page id when apply wrote one, else by the sent page id; a written but
 * unsafe id never falls back to the sent one.
 */
export function buildConfluenceResultRecord(
  applied: ConfluencePageMutationItemDisplay,
  sent: ConfluencePageMutationItemDisplay,
  vet: ResultVetting,
  certified: Effects,
): ConfluenceResultRecord {
  const record: ConfluenceResultRecord = { effects: certified };
  if (applied.resultPageId !== undefined)
    record.resultPageId = vettedId(applied.resultPageId, "pageId", vet);
  if (applied.resultPageUrl === null) record.resultPageUrl = null;
  else if (applied.resultPageUrl !== undefined) {
    const backing =
      applied.resultPageId !== undefined && applied.resultPageId !== null
        ? (record.resultPageId ?? undefined)
        : vet.identifier(sent.pageId, "pageId");
    const url = vet.url(applied.resultPageUrl, backing);
    if (url !== undefined) record.resultPageUrl = url;
  }
  const written = vettedVersion(applied.resultVersion);
  if (written !== undefined) record.resultVersion = written;
  if (typeof applied.warning === "string")
    record.warning = vet.text(
      applied.warning,
      ITEM_WARNING_MAX,
      WARNING_FALLBACK,
    );
  if (typeof applied.error === "string")
    record.error = vet.text(applied.error, ITEM_ERROR_MAX, ERROR_FALLBACK);
  if (sent.attachment) {
    const attachment: AttachmentResult = {};
    const raw = applied.attachment;
    if (raw?.resultId === null) attachment.resultId = null;
    else if (raw?.resultId !== undefined) {
      const id = vet.identifier(raw.resultId, "attachmentId");
      if (id !== undefined) attachment.resultId = id;
    }
    const attachmentVersion = vettedVersion(raw?.resultVersion);
    if (attachmentVersion !== undefined)
      attachment.resultVersion = attachmentVersion;
    record.attachment = attachment;
  }
  return record;
}

/** The record's shape, its links on `site`. */
function recordShape(site: string): Check<ConfluenceResultRecord> {
  return closed<ConfluenceResultRecord>({
    effects: req(effects),
    resultPageId: opt(nullable(formatted("pageId"))),
    resultPageUrl: opt(nullable(siteUrl(site))),
    resultVersion: opt(nullable(version)),
    warning: opt(boundedText(ITEM_WARNING_MAX)),
    error: opt(boundedText(ITEM_ERROR_MAX)),
    attachment: opt(
      closed<AttachmentResult>({
        resultId: opt(nullable(formatted("attachmentId"))),
        resultVersion: opt(nullable(version)),
      }),
    ),
  });
}

/**
 * Whether `record` is a valid record for `sent` from an edge on `site`:
 * closed, typed, formatted and capped, with attachment results exactly when
 * the sent item has an attachment.
 */
export function checkConfluenceResult(
  record: unknown,
  sent: ConfluencePageMutationItemDisplay,
  site: string,
): record is ConfluenceResultRecord {
  if (!recordShape(site)(record, 0)) return false;
  return (record.attachment === undefined) === (sent.attachment === undefined);
}

/**
 * Writes a checked record onto the card's item: each pure result field set
 * when present and deleted when absent.
 */
export function mergeConfluenceResult(
  card: ConfluencePageMutationItemDisplay,
  record: ConfluenceResultRecord,
): void {
  if (record.resultPageId === undefined) delete card.resultPageId;
  else card.resultPageId = record.resultPageId;
  if (record.resultPageUrl === undefined) delete card.resultPageUrl;
  else card.resultPageUrl = record.resultPageUrl;
  if (record.resultVersion === undefined) delete card.resultVersion;
  else card.resultVersion = record.resultVersion;
  if (record.warning === undefined) delete card.warning;
  else card.warning = record.warning;
  if (record.error === undefined) delete card.error;
  else card.error = record.error;
  if (card.attachment && record.attachment) {
    const { resultId, resultVersion } = record.attachment;
    if (resultId === undefined) delete card.attachment.resultId;
    else card.attachment.resultId = resultId;
    if (resultVersion === undefined) delete card.attachment.resultVersion;
    else card.attachment.resultVersion = resultVersion;
  }
}
