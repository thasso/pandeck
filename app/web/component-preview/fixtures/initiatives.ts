/**
 * A synthetic Initiative shaped like Hosted Labs (`docs/initiatives.md`): three
 * Projects, three epics, 32 member Tasks, cross-Project `blocks` links, done
 * prerequisites, two outside blockers and one milestone. Every title is
 * invented. The layout is the server's real ELK output for this structure,
 * the pinned snapshot `app/server/src/__snapshots__/initiative-layout-hosted-labs.json`
 * with its fixture names swapped for these ids; it depends on structure alone,
 * so the invented titles and statuses do not move it.
 *
 * SDC5=905, LAB2=914, LAB9=921, RELEASE=931: SDC5 is in progress AND blocked with a
 * running session, LAB2 is in progress with a running session, LAB9 is an
 * archived open member.
 */
import type {
  InitiativeDetail,
  InitiativeLayout,
  InitiativeSummary,
} from "@assistant/shared";

export const HOSTED_LABS_DETAIL: InitiativeDetail = {
  id: "7",
  title: "Hosted Labs",
  state: "active",
  progress: {
    total: 32,
    done: 5,
    doing: 5,
    startable: 5,
    blocked: 18,
  },
  nextMilestone: { id: "931", title: "First hosted release" },
  sessionIds: ["sess-labs-images", "sess-quotas"],
  sessionCount: 2,
  updatedAt: 1792100000000,
  description:
    "Run SDC, Stardust Labs and SRS on hosted infrastructure, with one first release when all three are ready.",
  createdAt: 1791500000000,
  rootIds: ["900", "912", "922", "931"],
  nodes: [
    {
      id: "900",
      title: "Hosted SDC sessions",
      status: "todo",
      projectId: "sdc",
      direct: true,
    },
    {
      id: "901",
      title: "Decide the hosted account model",
      status: "done",
      projectId: "sdc",
      parentId: "900",
    },
    {
      id: "902",
      title: "Provision the hosting tenant",
      status: "done",
      projectId: "sdc",
      parentId: "900",
    },
    {
      id: "903",
      title: "Session API behind the gateway",
      status: "doing",
      projectId: "sdc",
      parentId: "900",
    },
    {
      id: "904",
      title: "Usage metering",
      status: "todo",
      blocked: true,
      projectId: "sdc",
      parentId: "900",
    },
    {
      id: "910",
      title: "Meter schema and retention",
      status: "doing",
      projectId: "sdc",
      parentId: "904",
    },
    {
      id: "911",
      title: "Export metering to billing",
      status: "todo",
      blocked: true,
      projectId: "sdc",
      parentId: "904",
    },
    {
      id: "905",
      title: "Per-customer session quotas",
      status: "doing",
      blocked: true,
      projectId: "sdc",
      parentId: "900",
    },
    {
      id: "906",
      title: "Load test at 200 concurrent sessions",
      status: "todo",
      blocked: true,
      projectId: "sdc",
      parentId: "900",
    },
    {
      id: "907",
      title: "Wire SRS signing into session start",
      status: "todo",
      blocked: true,
      projectId: "sdc",
      parentId: "900",
    },
    {
      id: "908",
      title: "Failover drill for the session API",
      status: "todo",
      blocked: true,
      projectId: "sdc",
      parentId: "900",
    },
    {
      id: "909",
      title: "SDC production readiness review",
      status: "todo",
      blocked: true,
      projectId: "sdc",
      parentId: "900",
    },
    {
      id: "912",
      title: "Stardust Labs on hosted infrastructure",
      status: "todo",
      projectId: "stardust-labs",
      direct: true,
    },
    {
      id: "913",
      title: "Inventory Labs workloads",
      status: "done",
      projectId: "stardust-labs",
      parentId: "912",
    },
    {
      id: "914",
      title: "Container images for the Labs runners",
      status: "doing",
      projectId: "stardust-labs",
      parentId: "912",
    },
    {
      id: "915",
      title: "Shared storage for experiment artifacts",
      status: "todo",
      blocked: true,
      projectId: "stardust-labs",
      parentId: "912",
    },
    {
      id: "916",
      title: "Labs scheduler on the hosted cluster",
      status: "todo",
      blocked: true,
      projectId: "stardust-labs",
      parentId: "912",
    },
    {
      id: "917",
      title: "Labs client against the session API",
      status: "todo",
      blocked: true,
      projectId: "stardust-labs",
      parentId: "912",
    },
    {
      id: "918",
      title: "Notebook sign-in through hosted SSO",
      status: "todo",
      blocked: true,
      projectId: "stardust-labs",
      parentId: "912",
    },
    {
      id: "919",
      title: "Migrate the three pilot teams",
      status: "todo",
      blocked: true,
      projectId: "stardust-labs",
      parentId: "912",
    },
    {
      id: "920",
      title: "Labs production readiness review",
      status: "todo",
      blocked: true,
      projectId: "stardust-labs",
      parentId: "912",
    },
    {
      id: "921",
      title: "Self-service Labs quotas page",
      status: "todo",
      projectId: "stardust-labs",
      parentId: "912",
      archived: true,
    },
    {
      id: "922",
      title: "SRS hosted rollout",
      status: "todo",
      projectId: "srs",
      direct: true,
    },
    {
      id: "923",
      title: "Agree the SRS hosting contract",
      status: "done",
      projectId: "srs",
      parentId: "922",
    },
    {
      id: "924",
      title: "SRS key management in the tenant",
      status: "done",
      projectId: "srs",
      parentId: "922",
    },
    {
      id: "925",
      title: "Signing service deployment",
      status: "todo",
      projectId: "srs",
      parentId: "922",
    },
    {
      id: "926",
      title: "SRS runners on the Labs images",
      status: "doing",
      blocked: true,
      projectId: "srs",
      parentId: "922",
    },
    {
      id: "927",
      title: "Rotate signing keys without downtime",
      status: "todo",
      blocked: true,
      projectId: "srs",
      parentId: "922",
    },
    {
      id: "928",
      title: "SRS signing client library",
      status: "todo",
      projectId: "srs",
      parentId: "922",
    },
    {
      id: "929",
      title: "SRS audit log export",
      status: "todo",
      blocked: true,
      projectId: "srs",
      parentId: "922",
    },
    {
      id: "930",
      title: "SRS client release notes",
      status: "todo",
      blocked: true,
      projectId: "srs",
      parentId: "922",
    },
    {
      id: "931",
      title: "First hosted release",
      status: "todo",
      blocked: true,
      projectId: "sdc",
      direct: true,
      milestone: true,
    },
  ],
  externalBlockers: [
    {
      id: "932",
      title: "Security review of the hosting account",
      status: "done",
    },
    {
      id: "933",
      title: "Legal sign-off for hosted terms",
      status: "todo",
      projectId: "sdc",
    },
  ],
  edges: [
    {
      from: "901",
      to: "902",
    },
    {
      from: "902",
      to: "903",
    },
    {
      from: "903",
      to: "905",
    },
    {
      from: "905",
      to: "906",
    },
    {
      from: "906",
      to: "909",
    },
    {
      from: "910",
      to: "911",
    },
    {
      from: "911",
      to: "904",
    },
    {
      from: "907",
      to: "908",
    },
    {
      from: "908",
      to: "909",
    },
    {
      from: "913",
      to: "914",
    },
    {
      from: "914",
      to: "915",
    },
    {
      from: "915",
      to: "916",
    },
    {
      from: "916",
      to: "920",
    },
    {
      from: "917",
      to: "918",
    },
    {
      from: "918",
      to: "919",
    },
    {
      from: "919",
      to: "920",
    },
    {
      from: "923",
      to: "924",
    },
    {
      from: "924",
      to: "925",
    },
    {
      from: "925",
      to: "927",
    },
    {
      from: "926",
      to: "927",
    },
    {
      from: "927",
      to: "929",
    },
    {
      from: "928",
      to: "930",
    },
    {
      from: "903",
      to: "917",
    },
    {
      from: "914",
      to: "926",
    },
    {
      from: "928",
      to: "907",
    },
    {
      from: "909",
      to: "931",
    },
    {
      from: "920",
      to: "931",
    },
    {
      from: "932",
      to: "902",
    },
    {
      from: "932",
      to: "925",
    },
    {
      from: "933",
      to: "931",
    },
  ],
  milestoneIds: ["931"],
};

