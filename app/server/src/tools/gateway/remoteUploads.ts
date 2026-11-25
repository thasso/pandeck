/**
 * Client-mode Confluence uploads, Pandeck's side (Task-1441 P8a): what the
 * gateway's `confluence_mutate_page` (`remoteWrites.ts`) does before
 * `tools.prepare`, and what its apply (`remoteApply.ts`) reads from the card.
 *
 * Proposal (v02 AC1, v03 K4):
 * 1. A stat pre-check of every upload item reads and copies nothing: the
 *    local texts for a missing, empty or oversized source, then
 *    {@link UPLOAD_TOO_LARGE_NOTHING_WRITTEN} when the items total more than
 *    100 MiB.
 * 2. The items freeze in order under one work budget of 100 MiB: a repeated
 *    session attachment reuses its earlier freeze, any other source must
 *    still fit on a fresh stat and is read at most one chunk past what is
 *    left. A host path is copied under a staging id this call chose before
 *    any write (`p8a-` and 16 hex digits), so the call owns every partial
 *    copy and {@link discardStaged} removes exactly those.
 * 3. The upload items go to the edge naming their frozen source by
 *    `sourceAttachmentId`, with the sources' metadata beside the args.
 *
 * Binding (v02 AC4, v03 K2): a prepared upload row must carry its frozen
 * source exactly (staged id, digest, size, source, media type), and a target
 * name by the local rule, before any card is persisted. A row that names a
 * source this call did not freeze is refused, so an answer cannot select
 * another local file.
 *
 * Apply reads the sources from the card (v02 AC5 step 2): one stream per
 * staged id, the items sharing one must agree, and W at most 100 MiB.
 */
import { randomBytes } from "node:crypto";
import type { ConfluencePageMutationItemDisplay } from "@assistant/shared";
import type { FrozenUpload } from "../../confluenceAttachmentChange.ts";
import type {
  RemoteUploadSource,
  RemoteUploadStream,
} from "../../remoteTools.ts";
import {
  discardStagedAttachment,
  resolveSessionAttachment,
} from "../../sessionAttachments.ts";
import {
  UploadOverLimitError,
  freezeUploadSource,
  statUploadSource,
} from "../confluence/confluenceAttachments.ts";
import { withNothingWritten } from "./remoteWriteRules.ts";

const MIB = 1024 * 1024;
/** W, every upload item's bytes in one proposal, through the gateway. */
const UPLOAD_MAX_BYTES = 100 * MIB;
/** A target name the site chose, as the edge bounds a source's texts. */
const NAME_MAX = 1_024;
const SHA256_RE = /^[0-9a-f]{64}$/;

export const UPLOAD_TOO_LARGE_NOTHING_WRITTEN =
  "These uploads total more than 100 MiB, which is the limit through the gateway; nothing was written. Split them into smaller changes.";
export const UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN =
  "The approved file is no longer the same on this server; nothing was written. Ask for the upload again.";

/** What one item asks for, as far as its source goes. */
interface UploadRequestItem {
  operation?: unknown;
  attachmentId?: unknown;
  fileName?: unknown;
  sourceAttachmentId?: unknown;
  sourcePath?: unknown;
}

/** A proposal's frozen sources, by item. */
export interface FrozenSources {
  /** The items for `tools.prepare`: each upload names its frozen source. */
  items: unknown[];
  /** The declared sources, one per staged id, in first-use order. */
  uploads: RemoteUploadSource[];
  /** Each item's frozen source; undefined for an item that uploads nothing. */
  byIndex: (FrozenUpload | undefined)[];
  /** Every staging id this call chose, written to or not. */
  stageIds: string[];
}

const isUpload = (item: unknown): item is UploadRequestItem =>
  typeof item === "object" &&
  item !== null &&
  (item as UploadRequestItem).operation === "uploadAttachment";

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const sourceOf = (item: UploadRequestItem) => ({
  ...(text(item.sourceAttachmentId) !== undefined
    ? { sourceAttachmentId: text(item.sourceAttachmentId)! }
    : {}),
  ...(text(item.sourcePath) !== undefined
    ? { sourcePath: text(item.sourcePath)! }
    : {}),
});

/** A local refusal, with the client's own "nothing was written". */
const refused = (err: unknown): Error =>
  new Error(
    withNothingWritten(err instanceof Error ? err.message : String(err)),
  );

/** A fresh staging id, absent from the session's attachments. */
function stagingId(sessionId: string): string {
  for (;;) {
    const id = `p8a-${randomBytes(8).toString("hex")}`;
    if (!resolveSessionAttachment(sessionId, id)) return id;
  }
}

/**
 * Freezes the upload items of `items` for a gateway proposal; undefined
 * when none uploads. `fence` runs before each item and throws the call's
 * text when the call was cancelled or the route went away. On any refusal
 * every copy this call made is discarded before it throws.
 */
