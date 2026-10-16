import { useLayoutEffect, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionListItem, TaskSummary } from "@assistant/shared";
import { InitiativeDetailPage } from "../../../src/components/initiative/InitiativeDetailPage.tsx";
import { failed, idle, ready, refreshing } from "../../../src/lib/loadState.ts";
import {
  HOSTED_LABS_DETAIL,
  HOSTED_LABS_LAYOUT,
  HOSTED_LABS_LAYOUT_COLLAPSED,
  HOSTED_LABS_RUNNING_TASK_IDS,
  HOSTED_LABS_TASK_IDS as T,
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
function liveTasksWith(
  status: Record<string, TaskSummary["status"]> = {},
): Map<string, TaskSummary> {
  return new Map<string, TaskSummary>(
    HOSTED_LABS_DETAIL.nodes
      .filter((node) => !node.archived)
      .map((node) => [
        node.id,
        {
          id: node.id,
          title: node.title,
          status: status[node.id] ?? node.status,
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
}
const liveTasks = liveTasksWith();

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
/** Stardust Labs and Usage metering collapsed, drawn by the server. */
const heldCollapsed = {
  item: HOSTED_LABS_DETAIL,
  layout: HOSTED_LABS_LAYOUT_COLLAPSED,
  requestedCollapsed: [T.SDC4, T.LAB],
};
const OVERSIZED =
  "The map has 1203 nodes, more than the 1000 it lays out; collapse epics to draw it.";

/**
 * The page's map choices are `sessionStorage` state for one Initiative in one
 * tab, so a story seeds them before the page reads them.
 */
interface MapChoices {
  collapsed?: string[];
  hideDone?: boolean;
  criticalPath?: boolean;
}

function SeededMapChoices({
  choices,
  children,
}: {
  choices: MapChoices;
  children: ReactNode;
}) {
  const [seeded, setSeeded] = useState(false);
  useLayoutEffect(() => {
    sessionStorage.setItem(
      `assistant.initiativeMap.v1:${HOSTED_LABS_DETAIL.id}`,
      JSON.stringify({
        collapsed: choices.collapsed ?? [],
        hideDone: choices.hideDone ?? false,
        criticalPath: choices.criticalPath ?? false,
      }),
    );
    setSeeded(true);
  }, [choices]);
  return seeded ? children : null;
}

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
    (Story, context) => (
      <SeededMapChoices
        key={context.id}
        choices={(context.parameters.mapChoices as MapChoices) ?? {}}
      >
        <div className="h-screen">
          <Story />
        </div>
      </SeededMapChoices>
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

/** Stardust Labs and the nested Usage metering epic collapsed: one node each, live counts. */
export const MapCollapsedEpics: Story = {
  args: { detailState: ready(heldCollapsed) },
  parameters: { mapChoices: { collapsed: [T.SDC4, T.LAB] } },
};

/** A Task inside a collapsed epic is selected: the epic carries a softer ring. */
export const MapCollapsedHoldsSelection: Story = {
  args: { detailState: ready(heldCollapsed), selectedTaskId: T.LAB5 },
  parameters: { mapChoices: { collapsed: [T.SDC4, T.LAB] } },
};

/** The collapse was asked for and the server has not answered: the old map stays. */
export const MapRedrawing: Story = {
  args: { detailState: refreshing(held) },
  parameters: { mapChoices: { collapsed: [T.LAB] } },
};

/** The longest open chain into the release, everything else receding. */
export const MapCriticalPath: Story = {
  parameters: { mapChoices: { criticalPath: true } },
};

/** The path runs through a collapsed epic, which carries it. */
export const MapCriticalPathCollapsed: Story = {
  args: { detailState: ready(heldCollapsed) },
  parameters: {
    mapChoices: { collapsed: [T.SDC4, T.LAB], criticalPath: true },
  },
};

/** Three chains of five tie once SDC3 and LAB2 are done; each is marked. */
export const MapCriticalPathTie: Story = {
  args: { liveTasks: liveTasksWith({ [T.SDC3]: "done", [T.LAB2]: "done" }) },
  parameters: { mapChoices: { criticalPath: true } },
};

/** The release is done and no milestone is open: the line says so, nothing recedes. */
export const MapCriticalPathNoMilestone: Story = {
  args: { liveTasks: liveTasksWith({ [T.RELEASE]: "done" }) },
  parameters: { mapChoices: { criticalPath: true } },
};

/** Done work with nothing open under it leaves the map; a done epic over open work stays. */
export const MapHideDone: Story = {
  args: {
    liveTasks: liveTasksWith({ [T.SDC]: "done", [T.SRS3]: "done" }),
  },
  parameters: { mapChoices: { hideDone: true } },
};

/** Every Task is done and Hide done is on. */
export const EverythingDoneHidden: Story = {
  args: {
    liveTasks: liveTasksWith(
      Object.fromEntries(
        HOSTED_LABS_DETAIL.nodes.map((node) => [node.id, "done"]),
      ),
    ),
    detailState: ready({
      ...held,
      item: {
        ...HOSTED_LABS_DETAIL,
        nodes: HOSTED_LABS_DETAIL.nodes.map((node) => ({
          ...node,
          status: "done" as const,
        })),
      },
    }),
  },
  parameters: { mapChoices: { hideDone: true } },
};

/** A phone's List with an epic collapsed, done work hidden and the path marked. */
export const ListCollapsedOnPhone: Story = {
  args: { mobile: true },
  parameters: {
    viewport: { defaultViewport: "mobile1" },
    mapChoices: {
      collapsed: [T.SDC4, T.LAB],
      hideDone: true,
      criticalPath: true,
    },
  },
};

/**
 * Too large to draw, an expected outcome: a neutral notice with the drawn
 * count, Collapse all epics first, no Retry, and the List's collapse buttons.
 */
export const OversizedMap: Story = {
  args: {
    detailState: ready({
      item: HOSTED_LABS_DETAIL,
      layoutError: OVERSIZED,
      layoutTooLarge: { nodes: 1_203, limit: 1_000 },
    }),
  },
};

/** A real layout failure keeps its error and a Retry the user presses. */
export const LayoutTimedOut: Story = {
  args: {
    detailState: ready({
      item: HOSTED_LABS_DETAIL,
      layoutError: "The layout took longer than 20 s.",
    }),
  },
};

/** Still too large with every epic collapsed: nothing more to fold. */
export const OversizedEveryEpicCollapsed: Story = {
  args: {
    detailState: ready({
      item: HOSTED_LABS_DETAIL,
      layoutError: OVERSIZED.replace("1203", "1003"),
      layoutTooLarge: { nodes: 1_003, limit: 1_000 },
      requestedCollapsed: [T.SDC, T.LAB, T.SRS],
    }),
  },
  parameters: { mapChoices: { collapsed: [T.SDC, T.SDC4, T.LAB, T.SRS] } },
};
