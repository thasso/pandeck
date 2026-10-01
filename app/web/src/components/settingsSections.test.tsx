// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { SETTINGS_SECTION_IDS } from "../hooks/useSessionRouting.ts";
import {
  navigableSettingsGroups,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
} from "./settingsSections.tsx";

describe("grouped settings navigation", () => {
  test("keeps appearance first and provider controls together", () => {
    expect(SETTINGS_GROUPS[0]?.sections[0]?.id).toBe("appearance");
    expect(
      SETTINGS_GROUPS.find(
        (group) => group.id === "models-providers",
      )?.sections.map((section) => section.id),
    ).toEqual(["models", "claude-sdk", "openai", "openai-compatible"]);
  });

  test("places every routable section in exactly one group", () => {
    const groupedIds = SETTINGS_SECTIONS.map((section) => section.id);
    expect(groupedIds).toEqual([...SETTINGS_SECTION_IDS]);
    expect(new Set(groupedIds).size).toBe(groupedIds.length);
  });

  test("lists port forwarding only in the macOS shell, but routes it everywhere", () => {
    const listed = () =>
      navigableSettingsGroups()
        .flatMap((group) => group.sections)
        .map((section) => section.id);
    const everythingElse = SETTINGS_SECTIONS.map(
      (section) => section.id,
    ).filter((id) => id !== "port-forwarding");

    document.documentElement.removeAttribute("data-native-shell");
    expect(listed()).toEqual(everythingElse);
    document.documentElement.setAttribute("data-native-shell", "ios");
    expect(listed()).toEqual(everythingElse);
    document.documentElement.setAttribute("data-native-shell", "macos");
    expect(listed()).toEqual([...SETTINGS_SECTION_IDS]);
    document.documentElement.removeAttribute("data-native-shell");

    // Hidden from the browser's navigation, still a section it can render.
    expect(SETTINGS_SECTION_IDS).toContain("port-forwarding");
  });
});
