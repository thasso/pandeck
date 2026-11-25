import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import {
  SETTINGS_REGISTRY,
  settingDescriptor,
} from "@assistant/shared/settingsRegistry";
import type { AppSettings, ServerMessage } from "@assistant/shared";
import type { ScheduleTiming } from "@assistant/shared/schedules";
import { DATA_DIR } from "./config.ts";
import { setStateChangeSink } from "./db/changeSet.ts";
import { closeDb, getDb } from "./db/index.ts";
import { scheduleStore } from "./db/scheduleStore.ts";
import { subscribeIntegrationToolChanges } from "./integrationToolChanges.ts";
import { APP_SETTINGS_PATH, readStoredAppSettings } from "./appSettingsFile.ts";
import { getSettings } from "./settings.ts";
import {
  IntegrationRefusal,
  installRemoteIntegrationPort,
  type IntegrationStatus,
} from "./remoteIntegrations.ts";
import { listSettingsModelSlots } from "./settingsModelSlots.ts";
import {
  announceSettingsWritten,
  INTEGRATION_PATCH_FIELDS,
  onSettingsChanged,
  saveSettings,
  settingsPatchForWrites,
  type SettingsChange,
} from "./settingsService.ts";

/** Dotted paths of every leaf in a settings object; arrays are leaves. */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

function valueAt(root: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined,
      root,
    );
}

/**
 * Current settings with every optional field filled in, since defaults leave
 * them out: the slots' account pins (`listSettingsModelSlots` is tested to
 * list every slot) and Confluence's client-mode `credentialStore`.
 */
function populatedSettings(): AppSettings {
  const settings = structuredClone(getSettings());
  for (const { slot } of listSettingsModelSlots(settings))
    slot.credentialProfileId = "cp_fixture";
  settings.confluence.credentialStore = "gateway";
  return settings;
}

describe("registry coverage", () => {
  test("every leaf the Settings page receives has a descriptor", () => {
    const settings = populatedSettings();
    const covered = (leaf: string) =>
      SETTINGS_REGISTRY.some(
        (d) =>
          d.path === leaf ||
          d.configuredBy === leaf ||
          ((d.value?.kind === "json" || d.access === "readonly") &&
            leaf.startsWith(`${d.path}.`)),
      );
    assert.deepEqual(
      leafPaths(settings).filter((leaf) => !covered(leaf)),
      [],
      "add a descriptor to app/shared/settingsRegistry.ts",
    );
  });

  test("every descriptor points at something real", () => {
    const settings = populatedSettings();
    for (const d of SETTINGS_REGISTRY) {
      const [section = "", ...rest] = d.path.split(".");
      const integration = Object.hasOwn(INTEGRATION_PATCH_FIELDS, section)
        ? (INTEGRATION_PATCH_FIELDS as Record<string, Record<string, true>>)[
            section
          ]
        : undefined;
      if (d.configuredBy)
        assert.equal(
          typeof valueAt(settings, d.configuredBy),
          "boolean",
          `${d.path} configuredBy ${d.configuredBy}`,
        );
      if (d.clearWith)
        assert.ok(integration?.[d.clearWith], `${d.path} clearWith`);
      if (d.access === "oauth") continue;
      if (integration && d.access !== "readonly") {
        assert.ok(integration[rest.join(".")], `${d.path} is a patch field`);
        continue;
      }
      if (d.access === "secret") continue;
      assert.notEqual(valueAt(settings, d.path), undefined, d.path);
    }
  });

  test("the shared integration sections are the server's integration writers", async () => {
    const { INTEGRATION_SETTINGS_SECTIONS } =
      await import("@assistant/shared/settingsRegistry");
    assert.deepEqual(
      [...INTEGRATION_SETTINGS_SECTIONS].sort(),
      Object.keys(INTEGRATION_PATCH_FIELDS).sort(),
    );
  });

  test("every integration patch field is written by some descriptor", () => {
    for (const [section, fields] of Object.entries(INTEGRATION_PATCH_FIELDS)) {
      for (const field of Object.keys(fields)) {
        const path = `${section}.${field}`;
        const byPath = settingDescriptor(path);
        const byClear = SETTINGS_REGISTRY.some(
          (d) => d.path.startsWith(`${section}.`) && d.clearWith === field,
        );
        assert.ok(
          (byPath && byPath.access !== "readonly") || byClear,
          `${path} has no descriptor`,
        );
      }
    }
  });
});

