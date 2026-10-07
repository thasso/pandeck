/**
 * Line-comment widgets shared by DiffSurface and FileSurface: the thread card
 * rendered under an anchored line (pierre annotation slot — full React), the
 * new-comment composer, and the `useLineComments` hook that turns comment
 * threads + selection state into pierre annotation props.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, Reply, RotateCcw, Trash2 } from "lucide-react";
import type { WorktreeComment } from "@assistant/shared";
import type { SelectorBundle } from "@assistant/shared/comments";
import { bundleFromOffsets } from "../../lib/describeAnchor.ts";
import { showToast } from "../../lib/toast.ts";
import { usePublishCommentActuation } from "../review/CommentActuation.tsx";
import { CommentBody } from "../common/CommentBody.tsx";
import { CommentComposer as CommentComposerRow } from "../common/CommentComposer.tsx";

/** Callbacks the surfaces need to mutate comments (wired to WS actions). */
export interface CommentActions {
  onAddComment: (input: {
    body: string;
    path: string;
    line: number;
    parentId?: string;
    ref?: string;
    selectors?: SelectorBundle;
  }) => void;
  onResolveComment: (commentId: string, resolved: boolean) => void;
  onDeleteComment: (commentId: string) => void;
}

interface DiffCommentTarget {
  source: object;
  activate: () => void;
}

interface DiffCommentActuationContextValue {
  publishTarget: (target: DiffCommentTarget) => void;
  clearTarget: (source: object) => void;
}

const DiffCommentActuationContext =
  createContext<DiffCommentActuationContextValue | null>(null);

/**
 * Coordinates native selections from every lazily mounted diff/file surface,
 * then publishes the active selection into the route-level shell channel.
 */
export function DiffCommentBarProvider({
  pendingCount,
  onSubmitReview,
  enabled = true,
  children,
}: {
  pendingCount: number;
  onSubmitReview: () => void;
  /** False for a surface whose lines take no comments: the header offers none. */
  enabled?: boolean;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<DiffCommentTarget | null>(null);
  const publishTarget = useCallback(
    (next: DiffCommentTarget) => setTarget(next),
    [],
  );
  const clearTarget = useCallback(
    (source: object) =>
      setTarget((current) => (current?.source === source ? null : current)),
    [],
  );
  const contextValue = useMemo(
    () => ({ publishTarget, clearTarget }),
    [clearTarget, publishTarget],
  );
  const onComment = useCallback(() => {
    const activate = target?.activate;
    setTarget(null);
    activate?.();
  }, [target]);
  const actuation = useMemo(
    () => ({
      canComment: target !== null,
      onComment,
      pendingCount,
      onSubmitReview,
    }),
    [onComment, onSubmitReview, pendingCount, target],
  );
  usePublishCommentActuation(enabled ? actuation : null);
  return (
    <DiffCommentActuationContext.Provider value={contextValue}>
      {children}
    </DiffCommentActuationContext.Provider>
  );
}

function useDiffCommentActuation(): DiffCommentActuationContextValue | null {
  return useContext(DiffCommentActuationContext);
}

function selectedLineElement(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : (node.parentElement ?? null);
  return element?.closest<HTMLElement>("[data-line]") ?? null;
}

function lineStartOffset(contents: string, line: number): number | null {
  if (line < 1) return null;
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const newline = contents.indexOf("\n", offset);
    if (newline === -1) return null;
    offset = newline + 1;
  }
  return offset;
}

function offsetInLine(line: HTMLElement, node: Node, offset: number): number {
  const prefix = document.createRange();
  prefix.selectNodeContents(line);
  prefix.setEnd(node, offset);
  return prefix.toString().length;
}

type SelectionRange = Pick<
  Range,
  "startContainer" | "startOffset" | "endContainer" | "endOffset"
>;

