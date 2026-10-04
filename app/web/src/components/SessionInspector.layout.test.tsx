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
import { SessionInspector } from "./objectInspectors.tsx";

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
  it("leads with Actions, before the object's relations", () => {
    const html = render({
      ...base,
      onSettle: () => {},
      relatedTasks: [task(1)],
    });
    expect(html.indexOf("Actions")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("Actions")).toBeLessThan(html.indexOf("Tasks"));
  });

  it("leads the actions with Settle, then Review, under bare verb labels", () => {
    const html = render({
      ...base,
      onSettle: () => {},
      onReviewWork: () => {},
      onArchive: () => {},
      onDelete: () => {},
    });
    expect(html.indexOf(">Settle")).toBeLessThan(html.indexOf(">Review"));
    expect(html.indexOf(">Review")).toBeLessThan(html.indexOf(">Archive"));
    // The panel already says which session this is.
    expect(html).not.toContain("Archive session");
    expect(html).not.toContain("Delete session");
  });

  it("offers to bring a settled session back instead of settling it", () => {
    const html = render({ ...base, onSettle: () => {}, settled: true });
    expect(html).toContain("Bring back");
    expect(html).not.toContain(">Settle");
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

  it("offers Take over on a coordinator-run peer and Hand back once taken", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    const row = (
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
    const asked: string[] = [];
    const panel = (ownership: "coordinator" | "taken-over") => (
      <SessionInspector
        {...base}
        sessionId="child"
        sessions={[
          row("coordinator", "Coordinator"),
          row("child", "Implementer", {
            spawnedBySessionId: "coordinator",
            spawnOwnership: ownership,
          }),
        ]}
        onSetSpawnOwnership={(value) => asked.push(value)}
      />
    );
    const action = (label: string) =>
      [...host.querySelectorAll("button")].find((button) =>
        button.textContent?.startsWith(label),
      );

    // A poke never moves ownership, so taking over is offered explicitly.
    act(() => root.render(panel("coordinator")));
    expect(action("Hand back")).toBeUndefined();
    act(() => action("Take over")!.click());

    // Once taken, the action hands it back and names who gets it.
    act(() => root.render(panel("taken-over")));
    expect(action("Take over")).toBeUndefined();
    expect(action("Hand back")!.textContent).toContain("Coordinator");
    act(() => action("Hand back")!.click());
    expect(asked).toEqual(["taken-over", "coordinator"]);
  });

  it("offers no ownership action on a session nothing spawned", () => {
    const markup = render({
      ...base,
      onSetSpawnOwnership: () => {},
    });
    expect(markup).not.toContain("Take over");
    expect(markup).not.toContain("Hand back");
  });
});