describe("settingsPatchForWrites", () => {
  test("a leaf write carries the rest of its section", () => {
    const current = getSettings();
    const patch = settingsPatchForWrites(
      [{ path: "sessionNaming.enabled", value: false }],
      current,
    );
    assert.deepEqual(patch.sessionNaming, {
      ...current.sessionNaming,
      enabled: false,
    });
  });

  test("several writes to one section combine", () => {
    const patch = settingsPatchForWrites([
      { path: "worktrees.namingAgent.provider", value: "pi" },
      { path: "worktrees.namingAgent.modelId", value: "model-x" },
    ]);
    assert.equal(patch.worktrees?.namingAgent?.provider, "pi");
    assert.equal(patch.worktrees?.namingAgent?.modelId, "model-x");
  });

  test("an empty optional field is removed", () => {
    const current = getSettings();
    current.commitAgent.credentialProfileId = "cp_x";
    const patch = settingsPatchForWrites(
      [{ path: "commitAgent.credentialProfileId", value: "" }],
      current,
    );
    assert.equal("credentialProfileId" in patch.commitAgent!, false);
  });

  test("top-level settings are written as is", () => {
    const patch = settingsPatchForWrites([
      { path: "projectsRoot", value: "/srv/projects" },
      { path: "skills", value: { notes: "on" } },
    ]);
    assert.equal(patch.projectsRoot, "/srv/projects");
    assert.deepEqual(patch.skills, { notes: "on" });
  });

  test("integration writes become patch fields; null clears a secret", () => {
    const patch = settingsPatchForWrites([
      { path: "github.defaultOwner", value: "thasso" },
      { path: "github.token", value: null },
      { path: "google.connection", value: null },
    ]);
    assert.deepEqual(patch.github, {
      defaultOwner: "thasso",
      clearToken: true,
    });
    assert.deepEqual(patch.google, { clearTokens: true });
    assert.deepEqual(
      settingsPatchForWrites([{ path: "slack.connection", value: null }]).slack,
      { disconnect: true },
    );
  });

  test("refuses what cannot be written", () => {
    const refuse = (path: string, value: unknown, pattern: RegExp) =>
      assert.throws(() => settingsPatchForWrites([{ path, value }]), pattern);
    refuse("nope.never", true, /Unknown setting: nope\.never/);
    refuse("jira.jiraHost", "x", /read-only: Set in the deployment config/);
    refuse("google.connection", true, /connected through the browser/);
    refuse("memory.maxCards", 99, /memory\.maxCards must be between 1 and 32/);
    refuse("worktrees.defaultMergeStrategy", "octopus", /must be one of/);
    refuse("peerSpawnRuntimes", "oops", /peerSpawnRuntimes must be an array/);
  });

  test("synthesis settings validate named voices and normalize persisted bounds", async () => {
    const before = getSettings().speechSynthesis;
    try {
      assert.equal(before.voice, "af_heart");
      assert.equal(before.numThreads, 8);
      assert.throws(
        () =>
          settingsPatchForWrites([
            { path: "speechSynthesis.voice", value: "unknown" },
          ]),
        /must be one of/,
      );
      assert.throws(
        () =>
          settingsPatchForWrites([{ path: "speechSynthesis.speed", value: 0 }]),
        /must be between/,
      );
      await saveSettings(
        settingsPatchForWrites([
          { path: "speechSynthesis.voice", value: "bm_lewis" },
          { path: "speechSynthesis.speed", value: 1.2 },
        ]),
      );
      assert.equal(getSettings().speechSynthesis.voice, "bm_lewis");
      assert.equal(getSettings().speechSynthesis.speed, 1.2);
      await saveSettings({
        speechSynthesis: {
          ...before,
          voice: "bad",
          speed: 99,
          numThreads: 99,
          idleShutdownSeconds: -1,
        },
      });
      assert.deepEqual(getSettings().speechSynthesis, {
        ...before,
        voice: "af_heart",
        speed: 2,
        numThreads: 32,
        idleShutdownSeconds: 0,
      });
    } finally {
      await saveSettings({ speechSynthesis: before });
    }
  });

  test("conversation settings have bounded registry writes and normalized persistence", async () => {
    const before = getSettings().speechConversation;
    try {
      assert.equal(before.numThreads, 4);
      assert.equal(before.endpointSilenceSeconds, 1.2);
      assert.throws(
        () =>
          settingsPatchForWrites([
            { path: "speechConversation.endpointSilenceSeconds", value: 0 },
          ]),
        /must be between/,
      );
      await saveSettings(
        settingsPatchForWrites([
          { path: "speechConversation.endpointSilenceSeconds", value: 1.8 },
        ]),
      );
      assert.equal(
        getSettings().speechConversation.endpointSilenceSeconds,
        1.8,
      );
      await saveSettings({
        speechConversation: {
          ...before,
          modelId: "  streaming  ",
          numThreads: 99,
          idleShutdownSeconds: -1,
          endpointSilenceSeconds: 99,
        },
      });
      assert.deepEqual(getSettings().speechConversation, {
        ...before,
        modelId: "streaming",
        numThreads: 32,
        idleShutdownSeconds: 0,
        endpointSilenceSeconds: 5,
      });
    } finally {
      await saveSettings({ speechConversation: before });
    }
  });

  test("schedule settings default, have bounded registry writes and normalized persistence", async () => {
    const before = getSettings().schedules;
    try {
      assert.deepEqual(before, {
        graceWindowMinutes: 60,
        cardlessLimit: 10,
        paused: false,
      });
      assert.throws(
        () =>
          settingsPatchForWrites([
            { path: "schedules.graceWindowMinutes", value: 1441 },
          ]),
        /must be between/,
      );
      await saveSettings(
        settingsPatchForWrites([{ path: "schedules.paused", value: true }]),
      );
      assert.deepEqual(getSettings().schedules, { ...before, paused: true });
      // Projected from the schedule store; the file keeps the rest only.
      assert.equal(scheduleStore.paused(), true);
      assert.deepEqual(readStoredAppSettings().schedules, {
        graceWindowMinutes: 60,
        cardlessLimit: 10,
      });
      await saveSettings({
        schedules: {
          graceWindowMinutes: -5,
          cardlessLimit: 500,
          paused: false,
        },
      });
      assert.deepEqual(getSettings().schedules, {
        graceWindowMinutes: 0,
        cardlessLimit: 100,
        paused: false,
      });
    } finally {
      await saveSettings({ schedules: before });
    }
  });

  test("a malformed vocabulary is refused before it can erase the current one", async () => {
    const vocabulary = [{ from: "pan deck", to: "Pandeck" }];
    await saveSettings(
      settingsPatchForWrites([
        { path: "speechToText.vocabulary", value: vocabulary },
      ]),
    );
    const refuse = (value: unknown, pattern: RegExp) =>
      assert.throws(
        () =>
          settingsPatchForWrites([{ path: "speechToText.vocabulary", value }]),
        pattern,
      );
    refuse("not an array", /vocabulary must be an array/);
    refuse([{ from: "a", to: 1 }], /vocabulary\[0\]\.to must be a string/);
    refuse(["a"], /vocabulary\[0\] must be an object/);
    refuse(
      Array.from({ length: 201 }, () => ({ from: "a", to: "b" })),
      /at most 200 entries/,
    );
    assert.deepEqual(getSettings().speechToText.vocabulary, vocabulary);
  });
});

