/**
 * The apply half of `confluence_mutate_page` (Task-1463): sends the approved
 * items' writes and reports per-item results and a summary.
 *
 * Boundary-clean, so the gateway's edge may import it
 * (`workerBoundary.test.ts`): server state arrives as `ConfluenceApplyDeps`.
 * A rejected write surfaces as `ConfluenceWriteHttpError`, the code's own text
 * as `ConfluenceMutationError`, and an item error or label warning is
 * `deps.describeError` of either. Every request carries `deps.signal` when
 * there is one; an abort propagates as itself, never as an item error or
 * warning, and nothing is sent after it. Without a signal every call keeps the
 * exact argument list the local executor always sent.
 *
 * Deletes go only to the trash: `DELETE /wiki/api/v2/pages/{id}` and
 * `DELETE /wiki/api/v2/attachments/{id}`, with no query, once per item and
 * only after the item's verification read.
 */
import type {
  ConfluenceBodyPlacement,
  ConfluencePageMutationItemDisplay,
} from "@assistant/shared/confluenceMutation";
import { markdownToAdf, type AdfNode } from "./atlassian/adfFromMarkdown.ts";
import {
  adfBodyPayload,
  confluenceDelete,
  confluenceGet,
  confluencePost,
  confluencePut,
  confluenceWebUrl,
  normalizeConfluencePage,
  parseAdfBody,
  resolveSpaceId,
  type AdfDocument,
  type ConfluenceConfig,
  type ConfluencePageResponse,
} from "./atlassian/confluenceClient.ts";
import {
  executeAttachmentChange,
  type AttachmentApplyDeps,
} from "./confluenceAttachmentChange.ts";
import {
  ConfluenceMutationError,
  confluenceWrite,
  signalOptions,
  signalTail,
  stopIfAborted,
} from "./confluenceMutationErrors.ts";

/** What apply needs besides the config and the approved items. */
export interface ConfluenceApplyDeps extends AttachmentApplyDeps {
  /** The text a failure becomes as an item error or a label warning. */
  describeError(err: unknown): string;
  /** Checked before each item: text stops that item and every later one, which get it as their error and send nothing. */
  stopBefore?(): string | undefined;
}

/**
 * Apply each approved item in order, recording per-item results on the items
 * themselves. Throws `ConfluenceMutationError` when no item succeeded.
 */
export async function applyConfluenceMutationItems(
  config: ConfluenceConfig,
  items: ConfluencePageMutationItemDisplay[],
  deps: ConfluenceApplyDeps,
): Promise<{ succeeded: number; resultSummary: string; resultUrl?: string }> {
  let succeeded = 0;
  for (const [index, item] of items.entries()) {
    stopIfAborted(deps.signal);
    const stop = deps.stopBefore?.();
    if (stop) {
      for (const rest of items.slice(index)) rest.error = stop;
      break;
    }
    try {
      await executeMutationItem(config, item, deps);
      delete item.error;
      succeeded += 1;
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      item.error = deps.describeError(err);
    }
  }
  if (succeeded === 0)
    throw new ConfluenceMutationError(
      `All ${items.length} Confluence change(s) failed: ${items
        .map((item) => item.error)
        .filter(Boolean)
        .join("; ")}`,
    );
  const failed = items.length - succeeded;
  const warned = items.filter((item) => item.warning).length;
  const diagnostics = [
    failed ? `${failed} failed` : "",
    warned ? `${warned} warning(s)` : "",
  ].filter(Boolean);
  const base = `Applied ${succeeded} Confluence change(s)`;
  const resultUrl = items.find((item) => item.resultPageUrl)?.resultPageUrl;
  return {
    succeeded,
    resultSummary: diagnostics.length
      ? `${base}; ${diagnostics.join("; ")}`
      : base,
    ...(resultUrl ? { resultUrl } : {}),
  };
}

async function executeMutationItem(
  config: ConfluenceConfig,
  item: ConfluencePageMutationItemDisplay,
  deps: ConfluenceApplyDeps,
): Promise<void> {
  if (
    item.operation === "uploadAttachment" ||
    item.operation === "deleteAttachment"
  )
    return executeAttachmentChange(config, item, deps);
  if (item.operation === "create") return executeCreate(config, item, deps);
  if (item.operation === "comment") return executeComment(config, item, deps);
  if (item.operation === "delete") return executeDelete(config, item, deps);
  return executeEdit(config, item, deps);
}

