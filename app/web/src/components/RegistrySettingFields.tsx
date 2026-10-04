/**
 * @widget RegistrySettingFields
 * @purpose The part of a Settings section built from the settings registry
 *   ([Task-729](pa://task/729)): every setting of the section that the
 *   section's hand-written UI does not claim (`settingsClaims.ts`), rendered
 *   from its descriptor's label, hint, kind and bounds. A setting added to the
 *   registry therefore reaches the page, and the Personal Assistant, in one
 *   change. Read-only settings show their value; writable app settings save
 *   through the same patch as the rest of the page.
 * @useWhen Rendered by `SettingsPage` below every section; renders nothing
 *   when the section's own UI claims all its settings.
 */
import { useEffect, useState } from "react";
import type { AppSettings } from "@assistant/shared";
import {
  INTEGRATION_SETTINGS_SECTIONS,
  SETTINGS_REGISTRY,
  valueAtPath,
  writeAppSettingAt,
  type SettingDescriptor,
  type SettingsSectionId,
} from "@assistant/shared/settingsRegistry";
import { CLAIMED_SETTING_PATHS } from "./settingsClaims.ts";

/** Whether the page can render `descriptor` without hand-built UI. */
function renderable(descriptor: SettingDescriptor): boolean {
  if (descriptor.access === "readonly") return true;
  if (descriptor.access !== "value" || !descriptor.value) return false;
  if (descriptor.value.kind === "json") return false;
  const section = descriptor.path.split(".")[0] ?? "";
  return !INTEGRATION_SETTINGS_SECTIONS.includes(section);
}

function readonlyText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value))
    return value.every((item) => typeof item === "string")
      ? value.join(", ")
      : JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function Label({ descriptor }: { descriptor: SettingDescriptor }) {
  return (
    <span className="min-w-0">
      <span className="block font-medium">{descriptor.label}</span>
      {descriptor.hint && (
        <span className="mt-0.5 block text-caption text-muted">
          {descriptor.hint}
        </span>
      )}
    </span>
  );
}

/** A text value saved when the field loses focus or Enter is pressed. */
function TextValue({
  descriptor,
  value,
  onSave,
}: {
  descriptor: SettingDescriptor;
  value: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = () => {
    if (draft !== value) onSave(draft);
  };
  const multiline =
    descriptor.value?.kind === "string" && descriptor.value.multiline;
  return multiline ? (
    <textarea
      aria-label={descriptor.label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      rows={4}
      className="settings-input w-full"
    />
  ) : (
    <input
      aria-label={descriptor.label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") save();
      }}
      className="settings-input w-full"
    />
  );
}

function Field({
  descriptor,
  settings,
  onWrite,
}: {
  descriptor: SettingDescriptor;
  settings: AppSettings;
  onWrite: (value: unknown) => void;
}) {
  const value = valueAtPath(settings, descriptor.path);
  const spec = descriptor.value;
  if (descriptor.access === "readonly" || !spec)
    return (
      <div className="space-y-1 text-caption text-fg">
        <Label descriptor={descriptor} />
        <div className="break-all font-mono text-caption text-muted">
          {readonlyText(value)}
        </div>
      </div>
    );
  if (spec.kind === "boolean")
    return (
      <label className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-caption text-fg">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onWrite(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-accent"
        />
        <Label descriptor={descriptor} />
      </label>
    );
  return (
    <div className="space-y-1 text-caption text-fg">
      <Label descriptor={descriptor} />
      {spec.kind === "enum" ? (
        <select
          aria-label={descriptor.label}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onWrite(event.target.value)}
          className="settings-input w-full"
        >
          {spec.values.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : spec.kind === "integer" || spec.kind === "number" ? (
        <input
          type="number"
          aria-label={descriptor.label}
          min={spec.min}
          max={spec.max}
          step={spec.kind === "integer" ? 1 : "any"}
          value={typeof value === "number" ? value : ""}
          onChange={(event) => {
            const typed = event.target.valueAsNumber;
            if (!Number.isFinite(typed)) return;
            const whole = spec.kind === "integer" ? Math.round(typed) : typed;
            onWrite(Math.min(spec.max, Math.max(spec.min, whole)));
          }}
          className="settings-input w-full"
        />
      ) : (
        <TextValue
          descriptor={descriptor}
          value={typeof value === "string" ? value : ""}
          onSave={onWrite}
        />
      )}
    </div>
  );
}

export function RegistrySettingFields({
  section,
  settings,
  onUpdate,
  descriptors = SETTINGS_REGISTRY,
  claimed = CLAIMED_SETTING_PATHS,
}: {
  section: SettingsSectionId;
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
  descriptors?: readonly SettingDescriptor[];
  claimed?: ReadonlySet<string>;
}) {
  const shown = descriptors.filter(
    (d) => d.section === section && !claimed.has(d.path) && renderable(d),
  );
  if (shown.length === 0) return null;
  const write = (path: string, value: unknown) => {
    const patch: Record<string, unknown> = {};
    writeAppSettingAt(patch, settings, path, value);
    onUpdate(patch as Partial<AppSettings>);
  };
  return (
    <div className="mx-auto max-w-2xl px-6 pb-6">
      <div className="space-y-3 rounded-xl border border-line bg-panel p-4">
        <h3 className="text-body font-semibold text-fg">More settings</h3>
        {shown.map((descriptor) => (
          <Field
            key={descriptor.path}
            descriptor={descriptor}
            settings={settings}
            onWrite={(value) => write(descriptor.path, value)}
          />
        ))}
      </div>
    </div>
  );
}
