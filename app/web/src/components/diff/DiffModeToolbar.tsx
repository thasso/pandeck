/**
 * Controls for the remembered diff display modes (unified/split, word-level,
 * whitespace, wrap, expand context). Reads and writes the shared prefs, so
 * every diff surface in the app follows the same configuration.
 *
 * Rendered inside the worktree page's "view options" popover;
 * `showStyleToggle={false}` hides unified/split where the style is forced
 * (mobile renders unified regardless of the pref).
 */
import type { Prefs } from "../../hooks/usePrefs.ts";
import { useId } from "react";
import { Field, FieldGroup, FieldLabel } from "../ui/field.tsx";
import { Switch } from "../ui/switch.tsx";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.tsx";

export interface DiffModeToolbarProps {
  prefs: Prefs;
  onUpdate: (patch: Partial<Prefs>) => void;
  /** Whether the unified/split control renders (false where split is forced off). */
  showStyleToggle?: boolean;
}

type BooleanDiffPref =
  "diffWordLevel" | "diffIgnoreWhitespace" | "diffWrap" | "diffExpandContext";

const SWITCHES: Array<{ pref: BooleanDiffPref; label: string }> = [
  { pref: "diffWordLevel", label: "Words" },
  { pref: "diffIgnoreWhitespace", label: "Ignore whitespace" },
  { pref: "diffWrap", label: "Wrap" },
  { pref: "diffExpandContext", label: "Context" },
];

export function DiffModeToolbar({
  prefs,
  onUpdate,
  showStyleToggle = true,
}: DiffModeToolbarProps) {
  const id = useId();
  return (
    <FieldGroup className="min-w-40 gap-3">
      {showStyleToggle ? (
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Diff style"
          className="w-full"
          value={[prefs.diffStyle]}
          onValueChange={(next) => {
            const style = next[0] as Prefs["diffStyle"] | undefined;
            if (style) onUpdate({ diffStyle: style });
          }}
        >
          <ToggleGroupItem value="unified" className="flex-1">
            Unified
          </ToggleGroupItem>
          <ToggleGroupItem value="split" className="flex-1">
            Split
          </ToggleGroupItem>
        </ToggleGroup>
      ) : null}
      <div
        role="group"
        aria-label="Diff display options"
        className="flex flex-col gap-2.5"
      >
        {SWITCHES.map(({ pref, label }) => (
          <Field key={pref} orientation="horizontal">
            <FieldLabel htmlFor={`${id}-${pref}`}>{label}</FieldLabel>
            <Switch
              id={`${id}-${pref}`}
              size="sm"
              checked={prefs[pref]}
              onCheckedChange={(checked) => onUpdate({ [pref]: checked })}
            />
          </Field>
        ))}
      </div>
    </FieldGroup>
  );
}
