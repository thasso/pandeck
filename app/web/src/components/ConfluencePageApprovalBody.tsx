/**
 * @widget ConfluencePageApprovalBody
 * @purpose The Confluence detail of `ApprovalCard`: the pages a
 *   `confluence_mutate_page` proposal creates, edits, comments on or deletes,
 *   and the attachments it uploads or deletes.
 *   The Markdown body renders as Confluence will show it (the server converts
 *   the same source to ADF on execution), and a `replace` that would destroy
 *   macros, layouts or images says so before the user approves it.
 * @payload `ConfluencePageApprovalBody` (`ApprovalCard.body`).
 * @useWhen Rendered by `ApprovalCard` for `body.kind === "confluencePage"`.
 */
import { AlertTriangle, ExternalLink, Paperclip } from "lucide-react";
import type {
  ConfluencePageApprovalBody as ConfluencePageApprovalBodyData,
  ConfluencePageMutationItemDisplay,
} from "@assistant/shared";
import { formatFileSize } from "../lib/servedFiles.ts";
import { ClippedMarkdown } from "./JiraIssueApprovalBody.tsx";

type Item = ConfluencePageMutationItemDisplay;

export function ConfluencePageApprovalBody({
  body,
}: {
  body: ConfluencePageApprovalBodyData;
}) {
  return (
    <ul className="space-y-3">
      {body.items.map((item, i) => (
        <li key={item.clientId || i} className="space-y-1.5 text-caption">
          <Header item={item} />
          <LossWarning item={item} />
          <Attachment item={item} />
          {item.body ? <ClippedMarkdown text={item.body} /> : null}
          <Labels item={item} />
          <Outcome item={item} />
        </li>
      ))}
    </ul>
  );
}

/** What the write does, named the way the page will read afterwards. */
function actionLabel(item: Item): string {
  if (item.operation === "create") return "Create";
  if (item.operation === "comment") return "Comment on";
  if (item.operation === "delete") return "Delete";
  if (item.operation === "uploadAttachment")
    return item.attachment?.existingId
      ? "New attachment version on"
      : "Attach to";
  if (item.operation === "deleteAttachment") return "Delete attachment from";
  if (item.placement === "replace") return "Replace body of";
  if (item.placement === "prepend") return "Prepend to";
  if (item.placement === "append") return "Append to";
  return "Edit";
}

function Header({ item }: { item: Item }) {
  const title = item.newTitle || item.title || item.pageId || "page";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 text-micro text-accent">
        {actionLabel(item)}
      </span>
      {item.pageUrl ? (
        <a
          href={item.pageUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="min-w-0 break-words font-medium text-fg hover:underline"
        >
          {title}
        </a>
      ) : (
        <span className="min-w-0 break-words font-medium text-fg">{title}</span>
      )}
      {item.spaceKey ? (
        <span className="text-faint">
          in {item.spaceName || item.spaceKey}
          {item.parentTitle ? ` · under ${item.parentTitle}` : ""}
        </span>
      ) : null}
      {item.newTitle && item.title && item.newTitle !== item.title ? (
        <span className="text-faint">renamed from {item.title}</span>
      ) : null}
    </div>
  );
}

/**
 * The one thing the user cannot see from the Markdown alone: a full-body
 * rewrite cannot carry macros, layouts or images back, so it silently removes
 * them. A delete gets the same treatment for the same reason.
 */
function LossWarning({ item }: { item: Item }) {
  if (item.operation === "delete")
    return (
      <div className="flex items-start gap-1.5 text-caption text-yellow-600 dark:text-yellow-400">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <span>The page and its comments move to the trash.</span>
      </div>
    );
  if (item.operation === "deleteAttachment")
    return (
      <div className="flex items-start gap-1.5 text-caption text-yellow-600 dark:text-yellow-400">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <span>
          The attachment moves to the trash; wherever the page embeds it shows
          it as missing.
        </span>
      </div>
    );
  if (item.placement !== "replace" || !item.lossyNodes?.length) return null;
  return (
    <div className="flex items-start gap-1.5 text-caption text-yellow-600 dark:text-yellow-400">
      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      <span>
        Replacing the body drops content Markdown cannot carry back:{" "}
        {item.lossyNodes.join(", ")}.
      </span>
    </div>
  );
}

/** The file an attachment item writes or removes, and where its bytes came from. */
function Attachment({ item }: { item: Item }) {
  const attachment = item.attachment;
  if (!attachment) return null;
  const facts = [
    typeof attachment.size === "number"
      ? formatFileSize(attachment.size)
      : null,
    attachment.mediaType,
    item.operation === "uploadAttachment"
      ? attachment.existingId
        ? `replaces v${attachment.baseVersion ?? "?"}`
        : "new file"
      : null,
  ].filter(Boolean);
  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Paperclip size={12} className="shrink-0 text-muted" />
        <span className="min-w-0 break-all font-mono text-fg">
          {attachment.fileName}
        </span>
        {facts.length ? (
          <span className="text-faint">{facts.join(" · ")}</span>
        ) : null}
      </div>
      {attachment.source ? (
        <div className="break-all text-faint">from {attachment.source}</div>
      ) : null}
      {item.versionMessage ? (
        <div className="text-muted">“{item.versionMessage}”</div>
      ) : null}
    </div>
  );
}

function Labels({ item }: { item: Item }) {
  if (!item.labelsAdded?.length && !item.labelsRemoved?.length) return null;
  return (
    <div className="text-caption text-muted">
      {item.labelsAdded?.length ? `+${item.labelsAdded.join(" +")}` : ""}
      {item.labelsAdded?.length && item.labelsRemoved?.length ? " · " : ""}
      {item.labelsRemoved?.length ? `-${item.labelsRemoved.join(" -")}` : ""}
    </div>
  );
}

function outcomeLabel(item: Item): string {
  if (item.operation === "create") return "created";
  if (item.operation === "comment") return "commented";
  if (item.operation === "delete") return "deleted";
  if (item.operation === "deleteAttachment") return "attachment deleted";
  if (item.operation === "uploadAttachment")
    return item.attachment?.resultVersion
      ? `uploaded as v${item.attachment.resultVersion}`
      : "uploaded";
  return item.resultVersion ? `updated to v${item.resultVersion}` : "updated";
}

function Outcome({ item }: { item: Item }) {
  if (!item.error && !item.resultPageId && !item.warning) return null;
  return (
    <div className="space-y-0.5">
      {item.error ? (
        <div className="text-caption text-danger">{item.error}</div>
      ) : item.resultPageUrl ? (
        <a
          href={item.resultPageUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-caption text-green-600 hover:underline dark:text-green-400"
        >
          <ExternalLink size={11} />
          {outcomeLabel(item)}
        </a>
      ) : item.resultPageId ? (
        <div className="text-caption text-green-600 dark:text-green-400">
          {outcomeLabel(item)}
        </div>
      ) : null}
      {item.warning ? (
        <div className="text-caption text-yellow-600 dark:text-yellow-400">
          {item.warning}
        </div>
      ) : null}
    </div>
  );
}