test("working directory changes validate before persistence and rotate the PA", async () => {
  const pa = await import("./permanentAssistant.ts");
  const rotate = vi
    .spyOn(pa, "rotatePermanentAssistantSession")
    .mockResolvedValue();
  const before = getSettings().permanentAssistant;
  const cwd = join(DATA_DIR, "pa-settings-cwd");
  mkdirSync(cwd, { recursive: true });
  try {
    for (const workingDirectory of ["relative", join(cwd, "missing")]) {
      await assert.rejects(
        saveSettings({ permanentAssistant: { ...before, workingDirectory } }),
        /working directory.*(absolute path|existing directory)/,
      );
      assert.equal(
        getSettings().permanentAssistant.workingDirectory,
        before.workingDirectory,
      );
    }
    assert.equal(rotate.mock.calls.length, 0);
    await saveSettings({
      permanentAssistant: { ...before, workingDirectory: cwd },
    });
    assert.equal(getSettings().permanentAssistant.workingDirectory, cwd);
    assert.equal(rotate.mock.calls.length, 1);
    await saveSettings({
      permanentAssistant: getSettings().permanentAssistant,
    });
    assert.equal(rotate.mock.calls.length, 1);
    await saveSettings({
      permanentAssistant: {
        ...getSettings().permanentAssistant,
        workingDirectory: `${cwd}/../pa-settings-cwd/`,
      },
    });
    assert.equal(getSettings().permanentAssistant.workingDirectory, cwd);
    assert.equal(rotate.mock.calls.length, 1, "cosmetic paths do not rotate");
    assert.throws(
      () =>
        settingsPatchForWrites([
          { path: "permanentAssistant.workingDirectory", value: cwd },
        ]),
      /Settings UI/,
    );
    await saveSettings({
      permanentAssistant: { ...before, workingDirectory: "" },
    });
    assert.equal(getSettings().permanentAssistant.workingDirectory, "");
    assert.equal(rotate.mock.calls.length, 2);
  } finally {
    rotate.mockRestore();
    rmdirSync(cwd);
  }
});

