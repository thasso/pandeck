import { useEffect, useRef, useState } from "react";
import { FolderTree, Plus, Trash2, X } from "lucide-react";
import type { ProjectLocalPath, ProjectRecord } from "@assistant/shared";
import { InspectorSection } from "./shell/Inspector.tsx";
import { InlineEdit } from "./InlineEdit.tsx";
import { GhostIconButton } from "./common/GhostIconButton.tsx";
import { ErrorNote } from "./common/load.tsx";
import { errorOf, isPending, type LoadState } from "../lib/loadState.ts";

const KINDS: Array<NonNullable<ProjectLocalPath["kind"]>> = [
  "repo",
  "workspace",
  "folder",
];

/**
 * @component ProjectLocalPathsSection
 * @purpose The Project's extra folder mappings, as an object-panel section.
 * @useWhen Composing the Project object panel (`objectInspectors.tsx`).
 * @avoidWhen On the Project page: this was a bordered card of `<select>` grids
 *   above the worktree list, and for most projects it is empty — the managed
 *   checkout now states itself in the page's Repository section, so what is left
 *   here is only manually mapped extras.
 * @intent Shaped like the Task inspector's Links section: one row per path with
 *   the path itself editable, kind/match as chips that CYCLE on tap (no
 *   `<select>` — the app's other state controls are tap-to-change glyphs), and a
 *   draft input behind the section's `+`. `notes` is not editable here; nothing
 *   in the app reads it and a free-text field per path earned no space.
 * @prop hidePath The managed clone, shown read-only in the page's Repository
 *   section, so this list holds only ADDITIONAL manual mappings.
 */
export function ProjectLocalPathsSection({
  project,
  hidePath,
  onSave,
  mutationState,
}: {
  project: ProjectRecord;
  hidePath?: string | undefined;
  onSave: (localPaths: ProjectLocalPath[]) => void;
  mutationState?: LoadState<true> | undefined;
}) {
  const items = project.localPaths ?? [];
  // Original indices are kept so an edit/remove targets the full array even
  // though the managed clone is filtered out of the view.
  const visible = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !samePath(item.path, hidePath));
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  // The draft commits on blur (tapping away on a phone should not silently
  // discard what you typed), so cancelling has to win the race: a pointer press
  // on the header's X lands BEFORE the input's blur and suppresses that commit.
  const cancelRef = useRef(false);
  const attemptedRef = useRef<ProjectLocalPath[] | null>(null);
  const submit = (next: ProjectLocalPath[]) => {
    attemptedRef.current = next;
    onSave(next);
  };
  const awaitingAddRef = useRef(false);
  const sawPendingRef = useRef(false);
  const pending = mutationState ? isPending(mutationState) : false;
  const mutationError = mutationState ? errorOf(mutationState) : undefined;
  useEffect(() => {
    if (!awaitingAddRef.current) return;
    if (pending) {
      sawPendingRef.current = true;
      return;
    }
    if (sawPendingRef.current && !mutationError) {
      awaitingAddRef.current = false;
      sawPendingRef.current = false;
      setDraft("");
      setAdding(false);
    }
  }, [mutationError, pending]);
  const commitDraft = () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    const path = draft.trim();
    if (!path || pending) return;
    if (mutationState) awaitingAddRef.current = true;
    submit([...items, { path, kind: "repo", match: "prefix" }]);
    if (!mutationState) {
      setDraft("");
      setAdding(false);
    }
  };
  const replace = (index: number, next: ProjectLocalPath) =>
    submit(items.map((item, i) => (i === index ? next : item)));
  return (
    <InspectorSection
      id="project-local-paths"
      storageScope={`project:${project.id}`}
      title="Local paths"
      icon={<FolderTree size={13} />}
      summary={visible.length ? `${visible.length}` : undefined}
      defaultOpen={false}
      actions={
        <span
          onPointerDownCapture={() => {
            if (adding) cancelRef.current = true;
          }}
        >
          <GhostIconButton
            icon={adding ? <X size={13} /> : <Plus size={13} />}
            label={adding ? "Cancel adding a local path" : "Add a local path"}
            onClick={() => {
              setAdding((previous) => !previous);
              setDraft("");
            }}
          />
        </span>
      }
    >
      <div className="flex flex-col gap-1.5 px-1">
        {visible.length === 0 && !adding ? (
          <p className="text-sm text-muted-foreground">
            No extra folders mapped to this project.
          </p>
        ) : null}
        {visible.map(({ item, index }) => (
          <div
            key={`${item.path}:${index}`}
            className="group flex flex-col gap-0.5 rounded-lg px-2 py-1 transition-colors hover:bg-muted"
          >
            <div className="flex items-start gap-1">
              <InlineEdit
                value={item.path}
                submitState={mutationState}
                onSubmit={(path) =>
                  replace(index, { ...item, path: path.trim() })
                }
                ariaLabel="Local path"
                editorClassName="w-full rounded-md border border-border bg-card px-2 py-0.5 font-mono text-sm text-foreground outline-none focus:border-primary"
                renderDisplay={(begin) => (
                  <button
                    type="button"
                    onClick={begin}
                    title="Click to edit this path"
                    className="min-w-0 flex-1 break-all text-left font-mono text-sm text-foreground hover:text-primary"
                  >
                    {item.path}
                  </button>
                )}
              />
              <GhostIconButton
                danger
                revealOnHover
                icon={<Trash2 size={12} />}
                label="Remove local path"
                busy={pending}
                onClick={() => submit(items.filter((_, i) => i !== index))}
              />
            </div>
            <div className="flex items-center gap-1">
              <Chip
                label={item.kind ?? "repo"}
                title="Cycle: repo → workspace → folder"
                disabled={pending}
                onClick={() =>
                  replace(index, { ...item, kind: nextKind(item.kind) })
                }
              />
              <Chip
                label={item.match ?? "prefix"}
                disabled={pending}
                title={
                  (item.match ?? "prefix") === "prefix"
                    ? "Matches this folder and everything under it — tap for exact"
                    : "Matches only this exact folder — tap for prefix"
                }
                onClick={() =>
                  replace(index, {
                    ...item,
                    match:
                      (item.match ?? "prefix") === "prefix"
                        ? "exact"
                        : "prefix",
                  })
                }
              />
            </div>
          </div>
        ))}
        {adding ? (
          <input
            value={draft}
            autoFocus
            disabled={pending}
            aria-busy={pending || undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setAdding(false);
              if (event.key === "Enter") commitDraft();
            }}
            onBlur={commitDraft}
            placeholder="/absolute/path"
            aria-label="New local path"
            className="w-full rounded-lg border border-border bg-background px-2 py-1 font-mono text-sm text-foreground outline-none focus:border-primary"
          />
        ) : null}
        {mutationError ? (
          <ErrorNote
            message={mutationError}
            onRetry={() => {
              if (attemptedRef.current) onSave(attemptedRef.current);
            }}
          />
        ) : null}
      </div>
    </InspectorSection>
  );
}

function Chip({
  label,
  title,
  onClick,
  disabled = false,
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="rounded bg-muted px-1.5 py-0.5 text-xs uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
    >
      {label}
    </button>
  );
}

function nextKind(
  kind: ProjectLocalPath["kind"],
): NonNullable<ProjectLocalPath["kind"]> {
  const index = KINDS.indexOf(kind ?? "repo");
  return KINDS[(index + 1) % KINDS.length]!;
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const clean = (value: string) => value.replace(/[\\/]+$/, "");
  return clean(a) === clean(b);
}
