// @vitest-environment jsdom
/**
 * Map interaction on the real socket effect, reducer and page
 * (`docs/initiatives.md`, The Initiative page): collapsing epics through the
 * server's collapsed set, the critical path and Hide done over the live Tasks
 * topic, and the oversized map's List with the collapse controls that make it
 * drawable. The collapsed set is part of a read's identity: rapid toggles,
 * answers to an older wish and the server's normalisation never put an older
 * drawing over the newest one, strand it loading, or read in a loop.
 *   pnpm --filter @assistant/web test src/initiativeMapInteractionScenario.test.tsx
 */
import { act, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  InitiativeLayout,
  InitiativeSummary,
  ServerMessage,
  TaskSummary,
} from "@assistant/shared";
import { useAssistant, type UIState } from "./hooks/useAssistant.ts";
import { InitiativeDetailPage } from "./components/initiative/InitiativeDetailPage.tsx";
import { liveTaskIndex } from "./lib/initiativeView.ts";
import { FakeSocket } from "./test/fakeSocket.ts";
import {
  HOSTED_LABS_DETAIL,
  HOSTED_LABS_LAYOUT,
  HOSTED_LABS_LAYOUT_COLLAPSED,
  HOSTED_LABS_TASK_IDS as T,
  hostedLabsSummary,
} from "../component-preview/fixtures/initiatives.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function readyMessage(): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    sessions: [],
    settings: {},
    speechToText: {
      configured: false,
      availableModelIds: [],
      maxUtteranceSeconds: 120,
    },
    slashCommands: [],
    contextInfo: null,
  } as unknown as ServerMessage;
}

const TITLE = (id: string) =>
  [...HOSTED_LABS_DETAIL.nodes, ...HOSTED_LABS_DETAIL.externalBlockers].find(
    (node) => node.id === id,
  )!.title;

/** The Tasks topic as the server has it: every unarchived Task of the read. */
function liveTasks(
  status: Record<string, TaskSummary["status"]> = {},
): TaskSummary[] {
  return [...HOSTED_LABS_DETAIL.nodes, ...HOSTED_LABS_DETAIL.externalBlockers]
    .filter((node) => !node.archived)
    .map((node) => ({
      id: node.id,
      title: node.title,
      status: status[node.id] ?? node.status,
      source: { createdBy: "user" },
      createdAt: 1,
      updatedAt: 1,
      ...(node.projectId ? { projectId: node.projectId } : {}),
      ...("blocked" in node && node.blocked ? { openBlockerCount: 1 } : {}),
    }));
}

let latest: UIState;

