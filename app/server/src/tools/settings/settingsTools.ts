import type { AppSettings, SettingsInputApprovalBody } from "@assistant/shared";
import {
  SETTINGS_OUTSIDE_REGISTRY,
  SETTINGS_REGISTRY,
  SETTINGS_SECTION_IDS,
  settingDescriptor,
  valueAtPath,
  type SettingDescriptor,
  type SettingValueSpec,
  type SettingsSectionId,
} from "@assistant/shared/settingsRegistry";
import { errorText } from "../../errors.ts";
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import {
  approvalCardReference,
  createApproval,
} from "../../pendingApprovals.ts";
import { redactSecrets, redactSecretsDeep } from "../../secretRedaction.ts";
import { settingIsSet } from "../../settingsInput.ts";
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
const MAX_REASON_CHARS = 500;

// Typed loosely on purpose: the arguments are checked at execution.
type SettingsReadParams = Record<string, unknown>;
type SettingsUpdateParams = Record<string, unknown>;
type SettingsRequestInputParams = Record<string, unknown>;

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
      maxItems: TESTABLE_SETTINGS_SECTIONS.length,
      uniqueItems: true,
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

/** One setting as an agent sees it. A secret's value is never part of it. */
function entryFor(descriptor: SettingDescriptor, settings: AppSettings) {
  const { path, label, access, value, hint, configuredBy } = descriptor;
  const state =
    access === "secret"
      ? { configured: valueAtPath(settings, configuredBy!) === true }
      : access === "oauth"
        ? { connected: valueAtPath(settings, configuredBy!) === true }
        : { value: valueAtPath(settings, path) ?? null };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0)
    throw new Error(`${where} has unknown fields: ${extra.join(", ")}`);
}

function isSectionId(value: unknown): value is SettingsSectionId {
  return (SETTINGS_SECTION_IDS as readonly unknown[]).includes(value);
}

/**
 * The read arguments, checked here because neither harness enforces the
 * schema before `execute`.
 */
function readParams(raw: unknown): {
  section?: SettingsSectionId;
  paths: string[];
} {
  if (!isRecord(raw)) throw new Error("Arguments must be an object.");
  rejectUnknownKeys(raw, ["section", "paths"], "settings_read");
  if (raw.section !== undefined && !isSectionId(raw.section))
    throw new Error(`Unknown section: ${String(raw.section)}`);
  const paths = raw.paths ?? [];
  if (
    !Array.isArray(paths) ||
    paths.length > MAX_PATHS ||
    !paths.every((path) => typeof path === "string")
  )
    throw new Error(`paths must be at most ${MAX_PATHS} strings.`);
  return {
    ...(raw.section !== undefined ? { section: raw.section } : {}),
    paths,
  };
}

/** The update arguments, checked in full before anything is written. */
function updateParams(raw: unknown): {
  writes: SettingWrite[];
  tests: SettingsSectionId[];
} {
  if (!isRecord(raw)) throw new Error("Arguments must be an object.");
  rejectUnknownKeys(raw, ["changes", "test"], "settings_update");
  const changes = raw.changes ?? [];
  if (!Array.isArray(changes) || changes.length > MAX_CHANGES)
    throw new Error(`changes must be an array of at most ${MAX_CHANGES}.`);
  const writes = changes.map((change: unknown, i): SettingWrite => {
    if (!isRecord(change)) throw new Error(`changes[${i}] must be an object.`);
    rejectUnknownKeys(change, ["path", "value"], `changes[${i}]`);
    if (typeof change.path !== "string")
      throw new Error(`changes[${i}].path must be a string.`);
    // An omitted value is a malformed change, never a null that disconnects.
    if (!Object.hasOwn(change, "value") || change.value === undefined)
      throw new Error(`changes[${i}].value is required.`);
    const descriptor = settingDescriptor(change.path);
    if (descriptor?.access === "secret" && change.value !== null)
      throw new Error(
        `${change.path} is a secret, and secret values never pass through an agent. Ask the user for it with settings_request_input.`,
      );
    return { path: change.path, value: change.value };
  });
  const test = raw.test ?? [];
  if (!Array.isArray(test))
    throw new Error("test must be an array of section ids.");
  const tests = [...new Set(test as unknown[])].map((section) => {
    if (!TESTABLE_SETTINGS_SECTIONS.includes(section as SettingsSectionId))
      throw new Error(
        `${String(section)} has no connection test. Testable: ${TESTABLE_SETTINGS_SECTIONS.join(", ")}.`,
      );
    return section as SettingsSectionId;
  });
  if (writes.length === 0 && tests.length === 0)
    throw new Error("Pass at least one change or one section to test.");
  return { writes, tests };
}

/**
 * Run a tool body with everything it returns or throws scrubbed of secrets.
 * Settings values hold none by construction, but a base URL may carry
 * credentials and integration errors were written for the Settings page.
 */
async function scrubbed(run: () => Promise<unknown>, terminate = false) {
  try {
    const result = jsonResult(redactSecretsDeep(await run()));
    return terminate ? { ...result, terminate: true } : result;
  } catch (err) {
    throw new Error(redactSecrets(errorText(err)));
  }
}

