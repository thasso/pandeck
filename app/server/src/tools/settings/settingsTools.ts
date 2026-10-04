import type { AppSettings } from "@assistant/shared";
import {
  SETTINGS_OUTSIDE_REGISTRY,
  SETTINGS_REGISTRY,
  SETTINGS_SECTION_IDS,
  settingDescriptor,
  type SettingDescriptor,
  type SettingValueSpec,
  type SettingsSectionId,
} from "@assistant/shared/settingsRegistry";
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import { getSettings } from "../../settings.ts";
import {
  ASSISTANT_PROFILE_FIELDS,
  saveSettings,
  settingsPatchForWrites,
  TESTABLE_SETTINGS_SECTIONS,
  testSettingsSection,
  type SettingWrite,
} from "../../settingsService.ts";

/**
 * The Personal Assistant's view of the Settings page ([Task-729](pa://task/729)).
 * Both tools read and write through the registry and `settingsService.ts`, the
 * same path the page uses, so a setting the page gains is one they gain.
 * Secret values never pass through them: reads report only whether a secret
 * is set, and a write may only clear one.
 */

const MAX_PATHS = 50;
const MAX_CHANGES = 50;

type SettingsReadParams = { section?: string; paths?: string[] };

type SettingsUpdateParams = {
  changes?: Array<{ path?: string; value?: unknown }>;
  test?: string[];
};

const settingsReadSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    section: {
      type: "string",
      enum: [...SETTINGS_SECTION_IDS],
      description: "A Settings page section: every setting in it.",
    },
    paths: {
      type: "array",
      maxItems: MAX_PATHS,
      items: { type: "string" },
      description: "Specific setting paths, e.g. sessionNaming.enabled.",
    },
  },
} as const;

const settingsUpdateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    changes: {
      type: "array",
      maxItems: MAX_CHANGES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "value"],
        properties: {
          path: { type: "string", description: "A path from settings_read." },
          value: {
            description:
              "The new value, matching the setting's type. null clears a secret or disconnects an OAuth connection.",
          },
        },
      },
      description: "Applied together, in order.",
    },
    test: {
      type: "array",
      items: { type: "string", enum: TESTABLE_SETTINGS_SECTIONS },
      description:
        "Integration sections whose connection test runs after saving.",
    },
  },
} as const;

/** How a setting's value is written, in a few words. */
function describeValue(spec: SettingValueSpec): string {
  switch (spec.kind) {
    case "boolean":
      return "boolean";
    case "string":
      return spec.multiline ? "text" : "string";
    case "integer":
    case "number":
      return `${spec.kind} ${spec.min}–${spec.max}`;
    case "enum":
      return `one of: ${spec.values.join(", ")}`;
    case "json":
      return `json: ${spec.shape}`;
  }
}

function valueAt(root: unknown, path: string): unknown {
  let node = root;
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** One setting as an agent sees it. A secret's value is never part of it. */
function entryFor(descriptor: SettingDescriptor, settings: AppSettings) {
  const { path, label, access, value, hint, configuredBy } = descriptor;
  const state =
    access === "secret"
      ? { configured: valueAt(settings, configuredBy!) === true }
      : access === "oauth"
        ? { connected: valueAt(settings, configuredBy!) === true }
        : { value: valueAt(settings, path) ?? null };
  return {
    path,
    label,
    access,
    ...(value ? { type: describeValue(value) } : {}),
    ...state,
    ...(hint ? { hint } : {}),
  };
}

function sectionIndex() {
  return SETTINGS_SECTION_IDS.map((id) => {
    const count = SETTINGS_REGISTRY.filter((d) => d.section === id).length;
    const outside = SETTINGS_OUTSIDE_REGISTRY[id];
    return {
      section: id,
      settings: count,
      ...(outside ? { notInSettingsTools: outside } : {}),
    };
  });
}

const settingsReadTool = defineAgentTool<SettingsReadParams>({
  name: "settings_read",
  label: "Read Settings",
  description:
    "Read the app's settings: everything the user can see on the Settings page. With no arguments, list the sections; pass section for all its settings or paths for specific ones. Each setting reports its value, type and access. A secret reports only whether it is set: its value is never readable.",
  parameters: settingsReadSchema,
  async execute(params) {
    const paths = params.paths ?? [];
    if (!params.section && paths.length === 0)
      return jsonResult({ sections: sectionIndex() });
    const unknown = paths.filter((path) => !settingDescriptor(path));
    if (unknown.length > 0)
      throw new Error(
        `Unknown setting path: ${unknown.join(", ")}. Read a section to see its paths.`,
      );
    const descriptors = SETTINGS_REGISTRY.filter(
      (d) => d.section === params.section || paths.includes(d.path),
    );
    const settings = getSettings();
    const outside = params.section
      ? SETTINGS_OUTSIDE_REGISTRY[params.section as SettingsSectionId]
      : undefined;
    return jsonResult({
      settings: descriptors.map((d) => entryFor(d, settings)),
      ...(outside ? { notInSettingsTools: outside } : {}),
    });
  },
});

const settingsUpdateTool = defineAgentTool<SettingsUpdateParams>({
  name: "settings_update",
  label: "Update Settings",
  description:
    "Change settings, as the user could on the Settings page; the change applies at once. Each change names a path from settings_read and its new value: a field replaces only itself, a json value is written whole. null clears a secret or disconnects an OAuth connection. Never ask for a secret's value in chat: the user enters it on the section's Settings page. test runs integration connection tests after saving.",
  parameters: settingsUpdateSchema,
  async execute(params) {
    const changes = params.changes ?? [];
    const tests = (params.test ?? []) as SettingsSectionId[];
    if (changes.length === 0 && tests.length === 0)
      throw new Error("Pass at least one change or one section to test.");
    const writes: SettingWrite[] = changes.map(({ path = "", value }) => {
      const descriptor = settingDescriptor(path);
      if (descriptor?.access === "secret" && value !== null)
        throw new Error(
          `${path} is a secret, and secret values never pass through an agent. Ask the user to enter it on the Settings page (/settings/${descriptor.section}).`,
        );
      return { path, value: value === undefined ? null : value };
    });
    const assistantBefore = getSettings().permanentAssistant;
    if (writes.length > 0) await saveSettings(settingsPatchForWrites(writes));
    const settings = getSettings();
    const saved = writes.map(({ path }) =>
      entryFor(settingDescriptor(path)!, settings),
    );
    const results = [];
    for (const section of tests)
      results.push({ section, ...(await testSettingsSection(section)) });
    const restartsAssistant = ASSISTANT_PROFILE_FIELDS.some(
      (field) => assistantBefore[field] !== settings.permanentAssistant[field],
    );
    return jsonResult({
      ...(saved.length > 0 ? { saved } : {}),
      ...(results.length > 0 ? { tests: results } : {}),
      ...(restartsAssistant
        ? {
            assistantRestart:
              "The Personal Assistant's profile changed. The user's next message to it starts a fresh session with the new profile.",
          }
        : {}),
    });
  },
});

export const settingsTools = [settingsReadTool, settingsUpdateTool];