/** Safari clamps ordinary ranges at a shadow boundary; ask for the composed range when available. */
function selectedRange(
  selection: Selection,
  root: HTMLElement,
): SelectionRange | null {
  const composed = selection as Selection & {
    getComposedRanges?: (options: {
      shadowRoots: ShadowRoot[];
    }) => StaticRange[];
  };
  if (composed.getComposedRanges) {
    const shadowRoots = Array.from(
      root.querySelectorAll<HTMLElement>(".app-diff-host"),
    )
      .map((host) => host.shadowRoot)
      .filter((shadowRoot): shadowRoot is ShadowRoot => shadowRoot !== null);
    let ranges: StaticRange[];
    try {
      ranges = composed.getComposedRanges({ shadowRoots });
    } catch {
      // Safari 17–18.1 shipped the earlier variadic signature. If neither form
      // works, fail this secondary affordance closed instead of throwing on
      // every selectionchange; the gutter remains the primary path.
      try {
        const legacy = composed.getComposedRanges as unknown as (
          ...roots: ShadowRoot[]
        ) => StaticRange[];
        ranges = legacy(...shadowRoots);
      } catch {
        return null;
      }
    }
    return ranges.length === 1 ? ranges[0]! : null;
  }
  return selection.rangeCount === 1 ? selection.getRangeAt(0) : null;
}

/**
 * Snapshot a single-line native selection rendered inside Pierre's shadow root.
 * This intentionally cannot delegate to `useSelectionAnchor`: that hook owns a
 * cloneable light-DOM `Range` and paints it once a composer takes over, while
 * Pierre requires a composed `StaticRange` plus line/side metadata from inside
 * several shadow roots and never paints the live selection. Keep its listener
 * dismissal rules aligned with that shared hook.
 *
 * The load-bearing Pierre attributes below were verified against 1.2.12:
 * `[data-line]` contains code text only, line numbers are separate, and deletion
 * rows use `data-line-type="change-deletion"` or a `[data-deletions]` ancestor.
 */
export function useDiffTextSelection({
  root,
  contents,
  source,
  enabled,
  onActivate,
}: {
  root: HTMLElement | null;
  contents: string | undefined;
  source: object;
  enabled: boolean;
  onActivate: (line: number, selectors: SelectorBundle) => void;
}) {
  const actuation = useDiffCommentActuation();
  useEffect(() => {
    if (!root || !contents || !enabled || !actuation) return;
    let timer = 0;
    const evaluate = () => {
      timer = 0;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        actuation.clearTarget(source);
        return;
      }
      const range = selectedRange(selection, root);
      if (!range) {
        actuation.clearTarget(source);
        return;
      }
      const startLine = selectedLineElement(range.startContainer);
      const endLine = selectedLineElement(range.endContainer);
      if (!startLine || startLine !== endLine) {
        actuation.clearTarget(source);
        return;
      }
      const tree = startLine.getRootNode();
      if (!(tree instanceof ShadowRoot) || !root.contains(tree.host)) {
        actuation.clearTarget(source);
        return;
      }
      if (
        startLine.closest("[data-deletions]") ||
        startLine.dataset.lineType === "change-deletion"
      ) {
        actuation.clearTarget(source);
        showToast("Comments attach to the new side of a diff.", {
          key: "diff-comment-side",
        });
        return;
      }
      const line = Number(startLine.dataset.line);
      const lineStart = lineStartOffset(contents, line);
      if (!Number.isInteger(line) || lineStart === null) {
        actuation.clearTarget(source);
        return;
      }
      const localStart = offsetInLine(
        startLine,
        range.startContainer,
        range.startOffset,
      );
      const localEnd = offsetInLine(
        startLine,
        range.endContainer,
        range.endOffset,
      );
      const start = lineStart + Math.min(localStart, localEnd);
      const end = lineStart + Math.max(localStart, localEnd);
      const bundle = bundleFromOffsets(contents, start, end);
      if (!bundle) {
        actuation.clearTarget(source);
        return;
      }
      bundle.block = { id: String(line), occurrence: 1 };
      actuation.publishTarget({
        source,
        activate: () => {
          window.getSelection()?.removeAllRanges();
          onActivate(line, bundle);
        },
      });
    };
    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(evaluate, 150);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      const element =
        event.target instanceof Element
          ? event.target
          : event.target.parentElement;
      if (
        element?.closest("[data-comment-actuation], [data-comment-bar]") ||
        root.contains(event.target)
      )
        return;
      actuation.clearTarget(source);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      window.getSelection()?.removeAllRanges();
      actuation.clearTarget(source);
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      actuation.clearTarget(source);
    };
  }, [actuation, contents, enabled, onActivate, root, source]);
}

