/**
 * The proposal validators' exhaustiveness is the compiler's job (Task-1463
 * P6a, P6-F2): these cases must fail typecheck. Each refused declaration
 * differs from its valid twin in exactly the one place under test, so the
 * `@ts-expect-error` above it can only be spent on that error; a case that
 * compiled would leave its directive unused, which fails typecheck. The
 * runtime checks below only prove the valid twins are real values.
 */
import { expect, test } from "vitest";
import type { ConfluencePageMutationItemDisplay } from "@assistant/shared/confluenceMutation";
import type {
  JiraIssueMutationItemDisplay,
  JiraIssueRankScopeDisplay,
  JiraSprintField,
} from "@assistant/shared/jiraMutation";
import { CONFLUENCE_ITEM_RULES } from "./confluenceMutationCheck.ts";
import { JIRA_ITEM_RULES } from "./jiraMutationCheck.ts";
import {
  bool,
  count,
  literal,
  oneOf,
  opt,
  req,
  str,
  strOrNull,
  variants,
  type RuleTable,
} from "./mutationCheckRules.ts";

// 1. The Jira item type widened by one key: the real table lacks its rule.
type WidenedJiraItem = JiraIssueMutationItemDisplay & { reviewer?: string };
// @ts-expect-error -- the widened key has no rule
const refusedWidenedJira = JIRA_ITEM_RULES satisfies RuleTable<WidenedJiraItem>;
const validWidenedJira = {
  ...JIRA_ITEM_RULES,
  reviewer: opt(str),
} satisfies RuleTable<WidenedJiraItem>;

// 2. The same for the Confluence item type.
type WidenedConfluenceItem = ConfluencePageMutationItemDisplay & {
  reviewer?: string;
};
const refusedWidenedConfluence =
  // @ts-expect-error -- the widened key has no rule
  CONFLUENCE_ITEM_RULES satisfies RuleTable<WidenedConfluenceItem>;
const validWidenedConfluence = {
  ...CONFLUENCE_ITEM_RULES,
  reviewer: opt(str),
} satisfies RuleTable<WidenedConfluenceItem>;

// 3. A variant table missing one of its variant's keys.
const refusedVariant = variants<JiraIssueRankScopeDisplay, "kind">("kind", {
  // @ts-expect-error -- the board variant's `epics` has no rule
  board: { kind: req(literal("board")), boardId: req(count) },
  parent: { kind: req(literal("parent")), parentIssueKey: req(str) },
});
const validVariant = variants<JiraIssueRankScopeDisplay, "kind">("kind", {
  board: { kind: req(literal("board")), boardId: req(count), epics: req(bool) },
  parent: { kind: req(literal("parent")), parentIssueKey: req(str) },
});

// 4. A literal list missing one of its union's members.
// @ts-expect-error -- `goal` is missing from the list
const refusedLiterals = oneOf<JiraSprintField>()([
  "name",
  "startDate",
  "endDate",
]);
const validLiterals = oneOf<JiraSprintField>()([
  "name",
  "startDate",
  "endDate",
  "goal",
]);

// 5. An optional rule for a required key.
const refusedOptional = {
  ...JIRA_ITEM_RULES,
  // @ts-expect-error -- `clientId` is required
  clientId: opt(str),
} satisfies RuleTable<JiraIssueMutationItemDisplay>;
const validRequired = {
  ...JIRA_ITEM_RULES,
  clientId: req(str),
} satisfies RuleTable<JiraIssueMutationItemDisplay>;

// 6. A check wider than the field's type (`issueKey` is never null).
const refusedWider = {
  ...JIRA_ITEM_RULES,
  // @ts-expect-error -- `issueKey` is never null
  issueKey: req(strOrNull),
} satisfies RuleTable<JiraIssueMutationItemDisplay>;
const validExact = {
  ...JIRA_ITEM_RULES,
  issueKey: req(str),
} satisfies RuleTable<JiraIssueMutationItemDisplay>;

test("the valid twins are the tables and checks they claim to be", () => {
  expect(Object.keys(validWidenedJira)).toContain("reviewer");
  expect(Object.keys(validWidenedConfluence)).toContain("reviewer");
  expect(validVariant({ kind: "board", boardId: 1, epics: false }, 0)).toBe(
    true,
  );
  expect(validLiterals("goal", 0)).toBe(true);
  expect(validRequired.clientId.optional).toBe(false);
  expect(validExact.issueKey.check("NEB-1", 0)).toBe(true);
  // The refused declarations still exist at runtime; only their types fail.
  for (const refused of [
    refusedWidenedJira,
    refusedWidenedConfluence,
    refusedVariant,
    refusedLiterals,
    refusedOptional,
    refusedWider,
  ])
    expect(refused).toBeDefined();
});
