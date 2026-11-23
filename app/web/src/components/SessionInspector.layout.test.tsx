// @vitest-environment jsdom
/**
 * What the session Details panel puts where: where it runs and the runtime
 * facts it is asked for most (account/model/thinking) in one Details section,
 * and a Tasks group that cannot grow past its first page.
 *   pnpm --filter @assistant/web test src/components/SessionInspector.layout.test.tsx
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ModelOption,
  ProjectRecord,
  SessionListItem,
  SessionRuntimeChange,
  TaskSummary,
  WorktreeRecord,
} from "@assistant/shared";
import {
  SessionInspector,
  sessionInspectorActions,
} from "./objectInspectors.tsx";
import { DialogProvider } from "./common/dialogs.tsx";
import type { SessionRuntimeControl } from "./SessionRuntimeSection.tsx";
import { failed, loading, ready } from "../lib/loadState.ts";

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
  it("shows the cap and lets the user set or reset it", async () => {
    const asked: Array<[string, number | null]> = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    const props = {
      ...base,
      sessions: [
        { id: "s1", title: "Session", peerTurnCap: 6 } as SessionListItem,
      ],
      onSetPeerTurnCap: (id: string, cap: number | null) => {
        asked.push([id, cap]);
      },
    };
    await act(async () => root.render(<SessionInspector {...props} />));
    const trigger = () =>
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Peer turns at once"]',
      )!;
    expect(trigger().textContent).toContain("6");
    await act(async () => trigger().click());
    const option = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (item) => item.textContent === label,
      )!;
    await act(async () => option("8").click());
    expect(asked).toEqual([["s1", 8]]);
    await act(async () => trigger().click());
    await act(async () => option("Default (4)").click());
    expect(asked).toEqual([
      ["s1", 8],
      ["s1", null],
    ]);
  });
  it("offers Require enterprise account only when it would apply, and sends it once confirmed", async () => {
    const account = { name: "Personal", provider: "claude" as const };
    const action = (html: string) =>
      html.includes("Require enterprise account");
    const row = (requiresEnterprise?: true) => [
      {
        id: "s1",
        title: "Session",
        ...(requiresEnterprise ? { requiresEnterprise } : {}),
      } as SessionListItem,
    ];
    const offered = {
      ...base,
      sessions: row(),
      credentialProfile: account,
      enterpriseAccountAvailable: true,
      onRequireEnterprise: () => {},
    };
    expect(action(render(offered))).toBe(true);
    expect(
      action(render({ ...offered, enterpriseAccountAvailable: false })),
    ).toBe(false);
    expect(action(render({ ...offered, onRequireEnterprise: undefined }))).toBe(
      false,
    );
    expect(action(render({ ...offered, credentialProfile: undefined }))).toBe(
      false,
    );
    expect(
      action(
        render({
          ...offered,
          credentialProfile: {
            name: "Endpoint",
            provider: "openai-compatible",
          },
        }),
      ),
    ).toBe(false);
    const required = render({ ...offered, sessions: row(true) });
    expect(action(required)).toBe(false);
    expect(required).toContain("enterprise only");

    const asked: string[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () =>
      root.render(
        <DialogProvider>
          <SessionInspector
            {...offered}
            onRequireEnterprise={(id) => asked.push(id)}
          />
        </DialogProvider>,
      ),
    );
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.trim() === label,
      );
    await act(async () => button("Require enterprise account")!.click());
    expect(document.body.textContent).toContain("This cannot be undone.");
    expect(document.body.textContent).toContain("next turn moves it");
    expect(asked).toEqual([]);
    await act(async () => button("Cancel")!.click());
    expect(asked).toEqual([]);
    await act(async () => button("Require enterprise account")!.click());
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="dialog"] button, dialog button',
      ),
    ].find((item) => item.textContent?.trim() === "Require enterprise account");
    await act(async () => confirm!.click());
    expect(asked).toEqual(["s1"]);
  });

  it("disables Require enterprise account while the session runs, with a hint", async () => {
    const props = {
      ...base,
      credentialProfile: { name: "Personal", provider: "claude" as const },
      enterpriseAccountAvailable: true,
      onRequireEnterprise: () => {},
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    const show = (isStreaming: boolean) =>
      act(async () =>
        root.render(
          <DialogProvider>
            <SessionInspector
              {...props}
              sessions={[
                {
                  id: "s1",
                  title: "Session",
                  ...(isStreaming ? { isStreaming } : {}),
                } as SessionListItem,
              ]}
            />
          </DialogProvider>,
        ),
      );
    const button = () =>
      [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.trim() === "Require enterprise account",
      );
    const hint = "Available once the current turn ends.";

    await show(true);
    expect(button()).toBeDefined();
    expect(button()!.disabled).toBe(true);
    expect(host.textContent).toContain(hint);
    const describedBy = button()!.getAttribute("aria-describedby");
    expect(
      describedBy && document.getElementById(describedBy)?.textContent,
    ).toBe(hint);

    await show(false);
    expect(button()!.disabled).toBe(false);
    expect(button()!.hasAttribute("aria-describedby")).toBe(false);
    expect(host.textContent).not.toContain(hint);
  });

  describe("Runtime section", () => {
    const opus: ModelOption = {
      provider: "anthropic",
      id: "claude-opus",
      name: "Claude Opus",
      reasoning: true,
      supportedThinkingLevels: ["low", "medium", "high"],
      contextWindow: 200_000,
    };
    const sonnet: ModelOption = {
      ...opus,
      id: "claude-sonnet",
      name: "Claude Sonnet",
    };
    const gpt: ModelOption = {
      ...opus,
      provider: "openai-codex",
      id: "gpt-5.5",
      name: "GPT-5.5",
    };
    const mount = () => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      mounted = { host, root };
      return { host, root };
    };
    const control = (
      over: Partial<SessionRuntimeControl> = {},
    ): SessionRuntimeControl => ({
      current: {
        model: {
          provider: "anthropic",
          id: "claude-opus",
          name: "Claude Opus",
        },
        thinkingLevel: "high",
        accountName: "Personal",
      },
      pending: undefined,
      models: [opus, sonnet, gpt],
      modelRefusal: (model) =>
        model.provider === "openai-codex"
          ? "Another harness: not available yet"
          : undefined,
      accounts: {
        targets: undefined,
        onOpen: () => {},
        nameOf: (id) => ({ "cp-b": "Account B" })[id],
      },
      busy: false,
      onChange: () => {},
      onReset: () => {},
      ...over,
    });
    const show = (root: Root, runtime: SessionRuntimeControl) =>
      act(async () =>
        root.render(
          <SessionInspector
            {...base}
            sessions={[{ id: "s1", title: "Session" } as SessionListItem]}
            credentialProfile={{ name: "Personal", provider: "claude" }}
            runtime={runtime}
          />,
        ),
      );
    const trigger = (host: HTMLElement, label: string) =>
      host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    const options = () => [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ];

    it("shows the model, effort and account the next turn starts on, and no pending row", async () => {
      const { host, root } = mount();
      await show(root, control());
      expect(host.textContent).toContain("Runtime");
      expect(trigger(host, "Next turn's model").textContent).toContain(
        "Claude Opus",
      );
      expect(trigger(host, "Next turn's effort").textContent).toContain("High");
      expect(trigger(host, "Next turn's account").textContent).toContain(
        "Automatic · Personal",
      );
      expect(host.textContent).not.toContain("Next turn:");
      expect(
        [...host.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === "Reset",
        ),
      ).toBe(false);
    });

    it("lists another harness's model disabled with its reason, and sends the one picked", async () => {
      const { host, root } = mount();
      const changes: SessionRuntimeChange[] = [];
      await show(root, control({ onChange: (change) => changes.push(change) }));
      await act(async () => trigger(host, "Next turn's model").click());
      const gptOption = options().find((item) =>
        item.textContent?.includes("GPT-5.5"),
      )!;
      expect(gptOption.textContent).toContain(
        "Another harness: not available yet",
      );
      expect(gptOption.getAttribute("aria-disabled")).toBe("true");
      await act(async () =>
        options()
          .find((item) => item.textContent === "Claude Sonnet")!
          .click(),
      );
      expect(changes).toEqual([
        { model: { provider: "anthropic", id: "claude-sonnet" } },
      ]);
    });

    it("asks for the accounts when opened and states loading, empty and failure", async () => {
      const { host, root } = mount();
      let opened = 0;
      const accounts = (
        targets: NonNullable<SessionRuntimeControl["accounts"]>["targets"],
      ) => ({
        targets,
        onOpen: () => {
          opened += 1;
        },
        nameOf: () => undefined,
      });
      await show(root, control({ accounts: accounts(undefined) }));
      await act(async () => trigger(host, "Next turn's account").click());
      expect(opened).toBe(1);
      expect(document.body.textContent).toContain("Loading accounts…");
      await show(root, control({ accounts: accounts(loading()) }));
      expect(document.body.textContent).toContain("Loading accounts…");
      await show(root, control({ accounts: accounts(ready([])) }));
      expect(document.body.textContent).toContain(
        "No other account can run this model now.",
      );
      await show(
        root,
        control({
          accounts: accounts(failed("The accounts could not be read.")),
        }),
      );
      expect(document.body.textContent).toContain(
        "The accounts could not be read.",
      );
    });

    it("lists the eligible accounts after Automatic and sends the one picked", async () => {
      const { host, root } = mount();
      const changes: SessionRuntimeChange[] = [];
      await show(
        root,
        control({
          accounts: {
            targets: ready([
              { id: "cp-b", name: "Account B", enterprise: false },
              { id: "cp-w", name: "Work", enterprise: true },
            ]),
            onOpen: () => {},
            nameOf: () => undefined,
          },
          onChange: (change) => changes.push(change),
        }),
      );
      await act(async () => trigger(host, "Next turn's account").click());
      expect(options().map((item) => item.textContent)).toEqual([
        "Automatickeeps Personal when it can",
        "Account B",
        "Workenterprise",
      ]);
      await act(async () => options()[2]!.click());
      expect(changes).toEqual([{ account: { kind: "account", id: "cp-w" } }]);
    });

    it("states a pending change, who chose it, and resets it", async () => {
      const { host, root } = mount();
      let resets = 0;
      await show(
        root,
        control({
          pending: {
            model: { provider: "anthropic", id: "claude-sonnet" },
            thinkingLevel: "medium",
            account: { kind: "account", id: "cp-b" },
            setBy: "coordinator",
          },
          onReset: () => {
            resets += 1;
          },
        }),
      );
      expect(host.textContent).toContain(
        "Next turn: Claude Sonnet · Medium · Account B",
      );
      expect(host.textContent).toContain(
        "Now: Claude Opus · High · Personal · chosen by its coordinating session",
      );
      expect(trigger(host, "Next turn's account").textContent).toContain(
        "Account B",
      );
      const reset = [
        ...host.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "Reset")!;
      await act(async () => reset.click());
      expect(resets).toBe(1);
    });

    it("shows a change in flight on Reset", async () => {
      const { host, root } = mount();
      await show(
        root,
        control({
          busy: true,
          pending: {
            model: { provider: "anthropic", id: "claude-opus" },
            thinkingLevel: "low",
            account: { kind: "automatic" },
            setBy: "user",
          },
        }),
      );
      const reset = [
        ...host.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "Reset")!;
      expect(reset.getAttribute("aria-busy")).toBe("true");
    });

    it("shows a fixed account as text, without a picker", async () => {
      const { host, root } = mount();
      await show(root, control({ accounts: undefined }));
      expect(
        host.querySelector('[aria-label="Next turn\'s account"]'),
      ).toBeNull();
      expect(host.textContent).toContain("Personal");
    });
  });

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

  it("states where it runs, the account, model and thinking level in one Details section", () => {
    const html = render({
      ...base,
      credentialProfile: { name: "Work", provider: "claude" },
      model: { id: "claude-opus-5", name: "Opus 5", provider: "claude-sdk" },
      thinkingLevel: "high",
    });
    expect(html).toContain(">Details<");
    expect(html).not.toContain("Profile");
    // One labelled row per fact; the account is its NAME only, without the
    // provider.
    const doc = new DOMParser().parseFromString(html, "text/html");
    const fact = (label: string) =>
      [...doc.querySelectorAll("span")].find(
        (span) => span.textContent === label,
      )?.nextElementSibling?.textContent;
    expect(fact("Project")).toBe("None");
    expect(fact("Worktree")).toBe("None");
    expect(fact("Account")).toBe("Work");
    expect(fact("Model")).toBe("Opus 5");
    expect(fact("Thinking")).toBe("High");
    expect(html).not.toContain("Work · Claude");
    expect(html).not.toContain("Bound when this session started");
  });

  it("states a waiting child's Status in Details only while it waits", () => {
    const child = (extra: Partial<SessionListItem>) =>
      ({
        id: "s1",
        harness: "pi",
        agentType: "developer",
        title: "A session",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        spawnedBySessionId: "coordinator",
        ...extra,
      }) as SessionListItem;
    const status = (sessions: SessionListItem[]) => {
      const doc = new DOMParser().parseFromString(
        render({ ...base, sessions }),
        "text/html",
      );
      return [...doc.querySelectorAll("span")].find(
        (span) => span.textContent === "Status",
      )?.nextElementSibling?.textContent;
    };
    expect(status([child({ waitingForSlot: { position: 3 } })])).toBe(
      "Waiting for a slot (position 3)",
    );
    expect(status([child({})])).toBeUndefined();
    expect(status([])).toBeUndefined();
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

    const open = (title: string) =>
      host.querySelector<HTMLButtonElement>(
        `button[aria-label="Open ${title}"]`,
      );

    act(() => root.render(<SessionInspector {...props} sessionId="child" />));
    expect(open("Coordinator")).not.toBeNull();
    act(() => open("Coordinator")!.click());

    act(() =>
      root.render(<SessionInspector {...props} sessionId="coordinator" />),
    );
    const row = host.querySelector<HTMLElement>('[data-list-row-id="child"]');
    expect(row?.textContent).toContain("Implementer");
    // The coordinator's row states that the user owns this child now, in the
    // details the row unfolds, without changing what it opens.
    expect(row?.textContent).not.toContain("Taken over");
    act(() =>
      row!
        .querySelector<HTMLButtonElement>('button[title="Show details"]')!
        .click(),
    );
    expect(row?.textContent).toContain("Taken over");
    act(() => open("Implementer")!.click());
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

  // The ownership action lives in the session's actions (the header's ⋯).
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

describe("SessionInspector spawn-tree worktrees", () => {
  const peer: SessionListItem = {
    id: "peer",
    title: "Peer",
    harness: "pi",
    agentType: "developer",
    createdAt: 0,
    updatedAt: 0,
    messageCount: 1,
    spawnedBySessionId: "s1",
    spawnOwnership: "coordinator",
  };
  const handed: WorktreeRecord = {
    id: "wt-handed",
    projectId: "p1",
    mainRepoRoot: "/repo",
    path: "/repo-handed",
    branch: "handed-branch",
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    sessionIds: ["peer"],
    taskIds: [],
    treeSessionIds: ["peer", "s1"],
    createdAt: 0,
    updatedAt: 0,
  };
  // The rows are the sidebar's tree, which finds a worktree under its project.
  const projects: ProjectRecord[] = [{ id: "p1", name: "Project", key: "P1" }];

  it("reserves the group while the list is unanswered, for a session with a peer", () => {
    const html = render({ ...base, sessions: [peer], worktrees: null });
    expect(html).toContain("Worktrees from this session");
    expect(html).toContain('aria-label="Loading worktrees"');
    // Without evidence of a tree, nothing is reserved.
    expect(render({ ...base, worktrees: null })).not.toContain(
      "Worktrees from this session",
    );
  });

  it("states a failed first read with its retry instead of a skeleton", () => {
    const html = render({
      ...base,
      sessions: [peer],
      worktrees: null,
      worktreesError: "socket closed",
      onReloadWorktrees: () => {},
    });
    expect(html).toContain("socket closed");
    expect(html).not.toContain('aria-label="Loading worktrees"');
  });

  it("marks a refresh over retained rows", () => {
    const html = render({
      ...base,
      sessions: [peer],
      projects,
      worktrees: [handed],
      worktreesFresh: false,
    });
    expect(html).toContain("handed-branch");
    expect(html).toContain("Refreshing worktrees");
    expect(
      render({
        ...base,
        sessions: [peer],
        worktrees: [handed],
        worktreesFresh: true,
      }),
    ).not.toContain("Refreshing worktrees");
  });

  it("keeps retained rows and states a failed refresh beside them", () => {
    const html = render({
      ...base,
      sessions: [peer],
      projects,
      worktrees: [handed],
      worktreesError: "socket closed",
      onReloadWorktrees: () => {},
    });
    expect(html).toContain("handed-branch");
    expect(html).toContain("socket closed");
  });
});
