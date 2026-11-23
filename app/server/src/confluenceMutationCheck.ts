/**
 * The closed structural check of a `confluence_mutate_page` proposal
 * (Task-1463 P6a, P6-F2), as `jiraMutationCheck.ts` is for Jira: every key of
 * the item and of its attachment has a rule (`mutationCheckRules.ts`), pure
 * result fields (`confluenceMutationResult.ts`) are refused, and the
 * executor keeps its own guards. An `uploadAttachment` item passes here; the
 * edge's gate refuses it.
 *
 * Boundary-clean: only the shared types and the rule kit
 * (`workerBoundary.test.ts`).
 */
import type {
  ConfluenceAttachmentMutationDisplay,
  ConfluenceBodyPlacement,
  ConfluencePageMutationItemDisplay,
  ConfluencePageMutationOperation,
} from "@assistant/shared/confluenceMutation";
import {
  arrayOf,
  checkProposal,
  closed,
  count,
  nullable,
  oneOf,
  opt,
  req,
  result,
  str,
  strOrNull,
  type RuleTable,
} from "./mutationCheckRules.ts";

const operation = oneOf<ConfluencePageMutationOperation>()([
  "create",
  "edit",
  "comment",
  "delete",
  "uploadAttachment",
  "deleteAttachment",
]);
const placement = oneOf<ConfluenceBodyPlacement>()([
  "replace",
  "append",
  "prepend",
]);

export const CONFLUENCE_ATTACHMENT_RULES = {
  fileName: req(str),
  existingId: opt(str),
  baseVersion: opt(count),
  mediaType: opt(strOrNull),
  size: opt(nullable(count)),
  source: opt(str),
  stagedAttachmentId: opt(str),
  sha256: opt(str),
  resultId: result,
  resultVersion: result,
} satisfies RuleTable<ConfluenceAttachmentMutationDisplay>;

export const CONFLUENCE_ITEM_RULES = {
  clientId: req(str),
  operation: req(operation),
  pageId: opt(str),
  pageUrl: opt(strOrNull),
  title: opt(strOrNull),
  newTitle: opt(strOrNull),
  spaceKey: opt(strOrNull),
  spaceName: opt(strOrNull),
  parentId: opt(strOrNull),
  parentTitle: opt(strOrNull),
  body: opt(str),
  placement: opt(placement),
  currentBody: opt(str),
  baseVersion: opt(count),
  lossyNodes: opt(arrayOf(str)),
  labelsAdded: opt(arrayOf(str)),
  labelsRemoved: opt(arrayOf(str)),
  versionMessage: opt(str),
  attachment: opt(
    closed<ConfluenceAttachmentMutationDisplay>(CONFLUENCE_ATTACHMENT_RULES),
  ),
  resultPageId: result,
  resultPageUrl: result,
  resultVersion: result,
  warning: result,
  error: result,
} satisfies RuleTable<ConfluencePageMutationItemDisplay>;

const confluenceItem = closed<ConfluencePageMutationItemDisplay>(
  CONFLUENCE_ITEM_RULES,
);

/** Whether `value` is a `confluence_mutate_page` proposal (1 to 10 items). */
export function checkConfluencePageItems(
  value: unknown,
): value is ConfluencePageMutationItemDisplay[] {
  return checkProposal(value, confluenceItem);
}
