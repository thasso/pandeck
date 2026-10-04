// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { AppSettings } from "@assistant/shared";
import {
  INTEGRATION_SETTINGS_SECTIONS,
  SETTINGS_REGISTRY,
  settingDescriptor,
  type SettingDescriptor,
} from "@assistant/shared/settingsRegistry";
import { RegistrySettingFields } from "./RegistrySettingFields.tsx";
import { CLAIMED_SETTING_PATHS } from "./settingsClaims.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

test("every claimed path is a real setting", () => {
  const unknown = [...CLAIMED_SETTING_PATHS].filter(
    (path) => !settingDescriptor(path),
  );
  expect(unknown).toEqual([]);
});

test("every setting that needs hand-built UI is claimed", () => {
  const needsUi = SETTINGS_REGISTRY.filter(
    (d) =>
      d.access === "secret" ||
      d.access === "oauth" ||
      d.value?.kind === "json" ||
      (d.access === "value" &&
        INTEGRATION_SETTINGS_SECTIONS.includes(d.path.split(".")[0] ?? "")),
  ).map((d) => d.path);
  expect(needsUi.filter((path) => !CLAIMED_SETTING_PATHS.has(path))).toEqual(
    [],
  );
});

test("today only the read-only values no section shows are rendered from the registry", () => {
  const unclaimed = SETTINGS_REGISTRY.filter(
    (d) => !CLAIMED_SETTING_PATHS.has(d.path),
  ).map((d) => d.path);
  expect(unclaimed).toEqual([
    "google.redirectUri",
    "tempo.redirectUri",
    "tempo.authorAccountId",
  ]);
});

const settings = {
  appearance: { turnStatsRow: true, density: 3 },
  dayScan: { schedule: { time: "07:00" } },
  google: { redirectUri: "https://example.invalid/callback" },
} as unknown as AppSettings;

const synthetic: SettingDescriptor[] = [
  {
    path: "appearance.turnStatsRow",
    section: "appearance",
    label: "Stats row",
    access: "value",
    value: { kind: "boolean" },
    hint: "Shown after each turn.",
  },
  {
    path: "appearance.density",
    section: "appearance",
    label: "Density",
    access: "value",
    value: { kind: "integer", min: 1, max: 5 },
  },
  {
    path: "appearance.mode",
    section: "appearance",
    label: "Mode",
    access: "value",
    value: { kind: "enum", values: ["a", "b"] },
  },
];

test("a new setting renders from its descriptor and saves through a section patch", () => {
  const onUpdate = vi.fn();
  render(
    <RegistrySettingFields
      section="appearance"
      settings={settings}
      onUpdate={onUpdate}
      descriptors={synthetic}
      claimed={new Set()}
    />,
  );
  expect(container!.textContent).toContain("More settings");
  expect(container!.textContent).toContain("Shown after each turn.");

  const checkbox = container!.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  act(() => checkbox.click());
  expect(onUpdate).toHaveBeenLastCalledWith({
    appearance: { turnStatsRow: false, density: 3 },
  });

  const number = container!.querySelector<HTMLInputElement>(
    'input[type="number"]',
  )!;
  expect(number.min).toBe("1");
  expect(number.max).toBe("5");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(number, "9");
    number.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onUpdate).toHaveBeenLastCalledWith({
    appearance: { turnStatsRow: true, density: 5 },
  });

  const select = container!.querySelector<HTMLSelectElement>("select")!;
  act(() => {
    select.value = "b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onUpdate).toHaveBeenLastCalledWith({
    appearance: { turnStatsRow: true, density: 3, mode: "b" },
  });
});

test("a read-only setting shows its value", () => {
  render(
    <RegistrySettingFields
      section="google"
      settings={settings}
      onUpdate={vi.fn()}
    />,
  );
  expect(container!.textContent).toContain("OAuth redirect URI");
  expect(container!.textContent).toContain("https://example.invalid/callback");
  expect(container!.querySelector("input")).toBeNull();
});

test("a section whose own UI claims everything renders nothing", () => {
  render(
    <RegistrySettingFields
      section="appearance"
      settings={settings}
      onUpdate={vi.fn()}
    />,
  );
  expect(container!.textContent).toBe("");
});
