import { useRef, useState, type ReactNode } from "react";
import { Palette } from "lucide-react";
import type { ProjectRecord } from "@assistant/shared";
import { InlineEdit } from "./InlineEdit.tsx";
import { ErrorNote } from "./ui/load.tsx";
import { errorOf, isPending, type LoadState } from "../lib/loadState.ts";

/**
 * @component ProjectSettingsFields
 * @purpose The Project's rarely-changed settings — key, color, worktree root —
 *   as inspector-density rows.
 * @useWhen Composing the Project object panel (`objectInspectors.tsx`).
 * @avoidWhen On the Project page itself: these fields used to sit above the
 *   content (key/color as a chips row, the worktree root under the worktree
 *   list), where they were the first thing every visit and change about twice in
 *   a project's life. The panel is where an object's settings and actions live.
 * @intent Labelled rows, one save callback. The palette expands IN PLACE rather
 *   than in a popover: this renders inside a scrolling panel that is a bottom
 *   sheet on a phone, where an absolutely positioned menu gets clipped.
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
    <div className="flex flex-col gap-1 px-1">
      <FieldRow label="Key">
        <InlineEdit
          value={project.key}
          submitState={mutation("key")}
          onSubmit={(key) => onSave({ key: normalizeProjectKey(key) })}
          ariaLabel="Project Key"
          placeholder="KEY"
          editorClassName="w-24 rounded-md border border-line bg-surface px-2 py-0.5 text-caption font-semibold uppercase text-fg outline-none focus:border-accent"
          renderDisplay={(begin) => (
            <button
              type="button"
              onClick={begin}
              className="rounded-md px-1 font-mono text-caption font-semibold text-fg hover:bg-raised hover:text-accent"
              title="Click to edit key"
            >
              {project.key || "KEY"}
            </button>
          )}
        />
      </FieldRow>
      <ProjectColorRow
        project={project}
        mutationState={mutation("color")}
        onChange={(color) => onSave({ color })}
      />
      {/* Full width rather than a value-on-the-right row: this is an absolute
          path, and the panel is ~320px wide. Empty means the global default, so
          the placeholder names it instead of an explainer paragraph. */}
      <div className="pt-0.5">
        <span className="text-caption text-faint">Worktree root</span>
        <InlineEdit
          value={project.worktreeRoot ?? ""}
          submitState={mutation("worktreeRoot")}
          onSubmit={(next) => {
            const worktreeRootValue = next.trim() || undefined;
            return onSave({
              ...(worktreeRootValue !== undefined
                ? { worktreeRoot: worktreeRootValue }
                : {}),
            });
          }}
          allowEmpty
          ariaLabel="Worktree root override"
          placeholder="Settings → Worktrees root"
          editorClassName="mt-0.5 w-full rounded-md border border-line bg-surface px-2 py-1 font-mono text-caption text-fg outline-none focus:border-accent"
          renderDisplay={(begin) => (
            <button
              type="button"
              onClick={begin}
              title="Where new worktrees for this project are created (empty = the global Worktrees root)"
              className={`mt-0.5 block w-full break-all rounded-md px-1 py-0.5 text-left font-mono text-caption hover:bg-raised ${project.worktreeRoot ? "text-fg" : "text-faint"}`}
            >
              {project.worktreeRoot || "Settings → Worktrees root"}
            </button>
          )}
        />
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <span className="text-caption text-faint">{label}</span>
      {children}
    </div>
  );
}

function ProjectColorRow({
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
    <div>
      <FieldRow label="Color">
        <button
          type="button"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={() => setOpen((previous) => !previous)}
          className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-caption text-muted hover:bg-raised hover:text-fg"
          title="Change Project color"
          aria-label="Change Project color"
          aria-expanded={open}
        >
          <span
            className="size-2.5 rounded-full"
            style={{ backgroundColor: value }}
            aria-hidden
          />
          <Palette size={12} className="text-faint" />
        </button>
      </FieldRow>
      {open ? (
        <div className="mt-1 rounded-lg border border-line bg-surface p-2">
          <div
            className="grid grid-cols-5 gap-1.5"
            aria-label="Project color palette"
          >
            {PROJECT_COLOR_PALETTE.map((color) => {
              const selected = color.toUpperCase() === value.toUpperCase();
              return (
                <button
                  key={color}
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    submit(color);
                    setOpen(false);
                  }}
                  className={`size-6 rounded-full border transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${selected ? "border-fg ring-2 ring-fg/30" : "border-white/50"}`}
                  style={{ backgroundColor: color }}
                  title={`Use ${color}`}
                  aria-label={`Use Project color ${color}`}
                  aria-pressed={selected}
                />
              );
            })}
          </div>
          <label className="mt-2 flex items-center justify-between gap-2 text-caption text-muted">
            <span>Custom</span>
            <input
              type="color"
              value={value}
              disabled={pending}
              onChange={(event) =>
                submit(event.currentTarget.value.toUpperCase())
              }
              className="size-6 cursor-pointer rounded border border-line bg-transparent p-0"
              aria-label="Advanced Project color picker"
              title="Advanced color picker"
            />
          </label>
        </div>
      ) : null}
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