test("a vanished cwd does not block UI profile edits, agent edits or account-delete unpinning", async () => {
  const pa = await import("./permanentAssistant.ts");
  const rotate = vi
    .spyOn(pa, "rotatePermanentAssistantSession")
    .mockResolvedValue();
  const { createCredentialProfile, deleteCredentialProfile } =
    await import("./credentialProfiles.ts");
  const { clearProfilePins } = await import("./credentialProfileUsage.ts");
  const before = getSettings().permanentAssistant;
  const account = createCredentialProfile({
    provider: "claude",
    name: "Vanished cwd account",
  });
  const cwd = join(DATA_DIR, "pa-vanished-cwd");
  mkdirSync(cwd, { recursive: true });
  try {
    await saveSettings({
      permanentAssistant: {
        ...before,
        credentialProfileId: account.id,
        workingDirectory: cwd,
      },
    });
    rmdirSync(cwd);
    await saveSettings({
      permanentAssistant: {
        ...getSettings().permanentAssistant,
        name: "Updated by UI",
      },
    });
    await saveSettings(
      settingsPatchForWrites([
        {
          path: "permanentAssistant.additionalInstructions",
          value: "Updated by agent",
        },
      ]),
    );
    assert.equal(getSettings().permanentAssistant.workingDirectory, cwd);
    deleteCredentialProfile(account.id);
    await clearProfilePins(account.id);
    assert.equal(
      getSettings().permanentAssistant.credentialProfileId,
      undefined,
    );
  } finally {
    await saveSettings({ permanentAssistant: before });
    rotate.mockRestore();
  }
});

