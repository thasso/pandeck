/**
 * The closed `jira_mutate_issue` proposal check (Task-1463 P6a, P6-F2). Real
 * prepare output passes it in `jiraMutationResult.test.ts`; here a full hand
 * item passes, and each level refuses a stray key, a result field, a wrong
 * type or a wrong member. Every value is fake.
 */
import { describe, expect, test } from "vitest";
import type { JiraIssueMutationItemDisplay } from "@assistant/shared/jiraMutation";
import {
  JIRA_FIELD_CHANGE_RULES,
  JIRA_ITEM_RULES,
  JIRA_LINK_CHANGE_RULES,
  JIRA_RANK_STEP_RULES,
  JIRA_SPRINT_RULES,
  checkJiraIssueItems,
} from "./jiraMutationCheck.ts";
import { JIRA_RESULT_FIELDS } from "./jiraMutationResult.ts";
import { result, type Rule } from "./mutationCheckRules.ts";

/** An item using every input field of every nested type. */
function full(): JiraIssueMutationItemDisplay {
  return {
    clientId: "item-1",
    issueKey: "STAR-1",
    operation: "edit",
    issueId: "10001",
    issueUrl: "https://acme.atlassian.net/browse/STAR-1",
    issueSummary: "Subject",
    currentStatus: "Open",
    targetTransitionId: "31",
    targetTransitionName: "Done",
    targetStatus: "Done",
    fieldChanges: [
      {
        fieldId: "customfield_1",
        label: "One",
        from: null,
        to: "a",
        operation: "set",
        value: { nested: [1, "a", null, { deep: true }] },
      },
    ],
    linkChanges: [
      {
        op: "add",
        type: "Blocks",
        direction: "outward",
        relationship: "blocks",
        targetIssueKey: "STAR-2",
        targetIssueUrl: null,
        linkId: null,
      },
    ],
    createProjectKey: "STAR",
    createIssueType: "Task",
    createSummary: "New",
    createDescription: "Body",
    createParentIssue: "STAR-9",
    commentBody: "Hi",
    rankIssueKeys: ["STAR-2"],
    rankPosition: "before",
    rankTargetIssueKey: "STAR-1",
    rankScope: { kind: "board", boardId: 7, epics: false },
    rankSteps: [
      { issueKey: "STAR-2", placement: "before", relativeToIssueKey: "STAR-1" },
    ],
    sprint: {
      sprintId: 5,
      name: "Sprint 5",
      state: "future",
      boardId: null,
      changes: [{ field: "goal", from: null, to: "Ship" }],
    },
  };
}

const passes = (item: unknown) => checkJiraIssueItems([item]);

/** `full()` with `change` applied to it. */
function changed(
  change: (
    item: Record<string, unknown> & JiraIssueMutationItemDisplay,
  ) => void,
): unknown {
  const item = full() as Record<string, unknown> & JiraIssueMutationItemDisplay;
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
  expect(passes({ clientId: "a", issueKey: "STAR-1", fieldChanges: [] })).toBe(
    true,
  );
});

test("the tables' result rules are exactly the contract's result fields", () => {
  expect(resultKeys(JIRA_ITEM_RULES)).toEqual(
    [...JIRA_RESULT_FIELDS.item].sort(),
  );
  expect(resultKeys(JIRA_LINK_CHANGE_RULES)).toEqual(
    [...JIRA_RESULT_FIELDS.linkChanges].sort(),
  );
  expect(resultKeys(JIRA_RANK_STEP_RULES)).toEqual(
    [...JIRA_RESULT_FIELDS.rankSteps].sort(),
  );
  expect(resultKeys(JIRA_SPRINT_RULES)).toEqual(
    [...JIRA_RESULT_FIELDS.sprint].sort(),
  );
  expect(resultKeys(JIRA_FIELD_CHANGE_RULES)).toEqual([]);
});