export interface LineCommentsConfig {
  /** Thread roots + replies for the displayed file (current anchors). */
  comments: WorktreeComment[];
  /**
   * A thread to bring into view: the roster's rows are LINKS to the line they
   * annotate, and landing in the file without landing on the comment is what made
   * following one feel broken. The nonce re-fires the same request.
   */
  focus?: { commentId: string; nonce: number };
  /** The displayed file's repo-relative path. */
  path: string;
  actions: CommentActions;
  /**
   * Resolved commit oid the displayed content came from, when the surface
   * shows COMMITTED content rather than the working tree. Threads then render
   * at their immutable creation anchors for exactly this commit (positions on
   * this surface never move), and new comments anchor at this ref.
   * Absent = the surface shows current content (re-anchored positions).
   */
  refOid?: string;
}

function AuthorChip({ comment }: { comment: WorktreeComment }) {
  return comment.author.kind === "agent" ? (
    <span
      className="rounded bg-accent px-1 py-0.5 text-xs font-medium text-primary"
      title={[comment.author.sessionId, comment.author.thinkingLevel]
        .filter(Boolean)
        .join(" · ")}
    >
      {comment.author.model ?? "agent"} · {comment.author.sessionId.slice(0, 8)}
    </span>
  ) : (
    <span className="rounded bg-muted px-1 py-0.5 text-xs font-medium text-muted-foreground">
      you
    </span>
  );
}

/**
 * One line-comment thread, in the shape a thread has everywhere in the app
 * (`../KnowledgeComments.tsx`): who said what, the replies, then ONE bottom row of
 * icon actions. It carries no per-comment handoff to an agent — that is a REVIEW,
 * submitted as a batch from the roster (`docs/reference/web-review.md`) — and no jump,
 * because it renders ON the line it annotates.
 */