async function executeCreate(
  config: ConfluenceConfig,
  item: ConfluencePageMutationItemDisplay,
  deps: ConfluenceApplyDeps,
): Promise<void> {
  const { signal } = deps;
  const space = await resolveSpaceId(
    config,
    item.spaceKey ?? "",
    ...signalOptions(signal),
  );
  const created = await confluenceWrite(
    () =>
      confluencePost<ConfluencePageResponse>(
        config,
        "/wiki/api/v2/pages",
        {
          spaceId: space.id,
          status: "current",
          title: item.title ?? "",
          ...(item.parentId ? { parentId: item.parentId } : {}),
          body: adfBodyPayload(markdownToAdf(item.body ?? "")),
        },
        ...signalTail(signal),
      ),
    signal,
  );
  const page = normalizeConfluencePage(created, config.host);
  item.resultPageId = page.id;
  item.resultPageUrl = page.url;
  item.resultVersion = page.version;
  await applyLabels(config, page.id, item, deps);
}

async function executeComment(
  config: ConfluenceConfig,
  item: ConfluencePageMutationItemDisplay,
  deps: ConfluenceApplyDeps,
): Promise<void> {
  const { signal } = deps;
  const created = await confluenceWrite(
    () =>
      confluencePost<{
        id?: string;
        _links?: { webui?: string };
      }>(
        config,
        "/wiki/api/v2/footer-comments",
        {
          pageId: item.pageId,
          body: adfBodyPayload(markdownToAdf(item.body ?? "")),
        },
        ...signalTail(signal),
      ),
    signal,
  );
  item.resultPageId = item.pageId ?? null;
  item.resultPageUrl =
    confluenceWebUrl(config.host, created._links?.webui) ??
    item.pageUrl ??
    null;
}

/**
 * Re-read the page an approval targets and prove it is still the page that was
 * proposed. An approval can sit for minutes, so this runs for every write to
 * an existing page — including a delete, where there is no version precondition
 * to fall back on and nothing to undo afterwards.
 *
 * A missing `baseVersion` is a refusal, not a skipped check: an unverifiable
 * write to somebody's wiki page is exactly what the approval was meant to
 * prevent.
 */
async function readVerifiedPage(
  config: ConfluenceConfig,
  item: ConfluencePageMutationItemDisplay,
  signal: AbortSignal | undefined,
): Promise<{ page: ConfluencePageResponse; version: number }> {
  if (typeof item.baseVersion !== "number")
    throw new ConfluenceMutationError(
      `This proposal for page ${item.pageId} recorded no base version, so it cannot be applied safely. Re-read the page and propose the change again.`,
    );
  const page = await confluenceGet<ConfluencePageResponse>(
    config,
    `/wiki/api/v2/pages/${encodeURIComponent(item.pageId ?? "")}`,
    { "body-format": "atlas_doc_format" },
    ...signalOptions(signal),
  );
  const version = page.version?.number;
  if (typeof version !== "number")
    throw new ConfluenceMutationError(
      `Confluence did not report a version for page ${item.pageId}.`,
    );
  if (version !== item.baseVersion)
    throw new ConfluenceMutationError(
      `Page ${item.pageId} changed since this proposal was prepared (version ${item.baseVersion} → ${version}). Re-read it and propose the change again.`,
    );
  return { page, version };
}

/**
 * Delete an approved page. The version is verified first; Confluence's v2
 * DELETE takes no version precondition, so an edit landing between that check
 * and this call is a race the API cannot close — the check narrows the window
 * from the whole approval wait to a single round trip.
 */
async function executeDelete(
  config: ConfluenceConfig,
  item: ConfluencePageMutationItemDisplay,
  deps: ConfluenceApplyDeps,
): Promise<void> {
  const { signal } = deps;
  await readVerifiedPage(config, item, signal);
  await confluenceWrite(
    () =>
      confluenceDelete(
        config,
        `/wiki/api/v2/pages/${encodeURIComponent(item.pageId ?? "")}`,
        ...signalTail(signal),
      ),
    signal,
  );
  item.resultPageId = item.pageId ?? null;
  item.resultPageUrl = null;
}

