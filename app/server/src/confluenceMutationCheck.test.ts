/**
 * The closed `confluence_mutate_page` proposal check (Task-1463 P6a, P6-F2).
 * Real prepare output passes it in `confluenceMutationResult.test.ts`; here
 * a full hand item passes, and each level refuses a stray key, a result
 * field, a wrong type or a wrong member. Every value is fake.
 */
import { expect, test } from "vitest";
import type { ConfluencePageMutationItemDisplay } from "@assistant/shared/confluenceMutation";
import {
  CONFLUENCE_ATTACHMENT_RULES,
  CONFLUENCE_ITEM_RULES,
  checkConfluencePageItems,
} from "./confluenceMutationCheck.ts";
import { CONFLUENCE_RESULT_FIELDS } from "./confluenceMutationResult.ts";
import { result, type Rule } from "./mutationCheckRules.ts";

/** An item using every input field. */
function full(): ConfluencePageMutationItemDisplay {
  return {
    clientId: "cfl_0",
    operation: "uploadAttachment",
    pageId: "123",
    pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
    title: "Page 123",
    newTitle: null,
    spaceKey: "ENG",
    spaceName: "Engineering",
    parentId: null,
    parentTitle: null,
    body: "Body",
    placement: "append",
    currentBody: "Old",
    baseVersion: 7,
    lossyNodes: ["toc"],
    labelsAdded: ["a"],
    labelsRemoved: [],
    versionMessage: "Why",
    attachment: {
      fileName: "diagram.png",
      existingId: "att1",
      baseVersion: 2,
      mediaType: null,
      size: null,
      source: "/tmp/diagram.png",
      stagedAttachmentId: "staged-1",
      sha256: "a".repeat(64),
    },
  };
}

type Item = Record<string, unknown> & ConfluencePageMutationItemDisplay;

const passes = (item: unknown) => checkConfluencePageItems([item]);

function changed(change: (item: Item) => void): unknown {
  const item = full() as Item;
  change(item);
  return item;
}

const resultKeys = (table: Record<string, Rule<unknown, boolean>>) =>
  Object.entries(table)
    .filter(([, rule]) => rule === result)
    .map(([key]) => key)
    .sort();

test("a full item and a minimal one pass", () => {
  expect(passes(full())).toBe(true);
  expect(passes({ clientId: "a", operation: "delete" })).toBe(true);
});

test("the tables' result rules are exactly the contract's result fields", () => {
  expect(resultKeys(CONFLUENCE_ITEM_RULES)).toEqual(
    [...CONFLUENCE_RESULT_FIELDS.item].sort(),
  );
  expect(resultKeys(CONFLUENCE_ATTACHMENT_RULES)).toEqual(
    [...CONFLUENCE_RESULT_FIELDS.attachment].sort(),
  );
});

test.each<[string, (item: Item) => void]>([
  ["a stray item key", (item) => (item.extra = 1)],
  [
    "a stray attachment key",
    (item) => Object.assign(item.attachment!, { x: 1 }),
  ],
  ...CONFLUENCE_RESULT_FIELDS.item.map(
    (key): [string, (item: Item) => void] => [
      `the item result field ${key}`,
      (item) => Object.assign(item, { [key]: null }),
    ],
  ),
  ...CONFLUENCE_RESULT_FIELDS.attachment.map(
    (key): [string, (item: Item) => void] => [
      `the attachment result field ${key}`,
      (item) => Object.assign(item.attachment!, { [key]: null }),
    ],
  ),
  ["a missing operation", (item) => delete (item as Partial<Item>).operation],
  [
    "a missing file name",
    (item) =>
      delete (item.attachment as Partial<NonNullable<Item["attachment"]>>)
        .fileName,
  ],
  ["an unknown operation", (item) => (item.operation = "move" as never)],
  ["an unknown placement", (item) => (item.placement = "middle" as never)],
  ["a null page id", (item) => (item.pageId = null as never)],
  ["a negative base version", (item) => (item.baseVersion = -1)],
  ["a fractional size", (item) => (item.attachment!.size = 1.5)],
  ["a non-string label", (item) => (item.labelsAdded = [1 as never])],
])("refuses %s", (_name, change) => {
  expect(passes(changed(change))).toBe(false);
});