describe("saveSettings", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  test("persists an app section before its first await", async () => {
    // First run's conditional naming (`onboarding.ts`) reads the stored name
    // and writes in one synchronous step; it relies on exactly this.
    const before = getSettings().sessionStatus;
    const next = {
      ...before,
      thinkingLevel: before.thinkingLevel === "high" ? "low" : "high",
    } as const;
    const pending = saveSettings({ sessionStatus: next });
    assert.deepEqual(readStoredAppSettings().sessionStatus, next);
    await pending;
    await saveSettings({ sessionStatus: before });
  });

  test("a failing effect or listener skips nothing after it", async () => {
    cleanups.push(
      subscribeIntegrationToolChanges(() => {
        throw new Error("subscriber failure");
      }),
    );
    cleanups.push(
      onSettingsChanged(() => {
        throw new Error("listener failure");
      }),
    );
    const heard: SettingsChange[] = [];
    cleanups.push(onSettingsChanged((change) => heard.push(change)));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => vi.restoreAllMocks());

    await assert.rejects(
      saveSettings({ brave: { enabled: true } }),
      /Settings saved, but updating session tools failed: subscriber failure/,
    );
    assert.equal(getSettings().brave.enabled, true);
    assert.deepEqual(heard, [{ sections: ["brave"] }]);
  });

  test("a failed write throws its own error after announcing what landed", async () => {
    const appearance = getSettings().appearance;
    const heard: SettingsChange[] = [];
    cleanups.push(onSettingsChanged((change) => heard.push(change)));
    // A directory where the Brave file belongs makes every full read throw.
    // Whatever file was there is moved aside and put back afterwards.
    const bravePath = join(DATA_DIR, "settings", "brave.json");
    const saved = `${bravePath}.test-saved`;
    const hadFile = existsSync(bravePath);
    if (hadFile) renameSync(bravePath, saved);
    mkdirSync(bravePath, { recursive: true });
    try {
      await assert.rejects(
        saveSettings({
          appearance: { ...appearance, separatorAtTurnEnd: false },
          brave: { enabled: true },
        }),
        (err: Error) =>
          !err.message.startsWith("Settings saved") &&
          /Brave config/.test(err.message),
      );
    } finally {
      rmdirSync(bravePath);
      if (hadFile) renameSync(saved, bravePath);
    }
    // `updateSettings` persisted appearance, then threw re-reading the broken
    // Brave file, so the Brave writer never ran: appearance alone is announced.
    assert.deepEqual(heard, [{ sections: ["appearance"] }]);
    assert.equal(getSettings().appearance.separatorAtTurnEnd, false);
  });

  test("an async writer is awaited: nothing is announced until it settles, and its rejection throws after the announcement", async () => {
    let settle!: {
      resolve(s: IntegrationStatus): void;
      reject(e: Error): void;
    };
    cleanups.push(
      installRemoteIntegrationPort({
        set: () =>
          new Promise<IntegrationStatus>((resolve, reject) => {
            settle = { resolve, reject };
          }),
        clear: () => Promise.resolve(),
        status: () => Promise.resolve({ connected: false }),
      }),
    );
    const heard: SettingsChange[] = [];
    cleanups.push(onSettingsChanged((change) => heard.push(change)));
    let done = false;
    const saving = saveSettings({
      jira: { atlassianToken: "fake-deferred-token" },
    }).finally(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(done, false);
    assert.deepEqual(heard, []);
    settle.resolve({
      connected: true,
      site: "example.atlassian.net",
      email: "",
    });
    const settings = await saving;
    assert.deepEqual(heard, [{ sections: ["jira"] }]);
    assert.equal(settings.jira.credentialStore, "gateway");
    assert.equal(settings.jira.atlassianTokenConfigured, true);

    const failing = saveSettings({ jira: { atlassianToken: "fake-again" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(heard.length, 1);
    settle.reject(new IntegrationRefusal("vault_locked"));
    await assert.rejects(
      failing,
      /^Error: Jira: the gateway's vault is locked\.$/,
    );
    assert.deepEqual(heard, [{ sections: ["jira"] }, { sections: ["jira"] }]);
  });

  test("announcing a write made elsewhere reaches every listener", async () => {
    const heard: SettingsChange[] = [];
    cleanups.push(onSettingsChanged((change) => heard.push(change)));
    await announceSettingsWritten(["brave"]);
    assert.deepEqual(heard, [{ sections: ["brave"] }]);
  });

  test("persists, then tells every listener which sections changed", async () => {
    const heard: SettingsChange[] = [];
    const stop = onSettingsChanged((change) => heard.push(change));
    try {
      await saveSettings(
        settingsPatchForWrites([
          { path: "appearance.turnStatsRow", value: false },
          { path: "brave.apiKey", value: "brave-key" },
        ]),
      );
    } finally {
      stop();
    }
    const settings = getSettings();
    assert.equal(settings.appearance.turnStatsRow, false);
    assert.equal(settings.brave.apiKeyConfigured, true);
    assert.deepEqual(heard, [{ sections: ["appearance", "brave"] }]);
  });
});

test("a write reaches every connected viewer, not only the writer", async () => {
  const { hub } = await import("./hub.ts");
  const changes: SettingsChange[][] = [[], []];
  const viewers = changes.map((heard) => ({
    send: () => {},
    settingsChanged: (change: SettingsChange) => heard.push(change),
  }));
  for (const viewer of viewers) hub.register(viewer);
  try {
    await saveSettings({
      browserTools: { headed: true, rawMcpEnabled: false },
    });
  } finally {
    for (const viewer of viewers) hub.unregister(viewer);
  }
  assert.deepEqual(changes, [
    [{ sections: ["browserTools"] }],
    [{ sections: ["browserTools"] }],
  ]);
});

test("models an account's Test discovers reach every client", async () => {
  const { hub } = await import("./hub.ts");
  const { Connection } = await import("./connection.ts");
  const {
    createCredentialProfile,
    deleteCredentialProfile,
    patchOpenAiCompatibleEndpoint,
    testOpenAiCompatibleProfile,
  } = await import("./credentialProfiles.ts");
  const { id } = createCredentialProfile({
    name: "Discovery",
    provider: "openai-compatible",
  });
  patchOpenAiCompatibleEndpoint(id, { baseUrl: "http://models.invalid/v1" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: [{ id: "new-model" }] }), {
        status: 200,
      }),
  ) as typeof fetch;
  const sent: ServerMessage[][] = [[], []];
  const connections = sent.map((messages) => {
    const connection = new Connection({
      OPEN: 1,
      readyState: 1,
      send: (raw: string) => messages.push(JSON.parse(raw) as ServerMessage),
    } as unknown as ConstructorParameters<typeof Connection>[0]);
    hub.register(connection);
    return connection;
  });
  try {
    await testOpenAiCompatibleProfile(id);
  } finally {
    globalThis.fetch = originalFetch;
    for (const connection of connections) connection.dispose();
    deleteCredentialProfile(id);
  }
  for (const messages of sent) {
    const models = messages.filter((m) => m.type === "models").at(-1);
    assert.ok(models?.type === "models", "every client got a model list");
    assert.ok(
      models.models.some(
        (model) => model.provider === id && model.id === "new-model",
      ),
    );
  }
});

