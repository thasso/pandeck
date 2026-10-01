import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { SendHorizontal } from "lucide-react";
import type { SelectorBundle } from "@assistant/shared/comments";
import {
  commentDocumentKey,
  isDocumentComment,
  type CommentDocument,
  type PendingDocumentComment,
} from "../lib/chatCommentPrompt.ts";
import {
  addPendingComment,
  clearPendingComments,
  newPendingCommentId,
  readPendingComments,
  removePendingComment,
  subscribePendingComments,
  trayStorageKey,
  updatePendingComment,
} from "../lib/pendingCommentStore.ts";
import {
  rangeForPendingQuote,
  sourceLinesForRange,
  type DocumentLineSource,
} from "../lib/documentCommentAnchor.ts";
import { pointAt } from "../lib/textRanges.ts";
import {
  useSelectionAnchor,
  type CapturedSelection,
} from "../hooks/useSelectionAnchor.ts";
import {
  clearBrowserDraft,
  useBrowserDraft,
} from "../hooks/useBrowserDraft.ts";
import { ChatCommentChip } from "./ChatCommentChip.tsx";
import { usePublishCommentActuation } from "./review/CommentActuation.tsx";
import {
  SendCommentsSheet,
  type SendCommentsSession,
  type SendCommentsTarget,
} from "./review/SendCommentsSheet.tsx";
import { useMobileLayout } from "./shell/useMobileLayout.ts";
import { ErrorNote } from "./ui/load.tsx";
import {
  CommentComposer,
  type CommentDictationOptions,
  type CommentRefineOptions,
} from "./ui/CommentComposer.tsx";
import {
  COMPOSER_SHELL_CLASS,
  COMPOSER_SHELL_PADDING_CLASS,
} from "./ui/composerShell.ts";

/**
 * What the app supplies to every document that collects comments: where a
 * tray can be sent, and the shared composer affordances. A document rendered
 * outside this provider shows no comment controls at all.
 */
export interface DocumentCommentHost {
  /** Sessions the tray can go to; `linked` ones are offered first. */
  sessions: SendCommentsSession[];
  /**
   * Move the tray's comments into that session's composer and take the reader
   * there. A new session receives them in the new-session draft. Returns why
   * nothing moved, for the tray to report in place, or null.
   */
  send: (trayKey: string, target: SendCommentsTarget) => Promise<string | null>;
  composer?: {
    refine?: CommentRefineOptions;
    dictation?: CommentDictationOptions;
  };
}

const DocumentCommentHostContext = createContext<DocumentCommentHost | null>(
  null,
);

export function DocumentCommentHostProvider({
  host,
  children,
}: {
  host: DocumentCommentHost;
  children: ReactNode;
}) {
  return (
    <DocumentCommentHostContext.Provider value={host}>
      {children}
    </DocumentCommentHostContext.Provider>
  );
}

/** Whether this surface may collect comments at all. */
export function useDocumentCommentsEnabled(): boolean {
  return useContext(DocumentCommentHostContext) !== null;
}

const DRAFT_PREFIX = "pa.draft.document-comment:";
const PENDING_HIGHLIGHT = "document-comment-pending";

function highlightsSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

interface NewDocumentComment {
  body: string;
  quote?: string;
  selectors?: SelectorBundle;
  lines?: { start: number; end: number };
}

/** One document's tray: the comments collected on it and not yet sent. */
function useDocumentCommentTray(document: CommentDocument) {
  const trayKey = trayStorageKey(commentDocumentKey(document));
  const stored = useSyncExternalStore(
    useCallback(
      (listener: () => void) => subscribePendingComments(trayKey, listener),
      [trayKey],
    ),
    () => readPendingComments(trayKey),
  );
  const comments = useMemo(() => stored.filter(isDocumentComment), [stored]);
  // The document's identity travels with each comment; its current title is
  // what the agent should read, so a rename is picked up by the next add.
  const documentRef = useRef(document);
  documentRef.current = document;
  const add = useCallback(
    (input: NewDocumentComment) => {
      const created: PendingDocumentComment = {
        id: newPendingCommentId(),
        anchor: { kind: "document", document: documentRef.current },
        body: input.body.trim(),
        createdAt: new Date().toISOString(),
        ...(input.quote !== undefined ? { quote: input.quote } : {}),
        ...(input.selectors ? { selectors: input.selectors } : {}),
        ...(input.lines ? { lines: input.lines } : {}),
      };
      return addPendingComment(trayKey, created);
    },
    [trayKey],
  );
  /** A conditional save, compared against storage at the moment it writes. */
  const update = useCallback(
    (id: string, body: string, expectedBody: string) =>
      updatePendingComment(trayKey, id, body, expectedBody),
    [trayKey],
  );
  const remove = useCallback(
    (id: string) => removePendingComment(trayKey, id),
    [trayKey],
  );
  const clear = useCallback(() => clearPendingComments(trayKey), [trayKey]);
  return { trayKey, comments, add, update, remove, clear };
}

