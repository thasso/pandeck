import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  AgentType,
  CredentialProfileSummary,
  EntryLibraryList,
  ModelOption,
  ProjectRecord,
  SessionMode,
  ThinkingLevel,
  WorktreeRecord,
} from "@assistant/shared";
import type { UsageIndicator } from "@assistant/shared/usage";
import {
  NewSessionQuickStart,
  orderProjectsByActivity,
  orderWorktreesByActivity,
} from "./NewSessionQuickStart.tsx";
import {
  failed,
  idle,
  loading,
  ready,
  refreshing,
  type LoadState,
} from "../lib/loadState.ts";

const project = {
  id: "proj",
  name: "Demo Project",
  key: "DP",
  status: "active",
} as ProjectRecord;
const otherProject = {
  id: "other",
  name: "Other Project",
  key: "OP",
  status: "active",
} as ProjectRecord;

const model: ModelOption = {
  provider: "openai-codex",
  id: "gpt-test",
  name: "GPT Test",
  reasoning: true,
  supportedThinkingLevels: ["off", "medium", "high"],
  contextWindow: 200_000,
};
const otherModel: ModelOption = {
  ...model,
  id: "gpt-other",
  name: "GPT Other",
};

function worktree(overrides: Partial<WorktreeRecord>): WorktreeRecord {
  return {
    id: "wt1",
    projectId: "proj",
    branch: "feature/thing",
    baseBranch: "main",
    path: "/tmp/wt1",
    sessionIds: [],
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as WorktreeRecord;
}

function render(
  worktrees: WorktreeRecord[],
  opts: {
    selected?: string | null;
    models?: ModelOption[];
    thinkingLevel?: ThinkingLevel;
    loaded?: boolean;
    agentTypes?: AgentType[];
    agentType?: AgentType;
    projects?: ProjectRecord[];
    projectsLoaded?: boolean;
    selectedProjectId?: string | null;
    profiles?: CredentialProfileSummary[];
    selectedProfileId?: string;
    usageIndicators?: UsageIndicator[] | null;
    newWorktreeStaged?: boolean;
    mode?: SessionMode;
    agents?: LoadState<EntryLibraryList>;
    selectedAgent?: string | null;
    profilesLoaded?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <NewSessionQuickStart
      credentialProfiles={opts.profiles ?? []}
      credentialProfilesLoaded={opts.profilesLoaded ?? true}
      usageIndicators={opts.usageIndicators ?? null}
      selectedCredentialProfileId={opts.selectedProfileId}
      onSelectCredentialProfile={() => {}}
      agentTypes={opts.agentTypes ?? ["assistant"]}
      selectedAgentType={opts.agentType ?? "assistant"}
      onSelectAgentType={() => {}}
      worktrees={worktrees}
      worktreesLoaded={opts.loaded ?? true}
      projects={opts.projects ?? [project]}
      projectsLoaded={opts.projectsLoaded ?? true}
      selectedProjectId={opts.selectedProjectId ?? null}
      onSelectProject={() => {}}
      selectedWorktreeId={opts.selected ?? null}
      onSelectWorktree={() => {}}
      newWorktreeStaged={opts.newWorktreeStaged ?? false}
      onSelectNewWorktree={() => {}}
      models={opts.models ?? [model, otherModel]}
      selectedModel={(opts.models ?? [model, otherModel])[0]}
      onSelectModel={() => {}}
      thinkingLevel={opts.thinkingLevel ?? "medium"}
      onSelectThinking={() => {}}
      agents={opts.agents}
      selectedAgent={opts.selectedAgent ?? null}
    />,
  );
}

describe("orderProjectsByActivity", () => {
  it("ranks by the newest session or Task activity and keeps inactive registry order", () => {
    const inactiveFirst = { ...project, id: "inactive-first" };
    const recentBySession = { ...project, id: "session-project" };
    const recentByTask = { ...project, id: "task-project" };
    const inactiveSecond = { ...project, id: "inactive-second" };

    const ordered = orderProjectsByActivity(
      [inactiveFirst, recentBySession, recentByTask, inactiveSecond],
      [
        { projectId: "session-project", updatedAt: 100 },
        { projectId: "task-project", updatedAt: 20 },
        { updatedAt: 1_000 },
      ],
      [
        { projectId: "task-project", updatedAt: 200 },
        { projectId: "session-project", updatedAt: 50 },
      ],
    );

    expect(ordered.map((candidate) => candidate.id)).toEqual([
      "task-project",
      "session-project",
      "inactive-first",
      "inactive-second",
    ]);
  });
});

describe("orderWorktreesByActivity", () => {
  it("ranks by newest linked-session activity, falling back to the record timestamp", () => {
    const stale = worktree({ id: "stale", updatedAt: 50 });
    const recentBySession = worktree({
      id: "recent",
      updatedAt: 10,
      sessionIds: ["s1"],
    });
    const main = worktree({
      id: "main:proj",
      isMain: true,
      updatedAt: 0,
      sessionIds: ["s2"],
    });
    const ordered = orderWorktreesByActivity(
      [stale, recentBySession, main],
      [
        { id: "s1", updatedAt: 100 },
        { id: "s2", updatedAt: 70 },
      ],
    );
    expect(ordered.map((w) => w.id)).toEqual(["recent", "main:proj", "stale"]);
  });
});

describe("NewSessionQuickStart", () => {
  it("keeps a stable layout with nothing to pick: the worktree row renders a placeholder", () => {
    const single: ModelOption = {
      ...model,
      supportedThinkingLevels: ["off"],
      reasoning: false,
    };
    const html = render([], { models: [single] });
    expect(html).toContain("Worktree");
    expect(html).toContain("No worktrees");
    // Tasks are not staged from this screen at all.
    expect(html).not.toContain(">Task<");
  });

  it("keeps the worktree row with a placeholder when the staged project has no worktrees", () => {
    const html = render([worktree({ projectId: "other" })], {
      projects: [project, otherProject],
      selectedProjectId: "proj",
    });
    expect(html).toContain("No worktrees");
    expect(html).toContain("in Demo Project");
    // Nothing shown in scope means the More… escape hides too — it only makes
    // sense next to actual options.
    expect(html).not.toContain("More…");
  });

  it("renders the labelled agent row only with multiple personas, marking the selected one", () => {
    const single = render([worktree({})]);
    expect(single).not.toContain(">Agent<");
    const html = render([worktree({})], {
      agentTypes: ["assistant", "developer"],
      agentType: "developer",
    });
    expect(html).toContain(">Agent<");
    expect(html).toContain("Assistant");
    expect(html).toContain("Developer");
    expect(html).toMatch(/aria-selected="true"[^>]*>[\s\S]*?Developer/);
    // The runtime block (Agent/Model/Thinking) sits below the context rows,
    // separated by a ruler.
    expect(html).toContain("<hr");
    expect(html.indexOf("Worktree")).toBeLessThan(html.indexOf("<hr"));
    expect(html.indexOf("<hr")).toBeLessThan(html.indexOf(">Agent<"));
    expect(html.indexOf(">Agent<")).toBeLessThan(html.indexOf(">Model<"));
  });

  // Build/Plan is the composer's Plan switch, which is on screen beside this
  // card: a second control for it here would be two places to read one choice.
  it("leaves Build/Plan to the composer, even with Plan staged", () => {
    const html = render([worktree({})], {
      agentTypes: ["assistant", "developer"],
      agentType: "developer",
      mode: "plan",
    });
    expect(html).toContain(">Agent<");
    expect(html).not.toContain(">Mode<");
    expect(html).not.toContain("Build");
    expect(html).not.toContain(">Plan<");
  });

  it("leaves the mode out entirely for a persona without the axis", () => {
    expect(render([worktree({})])).not.toContain(">Mode<");
  });

  it("renders provider accounts as cards between Agent and Model", () => {
    const profiles: CredentialProfileSummary[] = [
      {
        id: "default",
        name: "Primary OpenAI",
        provider: "openai-codex",
        enabled: true,
        status: "ready",
        health: { state: "unknown", since: null },
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "claude-default",
        name: "Default Claude",
        provider: "claude",
        enabled: true,
        status: "ready",
        health: { state: "unknown", since: null },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "secondary",
        name: "Secondary OpenAI",
        provider: "openai-codex",
        enabled: true,
        status: "ready",
        health: { state: "unknown", since: null },
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    const html = render([worktree({})], {
      agentTypes: ["assistant", "developer"],
      profiles,
      selectedProfileId: "secondary",
    });
    expect(html).toContain(">Provider<");
    expect(html).toContain("Primary OpenAI");
    expect(html).toContain("Default Claude");
    expect(html).toContain("Secondary OpenAI");
    expect(html.indexOf("Default Claude")).toBeLessThan(
      html.indexOf("Primary OpenAI"),
    );
    expect(html.indexOf("Primary OpenAI")).toBeLessThan(
      html.indexOf("Secondary OpenAI"),
    );
    expect(html).toContain('aria-label="Claude"');
    expect(html).toContain('aria-label="OpenAI"');
    expect(html).not.toContain("<select");
    expect(html).toMatch(/aria-selected="true"[^>]*>[\s\S]*?Secondary OpenAI/);
    expect(html.indexOf(">Agent<")).toBeLessThan(html.indexOf(">Provider<"));
    expect(html.indexOf(">Provider<")).toBeLessThan(html.indexOf(">Model<"));
  });

  it("meters each provider card, keeping the account name and reserving the slot", () => {
    const profiles: CredentialProfileSummary[] = [
      {
        id: "claude-default",
        name: "Default Claude",
        provider: "claude",
        enabled: true,
        status: "ready",
        health: { state: "unknown", since: null },
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "default",
        name: "Primary OpenAI",
        provider: "openai-codex",
        enabled: true,
        status: "ready",
        health: { state: "unknown", since: null },
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    // Nothing cached yet: the rows are already there, holding the card's height.
    const empty = render([worktree({})], { profiles });
    expect(empty).toContain(">5h<");
    expect(empty).toContain(">wk<");
    // The provider word moved off the card into its label; the account name,
    // which is what distinguishes two accounts of one provider, stays.
    expect(empty).toContain("Default Claude");
    expect(empty).toContain("Use Default Claude (Claude)");

    const html = render([worktree({})], {
      profiles,
      usageIndicators: [
        {
          profileId: "claude-default",
          provider: "claude",
          refreshing: false,
          fetchedAt: Date.now(),
          limitsAvailable: true,
          short: { usedPct: 62, resetsAt: null },
          long: { usedPct: 41, resetsAt: null },
        },
        {
          profileId: "default",
          provider: "openai-codex",
          refreshing: false,
          fetchedAt: Date.now(),
          limitsAvailable: false,
          short: null,
          long: null,
        },
      ],
    });
    expect(html).toContain("62%");
    expect(html).toContain("41%");
    expect(html).toContain("sign in");
  });

  it("shows the project row only with multiple active projects and narrows the worktrees", () => {
    const single = render([worktree({})]);
    expect(single).not.toContain(">Project<");
    const both = [
      worktree({}),
      worktree({ id: "wt2", projectId: "other", branch: "other/branch" }),
    ];
    const unscoped = render(both, { projects: [project, otherProject] });
    expect(unscoped).toContain(">Project<");
    expect(unscoped).toContain("other/branch");
    const scoped = render(both, {
      projects: [project, otherProject],
      selectedProjectId: "proj",
    });
    expect(scoped).toContain("feature/thing");
    expect(scoped).not.toContain("other/branch");
  });

  it("keeps the project line on worktree cards even when a project is staged", () => {
    const scoped = render([worktree({})], {
      projects: [project, otherProject],
      selectedProjectId: "proj",
    });
    const cardSection = scoped.slice(scoped.indexOf("Worktree"));
    expect(cardSection).toContain("feature/thing");
    expect(cardSection).toContain("Demo Project");
  });

  it("reserves the worktree row with skeleton cards until the list is loaded", () => {
    const html = render([], { loaded: false });
    expect(html).toContain("Worktree");
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("More…");
  });

  it("reserves the project row with skeleton pills until the registry is loaded", () => {
    const html = render([worktree({})], { projectsLoaded: false });
    expect(html).toContain(">Project<");
    expect(html).toContain("animate-pulse");
    // Loaded with a single project: the row disappears for good (no picker needed).
    const loaded = render([worktree({})]);
    expect(loaded).not.toContain(">Project<");
  });

  it("renders worktree cards with project names and main-checkout labels, and no More… picker", () => {
    const html = render([
      worktree({}),
      worktree({ id: "main:proj", isMain: true, branch: "main" }),
    ]);
    expect(html).toContain("feature/thing");
    expect(html).toContain("main checkout");
    expect(html).toContain("Demo Project");
    // The row is the whole choice: every active worktree is in it, and a
    // staged project narrows it rather than hiding the rest behind a picker.
    expect(html).not.toContain("More…");
    const scoped = render(
      [
        worktree({}),
        worktree({ id: "wt2", projectId: "other", branch: "other/branch" }),
      ],
      { projects: [project, otherProject], selectedProjectId: "proj" },
    );
    expect(scoped).not.toContain("other/branch");
    expect(scoped).not.toContain("More…");
  });

  it("marks the staged worktree as selected", () => {
    const html = render([worktree({})], { selected: "wt1" });
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Remove worktree feature/thing");
  });

  it("offers + New worktree only with a project staged, and marks it when staged", () => {
    // No project staged: there is no repository to create the checkout in.
    const unscoped = render([worktree({})], {
      projects: [project, otherProject],
    });
    expect(unscoped).not.toContain("New worktree");

    const scoped = render([worktree({})], {
      projects: [project, otherProject],
      selectedProjectId: "proj",
    });
    expect(scoped).toContain("New worktree");
    expect(scoped).toContain("Create a worktree in Demo Project when you send");

    const staged = render([worktree({})], {
      projects: [project, otherProject],
      selectedProjectId: "proj",
      newWorktreeStaged: true,
    });
    expect(staged).toMatch(/aria-selected="true"[^>]*>[\s\S]*?New worktree/);
    // Escaped in the static markup, so match how it actually renders.
    expect(staged).toContain("Don&#x27;t create a worktree");
  });

  it("keeps + New worktree available when the staged project has no worktrees yet", () => {
    const html = render([], { selectedProjectId: "proj" });
    expect(html).toContain("No worktrees");
    expect(html).toContain("New worktree");
  });

  it("pins + New worktree then main checkout(s) ahead of a divider, then the rest in order", () => {
    // Activity order would otherwise put "recent" ahead of the main checkout.
    const main = worktree({ id: "main:proj", isMain: true, branch: "main" });
    const recent = worktree({ id: "recent", branch: "feature/recent" });
    const older = worktree({ id: "older", branch: "feature/older" });
    const html = render([recent, older, main], {
      projects: [project, otherProject],
      selectedProjectId: "proj",
    });
    expect(html.indexOf("New worktree")).toBeLessThan(
      html.indexOf("main checkout"),
    );
    expect(html.indexOf("main checkout")).toBeLessThan(
      html.indexOf("feature/recent"),
    );
    expect(html.indexOf("feature/recent")).toBeLessThan(
      html.indexOf("feature/older"),
    );
    // A divider sits between the pinned group and the rest.
    expect(html).toContain('<div aria-hidden="true" class="my-1');
    expect(html.indexOf("main checkout")).toBeLessThan(
      html.indexOf('<div aria-hidden="true" class="my-1'),
    );
    expect(html.indexOf('<div aria-hidden="true" class="my-1')).toBeLessThan(
      html.indexOf("feature/recent"),
    );
  });

  it("renders no divider when every active worktree is a main checkout", () => {
    const html = render(
      [worktree({ id: "main:proj", isMain: true, branch: "main" })],
      { projects: [project, otherProject], selectedProjectId: "proj" },
    );
    expect(html).not.toContain('<div aria-hidden="true" class="my-1');
  });

  it("renders the model row and a stepped thinking slider, its level in the row label", () => {
    const html = render([worktree({})]);
    expect(html).toContain("GPT Test");
    expect(html).toContain("GPT Other");
    // Discrete slider over the model's supported levels (off/medium/high → max index 2);
    // the current level is part of the row's label, not a line under it.
    expect(html).toContain('type="range"');
    expect(html).toContain('max="2"');
    expect(html).toContain('value="1"');
    expect(html).toContain(
      'Thinking · <span class="text-foreground">Medium</span>',
    );
    expect(html).not.toContain(">Medium</div>");
  });

  it("hides the model and thinking rows without choices, keeping worktrees", () => {
    const single: ModelOption = {
      ...model,
      supportedThinkingLevels: ["off"],
      reasoning: false,
    };
    const html = render([worktree({})], {
      models: [single],
      thinkingLevel: "off",
    });
    expect(html).toContain("feature/thing");
    expect(html).not.toContain("GPT Test");
    expect(html).not.toContain("Thinking");
  });
});

describe("agent definitions row", () => {
  const claudeAccount = {
    id: "claude-default",
    name: "Default Claude",
    provider: "claude",
    enabled: true,
    status: "ready",
    createdAt: 1,
    updatedAt: 1,
  } as CredentialProfileSummary;
  const agents: EntryLibraryList = {
    libraryPath: "/data/agents",
    entries: [
      {
        name: "test-reviewer",
        description: "Reviews tests.",
        path: "test-reviewer/AGENT.md",
      },
      { name: "stale", description: "Old.", path: "stale/AGENT.md" },
    ],
    diagnostics: [],
    agentRuntimes: {
      "test-reviewer": {
        persona: "developer",
        provider: "claude-sdk",
        modelId: "opus",
        thinkingLevel: "high",
      },
      stale: { problem: 'No enabled account offers a model "gemini".' },
    },
  };

  it("offers each definition, and one that cannot start says why", () => {
    const html = render([], {
      agents: ready(agents),
      selectedAgent: "test-reviewer",
      profiles: [claudeAccount],
    });
    expect(html).toContain("Agent definition");
    expect(html).toContain("test-reviewer");
    expect(html).toContain(
      'title="Start as a plain session instead of test-reviewer"',
    );
    // The unusable one is shown, disabled, and its reason is visible text.
    expect(html).toMatch(
      /title="No enabled account offers a model &quot;gemini&quot;\."[^>]*disabled|disabled[^>]*title="No enabled account offers a model &quot;gemini&quot;\."/,
    );
    expect(html).toContain(
      "<li>No enabled account offers a model &quot;gemini&quot;.</li>",
    );
  });

  it("offers nothing before the accounts are read, nor without an account of its provider", () => {
    const unread = render([], {
      agents: ready(agents),
      profilesLoaded: false,
    });
    expect(unread).toMatch(
      /<button[^>]*\sdisabled=""[^>]*title="Start as test-reviewer: Reviews tests\."|<button[^>]*title="Start as test-reviewer: Reviews tests\."[^>]*\sdisabled=""/,
    );

    const noClaude = render([], { agents: ready(agents), profiles: [] });
    expect(noClaude).toContain(
      "<li>Agent &quot;test-reviewer&quot; cannot start here: no enabled account runs claude-sdk models.</li>",
    );
  });

  it("keeps a picked definition clickable after it stops being able to start", () => {
    const html = render([], {
      agents: ready({
        ...agents,
        agentRuntimes: {
          ...agents.agentRuntimes,
          "test-reviewer": { problem: "Gone." },
        },
      }),
      selectedAgent: "test-reviewer",
    });
    expect(html).toMatch(
      /<button(?![^>]*\sdisabled="")[^>]*title="Gone\."[^>]*>/,
    );
  });

  it("shows no row unsubscribed or for an authoritatively empty library", () => {
    expect(render([], {})).not.toContain("Agent definition");
    expect(render([], { agents: idle() })).not.toContain("Agent definition");
    expect(
      render([], {
        agents: ready({ ...agents, entries: [], agentRuntimes: {} }),
      }),
    ).not.toContain("Agent definition");
  });

  /** The markup inside the row's listbox, which may hold only its options. */
  function agentListbox(html: string): string {
    const open = html.indexOf('role="listbox" aria-label="Agent definition"');
    expect(open).toBeGreaterThan(-1);
    const start = html.indexOf(">", open) + 1;
    let depth = 1;
    const tag = /<(\/?)div\b[^>]*>/g;
    tag.lastIndex = start;
    for (let match = tag.exec(html); match; match = tag.exec(html)) {
      depth += match[1] ? -1 : 1;
      if (depth === 0) return html.slice(start, match.index);
    }
    throw new Error("unclosed listbox");
  }

  it("reserves the row while the first read is out", () => {
    const html = render([], { agents: loading() });
    expect(html).toContain("Agent definition");
    expect(html).toContain('aria-busy="true"');
    // R6: the placeholder is a labelled status region, not just a busy list.
    expect(html).toMatch(
      /role="status" aria-label="Loading agent definitions"/,
    );
    expect(agentListbox(html)).not.toContain('role="status"');
    expect(html).not.toContain("test-reviewer");
  });

  it("keeps the pills through a rescan and says a failed read in place", () => {
    const rescanning = render([], { agents: refreshing(agents) });
    expect(rescanning).toContain("test-reviewer");
    expect(rescanning).toContain("Rescanning agents");
    expect(agentListbox(rescanning)).toContain("test-reviewer");
    expect(agentListbox(rescanning)).not.toContain("Rescanning agents");

    const failedRescan = render([], {
      agents: failed("Scan failed: EACCES", agents),
    });
    expect(failedRescan).toContain("test-reviewer");
    expect(failedRescan).toContain("Scan failed: EACCES");

    const failedFirst = render([], { agents: failed("Scan failed: EACCES") });
    expect(failedFirst).toContain("Scan failed: EACCES");
  });
});