export const HOSTED_LABS_LAYOUT: InitiativeLayout = {
  width: 3356,
  height: 1048,
  collapsed: [],
  groups: [
    {
      projectId: "sdc",
      laneIds: ["900"],
      x: 24,
      y: 24,
      width: 2648,
      height: 376,
    },
    {
      projectId: "stardust-labs",
      laneIds: ["912"],
      x: 24,
      y: 440,
      width: 2648,
      height: 272,
    },
    {
      projectId: "srs",
      laneIds: ["922"],
      x: 24,
      y: 752,
      width: 2648,
      height: 272,
    },
  ],
  lanes: [
    {
      id: "900",
      projectId: "sdc",
      x: 36,
      y: 56,
      width: 2624,
      height: 332,
    },
    {
      id: "912",
      projectId: "stardust-labs",
      x: 36,
      y: 472,
      width: 2624,
      height: 228,
    },
    {
      id: "922",
      projectId: "srs",
      x: 36,
      y: 784,
      width: 2624,
      height: 228,
    },
  ],
  milestoneColumn: {
    x: 2724,
    y: 24,
    width: 608,
    height: 1000,
  },
  nodes: [
    {
      id: "external:932:900",
      kind: "external",
      taskId: "932",
      laneId: "900",
      x: 52,
      y: 92,
      width: 240,
      height: 72,
    },
    {
      id: "900",
      kind: "task",
      taskId: "900",
      laneId: "900",
      x: 388,
      y: 196,
      width: 240,
      height: 72,
    },
    {
      id: "901",
      kind: "task",
      taskId: "901",
      laneId: "900",
      x: 388,
      y: 103,
      width: 240,
      height: 72,
    },
    {
      id: "902",
      kind: "task",
      taskId: "902",
      laneId: "900",
      x: 724,
      y: 92,
      width: 240,
      height: 72,
    },
    {
      id: "903",
      kind: "task",
      taskId: "903",
      laneId: "900",
      x: 1060,
      y: 92,
      width: 240,
      height: 72,
    },
    {
      id: "904",
      kind: "task",
      taskId: "904",
      laneId: "900",
      x: 1060,
      y: 196,
      width: 240,
      height: 72,
    },
    {
      id: "910",
      kind: "task",
      taskId: "910",
      laneId: "900",
      x: 388,
      y: 300,
      width: 240,
      height: 72,
    },
    {
      id: "911",
      kind: "task",
      taskId: "911",
      laneId: "900",
      x: 724,
      y: 196,
      width: 240,
      height: 72,
    },
    {
      id: "905",
      kind: "task",
      taskId: "905",
      laneId: "900",
      x: 1396,
      y: 92,
      width: 240,
      height: 72,
    },
    {
      id: "906",
      kind: "task",
      taskId: "906",
      laneId: "900",
      x: 1732,
      y: 92,
      width: 240,
      height: 72,
    },
    {
      id: "907",
      kind: "task",
      taskId: "907",
      laneId: "900",
      x: 1396,
      y: 196,
      width: 240,
      height: 72,
    },
    {
      id: "908",
      kind: "task",
      taskId: "908",
      laneId: "900",
      x: 1732,
      y: 196,
      width: 240,
      height: 72,
    },
    {
      id: "909",
      kind: "task",
      taskId: "909",
      laneId: "900",
      x: 2068,
      y: 92,
      width: 240,
      height: 72,
    },
    {
      id: "912",
      kind: "task",
      taskId: "912",
      laneId: "912",
      x: 388,
      y: 508,
      width: 240,
      height: 72,
    },
    {
      id: "913",
      kind: "task",
      taskId: "913",
      laneId: "912",
      x: 1060,
      y: 508,
      width: 240,
      height: 72,
    },
    {
      id: "914",
      kind: "task",
      taskId: "914",
      laneId: "912",
      x: 1396,
      y: 612,
      width: 240,
      height: 72,
    },
    {
      id: "915",
      kind: "task",
      taskId: "915",
      laneId: "912",
      x: 1732,
      y: 612,
      width: 240,
      height: 72,
    },
    {
      id: "916",
      kind: "task",
      taskId: "916",
      laneId: "912",
      x: 2068,
      y: 612,
      width: 240,
      height: 72,
    },
    {
      id: "917",
      kind: "task",
      taskId: "917",
      laneId: "912",
      x: 1396,
      y: 508,
      width: 240,
      height: 72,
    },
    {
      id: "918",
      kind: "task",
      taskId: "918",
      laneId: "912",
      x: 1732,
      y: 508,
      width: 240,
      height: 72,
    },
    {
      id: "919",
      kind: "task",
      taskId: "919",
      laneId: "912",
      x: 2068,
      y: 508,
      width: 240,
      height: 72,
    },
    {
      id: "920",
      kind: "task",
      taskId: "920",
      laneId: "912",
      x: 2404,
      y: 508,
      width: 240,
      height: 72,
    },
    {
      id: "921",
      kind: "task",
      taskId: "921",
      laneId: "912",
      x: 388,
      y: 612,
      width: 240,
      height: 72,
    },
    {
      id: "external:932:922",
      kind: "external",
      taskId: "932",
      laneId: "922",
      x: 52,
      y: 820,
      width: 240,
      height: 72,
    },
    {
      id: "922",
      kind: "task",
      taskId: "922",
      laneId: "922",
      x: 388,
      y: 859,
      width: 240,
      height: 72,
    },
    {
      id: "923",
      kind: "task",
      taskId: "923",
      laneId: "922",
      x: 1060,
      y: 924,
      width: 240,
      height: 72,
    },
    {
      id: "924",
      kind: "task",
      taskId: "924",
      laneId: "922",
      x: 1396,
      y: 924,
      width: 240,
      height: 72,
    },
    {
      id: "925",
      kind: "task",
      taskId: "925",
      laneId: "922",
      x: 1732,
      y: 924,
      width: 240,
      height: 72,
    },
    {
      id: "926",
      kind: "task",
      taskId: "926",
      laneId: "922",
      x: 1732,
      y: 820,
      width: 240,
      height: 72,
    },
    {
      id: "927",
      kind: "task",
      taskId: "927",
      laneId: "922",
      x: 2068,
      y: 820,
      width: 240,
      height: 72,
    },
    {
      id: "928",
      kind: "task",
      taskId: "928",
      laneId: "922",
      x: 1060,
      y: 820,
      width: 240,
      height: 72,
    },
    {
      id: "929",
      kind: "task",
      taskId: "929",
      laneId: "922",
      x: 2404,
      y: 820,
      width: 240,
      height: 72,
    },
    {
      id: "930",
      kind: "task",
      taskId: "930",
      laneId: "922",
      x: 1396,
      y: 820,
      width: 240,
      height: 72,
    },
    {
      id: "external:933:milestones",
      kind: "external",
      taskId: "933",
      x: 2740,
      y: 300,
      width: 240,
      height: 72,
    },
    {
      id: "931",
      kind: "task",
      taskId: "931",
      milestone: true,
      x: 3076,
      y: 300,
      width: 240,
      height: 72,
    },
  ],
  edges: [
    {
      from: "external:932:900",
      to: "902",
      points: [
        {
          x: 292,
          y: 128,
        },
        {
          x: 302,
          y: 128,
        },
        {
          x: 302,
          y: 92,
        },
        {
          x: 648,
          y: 92,
        },
        {
          x: 648,
          y: 140,
        },
        {
          x: 724,
          y: 140,
        },
      ],
    },
    {
      from: "901",
      to: "902",
      points: [
        {
          x: 628,
          y: 139,
        },
        {
          x: 638,
          y: 139,
        },
        {
          x: 638,
          y: 116,
        },
        {
          x: 724,
          y: 116,
        },
      ],
    },
    {
      from: "902",
      to: "903",
      points: [
        {
          x: 964,
          y: 128,
        },
        {
          x: 1060,
          y: 128,
        },
      ],
    },
    {
      from: "911",
      to: "904",
      points: [
        {
          x: 964,
          y: 232,
        },
        {
          x: 1060,
          y: 232,
        },
      ],
    },
    {
      from: "910",
      to: "911",
      points: [
        {
          x: 628,
          y: 336,
        },
        {
          x: 638,
          y: 336,
        },
        {
          x: 638,
          y: 232,
        },
        {
          x: 724,
          y: 232,
        },
      ],
    },
    {
      from: "903",
      to: "905",
      points: [
        {
          x: 1300,
          y: 116,
        },
        {
          x: 1310,
          y: 116,
        },
        {
          x: 1310,
          y: 128,
        },
        {
          x: 1396,
          y: 128,
        },
      ],
    },
    {
      from: "905",
      to: "906",
      points: [
        {
          x: 1636,
          y: 128,
        },
        {
          x: 1732,
          y: 128,
        },
      ],
    },
    {
      from: "928",
      to: "907",
      points: [
        {
          x: 1300,
          y: 844,
        },
        {
          x: 1320,
          y: 844,
        },
        {
          x: 1320,
          y: 232,
        },
        {
          x: 1396,
          y: 232,
        },
      ],
    },
    {
      from: "907",
      to: "908",
      points: [
        {
          x: 1636,
          y: 232,
        },
        {
          x: 1732,
          y: 232,
        },
      ],
    },
    {
      from: "906",
      to: "909",
      points: [
        {
          x: 1972,
          y: 128,
        },
        {
          x: 1982,
          y: 128,
        },
        {
          x: 1982,
          y: 116,
        },
        {
          x: 2068,
          y: 116,
        },
      ],
    },
    {
      from: "908",
      to: "909",
      points: [
        {
          x: 1972,
          y: 232,
        },
        {
          x: 1982,
          y: 232,
        },
        {
          x: 1982,
          y: 140,
        },
        {
          x: 2068,
          y: 140,
        },
      ],
    },
    {
      from: "913",
      to: "914",
      points: [
        {
          x: 1300,
          y: 544,
        },
        {
          x: 1310,
          y: 544,
        },
        {
          x: 1310,
          y: 648,
        },
        {
          x: 1396,
          y: 648,
        },
      ],
    },
    {
      from: "914",
      to: "915",
      points: [
        {
          x: 1636,
          y: 636,
        },
        {
          x: 1646,
          y: 636,
        },
        {
          x: 1646,
          y: 648,
        },
        {
          x: 1732,
          y: 648,
        },
      ],
    },
    {
      from: "915",
      to: "916",
      points: [
        {
          x: 1972,
          y: 648,
        },
        {
          x: 2068,
          y: 648,
        },
      ],
    },
    {
      from: "903",
      to: "917",
      points: [
        {
          x: 1300,
          y: 140,
        },
        {
          x: 1330,
          y: 140,
        },
        {
          x: 1330,
          y: 544,
        },
        {
          x: 1396,
          y: 544,
        },
      ],
    },
    {
      from: "917",
      to: "918",
      points: [
        {
          x: 1636,
          y: 544,
        },
        {
          x: 1732,
          y: 544,
        },
      ],
    },
    {
      from: "918",
      to: "919",
      points: [
        {
          x: 1972,
          y: 544,
        },
        {
          x: 2068,
          y: 544,
        },
      ],
    },
    {
      from: "916",
      to: "920",
      points: [
        {
          x: 2308,
          y: 648,
        },
        {
          x: 2318,
          y: 648,
        },
        {
          x: 2318,
          y: 532,
        },
        {
          x: 2404,
          y: 532,
        },
      ],
    },
    {
      from: "919",
      to: "920",
      points: [
        {
          x: 2308,
          y: 544,
        },
        {
          x: 2328,
          y: 544,
        },
        {
          x: 2328,
          y: 556,
        },
        {
          x: 2404,
          y: 556,
        },
      ],
    },
    {
      from: "923",
      to: "924",
      points: [
        {
          x: 1300,
          y: 960,
        },
        {
          x: 1396,
          y: 960,
        },
      ],
    },
    {
      from: "external:932:922",
      to: "925",
      points: [
        {
          x: 292,
          y: 856,
        },
        {
          x: 302,
          y: 856,
        },
        {
          x: 302,
          y: 848,
        },
        {
          x: 638,
          y: 848,
        },
        {
          x: 638,
          y: 869,
        },
        {
          x: 974,
          y: 869,
        },
        {
          x: 974,
          y: 902,
        },
        {
          x: 1310,
          y: 902,
        },
        {
          x: 1310,
          y: 911,
        },
        {
          x: 1656,
          y: 911,
        },
        {
          x: 1656,
          y: 972,
        },
        {
          x: 1732,
          y: 972,
        },
      ],
    },
    {
      from: "924",
      to: "925",
      points: [
        {
          x: 1636,
          y: 960,
        },
        {
          x: 1646,
          y: 960,
        },
        {
          x: 1646,
          y: 948,
        },
        {
          x: 1732,
          y: 948,
        },
      ],
    },
    {
      from: "914",
      to: "926",
      points: [
        {
          x: 1636,
          y: 660,
        },
        {
          x: 1646,
          y: 660,
        },
        {
          x: 1646,
          y: 856,
        },
        {
          x: 1732,
          y: 856,
        },
      ],
    },
    {
      from: "925",
      to: "927",
      points: [
        {
          x: 1972,
          y: 960,
        },
        {
          x: 1982,
          y: 960,
        },
        {
          x: 1982,
          y: 844,
        },
        {
          x: 2068,
          y: 844,
        },
      ],
    },
    {
      from: "926",
      to: "927",
      points: [
        {
          x: 1972,
          y: 856,
        },
        {
          x: 1992,
          y: 856,
        },
        {
          x: 1992,
          y: 868,
        },
        {
          x: 2068,
          y: 868,
        },
      ],
    },
    {
      from: "927",
      to: "929",
      points: [
        {
          x: 2308,
          y: 856,
        },
        {
          x: 2404,
          y: 856,
        },
      ],
    },
    {
      from: "928",
      to: "930",
      points: [
        {
          x: 1300,
          y: 868,
        },
        {
          x: 1310,
          y: 868,
        },
        {
          x: 1310,
          y: 856,
        },
        {
          x: 1396,
          y: 856,
        },
      ],
    },
    {
      from: "909",
      to: "931",
      points: [
        {
          x: 2308,
          y: 128,
        },
        {
          x: 2318,
          y: 128,
        },
        {
          x: 2318,
          y: 186,
        },
        {
          x: 2654,
          y: 186,
        },
        {
          x: 2654,
          y: 255,
        },
        {
          x: 3010,
          y: 255,
        },
        {
          x: 3010,
          y: 354,
        },
        {
          x: 3076,
          y: 354,
        },
      ],
    },
    {
      from: "920",
      to: "931",
      points: [
        {
          x: 2644,
          y: 544,
        },
        {
          x: 2654,
          y: 544,
        },
        {
          x: 2654,
          y: 382,
        },
        {
          x: 3000,
          y: 382,
        },
        {
          x: 3000,
          y: 336,
        },
        {
          x: 3076,
          y: 336,
        },
      ],
    },
    {
      from: "external:933:milestones",
      to: "931",
      points: [
        {
          x: 2980,
          y: 336,
        },
        {
          x: 2990,
          y: 336,
        },
        {
          x: 2990,
          y: 318,
        },
        {
          x: 3076,
          y: 318,
        },
      ],
    },
  ],
  key: "fixture-hosted-labs",
};

