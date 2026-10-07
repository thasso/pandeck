/**
 * The shared diff renderer: one @pierre/diffs surface for every diff in the
 * app. Takes full old/new contents when available (Pierre's native context
 * expansion path), or raw unified patch text as a fallback. Display modes come from
 * the remembered diff prefs via {@link diffOptionsFromPrefs}.
 *
 * With a `comments` config, review-comment threads render as annotations
 * under their (current) lines on the additions side. Pierre's native line
 * text selection publishes the shell Add-comment action, while the built-in
 * gutter utility opens the composer directly. Comments anchor to current content — pass the config
 * only when the new side shows the working
 * tree.
 *
 * Import lazily (`React.lazy`) — this module pulls the pierre + Shiki stack
 * into its own chunk.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getSingularPatch,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import type { SelectorBundle } from "@assistant/shared/comments";
import type { DocumentLineAnchor } from "@assistant/shared/documentTargets";
import {
  FileDiff as PierreFileDiff,
  MultiFileDiff,
  type DiffLineAnnotation,
} from "@pierre/diffs/react";
import type { Prefs } from "../../hooks/usePrefs.ts";
import { diffOptionsFromPrefs } from "./diffOptions.ts";
import {
  DiffWorkerProvider,
  useDiffWorkerCompletionVersion,
} from "./DiffWorkerProvider.tsx";
import {
  useDismissEmptyComposerOnOutsideTap,
  useDiffTextSelection,
  useFocusComment,
  useLineComments,
  useStableCommentsConfig,
  type LineCommentsConfig,
} from "./comments.tsx";
import { showToast } from "../../lib/toast.ts";
import { useDiffScrollRestoration } from "./useDiffScrollRestoration.ts";
import { anchorSelection } from "./anchorSelection.ts";
import { DocumentRangeNotice } from "../DocumentAnchorRegion.tsx";

type AnnotationMeta = { node: ReactNode };

export interface DiffSurfaceProps {
  prefs: Prefs;
  /** Raw unified diff text; fallback when full old/new contents are unavailable. */
  patch?: string;
  /** Full before/after contents; preferred because native context expansion works. */
  oldFile?: { name: string; contents: string };
  newFile?: { name: string; contents: string };
  /** Worker/highlight cache key; change it whenever the rendered content/patch changes. */
  cacheKey?: string;
  /** Review comments for the displayed file (new side = current content). */
  comments?: LineCommentsConfig | undefined;
  /** 1-based current-side line or inclusive range addressed by the route. */
  lineAnchor?: DocumentLineAnchor | undefined;
}

export function DiffSurface(props: DiffSurfaceProps) {
  return (
    <DiffWorkerProvider prefs={props.prefs}>
      <DiffSurfaceContent {...props} />
    </DiffWorkerProvider>
  );
}

/**
 * Pierre re-renders the whole diff whenever the `options`, file or annotation
 * objects it is handed are not the SAME objects as last time: its render effect
 * has no dependency array, and it compares those three by identity (options
 * shallowly, files and annotations by reference). Its hover gutter — the "+"
 * that opens a comment — lives in that DOM, so an unrelated re-render of this
 * component makes the affordance under the reader's pointer blink out and come
 * back.
 *
 * Our callers build those objects inline (`oldFile={{ name, contents }}`,
 * `comments={commentsConfigFor(path)}`), and above them sit the socket-fed
 * pages that re-render on every broadcast. So identity is stabilized HERE, by
 * value, rather than asked of every call site: this is the only place that knows
 * what Pierre compares.
 */
function useStableValue<T>(value: T, equal: (a: T, b: T) => boolean): T {
  const held = useRef(value);
  if (held.current !== value && !equal(held.current, value))
    held.current = value;
  return held.current;
}

function sameFile(
  a: { name: string; contents: string } | undefined,
  b: { name: string; contents: string } | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.name === b.name && a.contents === b.contents;
}

