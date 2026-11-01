// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  AgentInfo,
  WorktreeRecord,
  AccountPickPreviewResult,
  ClientMessage,
  CredentialProfileSummary,
  ModelOption,
  PullRequestInventoryItem,
  PullRequestCheckoutOutcome,
  ServerMessage,
} from "@assistant/shared";
import type { UsageIndicator } from "@assistant/shared/usage";
import {
  settingsAgents,
  settingsFixture,
} from "../component-preview/fixtures/settings.ts";

/**
 * WHO runs a new session (Task-787): Automatic unless the user picks an
 * account, optionally restricted to enterprise accounts. The first send states
 * exactly that — no account for Automatic, so the server's router picks one,
 * and `requiresEnterprise` whenever the restriction is on.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.setConfig({ testTimeout: 20_000 });

class ScenarioSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: ScenarioSocket[] = [];
  readyState = ScenarioSocket.CONNECTING;
  sent: ClientMessage[] = [];
  subscribedTopics = new Set<string>();
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    ScenarioSocket.instances.push(this);
  }
  open(): void {
    this.readyState = ScenarioSocket.OPEN;
    this.onopen?.();
  }
  receive(message: ServerMessage): void {
    if (
      message.type === "usageIndicators" &&
      !this.subscribedTopics.has("usage")
    )
      throw new Error("The server only sends usage to subscribers.");
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  send(source: string): void {
    const message = JSON.parse(source) as ClientMessage;
    this.sent.push(message);
    if (message.type === "subscribe")
      for (const topic of message.topics) this.subscribedTopics.add(topic);
    if (message.type === "unsubscribe")
      for (const topic of message.topics) this.subscribedTopics.delete(topic);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

/**
 * The review hand-off the App gives the pull request's actions provider, which
 * owns it for the panel and the page alike; the inspector stand-in calls it.
 */
const reviewSeam = vi.hoisted(() => ({
  onReview: undefined as
    | ((
        item: PullRequestInventoryItem,
        id: string,
        outcome: PullRequestCheckoutOutcome,
      ) => void)
    | undefined,
}));

vi.mock(
  "./components/pullRequest/PullRequestActions.tsx",
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import("./components/pullRequest/PullRequestActions.tsx")
      >();
    return {
      ...real,
      PullRequestActionsProvider: ({
        onReview,
        children,
      }: {
        onReview: NonNullable<typeof reviewSeam.onReview>;
        children: ReactNode;
      }) => {
        reviewSeam.onReview = onReview;
        return children;
      },
    };
  },
);

// Keep the App's real fresh-start handlers while replacing the heavy object
// inspectors with buttons that exercise their public callback seam.
vi.mock("./components/objectInspectors.tsx", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("./components/objectInspectors.tsx")>();
  return {
    ...real,
    ProjectInspector: ({
      onStartSession,
    }: {
      onStartSession: (id: string) => void;
    }) => (
      <button
        data-testid="fresh-project"
        onClick={() => onStartSession("default-project")}
      >
        Start in project
      </button>
    ),
    WorktreeInspector: ({
      onStartSession,
    }: {
      onStartSession: (id: string) => void;
    }) => (
      <button
        data-testid="fresh-worktree"
        onClick={() => onStartSession("wt-reset")}
      >
        Start in worktree
      </button>
    ),
    PullRequestInspector: () => (
      <button
        data-testid="fresh-pr-review"
        onClick={() =>
          reviewSeam.onReview?.(reviewFixture, "wt-reset", {
            status: "already-current",
            worktreeId: "wt-reset",
            branch: "feature",
            head: "test-head",
            base: {
              branch: "main",
              pullRequestBase: "main",
              matchesPullRequestBase: true,
            },
            taskIds: [],
          })
        }
      >
        Review pull request
      </button>
    ),
  };
});

await import("./components/MessageList.tsx");
const App = (await import("./App.tsx")).default;
const { ShortcutsProvider } = await import("./components/common/shortcuts.tsx");

const FRAME_MS = 25;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(frames = 4): Promise<void> {
  for (let i = 0; i < frames; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
    });
}

function account(
  id: string,
  name: string,
  enterprise: boolean,
): CredentialProfileSummary {
  return {
    id,
    name,
    provider: "claude",
    enabled: true,
    enterprise,
    status: "ready",
    health: { state: "ok", since: null },
    createdAt: 0,
    updatedAt: 0,
  } as CredentialProfileSummary;
}

const sonnet: ModelOption = {
  provider: "claude-sdk",
  id: "sonnet",
  name: "Claude Sonnet",
  reasoning: true,
  supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
  contextWindow: 200_000,
};