type ComposerState =
  | { open: false }
  | {
      open: true;
      /** The passage, or null for a comment on the whole document. */
      selection: CapturedSelection | null;
      lines?: { start: number; end: number };
    }
  | {
      open: true;
      editId: string;
      /**
       * The comment as it was when this edit began. Another view (the side
       * panel on the same entry, another tab) may change or send it meanwhile,
       * and a save must not silently overwrite or lose either side.
       */
      base: PendingDocumentComment;
    };

/**
 * @component DocumentCommentLayer
 * @purpose Collect comments on ONE document — a passage the reader selected, or
 *   the whole document — in its browser-local tray, then send the tray to a
 *   session's composer (`docs/comments.md`).
 * @useWhen A document viewer (a Knowledge entry, a host file) wants comments.
 *   Mount it as the LAST child of the viewer's full-height column: it owns the
 *   bottom edge (composer, tray bar) and publishes the header/dock controls.
 * @avoidWhen The surface keeps server-side threads (worktree review) or is the
 *   transcript, whose comments go straight into the composer.
 * @intent No server state and no threads. The tray survives reloads on this
 *   device; sending MOVES its comments into the chosen session's composer,
 *   where they ride the next prompt as plain prose. Passages are painted by
 *   their quote; one that no longer renders is simply not painted and is still
 *   sent by its quote. Without `rootRef`/`lineSource` (an image, a PDF, HTML)
 *   only whole-document comments are offered.
 */
export function DocumentCommentLayer({
  document,
  rootRef,
  lineSource,
  rootVersion = 0,
}: {
  document: CommentDocument;
  /** The rendered text a passage can be selected in, when there is one. */
  rootRef?: RefObject<HTMLElement | null>;
  lineSource?: DocumentLineSource;
  /** Bump when `rootRef` is a NEW element, so highlights are repainted. */
  rootVersion?: number;
}) {
  const host = useContext(DocumentCommentHostContext);
  if (!host) return null;
  return (
    <DocumentCommentLayerBody
      host={host}
      document={document}
      rootRef={rootRef}
      lineSource={lineSource}
      rootVersion={rootVersion}
    />
  );
}

const NO_ROOT: RefObject<HTMLElement | null> = { current: null };

