import { describe, expect, it } from "vitest";
import type { KnowledgeTreeNode } from "@assistant/shared/knowledgeBase";
import {
  buildKnowledgeTreeNodes,
  entryTreeNodeId,
  expandableKnowledgeTreeIds,
  knowledgeTreeOpenTarget,
  revealKnowledgeEntryExpansionIds,
  selectedKnowledgeTreeId,
  selectedKnowledgeTreeIdForPath,
} from "./knowledgeTree.ts";

const tree: KnowledgeTreeNode[] = [
  {
    path: "customers",
    name: "customers",
    type: "folder",
    children: [
      {
        path: "customers/globex",
        name: "globex",
        type: "entry",
        entryId: "globex-brief",
        title: "Globex brief",
        entryType: "brief",
        status: "active",
        children: [
          {
            path: "customers/globex/assets/logo.png",
            name: "logo.png",
            type: "asset",
            children: [],
          },
        ],
      },
      {
        path: "customers/broken",
        name: "broken",
        type: "invalid-entry",
        error: "Invalid frontmatter",
        children: [],
      },
    ],
  },
];

describe("knowledge tree helpers", () => {
  it("builds stable tree ids for entries and non-entry nodes", () => {
    const nodes = buildKnowledgeTreeNodes(tree);
    expect(nodes[0]?.id).toBe("folder:customers");
    expect(nodes[0]?.children?.[0]?.id).toBe(entryTreeNodeId("globex-brief"));
    expect(nodes[0]?.children?.[1]?.id).toBe("invalid-entry:customers/broken");
  });

  it("finds selected entry ids without selecting assets or invalid entries", () => {
    expect(selectedKnowledgeTreeId(tree, "globex-brief")).toBe(
      entryTreeNodeId("globex-brief"),
    );
    expect(selectedKnowledgeTreeId(tree, "missing")).toBeNull();
    expect(selectedKnowledgeTreeId(tree, null)).toBeNull();
  });

  it("computes expandable and reveal ids for routed selection state", () => {
    const nodes = buildKnowledgeTreeNodes(tree);
    expect(expandableKnowledgeTreeIds(nodes)).toEqual([
      "folder:customers",
      entryTreeNodeId("globex-brief"),
    ]);
    expect(revealKnowledgeEntryExpansionIds(nodes, "globex-brief")).toEqual([
      "folder:customers",
      entryTreeNodeId("globex-brief"),
    ]);
    expect(revealKnowledgeEntryExpansionIds(nodes, "missing")).toEqual([]);
  });

  it("highlights and opens invalid entries by folder path", () => {
    expect(selectedKnowledgeTreeIdForPath(tree, "customers/broken")).toBe(
      "invalid-entry:customers/broken",
    );
    expect(selectedKnowledgeTreeIdForPath(tree, "customers/globex")).toBe(
      entryTreeNodeId("globex-brief"),
    );
    expect(selectedKnowledgeTreeIdForPath(tree, null)).toBeNull();
  });

  it("resolves what a selected tree node opens", () => {
    expect(
      knowledgeTreeOpenTarget(tree, entryTreeNodeId("globex-brief")),
    ).toEqual({ entryId: "globex-brief" });
    expect(
      knowledgeTreeOpenTarget(tree, "invalid-entry:customers/broken"),
    ).toEqual({ path: "customers/broken" });
    // Assets open as previewable files by their tree path.
    expect(
      knowledgeTreeOpenTarget(tree, "asset:customers/globex/assets/logo.png"),
    ).toEqual({ filePath: "customers/globex/assets/logo.png" });
    // Folders are not openable targets.
    expect(knowledgeTreeOpenTarget(tree, "folder:customers")).toBeNull();
  });
});
