// @vitest-environment jsdom
import { act, useState } from "react";
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
import {
  CLAIMED_SETTING_PATHS,
  OMITTED_SETTING_PATHS,
  RENDERED_SETTING_PATHS,
} from "./settingsClaims.ts";

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

test("today only the Tempo worklog author is rendered from the registry", () => {
  const unclaimed = SETTINGS_REGISTRY.filter(
    (d) => !CLAIMED_SETTING_PATHS.has(d.path),
  ).map((d) => d.path);
  expect(unclaimed).toEqual(["tempo.authorAccountId"]);
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
    'input[aria-label="Density"]',
  )!;
  type(number, "9");
  blur(number);
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
      section="tempo"
      settings={
        { tempo: { authorAccountId: "acc-123" } } as unknown as AppSettings
      }
      onUpdate={vi.fn()}
    />,
  );
  expect(container!.textContent).toContain("Worklog author account");
  expect(container!.textContent).toContain("acc-123");
  expect(container!.querySelector("input")).toBeNull();
});

test("an omitted path says why, and is not also rendered", () => {
  for (const [path, reason] of Object.entries(OMITTED_SETTING_PATHS)) {
    expect(settingDescriptor(path), path).toBeDefined();
    expect(reason.length, path).toBeGreaterThan(10);
    expect(RENDERED_SETTING_PATHS, path).not.toContain(path);
  }
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

function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function blur(input: HTMLElement): void {
  act(() => {
    input.dispatchEvent(new FocusEvent("blur"));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

const timeout: SettingDescriptor = {
  path: "pdfConversion.timeoutMs",
  section: "pdf-conversion",
  label: "Timeout",
  access: "value",
  value: { kind: "integer", min: 30_000, max: 600_000 },
};
const projectId: SettingDescriptor = {
  path: "taskIntakeAgent.projectId",
  section: "task-intake",
  label: "Project",
  access: "value",
  value: { kind: "string" },
};

/** A page that applies each save to its settings, as the server's echo does. */
function Echoing({
  initial,
  descriptor,
  section,
  onSave,
  expose,
}: {
  initial: object;
  descriptor: SettingDescriptor;
  section: SettingDescriptor["section"];
  onSave: (patch: Partial<AppSettings>) => void;
  expose?: (set: (next: object) => void) => void;
}) {
  const [current, setCurrent] = useState(initial);
  expose?.(setCurrent);
  return (
    <RegistrySettingFields
      section={section}
      settings={current as AppSettings}
      descriptors={[descriptor]}
      claimed={new Set()}
      onUpdate={(patch) => {
        onSave(patch);
        setCurrent((was) => ({ ...was, ...patch }));
      }}
    />
  );
}

test("a number can be replaced digit by digit and is clamped only when saved", () => {
  const onSave = vi.fn();
  render(
    <Echoing
      initial={{ pdfConversion: { timeoutMs: 180_000 } }}
      descriptor={timeout}
      section="pdf-conversion"
      onSave={onSave}
    />,
  );
  const input = container!.querySelector<HTMLInputElement>("input")!;
  type(input, "");
  expect(input.value).toBe("");
  type(input, "6");
  type(input, "60");
  type(input, "60000");
  expect(onSave).not.toHaveBeenCalled();
  expect(input.value).toBe("60000");
  blur(input);
  expect(onSave).toHaveBeenLastCalledWith({
    pdfConversion: { timeoutMs: 60_000 },
  });
  expect(input.value).toBe("60000");

  // Out of range is clamped when saved; nothing usable keeps the stored value.
  type(input, "5");
  blur(input);
  expect(onSave).toHaveBeenLastCalledWith({
    pdfConversion: { timeoutMs: 30_000 },
  });
  type(input, "");
  blur(input);
  expect(onSave).toHaveBeenCalledTimes(2);
  expect(input.value).toBe("30000");
});

test("an incoming value never replaces text the user is still typing", () => {
  let setFromServer: (next: object) => void = () => {};
  const onSave = vi.fn();
  render(
    <Echoing
      initial={{ taskIntakeAgent: { projectId: "alpha" } }}
      descriptor={projectId}
      section="task-intake"
      onSave={onSave}
      expose={(set) => (setFromServer = set)}
    />,
  );
  const input = container!.querySelector<HTMLInputElement>("input")!;
  type(input, "beta-in-progress");
  // Another tab, or the assistant, saves a different value meanwhile.
  act(() => setFromServer({ taskIntakeAgent: { projectId: "gamma" } }));
  expect(input.value).toBe("beta-in-progress");
  blur(input);
  expect(onSave).toHaveBeenLastCalledWith({
    taskIntakeAgent: { projectId: "beta-in-progress" },
  });
  // A pristine field follows the server again.
  act(() => setFromServer({ taskIntakeAgent: { projectId: "delta" } }));
  expect(input.value).toBe("delta");
});

test("Escape discards an edit", () => {
  const onSave = vi.fn();
  render(
    <Echoing
      initial={{ taskIntakeAgent: { projectId: "alpha" } }}
      descriptor={projectId}
      section="task-intake"
      onSave={onSave}
    />,
  );
  const input = container!.querySelector<HTMLInputElement>("input")!;
  type(input, "oops");
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(input.value).toBe("alpha");
  blur(input);
  expect(onSave).not.toHaveBeenCalled();
});

test("an enum shows an unknown or missing value as such, not as the first choice", () => {
  const strategy: SettingDescriptor = {
    path: "worktrees.defaultMergeStrategy",
    section: "worktrees",
    label: "Strategy",
    access: "value",
    value: { kind: "enum", values: ["squash", "merge"] },
  };
  for (const [stored, label] of [
    ["octopus", "Unsupported: octopus"],
    [undefined, "Not set"],
  ] as const) {
    render(
      <Echoing
        initial={{ worktrees: { defaultMergeStrategy: stored } }}
        descriptor={strategy}
        section="worktrees"
        onSave={vi.fn()}
      />,
    );
    const select = container!.querySelector<HTMLSelectElement>("select")!;
    expect(select.selectedOptions[0]?.textContent).toBe(label);
    expect(select.selectedOptions[0]?.disabled).toBe(true);
    act(() => root?.unmount());
    container?.remove();
    root = null;
  }
});