describe("the settings message checks come from the registry", () => {
  test("every json setting has a deep check, and every deep check a setting", async () => {
    const { JSON_SETTING_VALIDATORS } =
      await import("./validateClientMessage.ts");
    const jsonPaths = SETTINGS_REGISTRY.filter(
      (d) => d.access === "value" && d.value?.kind === "json",
    )
      .map((d) => d.path)
      .sort();
    assert.deepEqual(Object.keys(JSON_SETTING_VALIDATORS).sort(), jsonPaths);
  });

  test("checks kinds the registry declares, including ones the old list missed", async () => {
    const { appSettingsPatchError } =
      await import("./validateClientMessage.ts");
    const cases: Array<[unknown, string | null]> = [
      [
        { worktrees: { namingAgent: "x" } },
        "patch.worktrees.namingAgent must be an object",
      ],
      [
        { worktrees: { namingAgent: { provider: 1 } } },
        "patch.worktrees.namingAgent.provider must be a string",
      ],
      [
        { sessionNaming: { credentialProfileId: 7 } },
        "patch.sessionNaming.credentialProfileId must be a string",
      ],
      [
        { backgroundWork: { ownerSessionCap: "many" } },
        "patch.backgroundWork.ownerSessionCap must be a finite number",
      ],
      [{ memory: "on" }, "patch.memory must be an object"],
      [{ skills: { notes: "ON" } }, 'patch.skills.notes must be "on" or "off"'],
      [
        { speechToText: { vocabulary: [{ from: "a", to: 1 }] } },
        "patch.speechToText.vocabulary[0].to must be a string",
      ],
      [
        { peerSpawnRuntimes: "oops" },
        "patch.peerSpawnRuntimes must be an array",
      ],
      [
        { models: { hidden: [1] } },
        "patch.models.hidden must be a string array",
      ],
      // Bounds and vocabularies stay with the normalizers, which clamp.
      [{ backgroundWork: { ownerSessionCap: 10_000 } }, null],
      [{ worktrees: { defaultMergeStrategy: "octopus" } }, null],
      // A read-only projection echoed back must still be its kind.
      [
        { profile: { effectiveTimeZone: 3 } },
        "patch.profile.effectiveTimeZone must be a string",
      ],
      [{ profile: { effectiveTimeZone: "UTC" } }, null],
    ];
    for (const [patch, expected] of cases)
      assert.equal(
        appSettingsPatchError(patch),
        expected,
        JSON.stringify(patch),
      );
  });
});