/** Members with a running session in the stories' session list. */
export const HOSTED_LABS_RUNNING_TASK_IDS: readonly string[] = ["914", "905"];

export const HOSTED_LABS_TASK_IDS = {
  SDC: "900",
  SDC1: "901",
  SDC2: "902",
  SDC3: "903",
  SDC4: "904",
  SDC5: "905",
  SDC6: "906",
  SDC7: "907",
  SDC8: "908",
  SDC9: "909",
  SDC4a: "910",
  SDC4b: "911",
  LAB: "912",
  LAB1: "913",
  LAB2: "914",
  LAB3: "915",
  LAB4: "916",
  LAB5: "917",
  LAB6: "918",
  LAB7: "919",
  LAB8: "920",
  LAB9: "921",
  SRS: "922",
  SRS1: "923",
  SRS2: "924",
  SRS3: "925",
  SRS4: "926",
  SRS5: "927",
  SRS6: "928",
  SRS7: "929",
  SRS8: "930",
  RELEASE: "931",
  "OUT-REVIEW": "932",
  "OUT-LEGAL": "933",
} as const;

export function hostedLabsSummary(
  partial: Partial<InitiativeSummary> = {},
): InitiativeSummary {
  const {
    description: _description,
    rootIds: _rootIds,
    nodes: _nodes,
    externalBlockers: _externalBlockers,
    edges: _edges,
    milestoneIds: _milestoneIds,
    ...summary
  } = HOSTED_LABS_DETAIL;
  return { ...summary, ...partial };
}
