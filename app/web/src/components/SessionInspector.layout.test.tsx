// @vitest-environment jsdom
/**
 * What the session Details panel puts where: actions first, the runtime facts
 * the panel is asked for most (account/model/thinking) under a Profile section,
 * and a Tasks group that cannot grow past its first page.
 *   pnpm --filter @assistant/web test src/components/SessionInspector.layout.test.tsx
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskSummary } from "@assistant/shared";
import {
  SessionInspector,
  sessionInspectorActions,
} from "./objectInspectors.tsx";

const openers = {
  onOpenTask: () => {},
  onOpenProject: () => {},
  onOpenSession: () => {},
  onOpenWorktree: () => {},
  onOpenKnowledge: () => {},
};

const task = (n: number): TaskSummary => ({
  id: `t${n}`,
  title: `Task number ${n}`,
  status: "todo",
  source: { createdBy: "user" },
  createdAt: n,
  updatedAt: n,
  sortOrder: n,
});

const render = (over: Parameters<typeof SessionInspector>[0]) =>
  renderToStaticMarkup(<SessionInspector {...over} />);

const base = {
  sessionId: "s1",
  title: "A session",
  relatedTasks: [],
  sessions: [],
  projects: [],
  openers,
};

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { host: HTMLElement; root: Root } | undefined;

afterEach(() => {
  if (!mounted) return;
  const { host, root } = mounted;
  mounted = undefined;
  act(() => root.unmount());
  host.remove();
});

describe("SessionInspector layout", () => {
  it("lists no actions: the session header's menu holds them", () => {
    const html = render({ ...base, relatedTasks: [task(1)] });
    expect(html).toContain("Tasks");
    expect(html).not.toContain("Actions");
  });

  it("leads the actions with Settle, then Review, under bare verb labels", () => {
    const labels = sessionInspectorActions({
      sessionId: "s1",
      sessions: [],
      onSettle: () => {},
      onReviewWork: () => {},
      onArchive: () => {},
      onDelete: () => {},
    }).map((action) => action.label);
    expect(labels).toEqual(["Settle", "Review", "Archive", "Delete"]);
  });

  it("offers to bring a settled session back instead of settling it", () => {
    const labels = sessionInspectorActions({
      sessionId: "s1",
      sessions: [],
      onSettle: () => {},
      settled: true,
    }).map((action) => action.label);
    expect(labels).toEqual(["Bring back"]);
  });

  it("states the account, model and thinking level in one Profile section", () => {
    const html = render({
      ...base,
      credentialProfile: { name: "Work", provider: "claude" },
      model: { id: "claude-opus-5", name: "Opus 5", provider: "claude-sdk" },
      thinkingLevel: "high",
    });
    expect(html).toContain("Profile");
    // Collapsed by default, so the summary carries the three facts; the account
    // is its NAME only, without the provider.
    expect(html).toContain("Work · Opus 5 · High");
    expect(html).not.toContain("Work · Claude");
    expect(html).not.toContain("Bound when this session started");
  });

  it("shows five tasks and defers the rest to a Show more", () => {
    const html = render({
      ...base,
      relatedTasks: [1, 2, 3, 4, 5, 6, 7].map(task),
    });
    expect(html).toContain("Task number 5");
    expect(html).not.toContain("Task number 6");
    expect(html).toContain("Show 2 more");
  });

  it("opens durable spawn relations in both directions", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    const opened: string[] = [];
    const sessions = [
      {
        id: "coordinator",
        harness: "pi" as const,
        agentType: "assistant" as const,
        title: "Coordinator",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
      },
      {
        id: "child",
        harness: "pi" as const,
        agentType: "assistant" as const,
        title: "Implementer",
        createdAt: 2,
        updatedAt: 2,
        messageCount: 1,
        spawnedBySessionId: "coordinator",
        spawnOwnership: "taken-over" as const,
      },
    ];
    const props = {
      ...base,
      sessions,
      openers: { ...openers, onOpenSession: (id: string) => opened.push(id) },
    };

    act(() => root.render(<SessionInspector {...props} sessionId="child" />));
    const coordinator = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Coordinator"),
    );
    expect(coordinator).toBeDefined();
    act(() => coordinator!.click());

    act(() =>
      root.render(<SessionInspector {...props} sessionId="coordinator" />),
    );
    const child = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Implementer"),
    );
    expect(child).toBeDefined();
    // The coordinator's row states that the user owns this child now, without
    // changing what the row opens.
    expect(child!.textContent).toContain("Taken over");
    act(() => child!.click());
    expect(opened).toEqual(["coordinator", "child"]);
  });

  it("re-bounds the tasks of the NEXT session opened after a Show more", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };

    const panel = (sessionId: string, titlePrefix: string) => (
      <SessionInspector
        {...base}
        sessionId={sessionId}
        relatedTasks={[1, 2, 3, 4, 5, 6, 7].map((n) => ({
          ...task(n),
          title: `${titlePrefix} ${n}`,
        }))}
      />
    );

    act(() => root.render(panel("s1", "First")));
    const showMore = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Show 2 more"),
    );
    expect(showMore).toBeDefined();
    act(() => showMore!.click());
    expect(host.textContent).toContain("First 7");

    // A different session is a different object: it opens bounded, not at
    // whatever depth the previous one was unfolded to.
    act(() => root.render(panel("s2", "Second")));
    expect(host.textContent).toContain("Second 5");
    expect(host.textContent).not.toContain("Second 6");
    expect(host.textContent).toContain("Show 2 more");
  });

  // The ownership action lives in the session's actions (the header's ⋮).
  const peer = (
    id: string,
    title: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    harness: "pi" as const,
    agentType: "assistant" as const,
    title,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    ...extra,
  });

  it("offers Take over on a coordinator-run peer and Hand back once taken", () => {
    const asked: string[] = [];
    const actionsFor = (ownership: "coordinator" | "taken-over") =>
      sessionInspectorActions({
        sessionId: "child",
        sessions: [
          peer("coordinator", "Coordinator"),
          peer("child", "Implementer", {
            spawnedBySessionId: "coordinator",
            spawnOwnership: ownership,
          }),
        ],
        onSetSpawnOwnership: (value) => asked.push(value),
      });
    const find = (
      actions: ReturnType<typeof sessionInspectorActions>,
      label: string,
    ) => actions.find((action) => action.label.startsWith(label));

    // A poke never moves ownership, so taking over is offered explicitly.
    const coordinatorRun = actionsFor("coordinator");
    expect(find(coordinatorRun, "Hand back")).toBeUndefined();
    find(coordinatorRun, "Take over")!.onRun();

    // Once taken, the action hands it back and names who gets it.
    const takenOver = actionsFor("taken-over");
    expect(find(takenOver, "Take over")).toBeUndefined();
    expect(find(takenOver, "Hand back")!.label).toContain("Coordinator");
    find(takenOver, "Hand back")!.onRun();
    expect(asked).toEqual(["taken-over", "coordinator"]);
  });

  it("offers no Hand back when the coordinator is gone from the list", () => {
    const labels = sessionInspectorActions({
      sessionId: "child",
      sessions: [
        peer("child", "Implementer", {
          spawnedBySessionId: "deleted-coordinator",
          spawnOwnership: "taken-over",
        }),
      ],
      onSetSpawnOwnership: () => {},
    }).map((action) => action.label);
    expect(labels.join(" ")).not.toContain("Hand back");
    expect(labels.join(" ")).not.toContain("Take over");
  });

  it("offers no ownership action on a session nothing spawned", () => {
    const labels = sessionInspectorActions({
      sessionId: "s1",
      sessions: [peer("s1", "Alone")],
      onSetSpawnOwnership: () => {},
    }).map((action) => action.label);
    expect(labels).toEqual([]);
  });
});
