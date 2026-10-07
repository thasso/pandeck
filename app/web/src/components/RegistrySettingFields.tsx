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
import { useEffect, useRef, useState } from "react";
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
        <span className="mt-0.5 block text-sm text-muted-foreground">
          {descriptor.hint}
        </span>
      )}
    </span>
  );
}

/**
 * A typed value the user edits as text and commits on blur or Enter. While
 * the user is editing (dirty), a new value from the server (another tab, the
 * assistant, the echo of an earlier save) never replaces what they typed;
 * a pristine field follows it. Escape discards the edit.
 */
function useDraft(value: string) {
  const [draft, setDraft] = useState(value);
  // A ref, so finishing an edit does not itself re-sync: a committed draft
  // stays on screen until the server's next value (its echo) replaces it.
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);
  return {
    draft,
    edit: (next: string) => {
      dirty.current = true;
      setDraft(next);
    },
    /** Hand the draft to `save` and stop editing. */
    commit: (save: (draft: string) => void) => {
      dirty.current = false;
      if (draft !== value) save(draft);
    },
    discard: () => {
      dirty.current = false;
      setDraft(value);
    },
  };
}

function draftKeys(
  draft: ReturnType<typeof useDraft>,
  save: (value: string) => void,
) {
  return (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !(event.target instanceof HTMLTextAreaElement))
      draft.commit(save);
    if (event.key === "Escape") draft.discard();
  };
}

function TextValue({
  descriptor,
  value,
  onSave,
}: {
  descriptor: SettingDescriptor;
  value: string;
  onSave: (value: string) => void;
}) {
  const draft = useDraft(value);
  const multiline =
    descriptor.value?.kind === "string" && descriptor.value.multiline;
  const props = {
    "aria-label": descriptor.label,
    value: draft.draft,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => draft.edit(event.target.value),
    onBlur: () => draft.commit(onSave),
    onKeyDown: draftKeys(draft, onSave),
    className: "settings-input w-full",
  };
  return multiline ? <textarea rows={4} {...props} /> : <input {...props} />;
}

/**
 * A number edited freely as text (empty and partial input allowed) and
 * validated, rounded and clamped to its bounds only when committed.
 */
function NumberValue({
  descriptor,
  spec,
  value,
  onSave,
}: {
  descriptor: SettingDescriptor;
  spec: { kind: "integer" | "number"; min: number; max: number };
  value: number | undefined;
  onSave: (value: number) => void;
}) {
  const shown = value === undefined ? "" : String(value);
  const draft = useDraft(shown);
  const save = (text: string) => {
    const typed = Number(text);
    // Nothing usable typed: keep the stored value.
    if (text.trim() === "" || !Number.isFinite(typed)) {
      draft.discard();
      return;
    }
    const whole = spec.kind === "integer" ? Math.round(typed) : typed;
    const next = Math.min(spec.max, Math.max(spec.min, whole));
    if (next !== value) onSave(next);
    else draft.discard();
  };
  return (
    <input
      type="text"
      inputMode={spec.kind === "integer" ? "numeric" : "decimal"}
      aria-label={descriptor.label}
      value={draft.draft}
      onChange={(event) => draft.edit(event.target.value)}
      onBlur={() => draft.commit(save)}
      onKeyDown={draftKeys(draft, save)}
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
      <div className="space-y-1 text-sm text-fg">
        <Label descriptor={descriptor} />
        <div className="break-all font-mono text-sm text-muted-foreground">
          {readonlyText(value)}
        </div>
      </div>
    );
  if (spec.kind === "boolean")
    return (
      <label className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-fg">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onWrite(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-primary"
        />
        <Label descriptor={descriptor} />
      </label>
    );
  return (
    <div className="space-y-1 text-sm text-fg">
      <Label descriptor={descriptor} />
      {spec.kind === "enum" ? (
        <select
          aria-label={descriptor.label}
          value={
            typeof value === "string" && spec.values.includes(value)
              ? value
              : ""
          }
          onChange={(event) => onWrite(event.target.value)}
          className="settings-input w-full"
        >
          {/* A stored value outside the choices, or none, is shown as such
              rather than letting the browser pick the first option. */}
          {!(typeof value === "string" && spec.values.includes(value)) && (
            <option value="" disabled>
              {typeof value === "string" && value
                ? `Unsupported: ${value}`
                : "Not set"}
            </option>
          )}
          {spec.values.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : spec.kind === "integer" || spec.kind === "number" ? (
        <NumberValue
          descriptor={descriptor}
          spec={spec}
          value={typeof value === "number" ? value : undefined}
          onSave={onWrite}
        />
      ) : (
        <TextValue
          descriptor={descriptor}
          value={typeof value === "string" ? value : ""}
          onSave={onWrite}
        />
      )}
      {(spec.kind === "integer" || spec.kind === "number") && (
        <div className="text-sm text-faint">
          {spec.min}–{spec.max}
        </div>
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
        <h3 className="text-sm font-semibold text-fg">More settings</h3>
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
