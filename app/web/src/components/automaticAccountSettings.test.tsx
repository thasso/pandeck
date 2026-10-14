// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountModelOption,
  AppSettings,
  CommitAgentSettings,
  CredentialProfileSummary,
  ModelOption,
} from "@assistant/shared";
import {
  AgentModelFields,
  applyModelSlotChange,
  CredentialProfilesContext,
} from "./AgentModelFields.tsx";
import { CredentialProfileCard, SettingsPage } from "./SettingsPage.tsx";
import {
  slotModelOptions,
  type SlotModelOption,
} from "../lib/credentialProfiles.ts";
import { ready } from "../lib/loadState.ts";
import {
  settingsFixture,
  settingsMemory,
  settingsModels,
  settingsPrefs,
  settingsProfiles,
  settingsSkills,
} from "../../component-preview/fixtures/settings.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

if (!Element.prototype.scrollIntoView)
  Element.prototype.scrollIntoView = () => {};
// The model popover's command list measures itself; jsdom has no layout.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Pick-preview requests a slot made, and the router's canned answer. */
let previews: Array<Record<string, unknown>> = [];
let pickAnswer: Record<string, unknown> = { profileId: null };

beforeEach(() => {
  previews = [];
  pickAnswer = { profileId: null };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      previews.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(pickAnswer), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const sonnet: ModelOption = {
  provider: "claude-sdk",
  id: "sonnet",
  name: "Claude Sonnet",
  reasoning: true,
  supportedThinkingLevels: ["off", "low", "medium", "high"],
  contextWindow: 200_000,
};
const accountModels: AccountModelOption[] = [
  { ...sonnet, credentialProfileId: "personal", accountName: "Personal" },
  { ...sonnet, credentialProfileId: "work", accountName: "Work" },
];

const pinned: CommitAgentSettings = {
  provider: "claude-sdk",
  modelId: "sonnet",
  thinkingLevel: "low",
  credentialProfileId: "work",
} as CommitAgentSettings;

/** A settings slot wired the way the Settings sections wire theirs. */
function Slot({
  onSaved,
  initial = pinned,
  models = slotModelOptions(accountModels),
}: {
  onSaved: (slot: CommitAgentSettings) => void;
  initial?: CommitAgentSettings;
  models?: SlotModelOption[];
}) {
  const [slot, setSlot] = useState(initial);
  return (
    <AgentModelFields
      models={models}
      provider={slot.provider}
      modelId={slot.modelId}
      thinkingLevel={slot.thinkingLevel}
      credentialProfileId={slot.credentialProfileId}
      onChange={(change) => {
        const next = applyModelSlotChange(slot, change);
        setSlot(next);
        onSaved(next);
      }}
    />
  );
}

function trigger(): HTMLElement {
  return container!.querySelector<HTMLElement>('button[title="Model"]')!;
}

function option(group: string): HTMLElement {
  const heading = [
    ...document.body.querySelectorAll("[cmdk-group-heading]"),
  ].find((node) => node.textContent === group);
  const item = heading
    ?.closest("[cmdk-group]")
    ?.querySelector<HTMLElement>("[cmdk-item]");
  expect(item, `${group} option`).toBeTruthy();
  return item!;
}

describe("settings slot account choice", () => {
  it("clears the pin when Automatic is picked and pins again on an account pick", () => {
    const saved = vi.fn();
    act(() => root!.render(<Slot onSaved={saved} />));
    expect(trigger().textContent).toContain("Work");

    act(() => trigger().click());
    act(() => option("Automatic").click());

    const automatic = saved.mock.lastCall![0] as CommitAgentSettings;
    expect(automatic).toMatchObject({
      modelId: "sonnet",
      thinkingLevel: "low",
    });
    expect("credentialProfileId" in automatic).toBe(false);
    expect(trigger().textContent).toContain("Automatic");

    act(() => trigger().click());
    act(() => option("Personal").click());
    expect(saved.mock.lastCall![0]).toMatchObject({
      credentialProfileId: "personal",
    });
  });
});

it.each([
  { name: "missing catalogs", models: [] },
  {
    name: "disabled accounts",
    models: slotModelOptions(
      accountModels.map((model) => ({ ...model, accountDisabled: true })),
    ),
  },
])(
  "can clear a pin with $name and still displays Automatic",
  async ({ models }) => {
    const saved = vi.fn();
    await act(async () =>
      root!.render(<Slot models={models} onSaved={saved} />),
    );
    const clear = [...container!.querySelectorAll("button")].find(
      (button) => button.textContent === "Use Automatic",
    );
    expect(clear).toBeDefined();
    await act(async () => clear!.click());
    const { credentialProfileId: _pin, ...automatic } = pinned;
    expect(saved.mock.lastCall![0]).toEqual(automatic);
    expect(trigger().textContent).toContain("Automatic");
    expect(trigger().textContent).not.toContain("Work");
    expect(container!.textContent).not.toContain("Use Automatic");
  },
);

describe("every Settings slot can return to Automatic", () => {
  const slots = [
    ["permanentAssistant", "personal-assistant", 0],
    ["memory.processor", "memory", 0],
    ["sessionNaming", "naming", 0],
    ["sessionStatus", "session-status", 0],
    ["promptRefinement", "refinement", 0],
    ["worktrees.namingAgent", "worktrees", 0],
    ["worktrees.mergeAgent", "worktrees", 1],
    ["commitAgent", "commit", 0],
    ["prAgent", "pull-request", 0],
    ["taskIntakeAgent", "task-intake", 0],
    ["pdfConversion", "pdf-conversion", 0],
  ] as const;

  function slotAt(settings: Partial<AppSettings>, key: string) {
    let value: unknown = settings;
    for (const part of key.split("."))
      value = (value as Record<string, unknown>)[part];
    return value as Record<string, unknown>;
  }

  const noop = () => {};
  const props = {
    settings: settingsFixture,
    prefs: settingsPrefs,
    models: settingsModels,
    accountModels: settingsModels,
    credentialProfiles: settingsProfiles,
    projects: [],
    memory: settingsMemory,
    skills: ready(settingsSkills),
    agents: ready({ ...settingsSkills, entries: [] }),
    serverBuild: null,
    speechToText: null,
    modelsRefreshing: false,
    onUpdatePrefs: noop,
    onToggleSkill: noop,
    onRefreshModels: noop,
    onSaveAndTestJira: noop,
    onTestJira: noop,
    jiraStatus: null,
    onSaveAndTestConfluence: noop,
    onTestConfluence: noop,
    confluenceStatus: null,
    onUpdateTempo: noop,
    onSaveAndTestTempo: noop,
    onTestTempo: noop,
    tempoStatus: null,
    onUpdateGoogle: noop,
    onSaveAndTestGoogle: noop,
    onTestGoogle: noop,
    googleStatus: null,
    onSaveAndTestSlack: noop,
    onTestSlack: noop,
    slackStatus: null,
    onSaveAndTestOpenAiCompatible: noop,
    onTestOpenAiCompatible: noop,
    openAiCompatibleStatus: null,
    onSaveAndTestBrave: noop,
    onTestBrave: noop,
    braveStatus: null,
    onSaveAndTestContext7: noop,
    onTestContext7: noop,
    context7Status: null,
    onSaveAndTestGithub: noop,
    onTestGithub: noop,
    githubStatus: null,
    onSaveAndTestForgejo: noop,
    onTestForgejo: noop,
    forgejoStatus: null,
  };

  it("describes usage thresholds as a preference, not an exclusion", async () => {
    await act(async () =>
      root!.render(
        <SettingsPage
          {...props}
          section="models"
          accountModels={settingsModels}
          onUpdate={vi.fn()}
        />,
      ),
    );
    expect(container!.textContent?.replace(/\s+/g, " ")).toContain(
      "Automatic prefers other accounts once one has used this much of a usage window.",
    );
    expect(container!.textContent).not.toContain("Automatic skips an account");
  });

  for (const empty of [false, true]) {
    it.each(slots)(
      `%s saves without a pin ${empty ? "without model offers" : "from the picker"}`,
      async (key, section, index) => {
        const saved = vi.fn();
        await act(async () =>
          root!.render(
            <SettingsPage
              {...props}
              accountModels={empty ? [] : settingsModels}
              section={section}
              onUpdate={saved}
            />,
          ),
        );
        if (empty) {
          const buttons = [...container!.querySelectorAll("button")].filter(
            (button) => button.textContent === "Use Automatic",
          );
          expect(buttons[index]).toBeDefined();
          act(() => buttons[index]!.click());
        } else {
          const model = container!.querySelectorAll<HTMLElement>(
            'button[title="Model"]',
          )[index];
          expect(model).toBeDefined();
          act(() => model!.click());
          act(() => option("Automatic").click());
        }
        const next = slotAt(
          saved.mock.lastCall![0] as Partial<AppSettings>,
          key,
        );
        const { credentialProfileId: _pin, ...automatic } = slotAt(
          settingsFixture,
          key,
        );
        expect(next).toEqual(automatic);
        expect("credentialProfileId" in next).toBe(false);
      },
    );
  }

  it("passes Automatic options to the peer roster and clears its exact pin", async () => {
    const saved = vi.fn();
    const model = settingsModels[0]!;
    const runtime = {
      id: "pr-pinned",
      provider: model.provider,
      modelId: model.id,
      thinkingLevel: "low" as const,
      credentialProfileId: model.credentialProfileId,
      relativeCost: "unknown" as const,
      enabled: true,
    };
    await act(async () =>
      root!.render(
        <SettingsPage
          {...props}
          settings={{ ...settingsFixture, peerSpawnRuntimes: [runtime] }}
          section="peer-runtimes"
          onUpdate={saved}
        />,
      ),
    );
    expect(trigger().textContent).toContain(model.accountName);
    act(() => trigger().click());
    act(() => option("Automatic").click());
    const { credentialProfileId: _pin, ...automatic } = runtime;
    expect(saved.mock.lastCall![0].peerSpawnRuntimes).toEqual([automatic]);
    expect(previews).toEqual([]);
  });

  it("does not offer pin clearing on explicit-only fields", () => {
    act(() =>
      root!.render(
        <AgentModelFields
          models={[]}
          {...pinned}
          accountFallback={false}
          onChange={() => {}}
        />,
      ),
    );
    expect(container!.textContent).not.toContain("Use Automatic");
  });
});

describe("settings slot Automatic preview", () => {
  const profiles = [
    {
      id: "personal",
      name: "Personal",
      enabled: true,
      health: { state: "ok" },
    },
    { id: "work", name: "Work", enabled: true, health: { state: "ok" } },
  ] as CredentialProfileSummary[];
  const { credentialProfileId: _pin, ...unpinned } = pinned;

  async function renderUnpinned() {
    await act(async () =>
      root!.render(
        <CredentialProfilesContext.Provider value={profiles}>
          <Slot onSaved={() => {}} initial={unpinned as CommitAgentSettings} />
        </CredentialProfilesContext.Provider>,
      ),
    );
    await act(async () => {});
  }

  it("names the account the current Automatic choice resolves to, asking once for background work", async () => {
    pickAnswer = { profileId: "work" };
    await renderUnpinned();

    expect(previews).toEqual([
      {
        model: { provider: "claude-sdk", modelId: "sonnet" },
        thinkingLevel: "low",
        scope: "background",
      },
    ]);
    expect(container!.textContent).toContain(
      "Automatic runs this on “Work” right now.",
    );
  });

  it("warns when the router can only degrade", async () => {
    pickAnswer = { profileId: "personal", degraded: "disabled-default" };
    await renderUnpinned();

    expect(container!.querySelector('[role="note"]')?.textContent).toContain(
      "Every account is disabled — background work falls back to “Personal”.",
    );
  });

  it("still explains an unpinned slot when no account offers an Automatic option", async () => {
    pickAnswer = { profileId: "personal", degraded: "disabled-default" };
    const disabled = profiles.map((profile) => ({
      ...profile,
      enabled: false,
    }));
    await act(async () =>
      root!.render(
        <CredentialProfilesContext.Provider value={disabled}>
          <AgentModelFields
            // Every account is disabled: no Automatic (or any) option exists.
            models={slotModelOptions([])}
            provider="claude-sdk"
            modelId="sonnet"
            thinkingLevel="low"
            onChange={() => {}}
          />
        </CredentialProfilesContext.Provider>,
      ),
    );
    await act(async () => {});

    expect(previews).toEqual([
      {
        model: { provider: "claude-sdk", modelId: "sonnet" },
        thinkingLevel: "low",
        scope: "background",
      },
    ]);
    expect(container!.querySelector('[role="note"]')?.textContent).toContain(
      "Every account is disabled — background work falls back to “Personal”.",
    );
  });

  it("asks nothing on a surface whose record must name an account", async () => {
    await act(async () =>
      root!.render(
        <AgentModelFields
          models={accountModels}
          provider="claude-sdk"
          modelId="sonnet"
          thinkingLevel="low"
          accountFallback={false}
          onChange={() => {}}
        />,
      ),
    );
    expect(previews).toEqual([]);
  });

  it("displays Automatic without a degrading preview for an exact runtime", async () => {
    await act(async () =>
      root!.render(
        <AgentModelFields
          models={slotModelOptions(accountModels)}
          provider="claude-sdk"
          modelId="sonnet"
          thinkingLevel="low"
          accountFallback={false}
          allowAutomatic
          thinkingSelection="exact"
          onChange={() => {}}
        />,
      ),
    );
    expect(trigger().textContent).toContain("Automatic");
    expect(previews).toEqual([]);
  });

  it("asks nothing for a pinned slot", async () => {
    await act(async () => root!.render(<Slot onSaved={() => {}} />));
    expect(previews).toEqual([]);
  });
});

describe("account card enterprise flag", () => {
  const profile = {
    id: "work",
    name: "Work",
    provider: "claude",
    enabled: true,
    enterprise: false,
    status: "ready",
    health: { state: "ok", since: null },
    createdAt: 0,
    updatedAt: 0,
  } as CredentialProfileSummary;

  function renderCard(
    overrides: Partial<CredentialProfileSummary>,
    onToggleEnterprise: (enterprise: boolean) => void,
  ) {
    act(() =>
      root!.render(
        <CredentialProfileCard
          profile={{ ...profile, ...overrides }}
          providerLabel="Claude"
          connectionLabel="Reconnect"
          onToggle={() => {}}
          onToggleEnterprise={onToggleEnterprise}
          onConnect={() => {}}
        />,
      ),
    );
    return container!.querySelector<HTMLElement>(
      '[aria-label="Enterprise account: Work"]',
    )!;
  }

  it("reports the flag the user switches to", () => {
    const toggle = vi.fn();
    const off = renderCard({ enterprise: false }, toggle);
    expect(off.getAttribute("aria-checked")).toBe("false");
    act(() => off.click());
    expect(toggle).toHaveBeenLastCalledWith(true, expect.anything());

    const on = renderCard({ enterprise: true }, toggle);
    expect(on.getAttribute("aria-checked")).toBe("true");
    act(() => on.click());
    expect(toggle).toHaveBeenLastCalledWith(false, expect.anything());
  });
});