const PERSONAL = account("claude-personal", "Personal Max", false);
const WORK = account("claude-work", "Work Enterprise", true);
const reviewFixture = {
  projectId: "reset-project",
  provider: "github",
  repositoryKey: "owner/repo",
  number: 1,
  title: "Fresh review",
  url: "https://example.test/owner/repo/pull/1",
  taskIds: [],
  headBranch: "feature",
  baseBranch: "main",
} as unknown as PullRequestInventoryItem;
const { pullRequestPath } = await import("./hooks/useSessionRouting.ts");

function projection(profiles: CredentialProfileSummary[]) {
  return {
    profiles,
    modelsByProfile: Object.fromEntries(
      profiles.map((profile) => [profile.id, [sonnet]]),
    ),
  };
}

function readyMessage(
  settings: Partial<AppSettings> = {},
  agents: AgentInfo[] = [],
): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [sonnet],
    agents,
    settings,
    speechToText: {
      configured: false,
      availableModelIds: [],
      maxUtteranceSeconds: 120,
    },
    slashCommands: [],
    contextInfo: null,
  } as unknown as ServerMessage;
}

beforeEach(() => {
  window.localStorage.clear();
  ScenarioSocket.instances = [];
  vi.stubGlobal("WebSocket", ScenarioSocket);
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.stubGlobal("IntersectionObserver", NoopObserver);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
  Element.prototype.scrollIntoView = () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** Pick-preview requests the page made, as sent. */
let previews: Array<Record<string, unknown>> = [];
/** Prompt-refinement requests the page made, as sent. */
let refines: Array<Record<string, unknown>> = [];

async function openNewSession(
  profiles: CredentialProfileSummary[],
  /** The server router's preview answer for Automatic. */
  pick: (
    request: Record<string, unknown>,
  ) => string | null | AccountPickPreviewResult = () => null,
  initial: {
    path?: string;
    settings?: Partial<AppSettings>;
    agents?: AgentInfo[];
  } = {},
): Promise<ScenarioSocket> {
  previews = [];
  refines = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/prompt/refine")) {
        refines.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ refinedText: "refined draft" });
      }
      if (String(url).endsWith("/api/account-router/pick")) {
        const request = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        previews.push(request);
        const answer = pick(request);
        return json(
          answer && typeof answer === "object" ? answer : { profileId: answer },
        );
      }
      if (String(url).endsWith("/api/pull-requests"))
        return json({ status: "ready", items: [], fetchedAt: 0 });
      return json(projection(profiles));
    }),
  );
  window.history.replaceState(null, "", initial.path ?? "/sessions/create");
  await act(async () => {
    root!.render(
      <ShortcutsProvider>
        <App />
      </ShortcutsProvider>,
    );
  });
  const socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage(initial.settings, initial.agents));
  });
  await settle();
  return socket;
}

/** The provider-account row's cards, by visible name. */
function accountCard(name: string): HTMLElement | undefined {
  return [...container!.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (node) => node.textContent?.startsWith(name),
  );
}

async function click(node: HTMLElement | undefined | null): Promise<void> {
  expect(node).toBeTruthy();
  await act(async () => node!.click());
  await settle(2);
}

