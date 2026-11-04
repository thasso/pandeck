import { MessageSquareQuote, SquareArrowOutUpRight } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { isClaudeSdkModel, type ModelOption } from "@assistant/shared";
import type { AssistantActions, UIState } from "../../hooks/useAssistant.ts";
import {
  useBackgroundStopPending,
  useComposerDictation,
  useSessionChat,
  useTranscriptPin,
  type SessionChatHost,
} from "../../hooks/useSessionChat.tsx";
import { useTranscriptFocus } from "../../hooks/useTranscriptFocus.ts";
import { visibleModels } from "../../lib/models.ts";
import { locksModelAfterStart } from "../../lib/sessionCapabilities.ts";
import { sessionPath } from "../../lib/sessionRoutes.ts";
import { IconButton } from "../common/IconButton.tsx";
import { SessionChat } from "../SessionChat.tsx";

/** Width-clamped transcript content measures the panel, not the main pane. */
const PANEL_WIDTH_STYLE = { "--shell-main-width": "100cqw" } as CSSProperties;

/**
 * @component PanelChatHeader
 * @purpose The compact row over a panel's chat: what it shows, then its actions.
 * @useWhen A right-panel surface shows a session, with or without a chat under it.
 */
export function PanelChatHeader({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border px-2">
      <div className="min-w-0 flex-1">{title}</div>
      {children}
    </div>
  );
}

/**
 * @component PanelSessionChat
 * @purpose `SessionChat` for a session a right-panel connection is viewing, with
 * the panel's header over it.
 * @useWhen A panel owns an isolated `useAssistant` and its session has arrived.
 * @intent The connection's state answers for the session; the lists come from
 * `host`, and everything a transcript opens lands in the main pane, because a
 * panel exists to stay beside what the main pane shows.
 */
export function PanelSessionChat({
  state,
  actions,
  session,
  host,
  visible,
  draftStorageKey,
  title,
  onOpenInMain,
}: {
  state: UIState;
  actions: AssistantActions;
  session: NonNullable<UIState["session"]>;
  host: SessionChatHost;
  visible: boolean;
  draftStorageKey: string;
  title: ReactNode;
  onOpenInMain: () => void;
}) {
  const { sessionId } = session;
  const { onNavigate, onPanelSessionChange, credentialProfiles } = host;
  const sessionRow = host.sessions.find((row) => row.id === sessionId);
  const transcriptPin = useTranscriptPin();
  const focus = useTranscriptFocus({
    actions,
    sessionId,
    onOpenDocument: onNavigate,
  });
  const { setMessageFocus } = focus;
  const [backgroundLedgeOpen, setBackgroundLedgeOpen] = useState(false);
  const backgroundStrip = useMemo(
    () => ({
      open: backgroundLedgeOpen,
      onToggle: () => setBackgroundLedgeOpen((value) => !value),
    }),
    [backgroundLedgeOpen],
  );
  const models = useMemo(
    () => visibleModels(state.models, state.settings),
    [state.models, state.settings],
  );
  const chat = useSessionChat({
    state,
    actions,
    host,
    surface:
      session.agentType === "personal-assistant" ? "assistant" : "session",
    session,
    sessionRow,
    messages: state.messages,
    streaming: state.streaming,
    hasOlderMessages: state.timelineStart > 0,
    draftStorageKey,
    models,
    backgroundStrip,
    backgroundStopPending: useBackgroundStopPending(state),
    dictation: useComposerDictation(state),
    focus,
    transcriptPin,
  });

  // The ledge's rows are the registry topic's, held on this connection only
  // while it is expanded.
  useEffect(() => {
    actions.setTopics(backgroundLedgeOpen ? ["background"] : []);
  }, [actions, backgroundLedgeOpen]);

  // An unselected tab draws its note where nobody can read it, so only the
  // panel on screen is a home for this session's failures.
  useEffect(() => {
    if (!visible) return;
    onPanelSessionChange(sessionId);
    return () => onPanelSessionChange(null);
  }, [visible, sessionId, onPanelSessionChange]);

  // A jump this connection resolved lands here when it is to this session; any
  // other session is the main pane's to open.
  const revealToken = state.messageReveal?.token;
  const revealSessionId = state.messageReveal?.sessionId;
  const revealEntryId = state.messageReveal?.entryId;
  useEffect(() => {
    if (revealToken === undefined || !revealSessionId || !revealEntryId) return;
    if (revealSessionId === sessionId)
      setMessageFocus({
        sessionId: revealSessionId,
        entryId: revealEntryId,
        token: revealToken,
      });
    else
      onNavigate(
        `${sessionPath(revealSessionId)}#m-${encodeURIComponent(revealEntryId)}`,
      );
  }, [
    revealToken,
    revealSessionId,
    revealEntryId,
    sessionId,
    setMessageFocus,
    onNavigate,
  ]);

  const openPaObject = useCallback(
    (link: { objectType: string; id: string; href: string }) => {
      if (link.objectType === "approval") actions.revealApproval(link.id);
      else onNavigate(link.href);
    },
    [actions, onNavigate],
  );

  const started = state.messages.some((message) => message.role === "user");
  const modelLocked = locksModelAfterStart(session) && started;
  const piStarted = session.harness === "pi" && started;
  const isModelDisabled = useCallback(
    (model: ModelOption) =>
      modelLocked || (piStarted && isClaudeSdkModel(model)),
    [modelLocked, piStarted],
  );
  const commentSelection = chat.commentSelection;
  return (
    <div
      className="@container flex h-full min-h-0 flex-col"
      style={PANEL_WIDTH_STYLE}
    >
      <PanelChatHeader title={title}>
        <IconButton
          label="Add comment"
          title={commentSelection ? "Add comment" : "Select text to comment"}
          size="icon"
          // Keep the transcript selection the comment anchors to.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => commentSelection?.onComment()}
          data-comment-actuation
          disabled={!commentSelection}
        >
          <MessageSquareQuote />
        </IconButton>
        <IconButton
          label="Open in main pane"
          size="icon"
          onClick={onOpenInMain}
        >
          <SquareArrowOutUpRight />
        </IconButton>
      </PanelChatHeader>
      <SessionChat
        chat={chat}
        composer={{
          isModelDisabled,
          modelLocked,
          thinkingLocked: modelLocked,
          accountName: credentialProfiles.find(
            (profile) => profile.id === sessionRow?.credentialProfileId,
          )?.name,
        }}
        transcript={{
          onOpenPaObject: openPaObject,
          turnStatsSeed: state.turnStatsSeed,
        }}
      />
    </div>
  );
}
