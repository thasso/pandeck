import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import {
  SETTINGS_REGISTRY,
  settingDescriptor,
} from "@assistant/shared/settingsRegistry";
import type {
  AppSettings,
  DayScanIdentities,
  ServerMessage,
} from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import { subscribeIntegrationToolChanges } from "./integrationToolChanges.ts";
import { getSettings } from "./settings.ts";
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
 * them out. Account pins are the slots' only optional field and
 * `listSettingsModelSlots` is tested to list every slot; the identities are
 * typed `Required`, so a new one is a type error until it is added here.
 */
function populatedSettings(): AppSettings {
  const settings = structuredClone(getSettings());
  for (const { slot } of listSettingsModelSlots(settings))
    slot.credentialProfileId = "cp_fixture";
  const identities: Required<DayScanIdentities> = {
    googleEmail: "me@example.com",
    jiraAccountId: "jira-account",
    jiraEmail: "me@example.com",
    githubLogin: "me",
    tempoAccountId: "tempo-account",
  };
  settings.dayScan.identities = identities;
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
      { path: "dayScan.schedule.enabled", value: true },
      { path: "dayScan.schedule.time", value: "06:30" },
    ]);
    assert.equal(patch.dayScan?.schedule.enabled, true);
    assert.equal(patch.dayScan?.schedule.time, "06:30");
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

describe("saveSettings", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
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

  test("announcing a write made elsewhere reaches every listener", async () => {
    const heard: SettingsChange[] = [];
    cleanups.push(onSettingsChanged((change) => heard.push(change)));
    await announceSettingsWritten(["openAiCompatible"]);
    assert.deepEqual(heard, [{ sections: ["openAiCompatible"] }]);
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

test("models a connection test discovers reach every client", async () => {
  const { hub } = await import("./hub.ts");
  const { Connection } = await import("./connection.ts");
  await saveSettings({
    openAiCompatible: { enabled: true, baseUrl: "http://models.invalid/v1" },
  });
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
    await connections[0]!.handle({ type: "testOpenAiCompatibleSettings" });
  } finally {
    globalThis.fetch = originalFetch;
    for (const connection of connections) connection.dispose();
  }
  const [tester = [], other = []] = sent;
  const otherSettings = other.filter((m) => m.type === "settings").at(-1);
  assert.ok(
    otherSettings?.type === "settings",
    "the other client got settings",
  );
  assert.deepEqual(
    otherSettings.settings.openAiCompatible.models.map((m) => m.id),
    ["new-model"],
  );
  assert.ok(
    other.some((m) => m.type === "models"),
    "and a fresh model list",
  );
  // The test result itself answers only the client that asked.
  assert.ok(tester.some((m) => m.type === "openAiCompatibleStatus"));
  assert.equal(
    other.some((m) => m.type === "openAiCompatibleStatus"),
    false,
  );
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
      [
        { dayScan: { schedule: "07:00" } },
        "patch.dayScan.schedule must be an object",
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
