import { useRef, useState } from "react";
import { FolderInput, KeyRound } from "lucide-react";
import type { ProjectRecord } from "@assistant/shared";
import { Input } from "./ui/input.tsx";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { ErrorNote } from "./common/load.tsx";
import {
  PROPERTY_TRIGGER,
  PropertyLabel,
  PropertyList,
  TextProperty,
} from "./common/PropertyList.tsx";
import { errorOf, isPending, type LoadState } from "../lib/loadState.ts";

/**
 * @component ProjectSettingsFields
 * @purpose The Project's rarely-changed settings — key, color, worktree root —
 *   as a property list in the object panel.
 * @useWhen Composing the Project object panel (`objectInspectors.tsx`).
 * @avoidWhen On the Project page itself: these fields used to sit above the
 *   content (key/color as a chips row, the worktree root under the worktree
 *   list), where they were the first thing every visit and change about twice in
 *   a project's life. The panel is where an object's settings and actions live.
 * @intent The Task inspector's Details shape: a muted label, the value as a
 *   quiet trigger, and its editor in a popover — the text fields share
 *   `TextProperty`, the color opens a swatch grid. Popovers portal to the body,
 *   so the phone's bottom-sheet panel does not clip them.
 */
export function ProjectSettingsFields({
  project,
  onSave,
  mutationStates = {},
}: {
  project: ProjectRecord;
  onSave: (patch: Partial<ProjectRecord>) => void;
  mutationStates?: Record<string, LoadState<true>>;
}) {
  const mutation = (field: string) =>
    mutationStates[`${project.id}:field:${field}`];
  return (
    <PropertyList>
      <PropertyLabel>Key</PropertyLabel>
      <TextProperty
        label="Project key"
        value={project.key}
        placeholder="KEY"
        hint="Up to 10 letters and digits. It prefixes the project everywhere it is named."
        icon={<KeyRound />}
        mono
        normalize={normalizeProjectKey}
        submitState={mutation("key")}
        onSave={(key) => onSave({ key })}
      />
      <PropertyLabel>Color</PropertyLabel>
      <ColorProperty
        project={project}
        mutationState={mutation("color")}
        onChange={(color) => onSave({ color })}
      />
      <PropertyLabel>Worktrees</PropertyLabel>
      {/* Empty means the global root, which is what the trigger then says. An
          empty string clears the override (the server drops it). */}
      <TextProperty
        label="Worktree root"
        value={project.worktreeRoot ?? ""}
        placeholder="Default root"
        hint="Where new worktrees for this project are created. Empty uses Settings → Worktrees."
        icon={<FolderInput />}
        mono
        allowEmpty
        submitState={mutation("worktreeRoot")}
        onSave={(worktreeRoot) => onSave({ worktreeRoot })}
      />
    </PropertyList>
  );
}

/**
 * The color as a property: a swatch and its hex on the line, and the palette
 * in a popover — a pick saves and closes; Custom opens the system picker.
 */
function ColorProperty({
  project,
  onChange,
  mutationState,
}: {
  project: ProjectRecord;
  onChange: (color: string) => void;
  mutationState?: LoadState<true> | undefined;
}) {
  const [open, setOpen] = useState(false);
  const value = hexColor(project.color) ?? fallbackProjectHex(project.id);
  const pending = mutationState ? isPending(mutationState) : false;
  const attemptedRef = useRef<string | null>(null);
  const submit = (color: string) => {
    attemptedRef.current = color;
    onChange(color);
  };
  const mutationError = mutationState ? errorOf(mutationState) : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              busy={pending}
              aria-label={`Project color: ${value}. Change`}
              className={`${PROPERTY_TRIGGER} justify-start`}
            />
          }
        >
          <span
            className="size-3.5 shrink-0 rounded-full"
            style={{ backgroundColor: value }}
            aria-hidden
          />
          <span
            className={`font-mono text-xs ${project.color ? "" : "text-muted-foreground"}`}
          >
            {project.color ? value : "Automatic"}
          </span>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto gap-2">
          <div
            className="grid grid-cols-5 gap-1.5"
            aria-label="Project color palette"
          >
            {PROJECT_COLOR_PALETTE.map((color) => {
              const selected = color.toUpperCase() === value.toUpperCase();
              return (
                <Button
                  key={color}
                  variant="outline"
                  size="icon-xs"
                  disabled={pending}
                  onClick={() => {
                    submit(color);
                    setOpen(false);
                  }}
                  className={`rounded-full ${selected ? "ring-2 ring-ring ring-offset-2 ring-offset-popover" : ""}`}
                  style={{ backgroundColor: color }}
                  title={color}
                  aria-label={`Use Project color ${color}`}
                  aria-pressed={selected}
                />
              );
            })}
          </div>
          <label className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>Custom</span>
            <Input
              type="color"
              value={value}
              disabled={pending}
              onChange={(event) =>
                submit(event.currentTarget.value.toUpperCase())
              }
              className="h-7 w-10 p-0.5"
              aria-label="Advanced Project color picker"
              title="Advanced color picker"
            />
          </label>
        </PopoverContent>
      </Popover>
      {mutationError ? (
        <ErrorNote
          message={mutationError}
          onRetry={() => {
            if (attemptedRef.current) onChange(attemptedRef.current);
          }}
        />
      ) : null}
    </div>
  );
}

const PROJECT_COLOR_PALETTE = [
  "#F97316",
  "#F59E0B",
  "#EAB308",
  "#84CC16",
  "#22C55E",
  "#10B981",
  "#14B8A6",
  "#06B6D4",
  "#0EA5E9",
  "#3B82F6",
  "#EC4899",
  "#D946EF",
  "#A855F7",
  "#8B5CF6",
  "#6366F1",
  "#64748B",
  "#78716C",
  "#0F766E",
  "#7C2D12",
  "#111827",
];

function normalizeProjectKey(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
}

function hexColor(value: string | undefined): string | null {
  return value && /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : null;
}

function fallbackProjectHex(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return hslToHex(hue, 60, 50);
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  const [r1, g1, b1] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const toHex = (channel: number) =>
    Math.round((channel + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`.toUpperCase();
}
