import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { SelectorBundle } from "@assistant/shared/comments";
import type {
  PendingChatComment,
  PendingTranscriptComment,
} from "../lib/chatCommentPrompt.ts";
import {
  addPendingComment,
  clearPendingComments,
  newPendingCommentId,
  outboxStorageKey,
  readPendingComments,
  removePendingComment,
  subscribePendingComments,
  updatePendingComment,
  type PendingCommentUpdate,
} from "../lib/pendingCommentStore.ts";

export interface NewPendingChatComment {
  sessionId: string;
  entryId: string;
  blockIndex: number;
  selectors: SelectorBundle;
  quote: string;
  body: string;
  transcriptPosition: PendingTranscriptComment["transcriptPosition"];
  entryCreatedAt?: string;
}

export interface PendingChatCommentsController {
  comments: readonly PendingChatComment[];
  activeCommentId: string | null;
  /** Whether storage kept it; on false the caller still holds the text. */
  add: (comment: NewPendingChatComment) => boolean;
  /**
   * Save an edit, compared against storage at the moment it writes:
   * `expectedBody` is the body the edit began from. Resolves what it found, so
   * the caller keeps the text on anything but `saved`.
   */
  update: (
    id: string,
    body: string,
    expectedBody?: string,
  ) => Promise<PendingCommentUpdate>;
  remove: (id: string) => void;
  /** Remove every comment, or only `ids` — what a send actually carried. */
  clear: (ids?: readonly string[]) => void;
  select: (id: string | null) => void;
}

/**
 * The composer's outbox: transcript comments made here and document comments
 * sent here from a tray, sharing the composer's browser-local draft namespace.
 */
export function usePendingChatComments(
  draftStorageKey: string | undefined,
): PendingChatCommentsController {
  const storageKey = draftStorageKey
    ? outboxStorageKey(draftStorageKey)
    : undefined;
  const comments = useSyncExternalStore(
    useCallback(
      (listener: () => void) => subscribePendingComments(storageKey, listener),
      [storageKey],
    ),
    () => readPendingComments(storageKey),
  );
  const [active, setActive] = useState<{
    storageKey: string | undefined;
    id: string | null;
  }>({ storageKey, id: null });
  // The selection belongs to the key: a session switch must not carry the
  // previous session's active comment into the next composer.
  const activeCommentId = active.storageKey === storageKey ? active.id : null;

  const add = useCallback(
    (comment: NewPendingChatComment) => {
      const created: PendingTranscriptComment = {
        id: newPendingCommentId(),
        anchor: {
          kind: "session",
          sessionId: comment.sessionId,
          entryId: comment.entryId,
          blockIndex: comment.blockIndex,
        },
        selectors: comment.selectors,
        quote: comment.quote,
        body: comment.body.trim(),
        transcriptPosition: comment.transcriptPosition,
        ...(comment.entryCreatedAt
          ? { entryCreatedAt: comment.entryCreatedAt }
          : {}),
      };
      if (!storageKey || !addPendingComment(storageKey, created)) return false;
      setActive({ storageKey, id: null });
      return true;
    },
    [storageKey],
  );
  const update = useCallback(
    (id: string, body: string, expectedBody?: string) =>
      storageKey
        ? updatePendingComment(storageKey, id, body, expectedBody)
        : Promise.resolve<PendingCommentUpdate>({ status: "failed" }),
    [storageKey],
  );
  const remove = useCallback(
    (id: string) => {
      if (storageKey) void removePendingComment(storageKey, id);
      setActive((current) =>
        current.id === id ? { storageKey, id: null } : current,
      );
    },
    [storageKey],
  );
  const clear = useCallback(
    (ids?: readonly string[]) => {
      if (storageKey) void clearPendingComments(storageKey, ids);
      setActive({ storageKey, id: null });
    },
    [storageKey],
  );
  const select = useCallback(
    (id: string | null) => setActive({ storageKey, id }),
    [storageKey],
  );

  return useMemo(
    () => ({
      comments,
      activeCommentId,
      add,
      update,
      remove,
      clear,
      select,
    }),
    [comments, activeCommentId, add, update, remove, clear, select],
  );
}
