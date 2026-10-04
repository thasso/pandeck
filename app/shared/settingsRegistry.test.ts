import { describe, expect, it } from "vitest";
import {
  SETTINGS_OUTSIDE_REGISTRY,
  SETTINGS_REGISTRY,
  SETTINGS_SECTION_IDS,
  settingBounds,
  settingDescriptor,
  settingValueError,
  writeAppSettingAt,
} from "./settingsRegistry.ts";

describe("settings registry", () => {
  it("names each path once", () => {
    const paths = SETTINGS_REGISTRY.map((d) => d.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("accounts for every Settings page section", () => {
    const withDescriptors = new Set(SETTINGS_REGISTRY.map((d) => d.section));
    const unaccounted = SETTINGS_SECTION_IDS.filter(
      (id) => !withDescriptors.has(id) && !SETTINGS_OUTSIDE_REGISTRY[id],
    );
    expect(unaccounted).toEqual([]);
  });

  it("gives every access class the fields it needs", () => {
    for (const d of SETTINGS_REGISTRY) {
      if (d.access === "value" || d.access === "secret")
        expect(d.value, d.path).toBeDefined();
      // A read-only setting may declare the kind it reads as, never a bound.
      if (d.access === "readonly" && d.value)
        expect(["boolean", "string"], d.path).toContain(d.value.kind);
      if (d.access === "secret" || d.access === "oauth") {
        expect(d.configuredBy, d.path).toBeDefined();
        expect(d.clearWith, d.path).toBeDefined();
      }
    }
  });

  it("checks kind and bounds of a write", () => {
    const maxCards = settingDescriptor("memory.maxCards")!;
    expect(settingValueError(maxCards, 8)).toBeNull();
    expect(settingValueError(maxCards, 8.5)).toBe("must be a whole number");
    expect(settingValueError(maxCards, 99)).toBe("must be between 1 and 32");
    expect(settingValueError(maxCards, "8")).toBe("must be a number");

    const strategy = settingDescriptor("worktrees.defaultMergeStrategy")!;
    expect(settingValueError(strategy, "rebase")).toBeNull();
    expect(settingValueError(strategy, "octopus")).toBe(
      "must be one of squash, merge, rebase",
    );

    const host = settingDescriptor("jira.jiraHost")!;
    expect(settingValueError(host, "x")).toBe(
      "jira.jiraHost cannot be written",
    );
  });

  it("gives a numeric setting's bounds and refuses any other", () => {
    expect(settingBounds("memory.maxCards")).toEqual({ min: 1, max: 32 });
    expect(() => settingBounds("sessionNaming.enabled")).toThrow(
      "sessionNaming.enabled is not a numeric setting",
    );
  });

  it("writes an app setting into a section patch that keeps the rest", () => {
    const current = {
      worktrees: { root: "/w", namingAgent: { modelId: "m" } },
      commitAgent: { modelId: "m", credentialProfileId: "cp_1" },
    };
    const patch: Record<string, unknown> = {};
    writeAppSettingAt(patch, current, "worktrees.namingAgent.modelId", "n");
    writeAppSettingAt(patch, current, "worktrees.root", "/x");
    writeAppSettingAt(patch, current, "commitAgent.credentialProfileId", "");
    writeAppSettingAt(patch, current, "projectsRoot", "/p");
    expect(patch).toEqual({
      worktrees: { root: "/x", namingAgent: { modelId: "n" } },
      commitAgent: { modelId: "m" },
      projectsRoot: "/p",
    });
    // The current settings are never modified.
    expect(current.worktrees.root).toBe("/w");
  });
});