describe("refuses", () => {
  test.each<
    [
      string,
      (item: Record<string, unknown> & JiraIssueMutationItemDisplay) => void,
    ]
  >([
    ["a stray item key", (item) => (item.extra = 1)],
    [
      "a stray field change key",
      (item) => Object.assign(item.fieldChanges[0]!, { x: 1 }),
    ],
    [
      "a stray link change key",
      (item) => Object.assign(item.linkChanges![0]!, { x: 1 }),
    ],
    [
      "a stray rank step key",
      (item) => Object.assign(item.rankSteps![0]!, { x: 1 }),
    ],
    [
      "a stray board scope key",
      (item) => Object.assign(item.rankScope!, { x: 1 }),
    ],
    [
      "a stray parent scope key",
      (item) =>
        (item.rankScope = {
          kind: "parent",
          parentIssueKey: "STAR-9",
          boardId: 7,
        } as never),
    ],
    ["a stray sprint key", (item) => Object.assign(item.sprint!, { x: 1 })],
    [
      "a stray sprint change key",
      (item) => Object.assign(item.sprint!.changes[0]!, { x: 1 }),
    ],
    ...JIRA_RESULT_FIELDS.item.map(
      (key): [string, (item: Record<string, unknown>) => void] => [
        `the item result field ${key}`,
        (item) => (item[key] = key === "rankResultOrder" ? [] : null),
      ],
    ),
    ...JIRA_RESULT_FIELDS.linkChanges.map(
      (key): [string, (item: JiraIssueMutationItemDisplay) => void] => [
        `the link result field ${key}`,
        (item) => Object.assign(item.linkChanges![0]!, { [key]: true }),
      ],
    ),
    ...JIRA_RESULT_FIELDS.rankSteps.map(
      (key): [string, (item: JiraIssueMutationItemDisplay) => void] => [
        `the rank step result field ${key}`,
        (item) => Object.assign(item.rankSteps![0]!, { [key]: "x" }),
      ],
    ),
    [
      "a sprint result",
      (item) =>
        (item.sprint!.result = { name: "S", startDate: null, endDate: null }),
    ],
    [
      "a missing clientId",
      (item) => delete (item as Partial<typeof item>).clientId,
    ],
    [
      "a missing fieldChanges",
      (item) => delete (item as Partial<typeof item>).fieldChanges,
    ],
    ["a null issueKey", (item) => (item.issueKey = null as never)],
    ["an unknown operation", (item) => (item.operation = "delete" as never)],
    [
      "an unknown rank position",
      (item) => (item.rankPosition = "middle" as never),
    ],
    [
      "an unknown link direction",
      (item) => (item.linkChanges![0]!.direction = "up" as never),
    ],
    [
      "an unknown scope kind",
      (item) => (item.rankScope = { kind: "sprint" } as never),
    ],
    [
      "a board scope without epics",
      (item) => (item.rankScope = { kind: "board", boardId: 7 } as never),
    ],
    [
      "a negative board id",
      (item) => (item.rankScope = { kind: "board", boardId: -1, epics: false }),
    ],
    ["a fractional sprint id", (item) => (item.sprint!.sprintId = 1.5)],
    [
      "an unknown sprint field",
      (item) => (item.sprint!.changes[0]!.field = "state" as never),
    ],
    ["a non-string rank key", (item) => (item.rankIssueKeys = [1 as never])],
    [
      "an opaque value with __proto__",
      (item) =>
        (item.fieldChanges[0]!.value = JSON.parse('{"a":{"__proto__":1}}')),
    ],
    [
      "an opaque value that is not JSON",
      (item) => (item.fieldChanges[0]!.value = new Date(0)),
    ],
    ["a create with a key", (item) => (item.operation = "create")],
  ])("%s", (_name, change) => {
    expect(passes(changed(change))).toBe(false);
  });
});

test("a create carries exactly the empty key", () => {
  expect(
    passes(
      changed((item) => {
        item.operation = "create";
        item.issueKey = "";
      }),
    ),
  ).toBe(true);
});