export function CommentThread({
  root,
  replies,
  actions,
}: {
  root: WorktreeComment;
  replies: WorktreeComment[];
  actions: CommentActions;
}) {
  const [replying, setReplying] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const resolved = root.resolvedAt !== undefined;
  const finePointer =
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: fine)").matches;

  return (
    <div
      className={`mx-1 my-1 border-l-2 px-2 py-1.5 text-left font-sans ${resolved ? "border-border opacity-70" : "border-primary/50"}`}
    >
      <div className="flex items-start gap-1.5">
        <AuthorChip comment={root} />
        <CommentBody
          body={root.body}
          className="min-w-0 flex-1 text-foreground"
        />
        {root.severity ? (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            {root.severity}
          </span>
        ) : null}
        {/* A badge only when the anchor is in trouble; an ordinary one says nothing. */}
        {root.anchorState === "moved" ? (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-500">
            moved
          </span>
        ) : null}
      </div>
      {replies.map((reply) => (
        <div
          key={reply.id}
          className="mt-1.5 flex items-start gap-1.5 border-t border-border/70 pt-1.5"
        >
          <AuthorChip comment={reply} />
          <CommentBody
            body={reply.body}
            className="min-w-0 flex-1 text-foreground"
          />
        </div>
      ))}
      {replying ? (
        <div className="mt-1.5">
          <CommentComposerRow
            onSubmit={(body) => {
              actions.onAddComment({
                body,
                path: root.current?.path ?? root.anchor?.path ?? "",
                line: root.current?.line ?? root.anchor?.line ?? 0,
                parentId: root.id,
              });
              setReplying(false);
            }}
            placeholder="Reply…"
            ariaLabel="Reply to this comment"
            autoFocus={finePointer}
          />
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-0.5">
        <ThreadAction
          icon={<Reply size={13} />}
          label={replying ? "Cancel reply" : "Reply"}
          active={replying}
          onClick={() => setReplying((value) => !value)}
        />
        <ThreadAction
          icon={resolved ? <RotateCcw size={13} /> : <Check size={13} />}
          label={resolved ? "Reopen thread" : "Resolve thread"}
          onClick={() => actions.onResolveComment(root.id, !resolved)}
        />
        {/* Deleting a thread was one unguarded tap here while every other delete in
            the app confirms; it now asks like the rest. */}
        {confirmingDelete ? (
          <span className="ml-auto flex items-center gap-1.5 text-sm">
            <span className="text-muted-foreground">Delete?</span>
            <button
              type="button"
              onClick={() => {
                actions.onDeleteComment(root.id);
                setConfirmingDelete(false);
              }}
              className="text-destructive hover:underline"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              No
            </button>
          </span>
        ) : (
          <span className="ml-auto">
            <ThreadAction
              danger
              icon={<Trash2 size={13} />}
              label="Delete thread"
              onClick={() => setConfirmingDelete(true)}
            />
          </span>
        )}
      </div>
    </div>
  );
}

/** One icon action in a thread's bottom row (the app-wide row-action shape). */
function ThreadAction({
  icon,
  label,
  onClick,
  active = false,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  const tone = danger
    ? "hover:bg-destructive/10 hover:text-destructive"
    : "hover:bg-muted hover:text-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors ${active ? "text-primary" : "text-muted-foreground"} ${tone}`}
    >
      {icon}
    </button>
  );
}

/**
 * The composer for a comment on a LINE: the app's one comment row
 * (`common/CommentComposer`), on the line it annotates.
 *
 * It says nothing about which line that is. It opens directly under it, the
 * reader is the one who just pressed the gutter there, and the caption that used
 * to state it existed only to carry a ✕ — which is now the composer's own cancel
 * action, beside the send button, where leaving is offered in every other
 * composer in the app.
 */
export function CommentComposer({
  onSubmit,
  onCancel,
  onDirtyChange,
}: {
  onSubmit: (body: string) => void;
  onCancel: () => void;
  /** Reported upward so a tap on another line knows whether it may retarget. */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  // Escape is the way out of a composer that holds text (a tap elsewhere is
  // deliberately ignored then), so it is bound for both states.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);
  const finePointer =
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: fine)").matches;
  return (
    <div className="mx-1 my-1 border-l-2 border-primary pl-2 font-sans">
      <CommentComposerRow
        onSubmit={onSubmit}
        onCancel={onCancel}
        onDirtyChange={onDirtyChange}
        placeholder="Comment on this line…"
        ariaLabel="Comment on this line"
        autoFocus={finePointer}
      />
    </div>
  );
}

/** How long a focused thread stays ringed after we scroll to it, in ms. */
const FOCUS_FLASH_MS = 1900;
/** Frames the scroll retries for while a lazily mounted section catches up. */
const FOCUS_RETRY_FRAMES = 90;

/**
 * Scroll a focused thread into view and briefly ring it, retrying while it is
 * still absent: the annotation appears asynchronously (Pierre renders it, and in
 * changeset mode the file's section mounts only once it is near the viewport), so
 * one attempt on the frame the request arrives finds nothing.
 *
 * The caller owns the element to search — for a shadow-DOM surface that is the
 * light-DOM subtree holding the slotted annotations.
 *
 * Takes the request as PRIMITIVES rather than an object. The nonce is what lets
 * the same comment be followed twice, so it has to reach the dependency array —
 * but a caller inlining `{ commentId, nonce }` would hand this a fresh identity
 * every render and turn the effect into a permanent re-scroll loop. Pairing
 * them here means no caller can get that wrong.
 */
export function useFocusComment(
  root: HTMLElement | null,
  commentId: string | undefined,
  nonce: number | undefined,
) {
  const focus = useMemo(
    () =>
      commentId !== undefined && nonce !== undefined
        ? { commentId, nonce }
        : undefined,
    [commentId, nonce],
  );
  useEffect(() => {
    if (!root || !focus) return;
    let frames = 0;
    let raf = 0;
    let timer = 0;
    let marked: HTMLElement | null = null;
    const attempt = () => {
      const marker = root.querySelector<HTMLElement>(
        `[data-comment-anchor="${CSS.escape(focus.commentId)}"]`,
      );
      if (!marker) {
        if (frames++ >= FOCUS_RETRY_FRAMES) return;
        raf = requestAnimationFrame(attempt);
        return;
      }
      marker.scrollIntoView({ behavior: "smooth", block: "center" });
      marker.classList.add("rounded-lg", "ring-2", "ring-primary");
      marked = marker;
      timer = window.setTimeout(() => {
        marker.classList.remove("rounded-lg", "ring-2", "ring-primary");
        marked = null;
      }, FOCUS_FLASH_MS);
    };
    raf = requestAnimationFrame(attempt);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (timer) window.clearTimeout(timer);
      marked?.classList.remove("rounded-lg", "ring-2", "ring-primary");
    };
    // One object per (commentId, nonce), built above: a new nonce re-fires this
    // for the same comment, and nothing else can.
  }, [root, focus]);
}