const settingsReadTool = defineAgentTool<SettingsReadParams>({
  name: "settings_read",
  label: "Read Settings",
  description:
    "Read the app's settings: everything the user can see on the Settings page. With no arguments, list the sections; pass section for all its settings or paths for specific ones. Each setting reports its value, type and access. A secret reports only whether it is set: its value is never readable.",
  parameters: settingsReadSchema,
  execute: (raw) =>
    scrubbed(async () => {
      const { section, paths } = readParams(raw);
      if (!section && paths.length === 0) return { sections: sectionIndex() };
      const unknown = paths.filter((path) => !settingDescriptor(path));
      if (unknown.length > 0)
        throw new Error(
          `Unknown setting path: ${unknown.join(", ")}. Read a section to see its paths.`,
        );
      const descriptors = SETTINGS_REGISTRY.filter(
        (d) => d.section === section || paths.includes(d.path),
      );
      const settings = getSettings();
      const outside = section ? SETTINGS_OUTSIDE_REGISTRY[section] : undefined;
      return {
        settings: descriptors.map((d) => entryFor(d, settings)),
        ...(outside ? { notInSettingsTools: outside } : {}),
      };
    }),
});

const settingsUpdateTool = defineAgentTool<SettingsUpdateParams>({
  name: "settings_update",
  label: "Update Settings",
  description:
    "Change settings, as the user could on the Settings page; the change applies at once. Each change names a path from settings_read and its new value: a field replaces only itself, a json value is written whole. null clears a secret or disconnects an OAuth connection. Never ask for a secret's value in chat: settings_request_input lets the user enter it. test runs integration connection tests after saving.",
  parameters: settingsUpdateSchema,
  execute: (raw, ctx) =>
    scrubbed(async () => {
      const { writes, tests } = updateParams(raw);
      const patch = settingsPatchForWrites(writes);
      ctx.signal?.throwIfAborted();
      const assistantBefore = getSettings().permanentAssistant;
      if (writes.length > 0) await saveSettings(patch);
      const settings = getSettings();
      const saved = writes.map(({ path }) =>
        entryFor(settingDescriptor(path)!, settings),
      );
      const results: Array<{ section: string; ok: boolean; message: string }> =
        [];
      for (const section of tests) {
        ctx.signal?.throwIfAborted();
        results.push({
          section,
          ...(await testSettingsSection(section, ctx.signal)),
        });
        ctx.progress?.(
          jsonResult(redactSecretsDeep({ saved, tests: results })),
        );
      }
      const restartsAssistant = ASSISTANT_PROFILE_FIELDS.some(
        (field) =>
          assistantBefore[field] !== settings.permanentAssistant[field],
      );
      return {
        ...(saved.length > 0 ? { saved } : {}),
        ...(results.length > 0 ? { tests: results } : {}),
        ...(restartsAssistant
          ? {
              assistantRestart:
                "The Personal Assistant's profile changed. The user's next message to it starts a fresh session with the new profile.",
            }
          : {}),
      };
    }),
});

const settingsRequestInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: {
      type: "string",
      description:
        "A secret or oauth setting from settings_read, e.g. github.token or google.connection.",
    },
    reason: {
      type: "string",
      maxLength: MAX_REASON_CHARS,
      description: "Why you need it, shown on the card.",
    },
  },
} as const;

function requestInputParams(raw: unknown): { path: string; reason?: string } {
  if (!isRecord(raw)) throw new Error("Arguments must be an object.");
  rejectUnknownKeys(raw, ["path", "reason"], "settings_request_input");
  if (typeof raw.path !== "string") throw new Error("path must be a string.");
  if (raw.reason !== undefined && typeof raw.reason !== "string")
    throw new Error("reason must be a string.");
  const reason = raw.reason?.trim().slice(0, MAX_REASON_CHARS);
  return { path: raw.path, ...(reason ? { reason } : {}) };
}

const settingsRequestInputTool = defineAgentTool<SettingsRequestInputParams>({
  name: "settings_request_input",
  label: "Request Setting Input",
  description:
    "Ask the user for a secret (an API key or token) or to connect an account, through a card in the chat. A secret goes from the card to the server and never reaches you; you learn only that it was saved and how the connection test went. Your turn ends; the outcome arrives when the user answers.",
  parameters: settingsRequestInputSchema,
  execute: (raw, ctx) =>
    scrubbed(async () => {
      const { path, reason } = requestInputParams(raw);
      const descriptor = settingDescriptor(path);
      if (!descriptor)
        throw new Error(
          `Unknown setting path: ${path}. Read a section to see its paths.`,
        );
      if (descriptor.access !== "secret" && descriptor.access !== "oauth")
        throw new Error(
          `${path} is not a secret or a connection; change it with settings_update.`,
        );
      const settings = getSettings();
      const section = path.split(".")[0] ?? "";
      if (
        descriptor.access === "oauth" &&
        valueAtPath(settings, `${section}.oauthClientConfigured`) === false
      )
        throw new Error(
          `${descriptor.label} cannot be connected: this server has no OAuth client for it in its deployment config.`,
        );
      const body: SettingsInputApprovalBody = {
        kind: "settingsInput",
        path,
        label: descriptor.label,
        section: descriptor.section,
        mode: descriptor.access === "oauth" ? "connect" : "secret",
        ...(reason ? { reason } : {}),
        wasConfigured: settingIsSet(descriptor, settings),
      };
      const card = createApproval({
        sessionId: ctx.session.sessionId,
        kind: "settingsInput",
        title:
          body.mode === "connect"
            ? `Connect ${descriptor.label}`
            : `Enter ${descriptor.label}`,
        summary: `Settings → ${descriptor.section}`,
        sourceToolCallId: ctx.toolCallId,
        body,
        // Asking again for the same setting replaces the earlier card.
        supersedes: (earlier) =>
          earlier.body.kind === "settingsInput" && earlier.body.path === path,
      });
      return {
        requested: path,
        note: `Waiting for the user. Nothing is saved until they answer in the card. ${approvalCardReference(card)}`,
      };
    }, true),
});

export const settingsTools = [
  settingsReadTool,
  settingsUpdateTool,
  settingsRequestInputTool,
];