function PageHarness({
  initiativeId = "7",
  mobile = false,
}: {
  initiativeId?: string;
  mobile?: boolean;
}) {
  const { actions, state } = useAssistant();
  latest = state;
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => actions.setTopics(["initiatives", "tasks"]), [actions]);
  const live = useMemo(
    () => liveTaskIndex(state.taskList?.items, state.taskListFresh),
    [state.taskList, state.taskListFresh],
  );
  return (
    <InitiativeDetailPage
      key={initiativeId}
      initiativeId={initiativeId}
      mobile={mobile}
      connected={state.connected}
      summary={state.initiatives.find((item) => item.id === initiativeId)}
      detailState={state.initiativeDetails[initiativeId]}
      onLoadDetail={actions.requestInitiativeDetail}
      onOpenInitiative={actions.setOpenInitiative}
      liveTasks={live}
      sessions={state.sessions}
      projectLabel={(id) => id ?? "No Project"}
      selectedTaskId={selected}
      onSelectTask={setSelected}
      onOpenIndex={() => {}}
    />
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  // React Flow measures its pane; jsdom has no layout.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.localStorage.clear();
  window.sessionStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const reads = (socket: FakeSocket) =>
  socket.sent.filter(
    (message): message is Extract<ClientMessage, { type: "getInitiative" }> =>
      message.type === "getInitiative",
  );

async function frames(count = 3): Promise<void> {
  for (let i = 0; i < count; i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
}

async function until(done: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (done()) return;
    await frames(1);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function connect(socket: FakeSocket, revision = 1): Promise<void> {
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  await act(async () => {
    socket.receive({
      type: "initiativeList",
      items: [{ ...hostedLabsSummary(), id: "7" } satisfies InitiativeSummary],
      seq: 1,
      revisions: [{ id: "7", revision }],
    });
    socket.receive({
      type: "taskList",
      list: { request: {}, items: liveTasks(), updatedAt: 1 },
      seq: 1,
      revisions: liveTasks().map((task) => ({ id: task.id, revision: 1 })),
    });
  });
}

async function answer(
  socket: FakeSocket,
  read: Extract<ClientMessage, { type: "getInitiative" }>,
  drawing: {
    layout?: InitiativeLayout;
    layoutError?: string;
    layoutTooLarge?: { nodes: number; limit: number };
  },
  revision = 1,
): Promise<void> {
  await act(async () =>
    socket.receive({
      type: "initiativeDetail",
      id: "7",
      item: { ...HOSTED_LABS_DETAIL, id: "7" },
      revision,
      ...drawing,
      requestId: read.requestId,
    }),
  );
  await frames(1);
}

/** Boot the page; the first read is answered with `first`. */
async function boot(
  first: {
    layout?: InitiativeLayout;
    layoutError?: string;
    layoutTooLarge?: { nodes: number; limit: number };
  } = {
    layout: HOSTED_LABS_LAYOUT,
  },
  options: { mobile?: boolean } = {},
): Promise<FakeSocket> {
  await act(async () => root.render(<PageHarness {...options} />));
  const socket = FakeSocket.instances.at(-1)!;
  await connect(socket);
  await until(() => reads(socket).length === 1, "the first read");
  await answer(socket, reads(socket)[0]!, first);
  return socket;
}

const button = (name: RegExp) =>
  [...container.querySelectorAll("button")].find((el) =>
    name.test(el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""),
  );
const click = async (name: RegExp) => {
  const target = button(name);
  if (!target) throw new Error(`no button ${name}`);
  await act(async () => target.click());
  await frames(1);
};
const mapNode = (id: string) =>
  container.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${id}"] button:not([aria-expanded])`,
  );
const text = () => container.textContent ?? "";

describe("collapsing epics", () => {
  it("reads the newest wish after rapid toggles, dropping the answer to an older one", async () => {
    const socket = await boot();
    await until(() => mapNode(T.LAB) !== null, "the map");
    expect(reads(socket)[0]!.collapsed).toBeUndefined();

    // Three gestures while the first read is in flight: one read goes out.
    await click(new RegExp(`^Collapse ${TITLE(T.SDC4)}$`));
    await click(new RegExp(`^Collapse ${TITLE(T.LAB)}$`));
    await click(new RegExp(`^Collapse ${TITLE(T.SRS)}$`));
    await click(new RegExp(`^Expand ${TITLE(T.SRS)}$`));
    expect(reads(socket).map((read) => read.collapsed)).toEqual([
      undefined,
      [T.SDC4],
    ]);
    // The held map stays, saying it is being redrawn.
    expect(latest.initiativeDetails["7"]?.status).toBe("refreshing");
    expect(text()).toContain("Redrawing the map");
    expect(mapNode(T.LAB5)).not.toBeNull();

    // The older wish answers, at the same revision: it is dropped, and the
    // newest wish is read instead. Its drawing never replaces the held one.
    const held = () => {
      const detail = latest.initiativeDetails["7"];
      return detail && "data" in detail ? detail.data : undefined;
    };
    const older = { ...HOSTED_LABS_LAYOUT, key: "older-wish" };
    await answer(socket, reads(socket)[1]!, { layout: older });
    expect(held()?.layout?.key).toBe(HOSTED_LABS_LAYOUT.key);
    expect(held()?.requestedCollapsed).toEqual([]);
    expect(reads(socket).map((read) => read.collapsed)).toEqual([
      undefined,
      [T.SDC4],
      [T.SDC4, T.LAB],
    ]);
    expect(latest.initiativeDetails["7"]?.status).toBe("refreshing");

    // A late duplicate of the dropped answer changes nothing.
    await answer(socket, reads(socket)[1]!, { layout: older });
    expect(latest.initiativeDetails["7"]?.status).toBe("refreshing");
    expect(held()?.layout?.key).toBe(HOSTED_LABS_LAYOUT.key);

    await answer(socket, reads(socket)[2]!, {
      layout: HOSTED_LABS_LAYOUT_COLLAPSED,
    });
    expect(latest.initiativeDetails["7"]?.status).toBe("ready");
    expect(held()?.requestedCollapsed).toEqual([T.SDC4, T.LAB]);
    await until(() => mapNode(T.LAB5) === null, "the collapsed drawing");
    // The collapsed epic is one node with its live progress; LAB9 is archived
    // and open, LAB1 done.
    expect(mapNode(T.LAB)!.getAttribute("aria-label")).toContain(
      "collapsed epic, 1 of 9 done",
    );
    expect(button(new RegExp(`^Expand ${TITLE(T.LAB)}$`))).toBeDefined();
    expect(button(new RegExp(`^Expand ${TITLE(T.SDC4)}$`))).toBeDefined();
    // Settled: nothing else is read.
    await frames(5);
    expect(reads(socket)).toHaveLength(3);
  });

  it("sends the set the server applies, remembers a nested epic, and never reads twice for one drawing", async () => {
    const socket = await boot({ layout: HOSTED_LABS_LAYOUT }, { mobile: true });
    // The List folds at once and needs no layout: no read.
    await click(new RegExp(`^Collapse ${TITLE(T.SDC4)}$`));
    await click(new RegExp(`^Collapse ${TITLE(T.SDC)}$`));
    expect(reads(socket)).toHaveLength(1);
    expect(button(new RegExp(`^${TITLE(T.SDC5)}, Task-`))).toBeUndefined();
    expect(
      button(new RegExp(`^${TITLE(T.SDC)}, Task-.*collapsed`)),
    ).toBeDefined();

    // The Map wants that drawing: SDC4 sits under SDC, so only SDC is sent.
    await click(/^Map$/);
    expect(reads(socket).at(-1)!.collapsed).toEqual([T.SDC]);
    await answer(socket, reads(socket).at(-1)!, {
      layout: { ...HOSTED_LABS_LAYOUT, collapsed: [T.SDC] },
    });
    await frames(5);
    expect(reads(socket)).toHaveLength(2);

    // Expanding SDC leaves SDC4 collapsed, as the user left it.
    await until(() => mapNode(T.SDC) !== null, "the map");
    await click(new RegExp(`^Expand ${TITLE(T.SDC)}$`));
    expect(reads(socket).at(-1)!.collapsed).toEqual([T.SDC4]);
    await answer(socket, reads(socket).at(-1)!, {
      layout: HOSTED_LABS_LAYOUT,
    });
    await frames(5);
    expect(reads(socket)).toHaveLength(3);
    // Kept for this Initiative in this tab only.
    expect(
      JSON.parse(
        window.sessionStorage.getItem("assistant.initiativeMap.v1:7") ?? "{}",
      ).collapsed,
    ).toEqual([T.SDC4]);
  });

  it("re-reads the wished drawing at a newer Initiative revision, and after a lost connection", async () => {
    window.sessionStorage.setItem(
      "assistant.initiativeMap.v1:7",
      JSON.stringify({
        collapsed: [T.LAB],
        hideDone: false,
        criticalPath: false,
      }),
    );
    const socket = await boot({ layout: HOSTED_LABS_LAYOUT_COLLAPSED });
    expect(reads(socket)[0]!.collapsed).toEqual([T.LAB]);
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "initiatives",
        seq: 2,
        events: [
          {
            kind: "upsert",
            id: "7",
            revision: 2,
            item: { ...hostedLabsSummary(), id: "7" },
          },
        ],
      }),
    );
    await frames(1);
    expect(reads(socket)).toHaveLength(2);
    expect(reads(socket)[1]!.collapsed).toEqual([T.LAB]);

    // The connection drops with that read in flight: the page keeps the map
    // and reads the same wish on the next connection.
    const sockets = FakeSocket.instances.length;
    await act(async () => socket.close());
    expect(latest.initiativeDetails["7"]).toMatchObject({
      status: "error",
      error: "Connection lost while loading this Initiative.",
    });
    expect(mapNode(T.LAB)).not.toBeNull();
    await until(() => FakeSocket.instances.length > sockets, "a new socket");
    const next = FakeSocket.instances.at(-1)!;
    await connect(next, 2);
    await until(() => reads(next).length > 0, "the re-read");
    expect(reads(next).map((read) => read.collapsed)).toEqual([[T.LAB]]);
  });

  it("keeps one Initiative's collapsed epics to its own page", async () => {
    window.sessionStorage.setItem(
      "assistant.initiativeMap.v1:7",
      JSON.stringify({
        collapsed: [T.LAB],
        hideDone: true,
        criticalPath: true,
      }),
    );
    await act(async () => root.render(<PageHarness initiativeId="8" />));
    const socket = FakeSocket.instances.at(-1)!;
    await connect(socket);
    await until(() => reads(socket).length === 1, "the read");
    expect(reads(socket)[0]).toMatchObject({ id: "8" });
    expect(reads(socket)[0]!.collapsed).toBeUndefined();
  });
});

