/**
 * Segmented controls for the remembered diff display modes (unified/split,
 * word-level, wrap, expand context). Reads and writes the shared prefs, so
 * every diff surface in the app follows the same configuration.
 *
 * Rendered inside the worktree page's "view options" popover: `stacked` lays
 * the groups out vertically, and `showStyleToggle={false}` hides unified/split
 * where the style is forced (mobile renders unified regardless of the pref).
 */
import { Check } from "lucide-react";
import type { Prefs } from "../../hooks/usePrefs.ts";

export interface DiffModeToolbarProps {
  prefs: Prefs;
  onUpdate: (patch: Partial<Prefs>) => void;
  /** Vertical group layout for popover/sheet placement. */
  stacked?: boolean;
  /** Whether the unified/split control renders (false where split is forced off). */
  showStyleToggle?: boolean;
}

function ModeButton({
  active,
  label,
  grow,
  onClick,
}: {
  active: boolean;
  label: string;
  grow: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-caption ${grow ? "flex-1 text-center" : ""} ${active ? "bg-raised font-medium text-fg" : "text-muted-foreground hover:text-fg"}`}
    >
      {label}
    </button>
  );
}

function ToggleMenuItem({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={active}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-caption text-muted-foreground transition-colors hover:bg-raised hover:text-fg"
    >
      <span className="flex-1">{label}</span>
      <span
        className="flex size-4 shrink-0 items-center justify-center text-primary"
        aria-hidden="true"
      >
        {active ? <Check size={14} /> : null}
      </span>
    </button>
  );
}

export function DiffModeToolbar({
  prefs,
  onUpdate,
  stacked = false,
  showStyleToggle = true,
}: DiffModeToolbarProps) {
  if (stacked) {
    return (
      <div className="flex min-w-36 flex-col items-stretch">
        {showStyleToggle ? (
          <div className="mb-1.5 flex items-center rounded-lg border border-line p-0.5">
            <ModeButton
              active={prefs.diffStyle === "unified"}
              label="Unified"
              grow
              onClick={() => onUpdate({ diffStyle: "unified" })}
            />
            <ModeButton
              active={prefs.diffStyle === "split"}
              label="Split"
              grow
              onClick={() => onUpdate({ diffStyle: "split" })}
            />
          </div>
        ) : null}
        <div
          role="menu"
          aria-label="Diff display options"
          className="flex flex-col py-0.5"
        >
          <ToggleMenuItem
            active={prefs.diffWordLevel}
            label="Words"
            onClick={() => onUpdate({ diffWordLevel: !prefs.diffWordLevel })}
          />
          <ToggleMenuItem
            active={prefs.diffIgnoreWhitespace}
            label="Ignore whitespace"
            onClick={() =>
              onUpdate({ diffIgnoreWhitespace: !prefs.diffIgnoreWhitespace })
            }
          />
          <ToggleMenuItem
            active={prefs.diffWrap}
            label="Wrap"
            onClick={() => onUpdate({ diffWrap: !prefs.diffWrap })}
          />
          <ToggleMenuItem
            active={prefs.diffExpandContext}
            label="Context"
            onClick={() =>
              onUpdate({ diffExpandContext: !prefs.diffExpandContext })
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {showStyleToggle ? (
        <div className="flex items-center rounded-lg border border-line p-0.5">
          <ModeButton
            active={prefs.diffStyle === "unified"}
            label="Unified"
            grow={false}
            onClick={() => onUpdate({ diffStyle: "unified" })}
          />
          <ModeButton
            active={prefs.diffStyle === "split"}
            label="Split"
            grow={false}
            onClick={() => onUpdate({ diffStyle: "split" })}
          />
        </div>
      ) : null}
      <div className="flex items-center rounded-lg border border-line p-0.5">
        <ModeButton
          active={prefs.diffWordLevel}
          label="Words"
          grow={false}
          onClick={() => onUpdate({ diffWordLevel: !prefs.diffWordLevel })}
        />
        <ModeButton
          active={prefs.diffIgnoreWhitespace}
          label="Ignore WS"
          grow={false}
          onClick={() =>
            onUpdate({ diffIgnoreWhitespace: !prefs.diffIgnoreWhitespace })
          }
        />
        <ModeButton
          active={prefs.diffWrap}
          label="Wrap"
          grow={false}
          onClick={() => onUpdate({ diffWrap: !prefs.diffWrap })}
        />
        <ModeButton
          active={prefs.diffExpandContext}
          label="Context"
          grow={false}
          onClick={() =>
            onUpdate({ diffExpandContext: !prefs.diffExpandContext })
          }
        />
      </div>
    </div>
  );
}
