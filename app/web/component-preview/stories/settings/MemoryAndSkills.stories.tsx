import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { expect, userEvent, within } from "storybook/test";
import {
  applyPatch,
  type AppSettings,
  type MemoryCard,
  type MemoryLoadBatch,
  type SkillDetailResponse,
  type SkillLibraryList,
  type SkillToggles,
} from "@assistant/shared";
import type {
  MemoryListView,
  UseMemory,
} from "../../../src/hooks/useMemory.ts";
import {
  failFrom,
  loading,
  ready,
  refreshing,
  type LoadState,
} from "../../../src/lib/loadState.ts";
import { CredentialProfilesContext } from "../../../src/components/AgentModelFields.tsx";
import { MemorySettingsSection } from "../../../src/components/MemorySettingsSection.tsx";
import {
  LoadedMemorySection,
  type StagedMemoryScope,
} from "../../../src/components/LoadedMemorySection.tsx";
import { SkillsSettingsSection } from "../../../src/components/SkillsSettingsSection.tsx";
import {
  settingsFixture,
  settingsMemory,
  settingsModels,
  settingsProfiles,
} from "../../fixtures/settings.ts";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 7, 12);

const card = (over: Partial<MemoryCard> & { id: string }): MemoryCard => ({
  revision: 1,
  text: "Prefers concise answers with the result first.",
  kind: "preference",
  scope: {},
  state: "active",
  pinned: false,
  strength: 1,
  temporal: { mode: "persistent" },
  observedAtMs: now - 3 * DAY,
  createdAt: now - 3 * DAY,
  updatedAt: now - DAY,
  provenance: { sourceKind: "processor", sessionId: "sess-4f2a91c0" },
  ...over,
});

const cards: MemoryCard[] = [
  card({ id: "mem_concise", pinned: true }),
  card({
    id: "mem_pnpm",
    text: "Uses pnpm 11 for every install; never generate a package-lock.json.",
    kind: "constraint",
    scope: { persona: "developer", projectId: "pandeck" },
    provenance: { sourceKind: "manual" },
  }),
  card({
    id: "mem_travel",
    text: "Travelling to Lisbon; prefers meetings after 14:00 local time.",
    kind: "working",
    scope: { persona: "personal-assistant" },
    temporal: {
      mode: "window",
      validFromMs: now - DAY,
      validUntilMs: now + 300 * DAY,
      timezone: "Europe/Lisbon",
    },
    provenance: { sourceKind: "agent" },
  }),
  card({
    id: "mem_standup",
    text: "Weekday standup at 09:30; keep the morning brief short on those days.",
    kind: "fact",
    temporal: {
      mode: "recurring",
      recurrence: { kind: "weekly", weekdays: [1, 2, 3, 4, 5] },
    },
    provenance: { sourceKind: "consolidation" },
  }),
  card({
    id: "mem_long",
    text: "When summarising long pull request threads, group the review comments by file, quote the reviewer's exact request, list what changed in response and what is still open, and never mark a thread resolved on the reviewer's behalf even when the fix looks complete.",
    kind: "preference",
    scope: { projectId: "a-very-long-project-identifier-for-wrapping" },
    provenance: { sourceKind: "import" },
  }),
];

const memoryWith = (
  list: LoadState<MemoryListView>,
  over: Partial<UseMemory> = {},
): UseMemory => ({ ...settingsMemory, list, ...over });

function MemoryPreview({ memory }: { memory: UseMemory }) {
  const [settings, setSettings] = useState<AppSettings>(settingsFixture);
  // The host provides the profiles; without them the processor's pinned
  // account would read as deleted.
  return (
    <CredentialProfilesContext.Provider value={settingsProfiles}>
      <MemorySettingsSection
        models={settingsModels}
        settings={settings}
        memory={memory}
        onUpdate={(patch) =>
          setSettings((current) => applyPatch(current, patch))
        }
      />
    </CredentialProfilesContext.Provider>
  );
}

const batch = (over: Partial<MemoryLoadBatch> = {}): MemoryLoadBatch => ({
  id: 2,
  sessionId: "sess-preview",
  userTurnId: "turn-2",
  fingerprint: "fp-2",
  deliveryState: "injected",
  renderedChars: 212,
  injectedChars: 212,
  cumulativeInjectedChars: 640,
  createdAt: now,
  items: [
    {
      memoryId: "mem_concise",
      revision: 1,
      rank: 1,
      reasonCode: "pinned",
      reason: "pinned",
      renderedChars: 52,
      text: cards[0]!.text,
      kind: "preference",
      scope: {},
      provenance: { sourceKind: "processor", sessionId: "sess-4f2a91c0" },
    },
    {
      memoryId: "mem_pnpm",
      revision: 1,
      rank: 2,
      reasonCode: "baseline-constraint",
      reason: "stable constraint",
      renderedChars: 74,
      text: cards[1]!.text,
      kind: "constraint",
      scope: { persona: "developer", projectId: "pandeck" },
      provenance: { sourceKind: "manual" },
    },
  ],
  ...over,
});

