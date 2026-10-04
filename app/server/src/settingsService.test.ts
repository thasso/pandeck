import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  SETTINGS_REGISTRY,
  settingDescriptor,
} from "@assistant/shared/settingsRegistry";
import { getSettings } from "./settings.ts";
import {
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

describe("registry coverage", () => {
  test("every leaf the Settings page receives has a descriptor", () => {
    const settings = getSettings();
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
    const settings = getSettings();
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
      const parent = d.optional
        ? d.path.split(".").slice(0, -1).join(".")
        : d.path;
      assert.notEqual(valueAt(settings, parent), undefined, d.path);
    }
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
});

describe("saveSettings", () => {
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
