/**
 * @component WorktreeChangesetList
 * @purpose The Review tab's "All files" mode: every changed file's diff stacked
 * in one scroll, with sticky per-file headers, per-file viewed tracking, and
 * lazy rendering so large changesets don't lock up the pierre stack.
 * @useWhen The worktree Review tab is in changeset mode (mobile default).
 * @avoidWhen Rendering a single selected file's diff (by-file mode uses
 * DiffSurface directly in WorktreeDetailPage).
 * @intent Each file section mounts its diff only when scrolled near the
 * viewport AND expanded; large/binary/viewed files start collapsed. Sections
 * register their elements with the parent for jump-to-file navigation.
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type {
  WorktreeChangeFile,
  WorktreeDiffScope,
  WorktreeFileDiffResponse,
} from "@assistant/shared";
import type { Prefs } from "../../hooks/usePrefs.ts";
import { DiffSurface } from "../diff/DiffSurface.tsx";
import type { LineCommentsConfig } from "../diff/comments.tsx";
import { fetchWorktreeFileDiff, hashContent } from "../../lib/worktrees.ts";
import { useNearViewport } from "../ui/useNearViewport.ts";
import { Spinner } from "../ui/load.tsx";

/** Diffs beyond this many changed lines start collapsed. */
const LARGE_DIFF_LINES = 600;

export interface WorktreeChangesetListProps {
  worktreeId: string;
  scope: WorktreeDiffScope;
  files: WorktreeChangeFile[];
  prefs: Prefs;
  refreshToken: number;
  /** Comment config for a file: `current` = new side shows the working tree. */
  commentsConfigFor: (
    path: string,
    current: boolean,
    refOid?: string,
  ) => LineCommentsConfig | undefined;
  viewedPaths: ReadonlySet<string>;
  onToggleViewed: (path: string) => void;
  /** Section element registry for jump-to-file scrolling (null unregisters). */
  registerSection: (path: string, el: HTMLElement | null) => void;
}

export function WorktreeChangesetList({
  worktreeId,
  scope,
  files,
  prefs,
  refreshToken,
  commentsConfigFor,
  viewedPaths,
  onToggleViewed,
  registerSection,
}: WorktreeChangesetListProps) {
  if (files.length === 0) {
    return (
      <div className="p-6 text-body text-muted-foreground">
        No changes in this scope.
      </div>
    );
  }
  return (
    <div className="border-y border-line">
      {files.map((file) => (
        <ChangesetFileSection
          key={file.path}
          worktreeId={worktreeId}
          scope={scope}
          file={file}
          prefs={prefs}
          refreshToken={refreshToken}
          commentsConfigFor={commentsConfigFor}
          viewed={viewedPaths.has(file.path)}
          onToggleViewed={() => onToggleViewed(file.path)}
          registerSection={registerSection}
        />
      ))}
    </div>
  );
}

function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  if (index < 0) return { dir: "", name: path };
  return { dir: path.slice(0, index), name: path.slice(index + 1) };
}

function ChangesetFileSection({
  worktreeId,
  scope,
  file,
  prefs,
  refreshToken,
  commentsConfigFor,
  viewed,
  onToggleViewed,
  registerSection,
}: {
  worktreeId: string;
  scope: WorktreeDiffScope;
  file: WorktreeChangeFile;
  prefs: Prefs;
  refreshToken: number;
  commentsConfigFor: (
    path: string,
    current: boolean,
    refOid?: string,
  ) => LineCommentsConfig | undefined;
  viewed: boolean;
  onToggleViewed: () => void;
  registerSection: (path: string, el: HTMLElement | null) => void;
}) {
  const large = file.additions + file.deletions > LARGE_DIFF_LINES;
  const [collapsed, setCollapsed] = useState(viewed || large || file.binary);
  const [diff, setDiff] = useState<WorktreeFileDiffResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const sectionRef = useRef<HTMLDivElement | null>(null);
  // Shared latch: mounted diffs stay mounted (rebuilding them is the expensive
  // part), only the initial render is deferred until the section is near view.
  const nearViewport = useNearViewport(sectionRef);

  // Register for jump-to-file scrolling; unregister on unmount/path change.
  useEffect(() => {
    registerSection(file.path, sectionRef.current);
    return () => registerSection(file.path, null);
  }, [file.path, registerSection]);

  const shouldLoad = nearViewport && !collapsed && !file.binary;
  useEffect(() => {
    if (!shouldLoad) return;
    let cancelled = false;
    setFailed(false);
    fetchWorktreeFileDiff(worktreeId, file.path, scope)
      .then((payload) => {
        if (!cancelled) setDiff(payload);
      })
      .catch(() => {
        // The file can drop out of the scope between the list and this fetch
        // (live edits); show a soft failure instead of blanking the section.
        if (!cancelled) {
          setDiff(null);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [shouldLoad, worktreeId, file.path, scope, refreshToken]);

  const toggleViewed = () => {
    // Marking viewed collapses the section (GitHub behavior); unmarking reopens.
    setCollapsed(!viewed);
    onToggleViewed();
  };

  const parts = splitPath(file.path);
  const current = scope.kind === "workingTree" || !scope.to;
  const cacheKey = diff
    ? `${worktreeId}:${diff.path}:${hashContent(diff.diff)}`
    : "";

  return (
    <div
      ref={sectionRef}
      className={`overflow-hidden border-b border-line last:border-b-0 ${collapsed ? "" : "min-h-24"}`}
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-2 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? "Expand diff" : "Collapse diff"}
          aria-label={
            collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`
          }
          aria-expanded={!collapsed}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span className="min-w-0 flex-1 truncate text-caption">
          <span className="font-medium text-fg">{parts.name}</span>
          {parts.dir ? (
            <span className="ml-1.5 font-mono text-micro text-faint">
              {parts.dir}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono text-micro text-faint">
          {file.additions > 0 ? (
            <span className="text-emerald-400">+{file.additions}</span>
          ) : null}
          {file.deletions > 0 ? (
            <span className="ml-1 text-red-400">−{file.deletions}</span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={toggleViewed}
          title={viewed ? "Mark as not viewed" : "Mark as viewed"}
          aria-pressed={viewed}
          className={`flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-micro ${viewed ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-400" : "border-line text-muted-foreground hover:bg-raised hover:text-fg"}`}
        >
          <Check size={11} /> Viewed
        </button>
      </div>
      {collapsed ? null : file.binary ? (
        <div className="p-4 text-caption text-muted-foreground">
          Binary file.
        </div>
      ) : failed ? (
        <div className="p-4 text-caption text-muted-foreground">
          This file is no longer changed in this scope.
        </div>
      ) : !diff ? (
        // Inline rather than a centred `PaneLoading`: the section already
        // reserves `min-h-24`, and this row sits where the diff's first line
        // will be. The deferral above it is the perf contract, untouched.
        <div
          role="status"
          className="flex items-center gap-2 p-4 text-caption text-muted-foreground"
        >
          <Spinner size="sm" /> Loading diff…
        </div>
      ) : (
        <DiffSurface
          prefs={prefs}
          patch={diff.diff}
          oldFile={{
            name: diff.oldPath ?? diff.path,
            contents: diff.oldContent,
          }}
          newFile={{ name: diff.path, contents: diff.newContent }}
          cacheKey={cacheKey}
          comments={commentsConfigFor(diff.path, current, diff.newOid)}
        />
      )}
    </div>
  );
}