describe("live path, progress and Hide done", () => {
  it("follows Task status changes without reading the graph or laying it out", async () => {
    window.sessionStorage.setItem(
      "assistant.initiativeMap.v1:7",
      JSON.stringify({
        collapsed: [T.SDC4, T.LAB],
        hideDone: false,
        criticalPath: true,
      }),
    );
    const socket = await boot({ layout: HOSTED_LABS_LAYOUT_COLLAPSED });
    await until(() => mapNode(T.LAB) !== null, "the map");
    // SDC3 → LAB5 … LAB8 → the release, with LAB5..LAB8 inside Stardust Labs.
    expect(text()).toContain(
      "Critical path: 6 open Tasks end at First hosted release.",
    );
    const onPath = () =>
      [...container.querySelectorAll(".react-flow__node [data-on-path]")]
        .map((el) => el.closest(".react-flow__node")!.getAttribute("data-id"))
        .sort();
    expect(onPath()).toEqual([T.SDC3, T.LAB, T.RELEASE].sort());
    expect(mapNode(T.LAB)!.getAttribute("aria-label")).toContain(
      "1 of 9 done, on the critical path",
    );

    // SDC3 finishes: three chains of five tie, and the collapsed epic still
    // carries one; nothing is read.
    const before = reads(socket).length;
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "tasks",
        seq: 2,
        events: [
          {
            kind: "upsert",
            id: T.SDC3,
            revision: 2,
            item: liveTasks({ [T.SDC3]: "done" }).find((t) => t.id === T.SDC3)!,
          },
          {
            kind: "upsert",
            id: T.LAB2,
            revision: 2,
            item: liveTasks({ [T.LAB2]: "done" }).find((t) => t.id === T.LAB2)!,
          },
        ],
      }),
    );
    await frames(1);
    expect(text()).toContain(
      "Critical path: more than one chain of 5 open Tasks ends at First hosted release; each is marked.",
    );
    expect(mapNode(T.LAB)!.getAttribute("aria-label")).toContain("2 of 9 done");
    expect(onPath()).not.toContain(T.SDC3);

    // Hide done takes done work off; the done SDC3 goes, its open epic stays.
    await click(/^Hide done$/);
    expect(mapNode(T.SDC3)).toBeNull();
    expect(mapNode(T.SDC1)).toBeNull();
    expect(mapNode(T.SDC)).not.toBeNull();
    expect(text()).toMatch(/\d+ done Tasks are hidden\./);
    expect(reads(socket)).toHaveLength(before);
  });

  it("shows the next milestone's path and says when there is none", async () => {
    window.sessionStorage.setItem(
      "assistant.initiativeMap.v1:7",
      JSON.stringify({ collapsed: [], hideDone: false, criticalPath: true }),
    );
    const socket = await boot();
    await until(() => mapNode(T.RELEASE) !== null, "the map");
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "tasks",
        seq: 2,
        events: [
          {
            kind: "upsert",
            id: T.RELEASE,
            revision: 2,
            item: liveTasks({ [T.RELEASE]: "done" }).find(
              (t) => t.id === T.RELEASE,
            )!,
          },
        ],
      }),
    );
    await frames(1);
    expect(text()).toContain(
      "No milestone is open, so there is no critical path.",
    );
    // Nothing recedes behind an empty highlight.
    expect(container.querySelectorAll("[data-on-path]")).toHaveLength(0);
    expect(reads(socket)).toHaveLength(1);
  });
});