async function typeDraft(text: string): Promise<void> {
  const textarea = container!.querySelector("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setValue.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function refineDraft(text: string): Promise<void> {
  await typeDraft(text);
  await click(
    container!.querySelector<HTMLElement>(
      'button[aria-label="Refine draft prompt"]',
    ),
  );
}

async function sendPrompt(text: string): Promise<void> {
  const textarea = container!.querySelector("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setValue.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(
    container!.querySelector<HTMLElement>('button[aria-label="Send message"]'),
  );
}

function firstSend(
  socket: ScenarioSocket,
): Extract<ClientMessage, { type: "harnessSend" }> | undefined {
  return socket.sent.find(
    (message): message is Extract<ClientMessage, { type: "harnessSend" }> =>
      message.type === "harnessSend",
  );
}

function requiresEnterpriseSwitch(): HTMLElement | null {
  const label = [...container!.querySelectorAll("label")].find(
    (node) => node.textContent === "Requires enterprise",
  );
  return label
    ? container!.querySelector<HTMLElement>(`#${label.htmlFor}`)
    : null;
}

const defaultProject = {
  id: "default-project",
  name: "Default project",
  key: "DP",
};
const mainWorktree: WorktreeRecord = {
  id: "main:default-project",
  projectId: defaultProject.id,
  isMain: true,
  mainRepoRoot: "/projects/default",
  path: "/projects/default",
  branch: "trunk",
  baseBranch: "trunk",
  baseCommit: "abc",
  status: "active",
  sessionIds: [],
  taskIds: [],
  createdAt: 0,
  updatedAt: 0,
};
const projectAgents: AgentInfo[] = [
  { agentType: "assistant", label: "Assistant" },
  { agentType: "developer", label: "Developer" },
  { agentType: "workshop", label: "Workshop", devOnly: true },
];

async function receiveProjects(socket: ScenarioSocket): Promise<void> {
  await act(async () =>
    socket.receive({
      type: "projectList",
      list: {
        request: { includeArchived: true },
        projects: [defaultProject, { id: "other", name: "Other", key: "OT" }],
        updatedAt: 1,
      },
      seq: 1,
      revisions: [
        { id: defaultProject.id, revision: 1 },
        { id: "other", revision: 1 },
      ],
    }),
  );
  await settle();
}

async function receiveWorktrees(
  socket: ScenarioSocket,
  worktrees: WorktreeRecord[],
): Promise<void> {
  await act(async () =>
    socket.receive({ type: "worktreeList", worktrees, updatedAt: Date.now() }),
  );
  await settle();
}

function projectCard(): HTMLElement | null {
  return container!.querySelector('button[title="Narrow to Default project"]');
}

function selectedMain(): HTMLElement | null {
  return container!.querySelector(
    'button[title="Remove worktree main checkout"]',
  );
}

function personaCard(name: string): HTMLElement | undefined {
  return [...container!.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (node) => node.textContent === name,
  );
}

describe("project-only session defaults", () => {
  it("selects the project's main checkout and Developer, even when Workshop is available", async () => {
    const socket = await openNewSession([PERSONAL], undefined, {
      agents: projectAgents,
    });
    await receiveProjects(socket);
    await receiveWorktrees(socket, [
      { ...mainWorktree, id: "feature", isMain: false, updatedAt: 10 },
      { ...mainWorktree, id: "other-main", projectId: "other" },
      { ...mainWorktree, id: "removed-main", removedAt: 1 },
      mainWorktree,
    ]);
    expect(selectedMain()).toBeNull();
    await click(projectCard());
    expect(selectedMain()).not.toBeNull();
    expect(personaCard("Developer")?.getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(firstSend(socket)).toBeUndefined();
    await sendPrompt("Fix this project");
    expect(firstSend(socket)).toMatchObject({
      agentType: "developer",
      worktreeId: mainWorktree.id,
      projectId: defaultProject.id,
      modelProvider: "claude-sdk",
      modelId: "sonnet",
    });
  });

  it("defaults a project already staged by its Start session action when worktrees arrive later", async () => {
    const socket = await openNewSession([PERSONAL], undefined, {
      agents: projectAgents,
      path: `/projects/${defaultProject.id}`,
    });
    await receiveProjects(socket);
    await click(container!.querySelector('[data-testid="fresh-project"]'));
    expect(window.location.pathname).toBe("/sessions/create");
    expect(selectedMain()).toBeNull();
    await receiveWorktrees(socket, [mainWorktree]);
    expect(selectedMain()).not.toBeNull();
    expect(personaCard("Developer")?.getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it.each([false, true])(
    "follows a project change with untouched defaults, clearing the old project first=%s",
    async (clearFirst) => {
      const socket = await openNewSession([PERSONAL], undefined, {
        agents: projectAgents,
      });
      await receiveProjects(socket);
      const otherMain = {
        ...mainWorktree,
        id: "main:other",
        projectId: "other",
      };
      await receiveWorktrees(socket, [mainWorktree, otherMain]);
      await click(projectCard());
      expect(selectedMain()).not.toBeNull();
      if (clearFirst)
        await click(
          container!.querySelector(
            'button[title="Remove project Default project"]',
          ),
        );
      await click(container!.querySelector('button[title="Narrow to Other"]'));
      expect(selectedMain()).not.toBeNull();
      expect(personaCard("Developer")?.getAttribute("aria-selected")).toBe(
        "true",
      );
      await sendPrompt("Work on the other project");
      expect(firstSend(socket)).toMatchObject({
        agentType: "developer",
        projectId: "other",
        worktreeId: otherMain.id,
      });
    },
  );

  it.each(["persona", "worktree"])(
    "does not treat an explicit %s pick as an untouched project default",
    async (axis) => {
      const socket = await openNewSession([PERSONAL], undefined, {
        agents: projectAgents,
      });
      await receiveProjects(socket);
      const feature = {
        ...mainWorktree,
        id: "feature",
        isMain: false,
        branch: "feature",
      };
      const otherMain = {
        ...mainWorktree,
        id: "main:other",
        projectId: "other",
      };
      await receiveWorktrees(socket, [mainWorktree, feature, otherMain]);
      await click(projectCard());
      if (axis === "persona") await click(personaCard("Assistant"));
      else {
        await click(
          container!.querySelector('button[title="Start in feature"]'),
        );
        await click(
          container!.querySelector('button[title="Start in main checkout"]'),
        );
      }
      await click(container!.querySelector('button[title="Narrow to Other"]'));
      expect(selectedMain()).toBeNull();
      expect(personaCard("Assistant")?.getAttribute("aria-selected")).toBe(
        "true",
      );
    },
  );

  it("preserves an explicit persona picked before the project", async () => {
    const socket = await openNewSession([PERSONAL], undefined, {
      agents: projectAgents,
    });
    await receiveProjects(socket);
    await click(personaCard("Developer"));
    await click(personaCard("Assistant"));
    await click(projectCard());
    await receiveWorktrees(socket, [mainWorktree]);
    expect(selectedMain()).toBeNull();
    expect(personaCard("Assistant")?.getAttribute("aria-selected")).toBe(
      "true",
    );
    await sendPrompt("Discuss this project");
    expect(firstSend(socket)?.worktreeId).toBeUndefined();
    expect(firstSend(socket)?.agentType).toBe("assistant");
  });

  it("does not restore a default worktree the user removed", async () => {
    const socket = await openNewSession([PERSONAL], undefined, {
      agents: projectAgents,
    });
    await receiveProjects(socket);
    await receiveWorktrees(socket, [mainWorktree]);
    await click(projectCard());
    await click(selectedMain());
    await receiveWorktrees(socket, [{ ...mainWorktree, updatedAt: 10 }]);
    expect(selectedMain()).toBeNull();
    expect(personaCard("Assistant")?.getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it.each(["existing", "new"])(
    "keeps a %s worktree choice when the main checkout arrives later",
    async (choice) => {
      const socket = await openNewSession([PERSONAL], undefined, {
        agents: projectAgents,
      });
      await receiveProjects(socket);
      const feature = {
        ...mainWorktree,
        id: "feature",
        isMain: false,
        branch: "feature",
      };
      await receiveWorktrees(socket, [feature]);
      await click(projectCard());
      await click(
        container!.querySelector(
          choice === "new"
            ? 'button[title="Create a worktree in Default project when you send"]'
            : 'button[title="Start in feature"]',
        ),
      );
      await receiveWorktrees(socket, [feature, mainWorktree]);
      expect(selectedMain()).toBeNull();
      await sendPrompt("Implement this");
      if (choice === "existing")
        expect(firstSend(socket)?.worktreeId).toBe("feature");
      else
        expect(firstSend(socket)?.createWorktreeInProjectId).toBe(
          defaultProject.id,
        );
    },
  );

  it("leaves a project without a main checkout as an Assistant draft", async () => {
    const socket = await openNewSession([PERSONAL], undefined, {
      agents: projectAgents,
    });
    await receiveProjects(socket);
    await receiveWorktrees(socket, [{ ...mainWorktree, removedAt: 1 }]);
    await click(projectCard());
    expect(selectedMain()).toBeNull();
    expect(personaCard("Assistant")?.getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});

describe("named definitions keep account intent", () => {
  it.each([
    [null, false],
    [PERSONAL.id, false],
    [WORK.id, true],
  ] as const)(
    "staging a definition keeps pin=%s and enterprise=%s",
    async (pin, enterprise) => {
      const socket = await openNewSession([PERSONAL, WORK]);
      if (enterprise) await click(requiresEnterpriseSwitch());
      if (pin !== null)
        await click(accountCard(pin === WORK.id ? WORK.name : PERSONAL.name));
      await act(async () =>
        socket.receive({
          type: "libraryList",
          library: "agents",
          list: {
            ...settingsAgents,
            entries: settingsAgents.entries.filter(
              (entry) => entry.name === "release-scribe",
            ),
            diagnostics: [],
            agentRuntimes: {
              "release-scribe": {
                persona: "assistant",
                provider: "claude-sdk",
                modelId: "sonnet",
                thinkingLevel: "low",
                models: [],
              },
            },
          },
        }),
      );
      await settle();
      await click(
        container!.querySelector<HTMLElement>(
          'button[title^="Start as release-scribe:"]',
        ),
      );
      expect(
        accountCard(
          pin === null
            ? "Automatic"
            : pin === WORK.id
              ? WORK.name
              : PERSONAL.name,
        )?.getAttribute("aria-selected"),
      ).toBe("true");
      await sendPrompt("Draft notes.");
      const sent = firstSend(socket)!;
      expect(sent).toMatchObject({
        agent: "release-scribe",
        modelProvider: "claude-sdk",
        modelId: "sonnet",
        thinkingLevel: "low",
      });
      if (pin === null) expect("credentialProfileId" in sent).toBe(false);
      else expect(sent.credentialProfileId).toBe(pin);
      if (enterprise) expect(sent.requiresEnterprise).toBe(true);
      else expect("requiresEnterprise" in sent).toBe(false);
    },
  );
});

describe("a picked role keeps what the user picks to run it", () => {
  /** Stage release-scribe: an assistant on sonnet at low effort. */
  async function stageScribe(socket: ScenarioSocket): Promise<void> {
    await act(async () =>
      socket.receive({
        type: "libraryList",
        library: "agents",
        list: {
          ...settingsAgents,
          entries: settingsAgents.entries.filter(
            (entry) => entry.name === "release-scribe",
          ),
          diagnostics: [],
          agentRuntimes: {
            "release-scribe": {
              persona: "assistant",
              provider: "claude-sdk",
              modelId: "sonnet",
              thinkingLevel: "low",
              models: [],
            },
          },
        },
      }),
    );
    await settle();
    await click(
      container!.querySelector<HTMLElement>(
        'button[title^="Start as release-scribe:"]',
      ),
    );
  }

  /** Move the thinking slider to the model's level at `index`. */
  async function setThinking(index: number): Promise<void> {
    const slider = container!.querySelector<HTMLInputElement>(
      'input[type="range"]',
    )!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(slider, String(index));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  }

  it("an effort pick keeps the role, and the first send runs the pick", async () => {
    const socket = await openNewSession([PERSONAL]);
    await stageScribe(socket);
    // sonnet: off, low, medium, high, xhigh.
    await setThinking(3);
    expect(
      container!.querySelector(
        'button[title="Start as a plain session instead of release-scribe"]',
      ),
    ).not.toBeNull();
    await sendPrompt("Draft notes.");
    expect(firstSend(socket)).toMatchObject({
      agent: "release-scribe",
      modelProvider: "claude-sdk",
      modelId: "sonnet",
      thinkingLevel: "high",
    });
  });

  it("moves through personas and roles with the arrow keys, as one tab stop", async () => {
    const socket = await openNewSession([PERSONAL], undefined, {
      agents: projectAgents,
    });
    await stageScribe(socket);
    const row = container!.querySelector(
      '[role="listbox"][aria-label="Agent"]',
    )!;
    const options = [...row.querySelectorAll<HTMLElement>('[role="option"]')];
    // The personas, then the role after them.
    expect(options.length).toBeGreaterThan(2);
    expect(options.at(-1)?.textContent).toBe("release-scribe");
    // Roving focus: the row is one tab stop, not one per option.
    expect(options.filter((option) => option.tabIndex === 0)).toHaveLength(1);
    await act(async () => options[0]!.focus());
    await act(async () => {
      options[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(options[1]);
    await act(async () => {
      options[1]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(options[2]);
  });

  it("picking the plain persona leaves the role", async () => {
    const socket = await openNewSession([PERSONAL], undefined, {
      agents: projectAgents,
    });
    await stageScribe(socket);
    expect(personaCard("Assistant")?.getAttribute("aria-selected")).toBe(
      "false",
    );
    await click(personaCard("Assistant"));
    expect(personaCard("Assistant")?.getAttribute("aria-selected")).toBe(
      "true",
    );
    await sendPrompt("Draft notes.");
    expect("agent" in firstSend(socket)!).toBe(false);
  });
});

describe("desktop Sessions quick-start usage", () => {
  it("subscribes on a cold /sessions load, updates meters and Automatic, and unsubscribes away", async () => {
    let picked = PERSONAL.id;
    const socket = await openNewSession([PERSONAL, WORK], () => picked, {
      path: "/sessions",
    });
    expect(socket.subscribedTopics.has("usage")).toBe(true);
    expect(accountCard("Automatic")?.textContent).toContain(
      "Now: Personal Max",
    );
    const beforeUsage = previews.length;
    const indicator: UsageIndicator = {
      profileId: PERSONAL.id,
      provider: "claude",
      refreshing: false,
      fetchedAt: Date.now(),
      limitsAvailable: true,
      short: { usedPct: 20, resetsAt: null },
      long: { usedPct: 30, resetsAt: null },
    };
    await act(async () =>
      socket.receive({ type: "usageIndicators", indicators: [indicator] }),
    );
    await settle();
    expect(accountCard("Personal Max")?.textContent).toContain("20%");
    expect(previews).toHaveLength(beforeUsage + 1);
    const intent = previews.at(-1);
    expect(intent).toMatchObject({
      model: { provider: sonnet.provider, modelId: sonnet.id },
      requiresEnterprise: false,
    });
    picked = WORK.id;
    await act(async () =>
      socket.receive({
        type: "usageIndicators",
        indicators: [{ ...indicator, refreshing: true }],
      }),
    );
    await settle();
    expect(previews).toHaveLength(beforeUsage + 1);
    await act(async () =>
      socket.receive({
        type: "usageIndicators",
        indicators: [
          {
            ...indicator,
            fetchedAt: indicator.fetchedAt! + 1,
            short: { usedPct: 95, resetsAt: null },
          },
        ],
      }),
    );
    await settle();
    expect(accountCard("Personal Max")?.textContent).toContain("95%");
    expect(accountCard("Automatic")?.textContent).toContain(
      "Now: Work Enterprise",
    );
    expect(previews).toHaveLength(beforeUsage + 2);
    expect(previews.at(-1)).toEqual(intent);
    await act(async () => {
      window.history.pushState(null, "", "/settings/appearance");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await settle();
    expect(socket.subscribedTopics.has("usage")).toBe(false);
    expect(() =>
      socket.receive({ type: "usageIndicators", indicators: [indicator] }),
    ).toThrow("The server only sends usage to subscribers.");
  });
});

describe("Settings Automatic account preview", () => {
  it("subscribes on a cold Settings load and re-resolves through socket usage state", async () => {
    await import("./components/SettingsPage.tsx");
    let picked = PERSONAL.id;
    const socket = await openNewSession([PERSONAL, WORK], () => picked, {
      path: "/settings/commit",
      settings: {
        ...settingsFixture,
        commitAgent: {
          provider: "claude-sdk",
          modelId: "sonnet",
          thinkingLevel: "low",
        },
      },
    });
    expect(socket.subscribedTopics.has("usage")).toBe(true);
    const beforeUsage = previews.length;
    expect(beforeUsage).toBeGreaterThan(0);
    const indicator: UsageIndicator = {
      profileId: PERSONAL.id,
      provider: "claude",
      refreshing: false,
      fetchedAt: 1,
      limitsAvailable: true,
      short: { usedPct: 20, resetsAt: null },
      long: { usedPct: 30, resetsAt: null },
    };
    async function receiveUsage(usage: UsageIndicator) {
      await act(async () =>
        socket.receive({ type: "usageIndicators", indicators: [usage] }),
      );
      await settle();
    }
    await receiveUsage(indicator);
    expect(previews).toHaveLength(beforeUsage + 1);
    expect(previews.at(-1)).toEqual({
      model: { provider: "claude-sdk", modelId: "sonnet" },
      thinkingLevel: "low",
      scope: "background",
    });
    expect(container!.textContent).toContain(
      "Automatic runs this on “Personal Max” right now.",
    );

    picked = WORK.id;
    await receiveUsage({ ...indicator, refreshing: true });
    expect(previews).toHaveLength(beforeUsage + 1);
    await receiveUsage({
      ...indicator,
      fetchedAt: 2,
      short: { usedPct: 95, resetsAt: null },
    });
    expect(previews).toHaveLength(beforeUsage + 2);
    expect(previews.at(-1)).toEqual(previews.at(-2));
    expect(container!.textContent).toContain(
      "Automatic runs this on “Work Enterprise” right now.",
    );

    await act(async () => {
      window.history.pushState(null, "", "/settings/appearance");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await settle();
    expect(socket.subscribedTopics.has("usage")).toBe(false);
  });
});

describe("live account limit views", () => {
  it("socket invalidation refreshes the mounted Settings account cards without a loop", async () => {
    const profiles = [{ ...PERSONAL }, WORK];
    const socket = await openNewSession(profiles, undefined, {
      path: "/settings/claude-sdk",
    });
    expect(container!.textContent).not.toContain("Limited until ");
    const until = Date.now() + 60_000;
    profiles[0]!.health = {
      state: "limited",
      since: 1,
      until,
      model: "sonnet",
      benchRevision: 1,
    };
    await act(async () => socket.receive({ type: "accountHealthChanged" }));
    await settle();
    expect(container!.textContent).toContain(
      `Limited until ${new Date(until).toLocaleString()} for sonnet`,
    );
    const calls = vi.mocked(fetch).mock.calls.length;
    await settle();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
    profiles[0]!.health = { state: "ok", since: 1, benchRevision: 2 };
    await act(async () => socket.receive({ type: "accountHealthChanged" }));
    await settle();
    expect(container!.textContent).not.toContain("Limited until ");
  });
  it.each(["/sessions/create", "/settings/commit"])(
    "%s preview updates for a shorter scope and early clear beneath an unchanged longest bench",
    async (path) => {
      const primaryUntil = Date.now() + 3600_000;
      const shortUntil = Date.now() + 300_000;
      const profiles = [
        {
          ...PERSONAL,
          health: {
            state: "limited" as const,
            since: 1,
            until: primaryUntil,
            model: "opus",
            benchRevision: 1,
          },
        },
        WORK,
      ];
      let capped = false;
      const socket = await openNewSession(
        profiles,
        () => ({
          profileId: PERSONAL.id,
          ...(capped
            ? {
                degraded: "no-eligible-account" as const,
                limited: { until: shortUntil, model: "sonnet" },
              }
            : {}),
        }),
        {
          path,
          settings: {
            ...settingsFixture,
            commitAgent: {
              provider: "claude-sdk",
              modelId: "sonnet",
              thinkingLevel: "low",
            },
          },
        },
      );
      const before = previews.length;
      const runtime = previews.at(-1);
      capped = true;
      profiles[0]!.health = { ...profiles[0]!.health, benchRevision: 2 };
      await act(async () => socket.receive({ type: "accountHealthChanged" }));
      await settle();
      expect(previews).toHaveLength(before + 1);
      expect(previews.at(-1)).toEqual(runtime);
      expect(container!.textContent).toContain("Limited until ");
      expect(container!.textContent).toContain(
        new Date(shortUntil).toLocaleString(),
      );
      capped = false;
      profiles[0]!.health = { ...profiles[0]!.health, benchRevision: 3 };
      await act(async () => socket.receive({ type: "accountHealthChanged" }));
      await settle();
      expect(previews).toHaveLength(before + 2);
      expect(previews.at(-1)).toEqual(runtime);
      expect(container!.textContent).not.toContain("Limited until ");
    },
  );
});

describe("new-session account choice", () => {
  it("health invalidation refreshes a limited Automatic preview when only its reset changes", async () => {
    let until = Date.now() + 60_000;
    const profiles = [
      {
        ...PERSONAL,
        health: { state: "limited" as const, since: 1, until, model: "sonnet" },
      },
      WORK,
    ];
    const socket = await openNewSession(profiles, () => ({
      profileId: PERSONAL.id,
      degraded: "no-eligible-account",
      limited: { until, model: "sonnet" },
    }));
    expect(accountCard("Automatic")?.textContent).toContain("Limited until ");
    const before = previews.length;
    until += 60_000;
    profiles[0]!.health = {
      state: "limited",
      since: 1,
      until,
      model: "sonnet",
    };
    await act(async () => socket.receive({ type: "accountHealthChanged" }));
    await settle();
    expect(previews).toHaveLength(before + 1);
    expect(accountCard("Automatic")?.textContent).toContain(
      new Date(until).toLocaleString(),
    );
    expect(container!.textContent).not.toContain("Needs login");
  });
  it("starts on Automatic and leaves the account to the server", async () => {
    const socket = await openNewSession([PERSONAL, WORK]);

    expect(accountCard("Automatic")?.getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(accountCard("Personal Max")?.getAttribute("aria-selected")).toBe(
      "false",
    );

    await sendPrompt("hello");
    const sent = firstSend(socket);
    expect(sent).toBeDefined();
    expect(sent).toMatchObject({ modelId: sonnet.id });
    expect(sent && "credentialProfileId" in sent).toBe(false);
    expect(sent && "requiresEnterprise" in sent).toBe(false);
  });

  it("shows the account the server's router would pick for Automatic", async () => {
    await openNewSession([PERSONAL, WORK], (request) =>
      request.requiresEnterprise ? WORK.id : PERSONAL.id,
    );

    expect(accountCard("Automatic")?.textContent).toContain(
      "Now: Personal Max",
    );
    expect(previews.at(-1)).toMatchObject({
      model: { provider: sonnet.provider, modelId: sonnet.id },
      requiresEnterprise: false,
    });

    await click(requiresEnterpriseSwitch());
    expect(previews.at(-1)).toMatchObject({ requiresEnterprise: true });
    expect(accountCard("Automatic")?.textContent).toContain(
      "Now: Work Enterprise",
    );
  });

  it("sends an explicitly picked account", async () => {
    const socket = await openNewSession([PERSONAL, WORK]);

    await click(accountCard("Personal Max"));
    expect(accountCard("Personal Max")?.getAttribute("aria-selected")).toBe(
      "true",
    );

    await sendPrompt("hello");
    expect(firstSend(socket)).toMatchObject({
      credentialProfileId: PERSONAL.id,
    });
  });

  it("offers only enterprise accounts once enterprise is required, and says so on the send", async () => {
    const socket = await openNewSession([PERSONAL, WORK]);

    // An explicit regular account cannot survive the restriction: it falls
    // back to Automatic instead of silently running a non-enterprise session.
    await click(accountCard("Personal Max"));
    await click(requiresEnterpriseSwitch());

    expect(accountCard("Personal Max")).toBeUndefined();
    expect(accountCard("Work Enterprise")).toBeDefined();
    expect(accountCard("Automatic")?.getAttribute("aria-selected")).toBe(
      "true",
    );

    await sendPrompt("hello");
    const sent = firstSend(socket);
    expect(sent).toMatchObject({ requiresEnterprise: true });
    expect(sent && "credentialProfileId" in sent).toBe(false);
  });

  it.each(["worktree", "pr-review"] as const)(
    "an explicit enterprise start does not leak into a fresh %s session",
    async (entry) => {
      const socket = await openNewSession([PERSONAL, WORK]);
      await click(requiresEnterpriseSwitch());
      await click(accountCard("Work Enterprise"));
      await sendPrompt("Enterprise start");
      expect(firstSend(socket)).toMatchObject({
        credentialProfileId: WORK.id,
        requiresEnterprise: true,
      });
      await act(async () => {
        window.history.pushState(
          null,
          "",
          entry === "worktree"
            ? "/worktrees/wt-reset"
            : pullRequestPath(reviewFixture),
        );
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await settle();
      await click(
        container!.querySelector<HTMLElement>(`[data-testid="fresh-${entry}"]`),
      );
      expect(accountCard("Automatic")?.getAttribute("aria-selected")).toBe(
        "true",
      );
      expect(accountCard("Personal Max")).toBeDefined();
      expect(previews.at(-1)).toMatchObject({ requiresEnterprise: false });
      await sendPrompt("Unrelated fresh work");
      const sends = socket.sent.filter(
        (message): message is Extract<ClientMessage, { type: "harnessSend" }> =>
          message.type === "harnessSend",
      );
      expect(sends).toHaveLength(2);
      expect("credentialProfileId" in sends[1]!).toBe(false);
      expect("requiresEnterprise" in sends[1]!).toBe(false);
    },
  );

  it("explains, and refuses to start, when enterprise is required but no account is one", async () => {
    const socket = await openNewSession([PERSONAL]);

    await click(requiresEnterpriseSwitch());

    expect(container!.textContent).toMatch(
      /no enabled account is marked enterprise/i,
    );
    await sendPrompt("hello");
    expect(firstSend(socket)).toBeUndefined();
  });

  it("keeps the pin and the enterprise requirement on the retry of a rejected first send", async () => {
    const socket = await openNewSession([PERSONAL, WORK]);
    await click(requiresEnterpriseSwitch());
    await click(accountCard("Work Enterprise"));

    await sendPrompt("hello");
    const first = firstSend(socket)!;
    expect(first).toMatchObject({
      credentialProfileId: WORK.id,
      requiresEnterprise: true,
    });

    await act(async () =>
      socket.receive({
        type: "error",
        message: "engine did not start",
        failedPromptClientRequestId: first.clientRequestId!,
      } as ServerMessage),
    );
    await settle(2);
    const retry = [
      ...container!.querySelectorAll<HTMLElement>("[role=alert] button"),
    ].find((node) => node.textContent === "Retry send");
    await click(retry);

    const sends = socket.sent.filter(
      (message): message is Extract<ClientMessage, { type: "harnessSend" }> =>
        message.type === "harnessSend",
    );
    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({
      credentialProfileId: WORK.id,
      requiresEnterprise: true,
      clientRequestId: first.clientRequestId,
    });
  });

  it("refuses, rather than reroutes, an explicit pick disabled while staged", async () => {
    const socket = await openNewSession([PERSONAL, WORK]);
    await click(accountCard("Personal Max"));

    // The account is disabled elsewhere; the projection refreshes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/api/account-router/pick")
          ? json({ profileId: null })
          : json(projection([{ ...PERSONAL, enabled: false }, WORK])),
      ),
    );
    await act(async () => {
      window.dispatchEvent(new Event("credentialProfilesChanged"));
    });
    await settle();

    expect(accountCard("Automatic")?.getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(container!.textContent).toContain(
      "“Personal Max” is disabled. Choose another account or Automatic.",
    );
    await sendPrompt("hello");
    expect(firstSend(socket)).toBeUndefined();
  });

  it("refines a staged enterprise-only draft only under the enterprise requirement", async () => {
    const socket = await openNewSession([PERSONAL, WORK]);
    await click(requiresEnterpriseSwitch());

    await refineDraft("tidy this up");

    expect(refines).toHaveLength(1);
    expect(refines[0]).toMatchObject({
      text: "tidy this up",
      requiresEnterprise: true,
    });
    expect(container!.querySelector("textarea")?.value).toBe("refined draft");
    // Refining is not a send: no session exists yet.
    expect(firstSend(socket)).toBeUndefined();
  });

  it("leaves an ordinary draft's refinement unrestricted", async () => {
    await openNewSession([PERSONAL, WORK]);

    await refineDraft("tidy this up");

    expect(refines).toHaveLength(1);
    expect(refines[0]).toMatchObject({ text: "tidy this up" });
    expect("requiresEnterprise" in refines[0]!).toBe(false);
  });
});