/**
 * Apply an approved edit. Writing over a version that changed in between would
 * silently discard whoever edited the page meanwhile, and Confluence's own
 * version check would not catch it either, since we would be sending the newer
 * number.
 */
async function executeEdit(
  config: ConfluenceConfig,
  item: ConfluencePageMutationItemDisplay,
  deps: ConfluenceApplyDeps,
): Promise<void> {
  const { signal } = deps;
  const { page: current, version } = await readVerifiedPage(
    config,
    item,
    signal,
  );
  const title = item.newTitle?.trim() || current.title || "";
  if (item.body?.trim()) {
    const addition = markdownToAdf(item.body);
    let body = addition;
    if (item.placement !== "replace") {
      // Re-checked here and not only at staging: splicing into a body that
      // came back unreadable would write the addition ALONE, which is a
      // silent full-page wipe rather than the append that was approved.
      const currentAdf = parseAdfBody(current);
      if (!currentAdf)
        throw new ConfluenceMutationError(
          `Confluence returned no readable body for page ${item.pageId}, so the approved ${item.placement ?? "append"} cannot be spliced without losing the page. Re-read it and propose the change again.`,
        );
      body = spliceAdf(currentAdf, addition, item.placement ?? "append");
    }
    await confluenceWrite(
      () =>
        confluencePut(
          config,
          `/wiki/api/v2/pages/${encodeURIComponent(item.pageId ?? "")}`,
          {
            id: item.pageId,
            status: "current",
            title,
            body: adfBodyPayload(body),
            version: {
              number: version + 1,
              ...(item.versionMessage ? { message: item.versionMessage } : {}),
            },
          },
          ...signalTail(signal),
        ),
      signal,
    );
  } else if (item.newTitle?.trim()) {
    await confluenceWrite(
      () =>
        confluencePut(
          config,
          `/wiki/api/v2/pages/${encodeURIComponent(item.pageId ?? "")}/title`,
          {
            id: item.pageId,
            status: "current",
            title,
          },
          ...signalTail(signal),
        ),
      signal,
    );
  }
  item.resultPageId = item.pageId ?? null;
  item.resultPageUrl = item.pageUrl ?? null;
  item.resultVersion = item.body?.trim() ? version + 1 : version;
  await applyLabels(config, item.pageId ?? "", item, deps);
}

/**
 * Splice new content into the page's existing ADF rather than rebuilding the
 * page from Markdown. This is what keeps an append from deleting the macros
 * and layouts Markdown cannot express.
 */
export function spliceAdf(
  current: AdfDocument,
  addition: AdfNode,
  placement: ConfluenceBodyPlacement,
): AdfNode {
  // `current` is an AdfDocument, not a nullable node: a splice target that
  // defaulted its blocks to [] would turn an append into a full-page wipe, so
  // the type makes the caller resolve that BEFORE reaching here.
  const existing = current.content;
  const added = addition.content ?? [];
  return {
    version: 1,
    type: "doc",
    content:
      placement === "prepend"
        ? [...added, ...existing]
        : [...existing, ...added],
  };
}

/**
 * Labels are a v1-only write and are secondary to the page itself: a failed
 * label must not turn a successful page write into a failed item, so it lands
 * as a warning on the card.
 */
async function applyLabels(
  config: ConfluenceConfig,
  pageId: string,
  item: ConfluencePageMutationItemDisplay,
  deps: ConfluenceApplyDeps,
): Promise<void> {
  if (!pageId) return;
  const { signal } = deps;
  const failures: string[] = [];
  for (const name of item.labelsAdded ?? []) {
    try {
      await confluenceWrite(
        () =>
          confluencePost(
            config,
            `/wiki/rest/api/content/${encodeURIComponent(pageId)}/label`,
            [{ prefix: "global", name }],
            ...signalTail(signal),
          ),
        signal,
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      failures.push(`add ${name}: ${deps.describeError(err)}`);
    }
  }
  for (const name of item.labelsRemoved ?? []) {
    try {
      await confluenceWrite(
        () =>
          confluenceDelete(
            config,
            `/wiki/rest/api/content/${encodeURIComponent(pageId)}/label/${encodeURIComponent(name)}`,
            ...signalTail(signal),
          ),
        signal,
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      failures.push(`remove ${name}: ${deps.describeError(err)}`);
    }
  }
  if (failures.length > 0)
    item.warning = `label changes failed: ${failures.join("; ")}`;
}