function Inspector({ children }: { children: ReactNode }) {
  return <div className="w-80 p-3">{children}</div>;
}

function loaded(
  batches: MemoryLoadBatch[] | undefined,
  props: {
    hasAcceptedUserTurn?: boolean;
    loadingEnabled?: boolean;
    stagedScope?: StagedMemoryScope;
  } = {},
) {
  return (
    <Inspector>
      <LoadedMemorySection
        sessionId="sess-preview"
        hasAcceptedUserTurn={props.hasAcceptedUserTurn ?? true}
        defaultOpen
        maxCards={8}
        loadingEnabled={props.loadingEnabled ?? true}
        onOpenManager={() => {}}
        memory={{
          ...settingsMemory,
          loadsBySession: batches ? { "sess-preview": batches } : {},
          lineageById: {
            mem_concise: { card: cards[0]!, supersededBy: [] },
          },
        }}
        {...(props.stagedScope ? { stagedScope: props.stagedScope } : {})}
      />
    </Inspector>
  );
}

const library: SkillLibraryList = {
  libraryPath: "/home/alex/assistant/skills",
  skills: [
    {
      name: "release-notes",
      description:
        "Draft release notes from the pull requests merged since the last tag.",
      path: "release-notes/SKILL.md",
    },
    {
      name: "triage",
      description:
        "Sort new issues into the backlog with a priority and a one-line reason.",
      path: "triage/SKILL.md",
    },
    {
      name: "incident-review",
      description:
        "Write a blameless incident review: timeline, contributing factors, what went well, what to change, and the follow-up tasks with owners.",
      path: "ops/incident-review/SKILL.md",
    },
  ],
  diagnostics: [
    {
      code: "missing-name",
      folder: "half-written",
      path: "half-written/SKILL.md",
      error: "Missing frontmatter name.",
    },
  ],
};

const releaseNotes: SkillDetailResponse = {
  kind: "skill",
  name: "release-notes",
  description: library.skills[0]!.description,
  folder: "release-notes",
  path: "release-notes/SKILL.md",
  markdown:
    "# Release notes\n\n1. List the pull requests merged since the last tag.\n2. Group them by area.\n3. Lead with user-visible changes.",
  bytes: 1840,
  truncated: false,
  files: {
    entries: [
      {
        type: "file",
        name: "SKILL.md",
        path: "SKILL.md",
        bytes: 1840,
        mimeType: "text/markdown",
      },
      {
        type: "directory",
        name: "templates",
        path: "templates",
        children: [
          {
            type: "file",
            name: "notes.md",
            path: "templates/notes.md",
            bytes: 420,
            mimeType: "text/markdown",
          },
        ],
      },
    ],
    entryCount: 3,
    metadataBytes: 64,
    truncated: false,
    limits: [],
    diagnostics: [],
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Serves ONLY the skill-detail read (`GET /api/skills/detail`) locally;
 * previews never call the app, so every other route answers 405. `release-notes`
 * reads as a skill and any other name as an `invalid` answer, unless `detail`
 * holds the read in flight or fails it.
 */
function SkillsPreview({
  state,
  skills = {},
  detail = "answer",
}: {
  state: LoadState<SkillLibraryList>;
  skills?: SkillToggles;
  detail?: "answer" | "loading" | "error";
}) {
  const [toggles, setToggles] = useState(skills);
  useLayoutEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.href);
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      if (method !== "GET" || url.pathname !== "/api/skills/detail")
        return json(
          { error: "Network actions are disabled in previews." },
          405,
        );
      if (detail === "loading") return new Promise<Response>(() => {});
      if (detail === "error")
        return json({ error: "Failed to read the skill: EACCES" }, 500);
      const name = url.searchParams.get("name") ?? "";
      const body: SkillDetailResponse =
        name === releaseNotes.name
          ? releaseNotes
          : {
              kind: "invalid",
              name,
              error: "This folder was renamed after the last scan.",
            };
      return json(body);
    };
    return () => {
      window.fetch = original;
    };
  }, [detail]);
  return (
    <SkillsSettingsSection
      library={state}
      settings={{ ...settingsFixture, skills: toggles }}
      onToggleSkill={(name, on) =>
        setToggles((current) => ({ ...current, [name]: on ? "on" : "off" }))
      }
    />
  );
}