export async function freezeRemoteUploads(
  sessionId: string,
  items: readonly unknown[],
  fence: () => void,
): Promise<FrozenSources | undefined> {
  if (!items.some(isUpload)) return undefined;
  // Step 1: sizes only, nothing read or copied.
  let total = 0;
  for (const item of items) {
    if (!isUpload(item)) continue;
    try {
      total += statUploadSource(sessionId, sourceOf(item)).size;
    } catch (err) {
      throw refused(err);
    }
  }
  if (total > UPLOAD_MAX_BYTES)
    throw new Error(UPLOAD_TOO_LARGE_NOTHING_WRITTEN);
  // Step 2: the progressive budget.
  const stageIds: string[] = [];
  const byIndex: (FrozenUpload | undefined)[] = [];
  const bySession = new Map<string, FrozenUpload>();
  let remaining = UPLOAD_MAX_BYTES;
  try {
    for (const item of items) {
      if (!isUpload(item)) {
        byIndex.push(undefined);
        continue;
      }
      fence();
      const request = sourceOf(item);
      let fresh;
      try {
        fresh = statUploadSource(sessionId, request);
      } catch (err) {
        throw refused(err);
      }
      const again =
        fresh.kind === "attachment" ? bySession.get(fresh.key) : undefined;
      if (again) {
        remaining -= again.size;
        if (remaining < 0) throw new Error(UPLOAD_TOO_LARGE_NOTHING_WRITTEN);
        byIndex.push(again);
        continue;
      }
      if (fresh.size > remaining)
        throw new Error(UPLOAD_TOO_LARGE_NOTHING_WRITTEN);
      const stageId = fresh.kind === "path" ? stagingId(sessionId) : undefined;
      if (stageId) stageIds.push(stageId);
      let frozen: FrozenUpload;
      try {
        frozen = await freezeUploadSource(sessionId, request, {
          limitBytes: remaining,
          ...(stageId ? { stageId } : {}),
        });
      } catch (err) {
        if (err instanceof UploadOverLimitError)
          throw new Error(UPLOAD_TOO_LARGE_NOTHING_WRITTEN);
        throw refused(err);
      }
      remaining -= frozen.size;
      if (fresh.kind === "attachment") bySession.set(fresh.key, frozen);
      byIndex.push(frozen);
    }
  } catch (err) {
    discardStaged(sessionId, stageIds);
    throw err;
  }
  const uploads = new Map<string, RemoteUploadSource>();
  for (const frozen of byIndex)
    if (frozen && !uploads.has(frozen.stagedAttachmentId))
      uploads.set(frozen.stagedAttachmentId, {
        stagedAttachmentId: frozen.stagedAttachmentId,
        name: frozen.name,
        mimeType: frozen.mimeType,
        size: frozen.size,
        sha256: frozen.sha256,
        source: frozen.source,
      });
  return {
    items: items.map((item, index) => {
      const frozen = byIndex[index];
      if (!frozen || !isUpload(item)) return item;
      const { sourcePath: _path, sourceAttachmentId: _id, ...rest } = item;
      return { ...rest, sourceAttachmentId: frozen.stagedAttachmentId };
    }),
    uploads: [...uploads.values()],
    byIndex,
    stageIds,
  };
}

/** Removes what this call staged; a card that persisted keeps its copies. */
export function discardStaged(
  sessionId: string,
  stageIds: readonly string[],
): void {
  for (const stageId of stageIds) discardStagedAttachment(sessionId, stageId);
}

/**
 * Whether the prepared rows are bound to what this call froze (v03 K2):
 * every upload row at an index whose request froze a source, carrying that
 * source exactly and a target name by the local rule; no other upload row.
 */
export function bindsFrozenUploads(
  requested: readonly unknown[],
  frozen: FrozenSources | undefined,
  prepared: readonly ConfluencePageMutationItemDisplay[],
): boolean {
  if (!frozen)
    return !prepared.some((row) => row.operation === "uploadAttachment");
  if (prepared.length !== requested.length) return false;
  for (const [index, row] of prepared.entries()) {
    const source = frozen.byIndex[index];
    if ((row.operation === "uploadAttachment") !== (source !== undefined))
      return false;
    if (!source) continue;
    const attachment = row.attachment;
    if (
      !attachment ||
      attachment.stagedAttachmentId !== source.stagedAttachmentId ||
      attachment.sha256 !== source.sha256 ||
      attachment.size !== source.size ||
      attachment.source !== source.source ||
      attachment.mediaType !== source.mimeType
    )
      return false;
    const request = requested[index] as UploadRequestItem;
    const named = text(request.fileName)?.trim() ?? "";
    if (text(request.attachmentId)?.trim()) {
      // The site's title, which the card shows; the edge refused any other
      // name the request gave.
      if (
        attachment.fileName.length === 0 ||
        attachment.fileName.length > NAME_MAX ||
        (named !== "" && attachment.fileName !== named)
      )
        return false;
    } else if (attachment.fileName !== (named || source.name)) return false;
  }
  return true;
}

/** The streams an approved card uploads and their W. */
export interface CardUploads {
  streams: RemoteUploadStream[];
  work: number;
}

/**
 * The card's upload sources (v02 AC5 step 2), or undefined when it uploads
 * nothing. Throws the card's text: items sharing a source that disagree,
 * or one without its frozen source, is
 * {@link UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN}; W over 100 MiB is
 * {@link UPLOAD_TOO_LARGE_NOTHING_WRITTEN}.
 */
export function cardUploads(
  items: readonly ConfluencePageMutationItemDisplay[],
): CardUploads | undefined {
  const streams = new Map<string, RemoteUploadStream>();
  let work = 0;
  for (const item of items) {
    if (item.operation !== "uploadAttachment") continue;
    const { stagedAttachmentId, size, sha256 } = item.attachment ?? {};
    if (
      typeof stagedAttachmentId !== "string" ||
      stagedAttachmentId.length === 0 ||
      typeof sha256 !== "string" ||
      !SHA256_RE.test(sha256) ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 1
    )
      throw new Error(UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN);
    const known = streams.get(stagedAttachmentId);
    if (known && (known.size !== size || known.sha256 !== sha256))
      throw new Error(UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN);
    if (!known)
      streams.set(stagedAttachmentId, { stagedAttachmentId, size, sha256 });
    work += size;
  }
  if (streams.size === 0) return undefined;
  if (work > UPLOAD_MAX_BYTES)
    throw new Error(UPLOAD_TOO_LARGE_NOTHING_WRITTEN);
  return { streams: [...streams.values()], work };
}
