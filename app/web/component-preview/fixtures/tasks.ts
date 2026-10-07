import type { ProjectRecord, TaskSummary } from "@assistant/shared";

export const taskAreaProjects: ProjectRecord[] = [
  {
    id: "pandeck",
    key: "PD",
    name: "Pandeck",
    color: "#5b62e6",
    localPaths: [{ path: "/work/pandeck", kind: "repo" }],
  },
  {
    id: "docs",
    key: "DOCS",
    name: "Product documentation",
    color: "#16856b",
    localPaths: [{ path: "/work/docs", kind: "repo" }],
  },
];

const today = new Date();
const dateKey = (offset: number) => {
  const date = new Date(today);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const now = Date.now();

export const taskAreaTask: TaskSummary = {
  id: "714",
  title: "Refine the task and project surfaces",
  status: "doing",
  source: { createdBy: "user" },
  projectId: "pandeck",
  priority: "high",
  scheduledFor: dateKey(0),
  dueDate: dateKey(2),
  descriptionPreview:
    "Keep the backlog scannable while bringing its controls into the shared UI system.",
  externalLinks: [
    {
      url: "https://example.com/spec",
      title: "Interaction spec",
      type: "related",
      source: "unknown",
      addedAt: 1739300000000,
    },
  ],
  createdAt: now - 2 * 86_400_000,
  updatedAt: now - 30 * 60_000,
};
