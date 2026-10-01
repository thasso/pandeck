/**
 * Rich diff renderer for the Knowledge history inspector. Offers two views of a
 * commit's changes:
 *
 * - "Rendered": the entry Markdown rendered as prose with inline word-level
 *   change marks — added text in `<ins>`, removed text struck through in `<del>`
 *   — like tracked/suggested changes (via `lib/knowledgeMarkdownDiff.ts` +
 *   raw-HTML Markdown rendering).
 * - "Diff": the source patch rendered through the shared @pierre/diffs surface
 *   (the code-diff stack), forced unified for the narrow inspector but otherwise
 *   honoring the user's diff prefs.
 *
 * Whitespace-only line changes are hidden by default (the `diffIgnoreWhitespace`
 * pref, toggleable here). Imported lazily (see objectInspectors.tsx) so the
 * pierre + Shiki stack stays out of the main bundle.
 */
import { useMemo, useState, type ReactNode } from "react";
import type {
  KnowledgeDiffFile,
  KnowledgeDiffPreview,
} from "@assistant/shared/knowledgeBase";
import type { Prefs } from "../hooks/usePrefs.ts";
import { DiffSurface } from "./diff/DiffSurface.tsx";
import { Markdown } from "./Markdown.tsx";
import {
  buildRenderedDiffMarkdown,
  stripFrontmatter,
} from "../lib/knowledgeMarkdownDiff.ts";

type ViewMode = "rendered" | "diff";

export function KnowledgeDiffView({
  diff,
  prefs,
  onUpdatePrefs,
}: {
  diff: KnowledgeDiffPreview;
  prefs: Prefs;
  onUpdatePrefs?: ((patch: Partial<Prefs>) => void) | undefined;
}) {
  const [mode, setMode] = useState<ViewMode>("rendered");
  // The inspector is narrow; split never fits. Otherwise honor the diff prefs.
  const diffPrefs = useMemo<Prefs>(
    () => ({ ...prefs, diffStyle: "unified" }),
    [prefs],
  );
  const files = diff.files;
  const anyMarkdown = files.some(isMarkdownFile);
  const effectiveMode: ViewMode =
    mode === "rendered" && !anyMarkdown ? "diff" : mode;
  const ignoreWhitespace = prefs.diffIgnoreWhitespace;

  if (files.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-panel/60 px-3 py-3 text-faint">
        No source-file changes in this commit.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-faint">
          {diff.commit.slice(0, 12)}
        </span>
        {anyMarkdown ? (
          <div className="flex rounded-lg border border-line p-0.5 text-caption">
            <ModeButton
              active={effectiveMode === "rendered"}
              onClick={() => setMode("rendered")}
            >
              Rendered
            </ModeButton>
            <ModeButton
              active={effectiveMode === "diff"}
              onClick={() => setMode("diff")}
            >
              Diff
            </ModeButton>
          </div>
        ) : null}
        {onUpdatePrefs ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={ignoreWhitespace}
            onClick={() =>
              onUpdatePrefs({ diffIgnoreWhitespace: !ignoreWhitespace })
            }
            className={`rounded-md border px-1.5 py-0.5 text-micro ${ignoreWhitespace ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-muted hover:text-fg"}`}
            title="Hide lines that differ only in whitespace"
          >
            Ignore whitespace
          </button>
        ) : null}
      </div>
      {files.map((file) => (
        <FileDiff
          key={`${file.path}:${file.oldPath ?? ""}`}
          file={file}
          commit={diff.commit}
          mode={effectiveMode}
          prefs={diffPrefs}
          ignoreWhitespace={ignoreWhitespace}
        />
      ))}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-0.5 ${active ? "bg-accent-soft text-accent" : "text-muted hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

function FileDiff({
  file,
  commit,
  mode,
  prefs,
  ignoreWhitespace,
}: {
  file: KnowledgeDiffFile;
  commit: string;
  mode: ViewMode;
  prefs: Prefs;
  ignoreWhitespace: boolean;
}) {
  const showRendered =
    mode === "rendered" && isMarkdownFile(file) && !file.binary;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel/60">
      <div className="flex items-center gap-2 border-b border-line px-2 py-1 text-caption">
        <StatusBadge status={file.status} />
        <span
          className="min-w-0 flex-1 truncate font-mono text-faint"
          title={file.path}
        >
          {file.oldPath && file.oldPath !== file.path
            ? `${file.oldPath} → ${file.path}`
            : file.path}
        </span>
      </div>
      {file.binary ? (
        <p className="px-3 py-3 text-faint">Binary file — no preview.</p>
      ) : showRendered ? (
        <RenderedMarkdownDiff
          oldText={file.oldText ?? ""}
          newText={file.newText ?? ""}
          ignoreWhitespace={ignoreWhitespace}
        />
      ) : (
        <div className="overflow-x-auto text-caption">
          <DiffSurface
            oldFile={{
              name: file.oldPath ?? file.path,
              contents: file.oldText ?? "",
            }}
            newFile={{ name: file.path, contents: file.newText ?? "" }}
            prefs={prefs}
            cacheKey={`kbdiff:${commit}:${file.path}`}
          />
        </div>
      )}
      {file.truncated ? (
        <div className="border-t border-line px-2 py-1 text-micro text-faint">
          Large file — contents were clipped.
        </div>
      ) : null}
    </div>
  );
}

function RenderedMarkdownDiff({
  oldText,
  newText,
  ignoreWhitespace,
}: {
  oldText: string;
  newText: string;
  ignoreWhitespace: boolean;
}) {
  const { markdown, changed } = useMemo(
    () =>
      buildRenderedDiffMarkdown(
        stripFrontmatter(oldText),
        stripFrontmatter(newText),
        { ignoreWhitespace },
      ),
    [oldText, newText, ignoreWhitespace],
  );
  if (!changed)
    return (
      <p className="px-3 py-3 text-faint">
        No changes to the rendered document.
      </p>
    );
  return (
    <div className="kb-md-diff px-3 py-2 text-caption">
      <Markdown text={markdown} />
    </div>
  );
}

function StatusBadge({ status }: { status: KnowledgeDiffFile["status"] }) {
  const map: Record<
    KnowledgeDiffFile["status"],
    { label: string; cls: string }
  > = {
    added: { label: "Added", cls: "bg-success-soft text-success" },
    modified: { label: "Modified", cls: "bg-raised text-muted" },
    deleted: { label: "Deleted", cls: "bg-danger-soft text-danger" },
    renamed: { label: "Renamed", cls: "bg-accent-soft text-accent" },
  };
  const { label, cls } = map[status];
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-px text-micro font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

function isMarkdownFile(file: { path: string }): boolean {
  return /\.(md|markdown|mdx)$/i.test(file.path);
}
