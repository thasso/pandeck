/**
 * The proposal-side text of a Confluence write card: its title, its summary
 * and the tool text that points the agent at it. The local
 * `confluence_mutate_page` uses it today, and the client-mode gateway write
 * tool will use it so both raise the same card (Task-1463 P6b). A leaf: shared
 * types and the card reference only, never the tool modules or the catalog.
 * `confluenceMutationOracle.test.ts` pins every string byte for byte.
 */
import type {
  ApprovalCard,
  ConfluencePageMutationItemDisplay,
} from "@assistant/shared";
import { approvalCardReference } from "../../pendingApprovals.ts";

/** The tool's label and search hint, local and on the gateway. */
export const CONFLUENCE_MUTATE_PAGE_LABEL = "Confluence: Prepare Page Changes";
export const CONFLUENCE_MUTATE_PAGE_SEARCH_HINT =
  "confluence create page edit page write comment delete label wiki upload attachment file";

function itemLabel(item: ConfluencePageMutationItemDisplay): string {
  const fileName = item.attachment?.fileName ?? "?";
  if (item.operation === "uploadAttachment")
    return `upload ${fileName} to ${item.title ?? item.pageId}`;
  if (item.operation === "deleteAttachment")
    return `delete ${fileName} from ${item.title ?? item.pageId}`;
  if (item.operation === "create")
    return `create ${item.spaceKey ?? "?"}/${item.title ?? "?"}`;
  if (item.operation === "comment")
    return `comment ${item.title ?? item.pageId}`;
  if (item.operation === "delete") return `delete ${item.title ?? item.pageId}`;
  return `${item.placement ?? "append"} ${item.title ?? item.pageId}`;
}

/** Approval-card title reflecting the mix of operations. */
export function confluenceMutationTitle(
  items: ConfluencePageMutationItemDisplay[],
): string {
  if (items.length === 1) {
    const item = items[0] as ConfluencePageMutationItemDisplay;
    if (item.operation === "create")
      return `Create page ${item.title ?? ""}`.trim();
    if (item.operation === "comment")
      return `Comment on ${item.title ?? "page"}`;
    if (item.operation === "delete") return `Delete ${item.title ?? "page"}`;
    if (item.operation === "uploadAttachment")
      return `Upload ${item.attachment?.fileName ?? "attachment"}`;
    if (item.operation === "deleteAttachment")
      return `Delete attachment ${item.attachment?.fileName ?? ""}`.trim();
    return `Edit ${item.title ?? "page"}`;
  }
  const kinds = new Set(items.map((item) => item.operation));
  if (kinds.size === 1) {
    const only = [...kinds][0];
    if (only === "create") return `Create ${items.length} Confluence pages`;
    if (only === "comment")
      return `Comment on ${items.length} Confluence pages`;
    if (only === "delete") return `Delete ${items.length} Confluence pages`;
    if (only === "uploadAttachment")
      return `Upload ${items.length} Confluence attachments`;
    if (only === "deleteAttachment")
      return `Delete ${items.length} Confluence attachments`;
  }
  return `${items.length} Confluence changes`;
}

/** The card summary: each item's label, then the warning count; "" when neither. */
export function confluenceProposalSummary(
  items: ConfluencePageMutationItemDisplay[],
  warnings: readonly string[],
): string {
  return [
    items.map(itemLabel).join(", "),
    warnings.length ? `${warnings.length} warning(s)` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The tool text for a proposed card: the count, the warnings and the card link. */
export function confluenceProposalText(
  items: ConfluencePageMutationItemDisplay[],
  warnings: readonly string[],
  card: ApprovalCard,
): string {
  const warnLine = warnings.length ? ` Warnings: ${warnings.join("; ")}.` : "";
  return `Prepared a Confluence proposal for ${items.length} page(s) pending your approval.${warnLine} Do not claim Confluence changed until the approved result appears. ${approvalCardReference(card)}`;
}
