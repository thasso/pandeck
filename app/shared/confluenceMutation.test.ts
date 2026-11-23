import { expectTypeOf, test } from "vitest";
import type * as Leaf from "./confluenceMutation.ts";
import type * as Protocol from "./protocol.ts";

// The leaf holds the declarations; the wire model re-exports them unchanged,
// so the web and every existing `@assistant/shared` import keep compiling.
test("the Confluence mutation display types are the same from the leaf and the wire model", () => {
  expectTypeOf<Leaf.ConfluencePageMutationItemDisplay>().toEqualTypeOf<Protocol.ConfluencePageMutationItemDisplay>();
  expectTypeOf<Leaf.ConfluenceAttachmentMutationDisplay>().toEqualTypeOf<Protocol.ConfluenceAttachmentMutationDisplay>();
  expectTypeOf<Leaf.ConfluencePageMutationOperation>().toEqualTypeOf<Protocol.ConfluencePageMutationOperation>();
  expectTypeOf<Leaf.ConfluenceBodyPlacement>().toEqualTypeOf<Protocol.ConfluenceBodyPlacement>();

  // And assignable both ways, as the approval body uses it.
  const fromLeaf = {
    clientId: "cfl_0",
    operation: "deleteAttachment",
    pageId: "123",
    attachment: { fileName: "diagram.png", existingId: "att1", baseVersion: 2 },
  } satisfies Leaf.ConfluencePageMutationItemDisplay;
  const body: Protocol.ConfluencePageApprovalBody = {
    kind: "confluencePage",
    items: [fromLeaf satisfies Protocol.ConfluencePageMutationItemDisplay],
  };
  body.items[0]! satisfies Leaf.ConfluencePageMutationItemDisplay;
});
