/**
 * The shared plain-file renderer: a @pierre/diffs `<File>` surface with the
 * same theme/wrap prefs and the same line-comment machinery as
 * {@link DiffSurface}, so file views and diff views look and behave alike.
 *
 * Import lazily — this module pulls the pierre + Shiki stack into its chunk.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SelectedLineRange } from "@pierre/diffs";
import { File, type LineAnnotation } from "@pierre/diffs/react";
import type { SelectorBundle } from "@assistant/shared/comments";
import type { DocumentLineAnchor } from "@assistant/shared/documentTargets";
import type { Prefs } from "../../hooks/usePrefs.ts";
import { codeOptionsFromPrefs } from "./diffOptions.ts";
import {
  DiffWorkerProvider,
  useDiffWorkerCompletionVersion,
} from "./DiffWorkerProvider.tsx";
import {
  useDiffTextSelection,
  useDismissEmptyComposerOnOutsideTap,
  useFocusComment,
  useLineComments,
  useStableCommentsConfig,
  type LineCommentsConfig,
} from "./comments.tsx";
import { useDiffScrollRestoration } from "./useDiffScrollRestoration.ts";
import { anchorSelection } from "./anchorSelection.ts";
import { DocumentRangeNotice } from "../DocumentAnchorRegion.tsx";

type AnnotationMeta = { node: ReactNode };

export interface FileSurfaceProps {
  prefs: Prefs;
  name: string;
  contents: string;
  /** Worker/highlight cache key; change it whenever the contents change. */
  cacheKey?: string;
  /** Review comments for this file (must show working-tree content). */
  comments?: LineCommentsConfig | undefined;
  lineAnchor?: DocumentLineAnchor | undefined;
}

export function FileSurface(props: FileSurfaceProps) {
  return (
    <DiffWorkerProvider prefs={props.prefs}>
      <FileSurfaceContent {...props} />
    </DiffWorkerProvider>
  );
}

function FileSurfaceContent({
  prefs,
  name,
  contents,
  cacheKey,
  comments: commentsProp,
  lineAnchor,
}: FileSurfaceProps) {
  // Identity, not content, is what pierre re-renders for — see `DiffSurface`.
  const comments = useStableCommentsConfig(commentsProp);
  const [composerLine, setComposerLine] = useState<number | null>(null);
  const [composerDirty, setComposerDirty] = useState(false);
  const [composerSelectors, setComposerSelectors] =
    useState<SelectorBundle | null>(null);
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(
    anchorSelection(lineAnchor),
  );
  useEffect(() => {
    setSelectedLines(anchorSelection(lineAnchor));
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
    contents,
    source: commentSource,
    enabled: Boolean(comments) && composerLine === null,
    onActivate: activateTextSelection,
  });

  const lineAnnotations = useMemo<Array<LineAnnotation<AnnotationMeta>>>(
    () => [
      ...(lineAnchor
        ? [
            {
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

  // Pierre compares the file, options and annotation objects it was handed by
  // identity on every render and rebuilds the surface when any of them is new,
  // so all three are memoized — see the note in `DiffSurface`.
  const file = useMemo(
    () => ({ name, contents, ...(cacheKey ? { cacheKey } : {}) }),
    [name, contents, cacheKey],
  );
  const onLineSelectionChange = useCallback(
    (range: SelectedLineRange | null) => setSelectedLines(range),
    [],
  );
  const commentsEnabled = Boolean(comments);
  const options = useMemo(
    () => ({
      ...codeOptionsFromPrefs(prefs, prefs.theme),
      // Native selection/gutter handling keeps pointer capture and touch
      // suppression inside Pierre instead of racing a custom slotted button.
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
    (annotation: LineAnnotation<AnnotationMeta>) => annotation.metadata.node,
    [],
  );

  return (
    <div ref={setSurfaceRoot} className="contents">
      {/* The same sentence every source shows when an address asked for more
          lines than are drawn; the selection above is bounded to match. */}
      <DocumentRangeNotice anchor={lineAnchor} className="px-3 pt-2" />
      <File<AnnotationMeta>
        key={`${cacheKey ?? name}:${remountVersion}`}
        className="app-diff-host"
        file={file}
        options={options}
        lineAnnotations={lineAnnotations}
        selectedLines={selectedLines}
        renderAnnotation={renderAnnotation}
      />
    </div>
  );
}
