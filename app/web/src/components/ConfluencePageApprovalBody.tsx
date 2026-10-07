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
import { AlertTriangle, Paperclip } from "lucide-react";
import type {
  ConfluencePageApprovalBody as ConfluencePageApprovalBodyData,
  ConfluencePageMutationItemDisplay,
} from "@assistant/shared";
import { formatFileSize } from "../lib/servedFiles.ts";
import { ClippedMarkdown, MutationOutcome } from "./JiraIssueApprovalBody.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

type Item = ConfluencePageMutationItemDisplay;

export function ConfluencePageApprovalBody({
  body,
}: {
  body: ConfluencePageApprovalBodyData;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {body.items.map((item, i) => (
        <li key={item.clientId || i} className="flex flex-col gap-1.5">
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
      <Badge variant="secondary">{actionLabel(item)}</Badge>
      {item.pageUrl ? (
        <a
          href={item.pageUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="min-w-0 break-words font-medium text-foreground hover:underline"
        >
          {title}
        </a>
      ) : (
        <span className="min-w-0 break-words font-medium text-foreground">
          {title}
        </span>
      )}
      {item.spaceKey ? (
        <span className="text-muted-foreground">
          in {item.spaceName || item.spaceKey}
          {item.parentTitle ? ` · under ${item.parentTitle}` : ""}
        </span>
      ) : null}
      {item.newTitle && item.title && item.newTitle !== item.title ? (
        <span className="text-muted-foreground">renamed from {item.title}</span>
      ) : null}
    </div>
  );
}

/**
 * The one thing the user cannot see from the Markdown alone: a full-body
 * rewrite cannot carry macros, layouts or images back, so it silently removes
 * them. A delete gets the same treatment for the same reason.
 */
function lossWarning(item: Item): string | null {
  if (item.operation === "delete")
    return "The page and its comments move to the trash.";
  if (item.operation === "deleteAttachment")
    return "The attachment moves to the trash; wherever the page embeds it shows it as missing.";
  if (item.placement !== "replace" || !item.lossyNodes?.length) return null;
  return `Replacing the body drops content Markdown cannot carry back: ${item.lossyNodes.join(", ")}.`;
}

function LossWarning({ item }: { item: Item }) {
  const warning = lossWarning(item);
  if (!warning) return null;
  return (
    <Alert variant="warning" role="note">
      <AlertTriangle />
      <AlertDescription>{warning}</AlertDescription>
    </Alert>
  );
}

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
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Paperclip className="size-3 shrink-0" />
        <span className="min-w-0 break-all font-mono text-foreground">
          {attachment.fileName}
        </span>
        {facts.length ? (
          <span className="text-muted-foreground">{facts.join(" · ")}</span>
        ) : null}
      </div>
      {attachment.source ? (
        <div className="break-all text-muted-foreground">
          from {attachment.source}
        </div>
      ) : null}
      {item.versionMessage ? (
        <div className="text-muted-foreground">“{item.versionMessage}”</div>
      ) : null}
    </div>
  );
}

function Labels({ item }: { item: Item }) {
  if (!item.labelsAdded?.length && !item.labelsRemoved?.length) return null;
  return (
    <div>
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
  return (
    <MutationOutcome
      error={item.error}
      warning={item.warning}
      url={item.resultPageUrl}
      done={Boolean(item.resultPageId)}
      label={outcomeLabel(item)}
    />
  );
}
