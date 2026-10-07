import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Tree, type TreeNode } from "../../../src/components/common/Tree.tsx";
type Entry = { title: string; kind: string };
const items: TreeNode<Entry>[] = [
  {
    id: "p",
    data: { title: "Pandeck", kind: "project" },
    children: [
      {
        id: "tasks",
        data: { title: "Tasks", kind: "folder" },
        children: [
          {
            id: "task-361",
            data: { title: "Storybook common components", kind: "task" },
          },
          {
            id: "task-383",
            data: { title: "Unify loading states", kind: "task" },
          },
        ],
      },
      {
        id: "docs",
        data: { title: "Documentation", kind: "folder" },
        children: [
          { id: "ui", data: { title: "ui-components.md", kind: "file" } },
        ],
      },
    ],
  },
];
function TreeStory() {
  const [selected, setSelected] = useState<string[]>(["task-361"]);
  return (
    <div className="max-w-lg p-6">
      <Tree
        items={items}
        defaultExpandedIds={["p", "tasks", "docs"]}
        selectedIds={selected}
        onSelectionChange={setSelected}
        aria-label="Project files"
        renderNode={(node, state) => (
          <span
            className={
              state.selected ? "font-medium text-primary" : "text-foreground"
            }
          >
            {node.data.title}
            <span className="ml-2 text-xs text-muted-foreground">
              {node.data.kind}
            </span>
          </span>
        )}
      />
    </div>
  );
}
const meta = {
  title: "Common/Tree",
  component: TreeStory,
  excludeStories: /.*Story$/,
} satisfies Meta<typeof TreeStory>;
export default meta;
export const ProjectHierarchy = {} satisfies StoryObj<typeof meta>;