/** Opens a skill's detail pane by clicking its production row. */
const openSkill =
  (name: string): NonNullable<Story["play"]> =>
  async ({ canvasElement }) => {
    const row = within(canvasElement).getByRole("button", {
      name: new RegExp(`^${name} `),
    });
    await userEvent.click(row);
  };

const meta = {
  title: "App/Settings/Memory and skills",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const MemoryPopulated: Story = {
  render: () => (
    <MemoryPreview
      memory={memoryWith(ready({ cards, total: 45, hasMore: true }))}
    />
  ),
};
export const MemoryLoading: Story = {
  render: () => <MemoryPreview memory={memoryWith(loading())} />,
};
export const MemoryRefreshing: Story = {
  render: () => (
    <MemoryPreview
      memory={memoryWith(refreshing({ cards, total: 5, hasMore: false }))}
    />
  ),
};
export const MemoryEmpty: Story = {
  render: () => (
    <MemoryPreview
      memory={memoryWith(ready({ cards: [], total: 0, hasMore: false }))}
    />
  ),
};
export const MemoryProcessorNotConfigured: Story = {
  render: () => (
    <MemoryPreview
      memory={memoryWith(ready({ cards, total: 5, hasMore: false }), {
        processorStatus: {
          configured: false,
          message:
            "The processor model is no longer offered by this account; automatic learning is paused.",
        },
      })}
    />
  ),
};

export const LoadedMemoryInjected: Story = {
  render: () =>
    loaded([
      batch(),
      batch({
        id: 1,
        userTurnId: "turn-1",
        deliveryState: "reused",
        injectedChars: 0,
      }),
    ]),
};
/** The row editor for the time-window card, opened through its own action. */
export const MemoryEditingWindow: Story = {
  ...MemoryPopulated,
  play: async ({ canvasElement }) => {
    const edit = within(canvasElement).getAllByRole("button", {
      name: "Edit / correct",
    });
    await userEvent.click(edit[2]!);
    await expect(
      within(canvasElement).getByLabelText("Window timezone"),
    ).toBeInTheDocument();
  },
};

export const LoadedMemoryEditing: Story = {
  render: () => loaded([batch()]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getAllByRole("button", { name: "Details / actions" })[0]!,
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit / correct" }),
    );
    await expect(canvas.getByLabelText("Memory text")).toBeInTheDocument();
  },
};
export const LoadedMemoryCleared: Story = {
  render: () => loaded([batch({ deliveryState: "cleared", items: [] })]),
};
export const LoadedMemoryFailed: Story = {
  render: () => loaded([batch({ deliveryState: "failed", items: [] })]),
};
export const LoadedMemoryNotYetLoaded: Story = {
  render: () => loaded(undefined),
};
export const LoadedMemoryDisabled: Story = {
  render: () => loaded([], { loadingEnabled: false }),
};
export const LoadedMemoryDraft: Story = {
  render: () =>
    loaded(undefined, {
      hasAcceptedUserTurn: false,
      stagedScope: {
        persona: "assistant",
        projectId: "pandeck",
        pendingTaskTitle: "Ship the shadcn port",
      },
    }),
};

export const SkillsPopulated: Story = {
  render: () => (
    <SkillsPreview state={ready(library)} skills={{ triage: "on" }} />
  ),
};
export const SkillsLoading: Story = {
  render: () => <SkillsPreview state={loading()} />,
};
export const SkillsEmpty: Story = {
  render: () => (
    <SkillsPreview state={ready({ ...library, skills: [], diagnostics: [] })} />
  ),
};
export const SkillsOnlyBroken: Story = {
  render: () => <SkillsPreview state={ready({ ...library, skills: [] })} />,
};
export const SkillsRescanFailed: Story = {
  render: () => (
    <SkillsPreview
      state={failFrom(
        ready(library),
        "Failed to read the skills library: EACCES",
      )}
    />
  ),
};

export const SkillDetail: Story = {
  render: () => <SkillsPreview state={ready(library)} />,
  play: openSkill("release-notes"),
};
export const SkillDetailInvalid: Story = {
  render: () => <SkillsPreview state={ready(library)} />,
  play: openSkill("triage"),
};
export const SkillDetailLoading: Story = {
  render: () => <SkillsPreview state={ready(library)} detail="loading" />,
  play: openSkill("release-notes"),
};
export const SkillDetailError: Story = {
  render: () => <SkillsPreview state={ready(library)} detail="error" />,
  play: openSkill("release-notes"),
};
