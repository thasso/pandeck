import { useCallback, useMemo, useState } from "react";
import { KNOWLEDGE_WORKTREE_ID } from "@assistant/shared";
import { documentTargetHref } from "@assistant/shared/documentTargets";
import {
  isDocumentComment,
  type PendingChatComment,
} from "../lib/chatCommentPrompt.ts";
import type { AssistantActions } from "./useAssistant.ts";

interface MessageFocus {
  sessionId: string;
  entryId: string;
  token: number;
  /** Land the row near the top instead of centring it (a comment's passage). */
  align?: "top";
}

/**
 * The row a jump landed on, held by the chat rather than read from `state`: the
 * transcript may still be loading back to it, and the reveal that named it is
 * consumed once (like a fork switch).
 */
export function useTranscriptFocus({
  actions,
  sessionId,
  onOpenDocument,
}: {
  actions: AssistantActions;
  /** The session on screen: a focus is only ever its transcript's business. */
  sessionId: string | undefined;
  onOpenDocument: (href: string) => void;
}) {
  const [messageFocus, setMessageFocus] = useState<MessageFocus | null>(null);
  // It has to stay referentially stable while it says the same thing (see
  // `src/CLAUDE.md`): the transcript re-runs its jump on a new object.
  const focusedSessionId = messageFocus?.sessionId;
  const focusedEntryId = messageFocus?.entryId;
  const focusToken = messageFocus?.token;
  const focusAlign = messageFocus?.align;
  const transcriptFocusEntry = useMemo(
    () =>
      focusedEntryId && focusToken && focusedSessionId === sessionId
        ? {
            entryId: focusedEntryId,
            token: focusToken,
            ...(focusAlign ? { align: focusAlign } : {}),
          }
        : null,
    [focusedEntryId, focusToken, focusAlign, focusedSessionId, sessionId],
  );
  // A jump is spent once the transcript lands on it: keeping it would replay the
  // jump the next time this session is opened, over the reader's own position —
  // and `useAssistant` would walk that session's fresh tail back to the old
  // anchor to make it possible. Both halves retire together.
  const retireMessageFocus = useCallback(
    (token: number) => {
      setMessageFocus((current) => (current?.token === token ? null : current));
      actions.retireMessageReveal(token);
    },
    [actions],
  );
  // A pending comment's row, reached from the composer's comment list: the same
  // jump a deep link makes, minus the server round trip — the row it annotates
  // is one this transcript has already rendered. `Math.max` keeps the token
  // moving even for two clicks inside one millisecond.
  // A document comment's row opens its document instead, at its lines when
  // it has them.
  const revealChatComment = useCallback(
    (comment: PendingChatComment) => {
      if (isDocumentComment(comment)) {
        const document = comment.anchor.document;
        onOpenDocument(
          documentTargetHref({
            ...(document.kind === "knowledgeFile"
              ? {
                  kind: "worktreeFile" as const,
                  worktreeId: KNOWLEDGE_WORKTREE_ID,
                  path: document.path,
                  view: "file" as const,
                }
              : { kind: "hostFile" as const, path: document.path }),
            ...(comment.lines
              ? {
                  anchor: {
                    start: comment.lines.start,
                    ...(comment.lines.end > comment.lines.start
                      ? { end: comment.lines.end }
                      : {}),
                  },
                }
              : {}),
          }),
        );
        return;
      }
      const { sessionId: commentSessionId, entryId } = comment.anchor;
      // Near the top, not centred: the floating composer (and its open
      // comments strip) covers the lower part of the transcript.
      setMessageFocus((current) => ({
        sessionId: commentSessionId,
        entryId,
        token: Math.max(Date.now(), (current?.token ?? 0) + 1),
        align: "top",
      }));
    },
    [onOpenDocument],
  );
  return {
    setMessageFocus,
    transcriptFocusEntry,
    retireMessageFocus,
    revealChatComment,
  };
}

export type TranscriptFocus = ReturnType<typeof useTranscriptFocus>;
