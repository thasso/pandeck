import { expectTypeOf, test } from "vitest";
import type * as Leaf from "./jiraMutation.ts";
import type * as Protocol from "./protocol.ts";

// The leaf holds the declarations; the wire model re-exports them unchanged,
// so the web and every existing `@assistant/shared` import keep compiling.
test("the Jira mutation display types are the same from the leaf and the wire model", () => {
  expectTypeOf<Leaf.JiraIssueMutationItemDisplay>().toEqualTypeOf<Protocol.JiraIssueMutationItemDisplay>();
  expectTypeOf<Leaf.JiraIssueMutationFieldChangeDisplay>().toEqualTypeOf<Protocol.JiraIssueMutationFieldChangeDisplay>();
  expectTypeOf<Leaf.JiraIssueLinkChangeDisplay>().toEqualTypeOf<Protocol.JiraIssueLinkChangeDisplay>();
  expectTypeOf<Leaf.JiraIssueMutationOperation>().toEqualTypeOf<Protocol.JiraIssueMutationOperation>();
  expectTypeOf<Leaf.JiraSprintField>().toEqualTypeOf<Protocol.JiraSprintField>();
  expectTypeOf<Leaf.JiraSprintChangeDisplay>().toEqualTypeOf<Protocol.JiraSprintChangeDisplay>();
  expectTypeOf<Leaf.JiraSprintUpdateDisplay>().toEqualTypeOf<Protocol.JiraSprintUpdateDisplay>();
  expectTypeOf<Leaf.JiraIssueRankPosition>().toEqualTypeOf<Protocol.JiraIssueRankPosition>();
  expectTypeOf<Leaf.JiraIssueRankScopeDisplay>().toEqualTypeOf<Protocol.JiraIssueRankScopeDisplay>();
  expectTypeOf<Leaf.JiraIssueRankStepDisplay>().toEqualTypeOf<Protocol.JiraIssueRankStepDisplay>();

  // And assignable both ways, as the approval body uses it.
  const fromLeaf = {
    clientId: "item-1",
    issueKey: "NEB-1",
    fieldChanges: [],
  } satisfies Leaf.JiraIssueMutationItemDisplay;
  const body: Protocol.JiraIssueApprovalBody = {
    kind: "jiraIssue",
    items: [fromLeaf satisfies Protocol.JiraIssueMutationItemDisplay],
  };
  body.items[0]! satisfies Leaf.JiraIssueMutationItemDisplay;
});
