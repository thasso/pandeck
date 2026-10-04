import { describe, expect, it } from "vitest";
import {
  SETTINGS_OUTSIDE_REGISTRY,
  SETTINGS_REGISTRY,
  SETTINGS_SECTION_IDS,
  settingDescriptor,
  settingValueError,
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
      if (d.access === "readonly") expect(d.value, d.path).toBeUndefined();
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
});
