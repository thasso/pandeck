import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProjectSelector } from "../../../src/components/ProjectSelector.tsx";
import { taskAreaProjects } from "../../fixtures/tasks.ts";

const meta = {
  title: "Tasks/Project selector",
  component: ProjectSelector,
  parameters: { layout: "centered" },
  args: {
    currentId: "pandeck",
    projects: taskAreaProjects,
    projectsById: new Map(
      taskAreaProjects.map((project) => [project.id, project]),
    ),
    onChange: () => {},
    defaultOpen: false,
  },
} satisfies Meta<typeof ProjectSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

function Selector({ initialOpen = false }: { initialOpen?: boolean }) {
  const [projectId, setProjectId] = useState<string | null>("pandeck");
  return (
    <ProjectSelector
      currentId={projectId}
      projects={taskAreaProjects}
      projectsById={
        new Map(taskAreaProjects.map((project) => [project.id, project]))
      }
      onChange={setProjectId}
      defaultOpen={initialOpen}
    />
  );
}

export const Closed: Story = { render: () => <Selector /> };
export const Open: Story = {
  args: { defaultOpen: true },
  render: () => <Selector initialOpen />,
  parameters: {
    docs: {
      description: { story: "Searchable project choices in the open picker." },
    },
  },
};