function DocumentCommentLayerBody({
  host,
  document,
  rootRef = NO_ROOT,
  lineSource,
  rootVersion,
}: {
  host: DocumentCommentHost;
  document: CommentDocument;
  rootRef?: RefObject<HTMLElement | null> | undefined;
  lineSource?: DocumentLineSource | undefined;
  rootVersion: number;
}) {
  const mobile = useMobileLayout();
  const tray = useDocumentCommentTray(document);
  /** Where a NEW comment's text survives a reload until it is stored. */
  const newDraftKey = `${DRAFT_PREFIX}${tray.trayKey}`;
  const selectable = rootRef !== NO_ROOT && lineSource !== undefined;
  const { selection, hold, release, highlightName } = useSelectionAnchor(
    rootRef,
    selectable,
  );
  const [composer, setComposer] = useState<ComposerState>({ open: false });
  /** The composer as last rendered, for a save that resolves after a switch. */
  const composerNow = useRef(composer);
  composerNow.current = composer;
  const [sending, setSending] = useState(false);
  /** A write or send storage refused, reported on the tray itself. */
  const [trayError, setTrayError] = useState<string | null>(null);
  /** Why the composer could not save; its text stays in the field. */
  const [composerError, setComposerError] = useState<string | null>(null);
  const commentField = useRef<HTMLTextAreaElement | null>(null);
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const pendingHighlight = `${PENDING_HIGHLIGHT}-${instanceId}`;

  // A different document is a different tray: nothing open carries over.
  useEffect(() => {
    release();
    setComposer({ open: false });
    setSending(false);
    setTrayError(null);
    setComposerError(null);
  }, [tray.trayKey, release]);

  /**
   * Take the composer, and on a phone put the caret in it within THIS tap: the
   * card is already mounted collapsed, so flushing the open first and focusing
   * after is what raises the keyboard without a second tap.
   */
  const takeComposer = (next: ComposerState) => {
    if (!mobile) {
      setComposer(next);
      return;
    }
    flushSync(() => setComposer(next));
    commentField.current?.focus({ preventScroll: true });
  };
  const openNewComment = () => {
    const root = rootRef.current;
    if (selection && root && lineSource) {
      const lines = sourceLinesForRange(selection.range, root, lineSource);
      hold();
      takeComposer({ open: true, selection, ...(lines ? { lines } : {}) });
      return;
    }
    release();
    takeComposer({ open: true, selection: null });
  };
  const openEdit = (id: string | null) => {
    release();
    setComposerError(null);
    const base =
      id === null ? undefined : tray.comments.find((item) => item.id === id);
    if (!base) setComposer({ open: false });
    else takeComposer({ open: true, editId: base.id, base });
  };
  const closeComposer = () => {
    release();
    setComposerError(null);
    setComposer({ open: false });
  };

  /** The comment the open edit began from, whatever has happened to it since. */
  const editing = composer.open && "editId" in composer ? composer.base : null;
  const removeFromTray = (id: string) => {
    void tray.remove(id);
    // Removed HERE, from this tray's own list: its edit has nothing left to do.
    if (editing?.id === id) closeComposer();
  };

  /** One save of an edit at a time; the composer shows it busy meanwhile. */
  const [saving, setSaving] = useState(false);
  /**
   * Save the composer's text; resolves whether it was stored AND the field
   * still holds exactly that text (`unchanged`), so only then may it close.
   */
  const submit = async (
    body: string,
    unchanged: () => boolean,
  ): Promise<boolean> => {
    if (composer.open && "editId" in composer) {
      if (saving) return false;
      const edit = composer;
      setSaving(true);
      const saved = await tray.update(edit.editId, body, edit.base.body);
      setSaving(false);
      // The reader opened something else while the store's lock was held:
      // this answer belongs to an edit no longer on screen.
      // Report nothing stored, so the composer now open keeps its own draft.
      if (composerNow.current !== edit) return false;
      if (saved.status === "saved" && !unchanged()) {
        // Typed on while the save waited: keep that text open, based on what
        // was just stored, so the next Save goes straight through.
        setComposer({ ...edit, base: { ...edit.base, body: body.trim() } });
        return false;
      }
      if (saved.status === "missing") {
        setComposerError(
          "This comment was sent or removed in another view. Your text is still here to copy.",
        );
        return false;
      }
      if (saved.status === "conflict") {
        // Rebase on what the other view saved, so a second Save is a
        // deliberate overwrite rather than the silent one this refuses.
        if (isDocumentComment(saved.current))
          setComposer({ ...edit, base: saved.current });
        setComposerError(
          "This comment was changed in another view. Save again to replace it with your text.",
        );
        return false;
      }
      if (saved.status === "failed") {
        setComposerError(
          "This browser did not store the change. Your text is still here to copy.",
        );
        return false;
      }
      setTrayError(null);
      closeComposer();
      return true;
    }
    if (!composer.open) return false;
    const captured = composer.selection;
    const stored = tray.add({
      body,
      ...(captured
        ? { quote: captured.quote, selectors: captured.bundle }
        : {}),
      ...(composer.lines ? { lines: composer.lines } : {}),
    });
    if (!stored) {
      // Stays open with the text in it: the tray may be empty, and an error
      // there would be nowhere the reader can see.
      setComposerError(
        "This browser couldn't store the comment (storage full or unavailable). Your text is still here.",
      );
      return false;
    }
    // Stored: its draft goes NOW, while the composer holding it is mounted —
    // closing unmounts it on a wide layout, and the next new comment on this
    // document must not reopen with the text just filed.
    clearBrowserDraft(newDraftKey);
    closeComposer();
    return true;
  };

  // Paint every collected passage, from the CURRENT DOM: a re-render replaces
  // the nodes a registered Highlight holds, so the paint follows the DOM.
  const passageRanges = useCallback((): { id: string; range: Range }[] => {
    const root = rootRef.current;
    if (!root || !selectable) return [];
    return tray.comments.flatMap((comment) => {
      if (comment.quote === undefined) return [];
      const range = rangeForPendingQuote(
        root,
        comment.quote,
        comment.selectors,
      );
      return range ? [{ id: comment.id, range }] : [];
    });
  }, [rootRef, selectable, tray.comments]);
  const paint = useCallback(() => {
    if (!highlightsSupported()) return;
    // A live selection in this document owns the paint (`review/CLAUDE.md`):
    // collected passages step aside until it collapses.
    const live = window.getSelection();
    const root = rootRef.current;
    if (
      root &&
      live &&
      live.rangeCount > 0 &&
      !live.isCollapsed &&
      live.getRangeAt(0).intersectsNode(root)
    ) {
      CSS.highlights.delete(pendingHighlight);
      return;
    }
    const ranges = passageRanges().map((item) => item.range);
    if (ranges.length > 0)
      CSS.highlights.set(pendingHighlight, new Highlight(...ranges));
    else CSS.highlights.delete(pendingHighlight);
  }, [passageRanges, pendingHighlight, rootRef]);
  useEffect(() => {
    paint();
    const root = rootRef.current;
    let observer: MutationObserver | undefined;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        paint();
      });
    };
    window.document.addEventListener("selectionchange", schedule);
    if (root && typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(schedule);
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    return () => {
      window.document.removeEventListener("selectionchange", schedule);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (highlightsSupported()) CSS.highlights.delete(pendingHighlight);
    };
  }, [paint, pendingHighlight, rootRef, rootVersion]);

  // A tap on a painted passage opens its comment; it never creates one.
  const openAtPointRef = useRef<(event: MouseEvent) => void>(() => {});
  openAtPointRef.current = (event: MouseEvent) => {
    // Controls keep their own click. A LINK does not: a passage is often
    // linked text, so the hit test decides, and only a painted passage is
    // intercepted — a tap anywhere else on the link still follows it.
    if (
      (event.target as HTMLElement | null)?.closest(
        "button, input, textarea, select, [role='button']",
      )
    )
      return;
    const live = window.getSelection();
    if (live && !live.isCollapsed) return;
    const point = pointAt(
      event.view?.document ?? window.document,
      event.clientX,
      event.clientY,
    );
    if (!point) return;
    const hit = passageRanges().find(({ range }) =>
      range.isPointInRange(point.node, point.offset),
    );
    if (!hit) return;
    if ((event.target as HTMLElement | null)?.closest("a")) {
      event.preventDefault();
      event.stopPropagation();
    }
    openEdit(hit.id);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !selectable) return;
    const onClick = (event: MouseEvent) => openAtPointRef.current(event);
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [rootRef, rootVersion, selectable]);

  const reveal = (comment: { id: string }) => {
    const hit = passageRanges().find((item) => item.id === comment.id);
    const node = hit?.range.startContainer;
    const element = node instanceof Element ? node : node?.parentElement;
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const count = tray.comments.length;
  const openSend = useCallback(() => {
    if (count > 0) setSending(true);
  }, [count]);
  usePublishCommentActuation({
    // A selection makes it a passage comment; without one it is about the
    // whole document, so the control is never dead.
    canComment: !composer.open,
    onComment: openNewComment,
    pendingCount: count,
    onSubmitReview: openSend,
    submitLabel: "Send comments",
    composerOpen: composer.open,
  });

  const passage = composer.open && !("editId" in composer);
  const placeholder = editing
    ? "Edit this comment…"
    : passage && composer.selection
      ? "Comment on the selected passage…"
      : "Comment on the whole document…";

  return (
    <>
      <style>{`
  ::highlight(${highlightName}) {
    color: inherit;
    background-color: color-mix(in oklab, var(--accent) 32%, transparent);
  }
  ::highlight(${pendingHighlight}) {
    color: inherit;
    background-color: color-mix(in oklab, #f5c518 34%, transparent);
  }
`}</style>
      {count > 0 && !composer.open ? (
        <div
          data-comment-bar
          className="shrink-0 border-t border-line bg-surface px-3 pt-2"
        >
          <div className="mx-auto w-full max-w-3xl">
            {trayError ? (
              <div className="mb-2">
                <ErrorNote message={trayError} />
              </div>
            ) : null}
            <ChatCommentChip
              comments={tray.comments}
              activeCommentId={editing?.id ?? null}
              onSelect={openEdit}
              onRemove={removeFromTray}
              onClear={() => void tray.clear()}
              onReveal={selectable ? reveal : undefined}
              action={
                <button
                  type="button"
                  onClick={openSend}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-caption font-medium text-accent hover:bg-accent/10"
                >
                  <SendHorizontal size={14} />
                  Send to session
                </button>
              }
            />
          </div>
        </div>
      ) : null}
      {composer.open || mobile ? (
        <DocumentCommentComposer
          key={editing?.id ?? "new"}
          open={composer.open}
          mobile={mobile}
          fieldRef={commentField}
          draftStorageKey={newDraftKey}
          editing={editing}
          placeholder={placeholder}
          refine={host.composer?.refine}
          dictation={host.composer?.dictation}
          onCancel={closeComposer}
          onDelete={editing ? () => removeFromTray(editing.id) : undefined}
          error={composerError ?? undefined}
          busy={saving}
          onSubmit={submit}
        />
      ) : null}
      {sending ? (
        <SendCommentsSheet
          count={count}
          sessions={host.sessions}
          initialTarget={
            host.sessions[0]?.linked
              ? { kind: "existing", sessionId: host.sessions[0].id }
              : { kind: "new" }
          }
          intro="The comments move into that session's composer, where you add a message and send them."
          linkedDetail="Current session"
          withMessage={false}
          verb="Send"
          newDetail="Opens the new-session page with these comments staged"
          newSubmitLabel="Continue to new session"
          submitLabel="Move to composer"
          onClose={() => setSending(false)}
          onSend={(target) => {
            setSending(false);
            void host.send(tray.trayKey, target).then(setTrayError);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The bottom-edge card a document comment is written in, in the chat
 * composer's shell. On a phone it stays MOUNTED collapsed, so whatever opens it
 * can focus its field inside the same tap.
 */
function DocumentCommentComposer({
  open,
  mobile,
  fieldRef,
  draftStorageKey,
  editing,
  placeholder,
  refine,
  dictation,
  onCancel,
  onDelete,
  error,
  onSubmit,
  busy = false,
}: {
  open: boolean;
  mobile: boolean;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  /** Where a NEW comment's draft survives a reload. */
  draftStorageKey: string;
  editing: PendingDocumentComment | null;
  placeholder: string;
  refine?: CommentRefineOptions | undefined;
  dictation?: CommentDictationOptions | undefined;
  onCancel: () => void;
  onDelete?: (() => void) | undefined;
  /** Why the last save was refused; the draft stays in the field. */
  error?: string | undefined;
  /** Resolves whether the comment was stored; only then is the draft cleared. */
  onSubmit: (body: string, unchanged: () => boolean) => Promise<boolean>;
  /** A save is in flight: submitting again waits for it. */
  busy?: boolean;
}) {
  const [draft, setDraft] = useBrowserDraft(draftStorageKey);
  // Keyed by the edited comment's id, so this seeds once per comment.
  const [editDraft, setEditDraft] = useState(editing?.body ?? "");
  // The field's text as last rendered, for a save that resolves later.
  const draftNow = useRef(draft);
  draftNow.current = draft;
  const editTextNow = useRef(editDraft);
  editTextNow.current = editDraft;
  const cancel = () => {
    if (!editing) setDraft("");
    onCancel();
  };
  const autoFocus =
    !mobile && (window.matchMedia?.("(pointer: fine)").matches ?? false);
  return (
    <div
      // Lifted by the keyboard exactly as the chat composer is.
      className="relative z-10 shrink-0 bg-transparent transition-transform duration-150 ease-out"
      style={{
        transform:
          "translateY(calc(-1 * var(--app-keyboard-inset-bottom, 0px)))",
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        cancel();
      }}
    >
      <div
        className={`${COMPOSER_SHELL_CLASS} ${open ? COMPOSER_SHELL_PADDING_CLASS : "pb-0"}`}
      >
        <CommentComposer
          layout="card"
          collapsed={!open}
          fieldRef={fieldRef}
          autoFocus={open && autoFocus}
          value={editing ? editDraft : draft}
          onChange={editing ? setEditDraft : setDraft}
          placeholder={placeholder}
          ariaLabel={editing ? "Edit comment" : "Add comment"}
          submitLabel={editing ? "Save comment" : "Add comment"}
          refine={refine}
          dictation={dictation}
          onCancel={cancel}
          onDelete={onDelete}
          deleteLabel="Remove comment"
          error={error}
          busy={busy}
          onSubmit={(body) => {
            // The draft goes only once the comment is stored: a refused save
            // leaves the reader's text where it was typed.
            void onSubmit(
              body,
              () =>
                (editing ? editTextNow.current : draftNow.current).trim() ===
                body,
            ).then((stored) => {
              if (stored && !editing) setDraft("");
            });
          }}
        />
      </div>
    </div>
  );
}