describe("a map too large to draw", () => {
  const OVERSIZED =
    "The map has 1203 nodes, more than the 1000 it lays out; collapse epics to draw it.";
  /** The server's answer for the size outcome: the reason and its numbers. */
  const tooLarge = (nodes: number) => ({
    layoutError: OVERSIZED.replace("1203", String(nodes)),
    layoutTooLarge: { nodes, limit: 1_000 },
  });
  const alerts = () =>
    [...container.querySelectorAll('[role="alert"]')].map(
      (el) => el.textContent ?? "",
    );
  const sizeNote = () =>
    [...container.querySelectorAll('[role="status"]')].find((el) =>
      el.textContent?.includes("more than the 1,000 it lays out"),
    );

  it("is an expected outcome: a neutral notice with the drawn count, Collapse all first, and no Retry", async () => {
    const socket = await boot(tooLarge(1_203));
    // Not a failure: no error alert, and no Retry that could not change it.
    expect(alerts().filter((el) => el.includes("could not be drawn"))).toEqual(
      [],
    );
    expect(button(/^Retry$/)).toBeUndefined();
    const note = sizeNote();
    expect(note?.textContent).toContain(
      "This map has 1,203 nodes, more than the 1,000 it lays out",
    );
    // Collapse all epics is the notice's primary action.
    const collapseAll = [...note!.querySelectorAll("button")].find((el) =>
      el.textContent?.includes("Collapse all epics"),
    );
    expect(collapseAll?.className).toContain("bg-primary");
    // The List's own collapse buttons, one per epic, are unchanged.
    for (const id of [T.SDC, T.SDC4, T.LAB, T.SRS])
      expect(button(new RegExp(`^Collapse ${TITLE(id)}$`))).toBeDefined();

    // Nothing reads again on its own: the answer stands until asked.
    await frames(10);
    expect(reads(socket)).toHaveLength(1);

    // Select a member, then collapse every epic from the notice.
    await click(new RegExp(`^${TITLE(T.LAB5)}, Task-`));
    await act(async () => collapseAll!.click());
    await frames(1);
    expect(reads(socket).at(-1)!.collapsed).toEqual([T.SDC, T.LAB, T.SRS]);
    // The List folds at once, keeping the selection and the notice until the
    // drawing answers.
    expect(text()).toContain(
      `The selected Task, Task-${T.LAB5}, is inside collapsed ${TITLE(T.LAB)}.`,
    );
    expect(
      button(new RegExp(`^${TITLE(T.LAB)}, Task-.*holds the selected Task`)),
    ).toBeDefined();
    await answer(socket, reads(socket).at(-1)!, {
      layout: HOSTED_LABS_LAYOUT_COLLAPSED,
    });
    await until(() => mapNode(T.LAB) !== null, "the drawn map");
    expect(sizeNote()).toBeUndefined();
    // The view stays the Map, and the selection is still the Task, carried by
    // the epic that holds it rather than replaced by it.
    expect(window.sessionStorage.getItem("assistant.initiativeView.v1")).toBe(
      '"auto"',
    );
    expect(mapNode(T.LAB)!.getAttribute("aria-label")).toContain(
      "holds the selected Task",
    );
    expect(mapNode(T.LAB)!.getAttribute("aria-current")).toBeNull();
  });

  it("says the drawn count of each answer, and when every epic is collapsed", async () => {
    const socket = await boot(tooLarge(1_203));
    await click(new RegExp(`^Collapse ${TITLE(T.LAB)}$`));
    expect(reads(socket).at(-1)!.collapsed).toEqual([T.LAB]);
    await answer(socket, reads(socket).at(-1)!, tooLarge(1_195));
    expect(sizeNote()?.textContent).toContain("This map has 1,195 nodes");
    await click(/^Collapse all epics$/);
    await answer(socket, reads(socket).at(-1)!, tooLarge(1_003));
    expect(sizeNote()?.textContent).toContain(
      "Every epic is collapsed, and the map still has 1,003 nodes",
    );
    expect(button(/^Retry$/)).toBeUndefined();
    expect(button(/^Expand all epics$/)).toBeDefined();
    await frames(5);
    expect(reads(socket)).toHaveLength(3);
  });

  it("keeps a real layout failure an error with a Retry the user presses", async () => {
    const fault = "The layout took longer than 20 s.";
    const socket = await boot({ layoutError: fault });
    expect(
      alerts().some(
        (el) => el.includes("could not be drawn") && el.includes(fault),
      ),
    ).toBe(true);
    expect(sizeNote()).toBeUndefined();
    // No retry on its own; one read per press.
    await frames(10);
    expect(reads(socket)).toHaveLength(1);
    await click(/^Retry$/);
    expect(reads(socket)).toHaveLength(2);
    await answer(socket, reads(socket).at(-1)!, { layout: HOSTED_LABS_LAYOUT });
    await until(() => mapNode(T.LAB5) !== null, "the drawn map");
    expect(alerts().some((el) => el.includes("could not be drawn"))).toBe(
      false,
    );
  });
});