function DiffSurfaceContent({
  prefs,
  patch,
  oldFile: oldFileProp,
  newFile: newFileProp,
  cacheKey,
  comments: commentsProp,
  lineAnchor,
}: DiffSurfaceProps) {
  const oldFile = useStableValue(oldFileProp, sameFile);
  const newFile = useStableValue(newFileProp, sameFile);
  const comments = useStableCommentsConfig(commentsProp);
  const [composerLine, setComposerLine] = useState<number | null>(null);
  const [composerDirty, setComposerDirty] = useState(false);
  const [composerSelectors, setComposerSelectors] =
    useState<SelectorBundle | null>(null);
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(
    anchorSelection(lineAnchor, "additions"),
  );
  useEffect(() => {
    setSelectedLines(anchorSelection(lineAnchor, "additions"));
  }, [lineAnchor]);
  const commentSource = useRef<object>({}).current;
  const clearSelectedLines = useCallback(() => setSelectedLines(null), []);
  const completionVersion = useDiffWorkerCompletionVersion();
  const remountVersion = cacheKey ? completionVersion : 0;

  const submitComment = useCallback(
    (body: string, line: number) => {
      if (comments)
        comments.actions.onAddComment({
          body,
          path: comments.path,
          line,
          ...(comments.refOid ? { ref: comments.refOid } : {}),
          ...(composerSelectors ? { selectors: composerSelectors } : {}),
        });
      setComposerLine(null);
      setComposerDirty(false);
      setComposerSelectors(null);
      setSelectedLines(null);
    },
    [comments, composerSelectors],
  );
  const cancelComposer = useCallback(() => {
    setComposerLine(null);
    setComposerDirty(false);
    setComposerSelectors(null);
    setSelectedLines(null);
  }, []);
  const openComposerForRange = useCallback((range: SelectedLineRange) => {
    const side = range.endSide ?? range.side;
    if (side === "deletions") {
      showToast("Comments attach to the new side of a diff.", {
        key: "diff-comment-side",
      });
      setSelectedLines(null);
      return;
    }
    setComposerSelectors(null);
    // Drop pierre's selection paint: the composer opens directly under the line
    // and says which one it is by being there. Leaving the range selected left a
    // block of highlight behind the composer that the next tap anywhere cleared,
    // which read as the composer having lost the line it is attached to.
    setSelectedLines(null);
    setComposerLine(range.end);
  }, []);
  const entries = useLineComments(
    comments,
    composerLine,
    submitComment,
    cancelComposer,
    setComposerDirty,
  );
  // An empty line composer is disposable: tapping away from the diff closes it.
  useDismissEmptyComposerOnOutsideTap(
    composerLine !== null && !composerDirty,
    cancelComposer,
  );
  // Bring a linked-to thread into view. The wrapper is `display: contents`, so it
  // adds no box while still being the light-DOM root the annotations live under.
  const [surfaceRoot, setSurfaceRoot] = useState<HTMLDivElement | null>(null);
  useDiffScrollRestoration(surfaceRoot);
  useFocusComment(
    surfaceRoot,
    comments?.focus?.commentId,
    comments?.focus?.nonce,
  );
  const activateTextSelection = useCallback(
    (line: number, selectors: SelectorBundle) => {
      setComposerSelectors(selectors);
      setSelectedLines(null);
      setComposerLine(line);
    },
    [],
  );
  useDiffTextSelection({
    root: surfaceRoot,
    contents: newFile?.contents,
    source: commentSource,
    enabled: Boolean(comments) && composerLine === null,
    onActivate: activateTextSelection,
  });

  // Pierre treats a new annotations ARRAY as changed annotations and re-renders
  // for it, so this may only be rebuilt when the threads themselves changed.
  const lineAnnotations = useMemo<Array<DiffLineAnnotation<AnnotationMeta>>>(
    () => [
      ...(lineAnchor
        ? [
            {
              side: "additions" as const,
              lineNumber: lineAnchor.start,
              metadata: {
                node: (
                  <span
                    data-document-line-anchor
                    className="block h-0 scroll-mt-16"
                  />
                ),
              },
            },
          ]
        : []),
      ...entries.map((entry, index) => ({
        side: "additions" as const,
        lineNumber: entry.lineNumber,
        metadata: { node: <span key={index}>{entry.node}</span> },
      })),
    ],
    [entries, lineAnchor],
  );
  useEffect(() => {
    if (!lineAnchor || !surfaceRoot) return;
    const reveal = () => {
      const marker = surfaceRoot.querySelector<HTMLElement>(
        "[data-document-line-anchor]",
      );
      marker?.scrollIntoView({ block: "center" });
      return Boolean(marker);
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect();
    });
    observer.observe(surfaceRoot, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), 2_000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [lineAnchor, surfaceRoot]);

  const parsedPatch = useMemo<FileDiffMetadata | null>(() => {
    if (patch === undefined || !patch.trim()) return null;
    try {
      return { ...getSingularPatch(patch), ...(cacheKey ? { cacheKey } : {}) };
    } catch (err) {
      console.warn(
        "Failed to parse unified diff patch; falling back to full-file diff when available",
        err,
      );
      return null;
    }
  }, [patch, cacheKey]);
  // Use Pierre's native line-range + gutter utility path. It owns pointer
  // capture, touch-action, and pointerup dispatch; custom slotted buttons race
  // that logic on iOS and can turn the interaction into a double-tap zoom.
  //
  // Pierre compares these options SHALLOWLY and force-renders the diff when any
  // entry differs, so the handlers below have to be stable callbacks and the
  // object itself memoized — an inline arrow here re-rendered the diff on every
  // render of this component.
  const onLineSelectionChange = useCallback(
    (range: SelectedLineRange | null) => setSelectedLines(range),
    [],
  );
  const commentsEnabled = Boolean(comments);
  const options = useMemo(
    () => ({
      ...diffOptionsFromPrefs(prefs, prefs.theme),
      ...(commentsEnabled
        ? {
            enableLineSelection: composerLine === null,
            enableGutterUtility: composerLine === null,
            onLineSelectionChange,
            onLineClick: clearSelectedLines,
            onGutterUtilityClick: openComposerForRange,
          }
        : {}),
    }),
    [
      prefs,
      commentsEnabled,
      composerLine,
      onLineSelectionChange,
      clearSelectedLines,
      openComposerForRange,
    ],
  );
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<AnnotationMeta>) =>
      annotation.metadata.node,
    [],
  );
  const annotationProps = {
    lineAnnotations,
    selectedLines,
    renderAnnotation,
  };

  const wrap = (surface: ReactNode) => (
    <div ref={setSurfaceRoot} className="contents">
      {/* The same sentence every source shows when an address asked for more
          lines than are drawn; the selection above is bounded to match. */}
      <DocumentRangeNotice anchor={lineAnchor} className="px-3 pt-2" />
      {surface}
    </div>
  );

  // Pierre re-parses (and re-diffs) both files whenever these objects change
  // identity, so they are built once per content change, not once per render.
  const pierreOldFile = useMemo(
    () =>
      oldFile
        ? { ...oldFile, ...(cacheKey ? { cacheKey: `${cacheKey}:old` } : {}) }
        : undefined,
    [oldFile, cacheKey],
  );
  const pierreNewFile = useMemo(
    () =>
      newFile
        ? { ...newFile, ...(cacheKey ? { cacheKey: `${cacheKey}:new` } : {}) }
        : undefined,
    [newFile, cacheKey],
  );

  if (oldFile && newFile && pierreOldFile && pierreNewFile) {
    return wrap(
      <MultiFileDiff<AnnotationMeta>
        key={`${cacheKey ?? `${oldFile.name}:${newFile.name}`}:${remountVersion}`}
        className="app-diff-host"
        oldFile={pierreOldFile}
        newFile={pierreNewFile}
        options={options}
        {...annotationProps}
      />,
    );
  }
  if (patch !== undefined && parsedPatch) {
    return wrap(
      <PierreFileDiff<AnnotationMeta>
        key={`${cacheKey ?? parsedPatch.name}:${remountVersion}`}
        className="app-diff-host"
        fileDiff={parsedPatch}
        options={options}
        {...annotationProps}
      />,
    );
  }
  return (
    <div className="p-4 text-sm text-muted-foreground">Nothing to diff.</div>
  );
}