describe("Pause all through saveSettings", () => {
  const DEC1 = Date.parse("2026-12-01T09:00:00Z");
  const DEC2 = DEC1 + 24 * 60 * 60_000;
  const DAILY: ScheduleTiming = {
    kind: "daily",
    time: "09:00",
    timeZone: "UTC",
  };
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    while (cleanups.length) cleanups.pop()?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Back to defaults, then no row: the next read imports from the file.
    await saveSettings({
      schedules: { graceWindowMinutes: 60, cardlessLimit: 10, paused: false },
    });
    getDb().exec(
      "DELETE FROM schedule_occurrences; DELETE FROM schedules; DELETE FROM schedule_pause;",
    );
  });

  /** Dec 2 09:00 due and unticked, Dec 1 claimed and owed; now 09:00:15. */
  function dueWithOwed(): { id: string; owedId: string } {
    vi.useFakeTimers({ toFake: ["Date"] });
    getDb().exec(
      "DELETE FROM schedule_occurrences; DELETE FROM schedules; DELETE FROM schedule_pause;",
    );
    const { id } = scheduleStore.create(
      {
        name: "Daily check",
        prompt: "Check CI",
        timing: DAILY,
        target: { kind: "session", sessionId: "settings-target" },
        createdBy: { kind: "user" },
      },
      DEC1 - 60_000,
    );
    const owedId = scheduleStore.claimDue(id, DEC1, { graceMs: 3_600_000 })
      .claimed!.id;
    vi.setSystemTime(DEC2 + 15_000);
    return { id, owedId };
  }

  function states(id: string): string[] {
    return scheduleStore
      .history(id)
      .map((o) => `${new Date(o.dueAtMs).toISOString()} ${o.state}`);
  }

  /** Announcements, schedules topic reports and claims while it runs. */
  function record() {
    const heard = {
      sections: [] as SettingsChange[],
      reports: 0,
      claims: [] as string[],
    };
    cleanups.push(onSettingsChanged((change) => heard.sections.push(change)));
    const previous = setStateChangeSink((topic, ids) => {
      if (topic === "schedules" && ids.length) heard.reports += 1;
    });
    cleanups.push(() => setStateChangeSink(previous));
    cleanups.push(scheduleStore.onClaimed((o) => heard.claims.push(o.id)));
    return heard;
  }

  test("a switch that fails before commit leaves nothing of it; the grace in the same patch is saved (T2)", async () => {
    const { id, owedId } = dueWithOwed();
    const revision = scheduleStore.revision(id);
    const heard = record();
    getDb().exec(`CREATE TEMP TRIGGER fail_schedule_stamp
      BEFORE UPDATE OF revision ON schedules
      BEGIN SELECT RAISE(ABORT, 'stamp failed'); END`);
    cleanups.push(() => getDb().exec("DROP TRIGGER temp.fail_schedule_stamp"));
    await assert.rejects(
      saveSettings({
        schedules: { graceWindowMinutes: 90, cardlessLimit: 10, paused: true },
      }),
      /stamp failed/,
    );
    assert.equal(scheduleStore.paused(), false);
    assert.deepEqual(states(id), ["2026-12-01T09:00:00.000Z claimed"]);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
    assert.equal(scheduleStore.get(id)?.nextDueAtMs, DEC2);
    assert.equal(scheduleStore.revision(id), revision);
    assert.equal(heard.reports, 0);
    assert.deepEqual(heard.claims, []);
    assert.deepEqual(heard.sections, [{ sections: ["schedules"] }]);
    assert.deepEqual(getSettings().schedules, {
      graceWindowMinutes: 90,
      cardlessLimit: 10,
      paused: false,
    });
  });

  test("a failure after commit keeps the switch and its claims, still announces, and rejects (T3)", async () => {
    const { id, owedId } = dueWithOwed();
    const heard = record();
    const pause = settingsPatchForWrites([
      { path: "schedules.paused", value: true },
    ]);
    // A directory where the Brave file belongs makes every full read throw.
    const bravePath = join(DATA_DIR, "settings", "brave.json");
    const saved = `${bravePath}.test-saved`;
    const hadFile = existsSync(bravePath);
    if (hadFile) renameSync(bravePath, saved);
    mkdirSync(bravePath, { recursive: true });
    try {
      await assert.rejects(
        saveSettings(pause),
        (err: Error) =>
          !err.message.startsWith("Settings saved") &&
          /Brave config/.test(err.message),
      );
    } finally {
      rmdirSync(bravePath);
      if (hadFile) renameSync(saved, bravePath);
    }
    assert.deepEqual(heard.sections, [{ sections: ["schedules"] }]);
    assert.equal(scheduleStore.paused(), true);
    assert.deepEqual(states(id), [
      "2026-12-02T09:00:00.000Z claimed",
      "2026-12-01T09:00:00.000Z superseded",
    ]);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "superseded");
    assert.equal(heard.claims.length, 1);
    assert.equal(heard.reports, 1);
    closeDb();
    assert.equal(getSettings().schedules.paused, true);
  });

  test("a failed file write switches nothing (T4)", async () => {
    const { id, owedId } = dueWithOwed();
    const revision = scheduleStore.revision(id);
    const heard = record();
    const tmp = `${APP_SETTINGS_PATH}.tmp`;
    mkdirSync(tmp, { recursive: true });
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    await assert.rejects(
      saveSettings(
        settingsPatchForWrites([{ path: "schedules.paused", value: true }]),
      ),
      /EISDIR|illegal operation on a directory/,
    );
    assert.equal(scheduleStore.paused(), false);
    assert.deepEqual(states(id), ["2026-12-01T09:00:00.000Z claimed"]);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
    assert.equal(scheduleStore.revision(id), revision);
    assert.deepEqual(heard.claims, []);
    assert.equal(heard.reports, 0);
    assert.deepEqual(heard.sections, [{ sections: ["schedules"] }]);
  });

  test("an unreadable settings file with no stored pause switches nothing and never reads as not paused", async () => {
    const { id, owedId } = dueWithOwed();
    // The fixture's claim imported the pause; start with no row again.
    getDb().exec("DELETE FROM schedule_pause");
    const heard = record();
    const { readFileSync, writeFileSync } = await import("node:fs");
    const original = readFileSync(APP_SETTINGS_PATH, "utf8");
    writeFileSync(APP_SETTINGS_PATH, "{ not json");
    cleanups.push(() => writeFileSync(APP_SETTINGS_PATH, original));
    await assert.rejects(
      saveSettings({
        schedules: { graceWindowMinutes: 60, cardlessLimit: 10, paused: true },
      }),
      /Failed to read app settings/,
    );
    assert.equal(
      getDb().prepare("SELECT 1 FROM schedule_pause").get(),
      undefined,
      "no row was manufactured",
    );
    assert.deepEqual(states(id), ["2026-12-01T09:00:00.000Z claimed"]);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
    assert.deepEqual(heard.claims, []);
    assert.equal(heard.reports, 0);
    assert.deepEqual(heard.sections, [{ sections: ["schedules"] }]);
  });

  test("a save imports the file's former pause before dropping it from the file", async () => {
    getDb().exec("DELETE FROM schedule_pause");
    const { writeStoredAppSettings } = await import("./appSettingsFile.ts");
    writeStoredAppSettings({
      ...readStoredAppSettings(),
      schedules: { graceWindowMinutes: 60, cardlessLimit: 10, paused: true },
    });
    // A save that does not touch the pause keeps it.
    await saveSettings(
      settingsPatchForWrites([
        { path: "schedules.graceWindowMinutes", value: 45 },
      ]),
    );
    assert.equal("paused" in (readStoredAppSettings().schedules ?? {}), false);
    assert.deepEqual(getSettings().schedules, {
      graceWindowMinutes: 45,
      cardlessLimit: 10,
      paused: true,
    });
  });
});