/**
 * Dismiss an EMPTY line composer when you tap away from the diff — the Knowledge
 * viewer's rule, so the two behave the same. Taps INSIDE a diff surface are left
 * to the line handler (which moves the composer to the line you tapped, or closes
 * it when that is its own line); Pierre retargets shadow-DOM taps to its host
 * element, so one class check covers both the surface and our slotted composer.
 */
export function useDismissEmptyComposerOnOutsideTap(
  active: boolean,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".app-diff-host")) return;
      onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [active, onDismiss]);
}

export interface LineAnnotationEntry {
  lineNumber: number;
  node: React.ReactNode;
}

/**
 * Every annotation node is prose in a box pierre already sizes to the visible
 * column (`[data-annotation-content]` is sticky at the column's width). What it
 * does NOT reset is inherited text layout: the slot it hands us sits under the
 * code column's `white-space: pre` (verified against 1.2.12), so a comment laid
 * itself out as one unwrappable line — running past the box and widening the
 * surface's horizontal scroll. Code lines may overflow that way; a comment card
 * never does.
 */
const ANNOTATION_CLASS = "block whitespace-normal break-words";

/**
 * Turn the file's comment threads + an optional open composer into annotation
 * entries (one per line).
 *
 * Current-content surfaces (no `refOid`) place roots at their re-anchored
 * `current` position; orphaned threads surface in the page-level comments
 * panel instead. Committed surfaces (`refOid`) place roots at their immutable
 * creation anchor for exactly that commit — those positions are always valid
 * for that commit's content and never move.
 */
/**
 * Hold a comments config by VALUE.
 *
 * Every caller builds this object inline (`commentsConfigFor(path)`), under a
 * page that re-renders on every socket broadcast, and its identity reaches
 * pierre through {@link useLineComments} — which rebuilds the annotations for a
 * fresh object, which makes pierre re-render the whole surface. Nothing about
 * the config changed, so hold the previous one.
 */
export function useStableCommentsConfig(
  config: LineCommentsConfig | undefined,
): LineCommentsConfig | undefined {
  const held = useRef(config);
  if (held.current !== config && !sameCommentsConfig(held.current, config))
    held.current = config;
  return held.current;
}

function sameCommentsConfig(
  a: LineCommentsConfig | undefined,
  b: LineCommentsConfig | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.path === b.path &&
    a.refOid === b.refOid &&
    a.comments === b.comments &&
    a.actions === b.actions &&
    a.focus?.commentId === b.focus?.commentId &&
    a.focus?.nonce === b.focus?.nonce
  );
}

export function useLineComments(
  config: LineCommentsConfig | undefined,
  composerLine: number | null,
  onComposerSubmit: (body: string, line: number) => void,
  onComposerCancel: () => void,
  onComposerDirtyChange?: (dirty: boolean) => void,
): LineAnnotationEntry[] {
  return useMemo(() => {
    if (!config) return [];
    const entries: LineAnnotationEntry[] = [];
    const roots = config.refOid
      ? config.comments.filter(
          (comment) =>
            !comment.parentId &&
            comment.anchor?.path === config.path &&
            comment.anchor.commit === config.refOid,
        )
      : config.comments.filter(
          (comment) =>
            !comment.parentId && comment.current?.path === config.path,
        );
    for (const root of roots) {
      const replies = config.comments.filter(
        (comment) => comment.parentId === root.id,
      );
      entries.push({
        lineNumber: config.refOid ? root.anchor!.line : root.current!.line,
        // The marker is what `useFocusComment` scrolls to; the annotation itself is
        // Pierre's, so we cannot query it by anything of ours without one.
        node: (
          <span
            key={root.id}
            data-comment-anchor={root.id}
            className={ANNOTATION_CLASS}
          >
            <CommentThread
              root={root}
              replies={replies}
              actions={config.actions}
            />
          </span>
        ),
      });
    }
    if (composerLine !== null) {
      entries.push({
        lineNumber: composerLine,
        node: (
          <span key="composer" className={ANNOTATION_CLASS}>
            <CommentComposer
              onSubmit={(body) => onComposerSubmit(body, composerLine)}
              onCancel={onComposerCancel}
              onDirtyChange={onComposerDirtyChange}
            />
          </span>
        ),
      });
    }
    return entries;
  }, [
    config,
    composerLine,
    onComposerSubmit,
    onComposerCancel,
    onComposerDirtyChange,
  ]);
}
