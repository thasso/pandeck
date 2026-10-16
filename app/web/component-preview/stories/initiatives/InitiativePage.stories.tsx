import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionListItem, TaskSummary } from "@assistant/shared";
import { InitiativeDetailPage } from "../../../src/components/initiative/InitiativeDetailPage.tsx";
import { failed, idle, ready, refreshing } from "../../../src/lib/loadState.ts";
import {
  HOSTED_LABS_DETAIL,
  HOSTED_LABS_LAYOUT,
  HOSTED_LABS_RUNNING_TASK_IDS,
  hostedLabsSummary,
} from "../../fixtures/initiatives.ts";

const PROJECT_NAMES: Record<string, string> = {
  sdc: "SDC",
  "stardust-labs": "Stardust Labs",
  srs: "SRS",
};

/**
 * The Tasks topic as the page sees it: one live row per member, the two with a
 * running session linked to it. Built from the same fixture so the overlay and
 * the read agree, as they do when nothing has moved since the read.
 */
const liveTasks = new Map<string, TaskSummary>(
  HOSTED_LABS_DETAIL.nodes
    .filter((node) => !node.archived)
    .map((node) => [
      node.id,
      {
        id: node.id,
        title: node.title,
        status: node.status,
        source: { createdBy: "user" },
        createdAt: 1,
        updatedAt: 1,
        ...(node.projectId ? { projectId: node.projectId } : {}),
        ...(node.blocked ? { openBlockerCount: 1 } : {}),
        ...(HOSTED_LABS_RUNNING_TASK_IDS.includes(node.id)
          ? {
              sessionRefs: [
                { sessionId: `session-${node.id}`, origin: "task-start" },
              ],
            }
          : {}),
      } satisfies TaskSummary,
    ]),
);

const sessions: SessionListItem[] = HOSTED_LABS_RUNNING_TASK_IDS.map((id) => ({
  id: `session-${id}`,
  harness: "claude-sdk",
  agentType: "developer",
  title: `Working on Task-${id}`,
  createdAt: 1,
  updatedAt: 1,
  messageCount: 4,
  isStreaming: true,
}));

const held = { item: HOSTED_LABS_DETAIL, layout: HOSTED_LABS_LAYOUT };

const meta = {
  title: "App/Initiatives/Initiative page",
  component: InitiativeDetailPage,
  args: {
    initiativeId: HOSTED_LABS_DETAIL.id,
    mobile: false,
    connected: true,
    summary: hostedLabsSummary(),
    detailState: ready(held),
    onLoadDetail: () => {},
    onOpenInitiative: () => {},
    liveTasks,
    sessions,
    projectLabel: (id: string | undefined) =>
      id ? (PROJECT_NAMES[id] ?? id) : "No Project",
    selectedTaskId: null,
    onSelectTask: () => {},
    onOpenIndex: () => {},
  },
  decorators: [
    (Story) => (
      <div className="h-screen">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof InitiativeDetailPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Wide default: the map, with a doing-and-blocked Task and two running ones. */
export const MapView: Story = {};

/** A member selected: its node is ringed, and the panel shows it. */
export const MapWithSelection: Story = {
  args: { selectedTaskId: HOSTED_LABS_RUNNING_TASK_IDS[1]! },
};

/** A phone's default view. */
export const ListOnPhone: Story = {
  args: { mobile: true },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

export const Loading: Story = { args: { detailState: idle() } };

/** A newer revision is being read; the old graph stays. */
export const Refreshing: Story = { args: { detailState: refreshing(held) } };

/** The read failed before anything was shown. */
export const Failed: Story = {
  args: {
    detailState: failed("Connection lost while loading this Initiative."),
  },
};

/** The graph arrived but no layout: the reason, a retry, and the List. */
export const LayoutError: Story = {
  args: {
    detailState: ready({
      item: HOSTED_LABS_DETAIL,
      layoutError:
        "The map is being laid out by too many readers at once; read it again in a few seconds.",
    }),
  },
};

export const NoMembers: Story = {
  args: {
    detailState: ready({
      item: { ...HOSTED_LABS_DETAIL, nodes: [], rootIds: [], edges: [] },
    }),
  },
};

export const DoesNotExist: Story = {
  args: { detailState: ready(null), summary: undefined },
};

export const Archived: Story = {
  args: {
    summary: undefined,
    detailState: ready({
      ...held,
      item: { ...HOSTED_LABS_DETAIL, archivedAt: 1_792_000_000_000 },
    }),
  },
};
