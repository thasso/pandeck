import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  peerPromptHopRefusalMessage,
  type AgentQuestionResponse,
  type CredentialProfileProvider,
  type EntrySummary,
  type ModelOption,
  type PromptAttachment,
  type SessionListItem,
  type SessionState,
  type TaskStatus,
} from "@assistant/shared";
import { pendingQuestionEntryId } from "../components/AgentQuestionToolCard.tsx";
import { BackgroundWorkLedge } from "../components/BackgroundWorkLedge.tsx";
import type { Composer } from "../components/Composer.tsx";
import type { MessageList } from "../components/MessageList.tsx";
import { PendingApprovalsLedge } from "../components/PendingApprovalsLedge.tsx";
import {
  PendingCommentsLedge,
  type CommentLedgeItem,
} from "../components/PendingCommentsLedge.tsx";
import {
  PendingQuestionLedge,
  pendingQuestionsLedgeKey,
} from "../components/PendingQuestionLedge.tsx";
import { PromptQueueLedge } from "../components/PromptQueueLedge.tsx";
import {
  SpawnedSessionsLedge,
  type SpawnedSessionDetails,
} from "../components/SpawnedSessionsLedge.tsx";
import type { TaskLiveSourceProvider } from "../components/TaskLiveState.tsx";
import type { TranscriptViewPrefs } from "../components/transcriptView.ts";
import {
  pendingApprovalCards,
  pendingApprovalsKey,
} from "../lib/approvalCards.ts";
import { acceptStatusSuggestionSave } from "../lib/backlogTree.ts";
import { skillSummariesKey } from "../lib/transcriptKeys.ts";
import { commentDocumentLabel } from "../lib/chatCommentPrompt.ts";
import { createClientId } from "../lib/clientId.ts";
import { dataOf } from "../lib/loadState.ts";
import { failureOnViewedSession } from "../lib/messageAnnounce.ts";
import { visibleSessionDraft } from "../lib/newSessionRuntime.ts";
import { applyPeerPromptCardOverridesToMessages } from "../lib/peerPromptCardOverrides.ts";
import {
  spawnedSessionsKey,
  spawnedSessionsView,
} from "../lib/sessionInbox.ts";
import type { AssistantActions, UIState } from "./useAssistant.ts";
import type { TranscriptFocus } from "./useTranscriptFocus.ts";
import {
  usePendingChatComments,
  type NewPendingChatComment,
} from "./usePendingChatComments.ts";

type ComposerProps = ComponentProps<typeof Composer>;
type MessageListProps = ComponentProps<typeof MessageList>;

/** The ledge's queue when only peer prompts wait: nothing of the user's own. */
const EMPTY_PROMPT_QUEUE: import("@assistant/shared").PromptQueueState = {
  items: [],
  paused: false,
};
const EMPTY_CONVERSATION_MESSAGES: import("@assistant/shared").DisplayMessage[] =
  [];
const EMPTY_UNHANDLED_BATCH: import("@assistant/shared").BackgroundHandlingRef[] =
  [];
/** The permanent Assistant's ledge after a Stop: its hold, and no drafts. */
const HELD_ASSISTANT_QUEUE: import("@assistant/shared").PromptQueueState = {
  items: [],
  paused: true,
  automaticTurnsHeld: true,
};
/** A held Assistant's ledge has no rows to send or remove. */
const noop = () => {};

/**
 * The cards whose conflicted rebase is with this session's agent. Each entry of
 * `state.pullRequestCards` is the one-block message `upsertPullRequestCard`
 * writes, so the card is read off the block rather than from a second store.
 */
function rebaseHandedOffCardIds(cards: UIState["pullRequestCards"]): string[] {
  const ids: string[] = [];
  for (const message of cards)
    for (const block of message.blocks)
      if (block.kind === "pullRequest" && block.pullRequest.rebaseHandedOff)
        ids.push(block.pullRequest.id);
  return ids;
}

/**
 * What the app hands every session chat, wherever it sits. The session list and
 * the rest are the MAIN connection's: a side panel's own connection subscribes
 * none of them, so its surfaces read the lists the app already holds. Every
 * `on…` opens in the main pane.
 */
export interface SessionChatHost {
  sessions: SessionListItem[];
  workflowRuns: UIState["workflowRuns"];
  workflowCards: UIState["workflowCards"];
  view: TranscriptViewPrefs;
  accountModels: NonNullable<MessageListProps["accountModels"]>;
  taskLiveSource: ComponentProps<typeof TaskLiveSourceProvider>["source"];
  credentialProfiles: readonly {
    id: string;
    name: string;
    provider: CredentialProfileProvider;
  }[];
  describeSession: (session: SessionListItem) => SpawnedSessionDetails;
  onNavigate: (path: string) => void;
  onOpenSession: (id: string) => void;
  onOpenTask: (id: string) => void;
  onOpenBackgroundWork: (id: string) => void;
  onOpenWorktree: (id: string) => void;
  onDismissSessionFailure: ComponentProps<
    typeof SpawnedSessionsLedge
  >["onDismissSessionFailure"];
  /**
   * Fork on the MAIN connection, which is what opens the fork in the main pane.
   * Run on a panel's it would move that panel off the session it was asked for.
   */
  onForkSession: AssistantActions["forkSession"];
  /** The session a panel chat renders failures for, while it is on screen. */
  onPanelSessionChange: (sessionId: string | null) => void;
}

export interface SessionChatInput {
  /** The connection viewing this session. */
  state: UIState;
  actions: AssistantActions;
  host: SessionChatHost;
  /**
   * Which strips the composer's shelf may hold: an ordinary session's, the
   * permanent Assistant's hold alone, or a staged chat's own, none of which are
   * this hook's.
   */
  surface: "session" | "assistant" | "staged";
  session: SessionState | null;
  sessionRow: SessionListItem | undefined;
  messages: MessageListProps["messages"];
  streaming: boolean;
  hasOlderMessages: boolean;
  draftStorageKey: string;
  models: ModelOption[];
  backgroundStrip: { open: boolean; onToggle: () => void };
  backgroundStopPending: ReadonlySet<string>;
  dictation: NonNullable<ComposerProps["dictation"]>;
  focus: TranscriptFocus;
  transcriptPin: TranscriptPin;
  /** The staged chat's send. Absent, a prompt goes to the session on screen. */
  onSend?: (text: string, attachments?: PromptAttachment[]) => void;
  /** What only a new session's shelf carries: its staged Task, document, review. */
  stagedLedges?: ReactNode;
  /** A draft the host staged, ahead of a fork or resend draft. */
  stagedDraft?: ComposerProps["draft"];
  /** The failure is already on screen in the transcript's place. */
  failureShownElsewhere?: boolean;
  /** Where a fork runs. Absent, on this connection. */
  onForkSession?: AssistantActions["forkSession"];
  /**
   * False for a chat pinned to one session: a new draft is created on this
   * connection, because it inherits the viewed session's runtime, and takes the
   * connection with it.
   */
  canCreateDrafts?: boolean;
  /** `/review`: only a host that can start the review session offers it. */
  onReviewCommand?: (rawArgs: string) => string | null;
}

/** Submitting follows the answer, wherever in the conversation it was sent from. */
export interface TranscriptPin {
  token: number;
  pinToBottom: () => void;
}

export function useTranscriptPin(): TranscriptPin {
  // A token rather than something the transcript could notice by itself — an
  // attachments-only prompt echoes no optimistic row to notice.
  const [token, setToken] = useState(0);
  const pinToBottom = useCallback(() => setToken((value) => value + 1), []);
  return useMemo(() => ({ token, pinToBottom }), [token, pinToBottom]);
}

/** The composer's dictation control, as every composer reads it. */
export function useComposerDictation(state: UIState) {
  return useMemo(
    () => ({
      enabled: state.settings.speechToText.enabled,
      status: state.speechToText,
    }),
    [state.settings.speechToText.enabled, state.speechToText],
  );
}

/**
 * Pending CONTROL state only: which Stop buttons this browser is waiting on.
 * A Stop-all covers every item its owner holds, so those ids join the set too
 * — and nothing in it changes what a row SAYS about the work.
 */
export function useBackgroundStopPending(state: UIState): ReadonlySet<string> {
  return useMemo(() => {
    const pending = new Set(state.backgroundStopPending);
    if (state.backgroundStopAllPending.length > 0)
      for (const item of state.backgroundWorkItems)
        if (state.backgroundStopAllPending.includes(item.ownerSessionId))
          pending.add(item.id);
    return pending;
  }, [
    state.backgroundStopPending,
    state.backgroundStopAllPending,
    state.backgroundWorkItems,
  ]);
}

/**
 * The model behind a session chat: everything between a connection's state and
 * `<SessionChat>` — the transcript's and the composer's wiring, and the shelf of
 * strips over the composer. The center and the right-panel chats both come
 * through here; what only one of them has arrives as an input or as a prop on
 * `<SessionChat>`, so there is no second chat surface to keep in step.
 */
export function useSessionChat({
  state,
  actions,
  host,
  surface,
  session,
  sessionRow,
  messages,
  streaming,
  hasOlderMessages,
  draftStorageKey,
  models,
  backgroundStrip,
  backgroundStopPending,
  dictation,
  focus,
  transcriptPin,
  onSend,
  stagedLedges,
  stagedDraft,
  failureShownElsewhere = false,
  onForkSession = actions.forkSession,
  canCreateDrafts = true,
  onReviewCommand,
}: SessionChatInput) {
  const {
    sessions,
    workflowRuns,
    workflowCards,
    describeSession,
    onOpenSession,
    onDismissSessionFailure,
  } = host;
  const { setMessageFocus, revealChatComment } = focus;
  const pinTranscriptToBottom = transcriptPin.pinToBottom;
  const sessionId = session?.sessionId;
  // The composer's spawned-session ledge, expanded. It subscribes nothing: the
  // peers are rows of the session list this browser already holds.
  const [spawnedLedgeOpen, setSpawnedLedgeOpen] = useState(false);
  // The session whose ledge also lists its SETTLED peers. Keyed by session
  // rather than a boolean so a chat switched to starts with live peers only,
  // without an effect to reset it; closing the strip forgets it.
  const [spawnedLedgeSettledFor, setSpawnedLedgeSettledFor] = useState<
    string | null
  >(null);
  const toggleSpawnedLedge = useCallback(() => {
    setSpawnedLedgeOpen((value) => {
      if (value) setSpawnedLedgeSettledFor(null);
      return !value;
    });
  }, []);

  // A fork draft is a one-session handoff. The reducer retains the last one, so
  // never let a later composer remount stage it onto another session or the
  // shared new-session draft slot.
  const forkDraft = visibleSessionDraft(state.forkDraft, sessionId);
  // The composer took a staged draft. Only the fork draft lives in the reducer,
  // so only its token matches; the review handoffs are this component's own
  // state and are dropped where they are sent.
  const retireStagedDraft = useCallback(
    (token: number) => actions.retireSessionDraft(token),
    [actions],
  );

  const chatComments = usePendingChatComments(draftStorageKey);
  const [chatCommentDraft, setChatCommentDraft] = useState<Omit<
    NewPendingChatComment,
    "body"
  > | null>(null);
  const [chatCommentSelection, setChatCommentSelection] = useState<{
    quote: string;
    onComment: () => void;
  } | null>(null);
  const onChatCommentSelectionChange = useCallback(
    (selection: { quote: string; onComment: () => void } | null) =>
      setChatCommentSelection(selection),
    [],
  );
  // A transcript can unmount between session routes; clear its anchor in the
  // host as well as in MessageList so it cannot attach under the next session.
  useEffect(() => {
    setChatCommentDraft(null);
    setChatCommentSelection(null);
  }, [sessionId]);

  // Answering an agent's status suggestion from a transcript card: the SAME save
  // the Backlog Focus row sends (`acceptStatusSuggestionSave`). It resumes no
  // session, so answering here costs no provider call, and it carries no title,
  // so a card recorded before a rename cannot undo it.
  const applyTaskStatusSuggestion = useCallback(
    (task: { id: string; status: TaskStatus }) =>
      actions.saveTask(
        acceptStatusSuggestionSave({ id: task.id, to: task.status }),
      ),
    [actions],
  );

  // The id is the whole of what this reads, and it must stay referentially
  // stable for the memoized transcript rows that carry it.
  const forkSourceSessionId = state.session?.sessionId;
  const forkMessage = useCallback(
    (entryId: string, position: "before" | "at") => {
      if (!forkSourceSessionId) return;
      onForkSession(forkSourceSessionId, entryId, position);
    },
    [onForkSession, forkSourceSessionId],
  );

  // Resend a prompt into the SAME session: it lands in the composer for the user
  // to send, which is the only safe repeat when a turn may have failed after
  // tool calls already ran.
  const resendPrompt = useCallback(
    (text: string) => {
      if (!sessionId) return;
      actions.stageSessionDraft(sessionId, text);
    },
    [actions, sessionId],
  );

  const acknowledgeMissingWorktree = useCallback(() => {
    if (sessionId) actions.acknowledgeMissingWorktree(sessionId);
  }, [actions, sessionId]);

  const abortRun = useCallback(() => actions.abort(), [actions]);
  const [conversationActive, setConversationActive] = useState(false);
  // Display projection calls every transient response "live". Speech needs the
  // runtime's unique stream id so successive turns never share a cursor.
  const conversationStreamId = state.liveStreams.find(
    (stream) => stream.kind === "message",
  )?.streamId;
  const conversationSourceMessages = useMemo(
    () =>
      messages.map((message) =>
        message.id === "live" && conversationStreamId
          ? { ...message, id: `voice-live:${conversationStreamId}` }
          : message,
      ),
    [messages, conversationStreamId],
  );
  const conversationMessagesRef = useRef(conversationSourceMessages);
  conversationMessagesRef.current = conversationSourceMessages;
  const getConversationMessages = useCallback(
    () => conversationMessagesRef.current,
    [],
  );
  const conversationMessages = conversationActive
    ? conversationSourceMessages
    : EMPTY_CONVERSATION_MESSAGES;
  const composerConversation = useMemo(
    () => ({
      settings: {
        speechConversation: state.settings.speechConversation,
        speechSynthesis: state.settings.speechSynthesis,
      },
      // Idle transcript traffic must not redraw the memoized composer.
      messages: conversationMessages,
      getMessages: getConversationMessages,
      onActiveChange: setConversationActive,
    }),
    [
      conversationMessages,
      state.settings.speechConversation,
      state.settings.speechSynthesis,
      getConversationMessages,
    ],
  );

  // Answering a question is a submit too, so the transcript follows it.
  const respondToQuestion = useCallback(
    (response: AgentQuestionResponse) => {
      pinTranscriptToBottom();
      actions.respondToQuestion(response);
    },
    [actions, pinTranscriptToBottom],
  );

  /**
   * A conflicted "Update with main" is not answered on the card at all: it
   * lands as a PROMPT in this session, seconds after the click, and the card
   * only says so afterwards (`rebaseHandedOff`). That is a submit, so the
   * transcript follows it — but not at click time, when there is nothing to
   * follow yet and the rebase may still resolve deterministically, and not in
   * a second viewer of the same session, which never asked for anything and
   * keeps its reading position. Hence the intent is remembered HERE, per card,
   * and spent when that card's handoff actually shows up.
   */
  const rebaseHandoffPending = useRef<Set<string>>(new Set());
  const runPullRequestCardAction = useCallback<
    AssistantActions["runPullRequestCardAction"]
  >(
    (cardId, action, options) => {
      if (action === "update-with-main")
        rebaseHandoffPending.current.add(cardId);
      actions.runPullRequestCardAction(cardId, action, options);
    },
    [actions],
  );
  useEffect(() => {
    const waiting = rebaseHandoffPending.current;
    if (waiting.size === 0) return;
    let handedOff = false;
    for (const id of rebaseHandedOffCardIds(state.pullRequestCards))
      if (waiting.delete(id)) handedOff = true;
    if (handedOff) pinTranscriptToBottom();
  }, [state.pullRequestCards, pinTranscriptToBottom]);

  // The composer's background ledge: only on a session screen whose session
  // owns active work or holds a retained host (that is when the projection is
  // present), and memoized so the composer does not re-render for every
  // unrelated App render. Its rows are the registry topic's, which the open
  // flag subscribes (`activeTopics`).
  // Only running work earns the strip: a retained provider host with nothing
  // left in it is the runtime's bookkeeping, not the user's.
  const backgroundLedgeActivity =
    surface === "session" &&
    (sessionRow?.backgroundActivity?.activeCount ?? 0) > 0
      ? sessionRow?.backgroundActivity
      : undefined;
  // The session both composer ledges speak for: the one on screen.
  const ledgeSessionId = sessionRow?.id;
  const backgroundLedge = useMemo(
    () =>
      backgroundLedgeActivity && ledgeSessionId ? (
        <BackgroundWorkLedge
          sessionId={ledgeSessionId}
          activity={backgroundLedgeActivity}
          items={state.backgroundWorkItems}
          open={backgroundStrip.open}
          onToggle={backgroundStrip.onToggle}
          stopPending={backgroundStopPending}
          onStop={actions.stopBackgroundWork}
        />
      ) : undefined,
    [
      backgroundLedgeActivity,
      ledgeSessionId,
      state.backgroundWorkItems,
      backgroundStrip.open,
      backgroundStrip.onToggle,
      backgroundStopPending,
      actions.stopBackgroundWork,
    ],
  );
  // The composer's spawned-session ledge: the peers THIS session started, shaped
  // by the same projection the Sessions inbox uses. Derived from the session
  // list alone — no subscription, no server call — and absent (so the strip is
  // never mounted) for a session that spawned nothing, which is almost all of
  // them.
  const spawnedLedgeSettled =
    ledgeSessionId !== undefined && spawnedLedgeSettledFor === ledgeSessionId;
  const spawnedSessions = useMemo(
    () =>
      surface === "session" && ledgeSessionId
        ? spawnedSessionsView({
            sessions: sessions,
            coordinatorId: ledgeSessionId,
            includeSettled: spawnedLedgeSettled,
            workflowRuns: workflowRuns,
            workflowCards: workflowCards,
          })
        : undefined,
    [
      surface,
      ledgeSessionId,
      sessions,
      spawnedLedgeSettled,
      workflowRuns,
      workflowCards,
    ],
  );
  const toggleSpawnedSettled = useCallback(
    () =>
      setSpawnedLedgeSettledFor((current) =>
        current === ledgeSessionId ? null : (ledgeSessionId ?? null),
      ),
    [ledgeSessionId],
  );

  // Gated on what the strip DRAWS (`spawnedSessionsKey`), exactly as the
  // Backlog's session slice is: the projection above is rebuilt on every
  // rebroadcast, `Composer` is memoized, and a ledge node rebuilt with it would
  // re-render the whole card several times a second for a line whose text did
  // not change (`src/CLAUDE.md`). Whether the strip is OPEN is part of the key's
  // question, because it decides whether the peer rows are on screen at all.
  const spawnedLedgeKey = spawnedSessions
    ? spawnedSessionsKey(spawnedSessions, spawnedLedgeOpen)
    : "";
  // oxlint-disable-next-line react/exhaustive-deps -- `spawnedLedgeKey` IS the strip's visible content of `spawnedSessions` (`lib/sessionInbox.ts` enumerates it); depending on the projection would rebuild the ledge on every rebroadcast, which is the whole point of the gate
  const spawnedLedgeView = useMemo(() => spawnedSessions, [spawnedLedgeKey]);
  const spawnedLedge = useMemo(
    () =>
      spawnedLedgeView &&
      (spawnedLedgeView.counts.total > 0 ||
        spawnedLedgeView.settled > 0 ||
        spawnedLedgeView.stall) &&
      ledgeSessionId ? (
        <SpawnedSessionsLedge
          sessionId={ledgeSessionId}
          describeSession={describeSession}
          view={spawnedLedgeView}
          open={spawnedLedgeOpen}
          onToggle={toggleSpawnedLedge}
          onOpenSession={onOpenSession}
          onToggleSettled={toggleSpawnedSettled}
          onDismissSessionFailure={onDismissSessionFailure}
        />
      ) : undefined,
    [
      spawnedLedgeView,
      ledgeSessionId,
      spawnedLedgeOpen,
      toggleSpawnedLedge,
      onOpenSession,
      toggleSpawnedSettled,
      onDismissSessionFailure,
      describeSession,
    ],
  );
  // The composer's pending-approval strip: the cards the viewed session is
  // waiting on, read from its own approval state. Gated on what the strip
  // DRAWS, like the peers strip: `state.approvals` is rebuilt on every card
  // update and snapshot, and `Composer` is memoized.
  const pendingApprovals =
    surface === "session" &&
    ledgeSessionId &&
    state.session?.sessionId === ledgeSessionId
      ? pendingApprovalCards(state.approvals)
      : [];
  const pendingApprovalsLedgeKey = pendingApprovalsKey(pendingApprovals);
  const pendingApprovalsLedge = useMemo(
    () =>
      pendingApprovals.length > 0 ? (
        <PendingApprovalsLedge
          cards={pendingApprovals}
          onRevealApproval={actions.revealApproval}
        />
      ) : undefined,
    // oxlint-disable-next-line react/exhaustive-deps -- `pendingApprovalsLedgeKey` IS the strip's visible content of `pendingApprovals` (`lib/approvalCards.ts`); depending on the array would rebuild the strip on every snapshot
    [pendingApprovalsLedgeKey, actions.revealApproval],
  );
  const pendingQuestions =
    surface === "session" ? session?.pendingQuestions : undefined;
  const pendingQuestionsKey = pendingQuestionsLedgeKey(pendingQuestions ?? []);
  // The flow the user asked to see, while it is still pending: answering or
  // cancelling it elsewhere ends the jump.
  const [questionJump, setQuestionJump] = useState<string | null>(null);
  const jumpQuestion = questionJump
    ? pendingQuestions?.find((request) => request.requestId === questionJump)
    : undefined;
  const jumpQuestionSessionId = jumpQuestion?.sessionId;
  const questionEntryId = jumpQuestion
    ? pendingQuestionEntryId(
        messages,
        pendingQuestions,
        session?.answeredQuestions,
        jumpQuestion,
      )
    : undefined;
  const revealPendingQuestion = useCallback((requestId: string) => {
    setQuestionJump(requestId);
  }, []);
  useEffect(() => {
    if (!questionJump) return;
    if (!jumpQuestionSessionId) {
      setQuestionJump(null);
      return;
    }
    if (questionEntryId) {
      setMessageFocus((current) => ({
        sessionId: jumpQuestionSessionId,
        entryId: questionEntryId,
        token: Math.max(Date.now(), (current?.token ?? 0) + 1),
        align: "top",
      }));
      setQuestionJump(null);
    } else if (!hasOlderMessages) {
      // The whole transcript is loaded and holds no form for it.
      setQuestionJump(null);
    } else if (state.timelineRangePending === null) {
      actions.loadOlderTimeline();
    }
  }, [
    setMessageFocus,
    questionJump,
    jumpQuestionSessionId,
    questionEntryId,
    hasOlderMessages,
    state.timelineStart,
    state.timelineRangePending,
    actions,
  ]);
  const pendingQuestionLedge = useMemo(
    () =>
      pendingQuestions?.length ? (
        <PendingQuestionLedge
          questions={pendingQuestions}
          onRevealQuestion={revealPendingQuestion}
        />
      ) : undefined,
    // oxlint-disable-next-line react/exhaustive-deps -- `pendingQuestionsKey` IS the strip's visible content of `pendingQuestions`; depending on the array would rebuild the strip on every state broadcast
    [pendingQuestionsKey, revealPendingQuestion],
  );
  // The user's own queue (`promptQueue.ts`) belongs to an ordinary session on
  // screen; the permanent Assistant queues its intake on its own.
  const queueSessionId = surface === "session" ? session?.sessionId : undefined;
  const sendPromptQueue = actions.promptQueue;
  const shownPromptQueue = queueSessionId ? session?.promptQueue : undefined;
  // Alt+Enter queues a message AND steers it in at once, so it is seen in the
  // queue on its way. The server names the row, so the steer waits for the
  // queue update that brings a new row with exactly this text.
  const pendingSteerRef = useRef<{
    sessionId: string;
    text: string;
    knownIds: ReadonlySet<string>;
  } | null>(null);
  const shownPromptQueueRef = useRef(shownPromptQueue);
  shownPromptQueueRef.current = shownPromptQueue;
  // A queued message shows in the strip the moment it is sent ("Queuing…"),
  // not only once the server's queue update has made the round trip — which
  // on a busy server took seconds with nothing on screen. Matched like the
  // Alt+Enter steer: the first NEW row with exactly this text replaces it.
  const [queuingLocally, setQueuingLocally] = useState<
    {
      key: string;
      sessionId: string;
      text: string;
      knownIds: ReadonlySet<string>;
      at: number;
    }[]
  >([]);
  const queuePrompt = useMemo(
    () =>
      queueSessionId
        ? (item: {
            text: string;
            attachments?: PromptAttachment[];
            command?: { name: string; rawArgs: string };
            steerNow?: boolean;
          }) => {
            const { steerNow, ...queued } = item;
            const knownIds = new Set(
              (shownPromptQueueRef.current?.items ?? []).map((row) => row.id),
            );
            if (steerNow && !queued.command)
              pendingSteerRef.current = {
                sessionId: queueSessionId,
                text: queued.text,
                knownIds,
              };
            setQueuingLocally((current) => [
              ...current,
              {
                key: createClientId(),
                sessionId: queueSessionId,
                text: queued.text,
                knownIds,
                at: Date.now(),
              },
            ]);
            sendPromptQueue({
              type: "queuePrompt",
              sessionId: queueSessionId,
              ...queued,
            });
          }
        : undefined,
    [queueSessionId, sendPromptQueue],
  );
  // Retire an optimistic row once the server's queue carries it, and give up
  // on one the server never confirmed after a while.
  useEffect(() => {
    setQueuingLocally((current) => {
      if (current.length === 0) return current;
      const items = shownPromptQueue?.items ?? [];
      const now = Date.now();
      const next = current.filter(
        (local) =>
          now - local.at < 20_000 &&
          !items.some(
            (item) => !local.knownIds.has(item.id) && item.text === local.text,
          ),
      );
      return next.length === current.length ? current : next;
    });
  }, [shownPromptQueue]);
  useEffect(() => {
    if (queuingLocally.length === 0) return;
    const timer = window.setTimeout(
      () =>
        setQueuingLocally((current) =>
          current.filter((local) => Date.now() - local.at < 20_000),
        ),
      20_000,
    );
    return () => window.clearTimeout(timer);
  }, [queuingLocally]);
  const shownQueuingLocally = useMemo(
    () =>
      queuingLocally
        .filter((local) => local.sessionId === queueSessionId)
        .map(({ key, text }) => ({ key, text })),
    [queuingLocally, queueSessionId],
  );
  useEffect(() => {
    const pending = pendingSteerRef.current;
    if (!pending || !shownPromptQueue) return;
    if (pending.sessionId !== queueSessionId) {
      pendingSteerRef.current = null;
      return;
    }
    const row = shownPromptQueue.items.find(
      (item) => !pending.knownIds.has(item.id) && item.text === pending.text,
    );
    if (!row) return;
    pendingSteerRef.current = null;
    sendPromptQueue({
      type: "sendQueuedPromptNow",
      sessionId: pending.sessionId,
      id: row.id,
    });
  }, [shownPromptQueue, queueSessionId, sendPromptQueue]);
  const shownQueuedPeers = queueSessionId
    ? session?.queuedPeerPrompts
    : undefined;
  const sessionCanSteer = Boolean(session?.canSteer);
  const shownBackgroundUpdates = session?.queuedBackgroundUpdates ?? 0;
  const shownUnhandledBackground = session?.unhandledBackgroundUpdates ?? 0;
  // The exact updates Recover and Dismiss act on: what the user was shown.
  const shownUnhandledBatch =
    session?.unhandledBackgroundBatch ?? EMPTY_UNHANDLED_BATCH;
  const unhandledSessionId =
    shownUnhandledBackground > 0 ? session?.sessionId : undefined;
  // The permanent Assistant queues its intake on its own and shows no drafts,
  // but a Stop holds it like any session: it gets the hold's Resume alone, and
  // the Recover of updates a turn did not finish.
  const assistantHeld = Boolean(session?.promptQueue?.automaticTurnsHeld);
  const heldAssistantSessionId =
    surface === "assistant" && (assistantHeld || shownUnhandledBackground > 0)
      ? session?.sessionId
      : undefined;
  const promptQueueLedge = useMemo(
    () =>
      heldAssistantSessionId ? (
        <PromptQueueLedge
          queue={assistantHeld ? HELD_ASSISTANT_QUEUE : EMPTY_PROMPT_QUEUE}
          backgroundUpdates={shownBackgroundUpdates}
          unhandledBackgroundUpdates={shownUnhandledBackground}
          onRecoverBackground={() =>
            sendPromptQueue({
              type: "recoverBackgroundUpdates",
              sessionId: heldAssistantSessionId,
              items: shownUnhandledBatch,
            })
          }
          onDismissBackground={() =>
            sendPromptQueue({
              type: "dismissBackgroundUpdates",
              sessionId: heldAssistantSessionId,
              items: shownUnhandledBatch,
            })
          }
          running={streaming}
          canSteer={false}
          onRemove={noop}
          onSendNow={noop}
          onResume={() =>
            sendPromptQueue({
              type: "resumePromptQueue",
              sessionId: heldAssistantSessionId,
            })
          }
        />
      ) : (shownPromptQueue ||
          shownQueuingLocally.length > 0 ||
          (shownQueuedPeers?.length ?? 0) > 0 ||
          unhandledSessionId) &&
        queueSessionId ? (
        <PromptQueueLedge
          queue={shownPromptQueue ?? EMPTY_PROMPT_QUEUE}
          queuing={shownQueuingLocally}
          peers={shownQueuedPeers}
          backgroundUpdates={shownBackgroundUpdates}
          unhandledBackgroundUpdates={shownUnhandledBackground}
          onRecoverBackground={() =>
            sendPromptQueue({
              type: "recoverBackgroundUpdates",
              sessionId: queueSessionId,
              items: shownUnhandledBatch,
            })
          }
          onDismissBackground={() =>
            sendPromptQueue({
              type: "dismissBackgroundUpdates",
              sessionId: queueSessionId,
              items: shownUnhandledBatch,
            })
          }
          running={streaming}
          canSteer={sessionCanSteer}
          onRemove={(id) =>
            sendPromptQueue({
              type: "removeQueuedPrompt",
              sessionId: queueSessionId,
              id,
            })
          }
          onSendNow={(id) =>
            sendPromptQueue({
              type: "sendQueuedPromptNow",
              sessionId: queueSessionId,
              id,
            })
          }
          onResume={() =>
            sendPromptQueue({
              type: "resumePromptQueue",
              sessionId: queueSessionId,
            })
          }
          onSendPeerNow={(id) =>
            sendPromptQueue({
              type: "sendQueuedPeerPromptNow",
              sessionId: queueSessionId,
              id,
            })
          }
          onWithdrawPeer={(id) =>
            sendPromptQueue({
              type: "withdrawQueuedPeerPrompt",
              sessionId: queueSessionId,
              id,
            })
          }
          onOpenSession={onOpenSession}
        />
      ) : undefined,
    [
      heldAssistantSessionId,
      assistantHeld,
      shownPromptQueue,
      shownQueuingLocally,
      shownQueuedPeers,
      shownBackgroundUpdates,
      shownUnhandledBackground,
      shownUnhandledBatch,
      unhandledSessionId,
      onOpenSession,
      queueSessionId,
      streaming,
      sessionCanSteer,
      sendPromptQueue,
    ],
  );
  // The comments riding with the next prompt, as a strip of their own.
  const pendingComments = chatComments.comments;
  const pendingCommentItems = useMemo<CommentLedgeItem[]>(
    () =>
      pendingComments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        source:
          comment.anchor.kind === "document"
            ? commentDocumentLabel(comment.anchor.document)
            : undefined,
        quote: comment.quote,
        wholeDocument: comment.quote === undefined,
      })),
    [pendingComments],
  );
  const revealPendingComment = useCallback(
    (id: string) => {
      const comment = pendingComments.find((item) => item.id === id);
      if (comment) revealChatComment(comment);
    },
    [pendingComments, revealChatComment],
  );
  const pendingCommentsLedge = useMemo(
    () =>
      pendingCommentItems.length > 0 ? (
        <PendingCommentsLedge
          items={pendingCommentItems}
          activeCommentId={chatComments.activeCommentId}
          onSelect={chatComments.select}
          onRemove={chatComments.remove}
          onClear={chatComments.clear}
          onReveal={revealPendingComment}
        />
      ) : undefined,
    [
      pendingCommentItems,
      chatComments.activeCommentId,
      chatComments.select,
      chatComments.remove,
      chatComments.clear,
      revealPendingComment,
    ],
  );

  // One shelf, up to five strips on it: what waits on the user on top, then
  // the peers, background work, and on the edge nearest the field what the
  // user wrote that is still to go — the queue, then the comments that ride
  // with the next prompt.
  const composerLedge = useMemo(
    () =>
      pendingQuestionLedge ||
      pendingApprovalsLedge ||
      spawnedLedge ||
      backgroundLedge ||
      promptQueueLedge ||
      stagedLedges ||
      pendingCommentsLedge ? (
        <>
          {pendingQuestionLedge}
          {pendingApprovalsLedge}
          {spawnedLedge}
          {backgroundLedge}
          {promptQueueLedge}
          {stagedLedges}
          {pendingCommentsLedge}
        </>
      ) : undefined,
    [
      pendingQuestionLedge,
      pendingApprovalsLedge,
      spawnedLedge,
      backgroundLedge,
      promptQueueLedge,
      stagedLedges,
      pendingCommentsLedge,
    ],
  );

  // The composer's `/<skill>` rows read the library scan, which every
  // subscribe and rescan answers afresh: hand it a new array only when what
  // the rows show changed.
  const skillSummariesCache = useRef<{
    key: string;
    value: EntrySummary[] | undefined;
  }>({ key: "", value: undefined });
  const skillEntries = dataOf(state.skillLibrary)?.entries;
  const skillEntriesKey = skillEntries ? skillSummariesKey(skillEntries) : "";
  if (skillSummariesCache.current.key !== skillEntriesKey)
    skillSummariesCache.current = {
      key: skillEntriesKey,
      value: skillEntries,
    };

  const worktreeMissing = Boolean(session?.worktreeMissing);
  const sendToSession = useCallback(
    (text: string, attachments: PromptAttachment[] = []) => {
      if (worktreeMissing) return;
      pinTranscriptToBottom();
      actions.prompt(text, attachments);
    },
    [actions, pinTranscriptToBottom, worktreeMissing],
  );
  const runClientSlashCommand = useCallback(
    (name: string, rawArgs: string): string | null => {
      if (name === "review" && onReviewCommand) return onReviewCommand(rawArgs);
      if (name === "rename") {
        // Only "is there a session" is decided here: the loaded transcript is a
        // window that may open mid-turn with no user row, so whether there is a
        // conversation to name is the server's call, made from the whole log.
        if (!sessionId) return "/rename needs an existing session.";
        actions.regenerateSessionTitle(sessionId, rawArgs);
        return null;
      }
      return `/${name} is not available here.`;
    },
    [actions, sessionId, onReviewCommand],
  );
  // Live peer-prompt card lifecycle patches (Task 90/89 in-place reconciliation)
  // overlaid onto the rendered messages regardless of their source above.
  const transcriptMessages = useMemo(
    () =>
      applyPeerPromptCardOverridesToMessages(
        messages,
        state.peerPromptCardOverrides,
      ),
    [messages, state.peerPromptCardOverrides],
  );
  // Only the list that belongs to the session on screen. The transcript gets
  // the OWN grants alone; what it inherits is for the inspector.
  const approvalGrants =
    state.approvalGrants?.sessionId === sessionId
      ? state.approvalGrants?.grants
      : undefined;
  // A failure that names the session currently in view. It has a home on
  // screen, so it is rendered there (above the composer) and NOT announced in
  // passing — the doc's first question, applied to the object with the most
  // failures by far.
  const failure = failureShownElsewhere
    ? null // the unavailable panel already says it, in the transcript's place
    : failureOnViewedSession(state.sessionFailures, sessionId);

  return {
    sessionId,
    commentSelection: chatCommentSelection,
    queuePrompt,
    sessionCanSteer,
    worktreeMissing,
    onAcknowledgeMissingWorktree: acknowledgeMissingWorktree,
    hopRefusal: sessionRow?.peerPromptHopRefusal
      ? peerPromptHopRefusalMessage(sessionRow.peerPromptHopRefusal)
      : null,
    failure,
    onDismissFailure: () => {
      if (sessionId) actions.clearChatError(sessionId);
    },
    taskLiveSource: host.taskLiveSource,
    composer: {
      onSend: onSend ?? sendToSession,
      ...(queuePrompt ? { onQueue: queuePrompt } : {}),
      onAbort: abortRun,
      streaming,
      // A dead worktree edge disables the whole composer, not just Send: the
      // banner above it owns the one action that unblocks the session.
      disabled: !state.connected || worktreeMissing,
      contextInfo:
        state.contextInfo?.sessionId === sessionId ? state.contextInfo : null,
      session,
      models,
      slashCommands: state.slashCommands,
      onClientSlashCommand: runClientSlashCommand,
      skillSummaries: skillSummariesCache.current.value,
      actions,
      draftStorageKey,
      chatComments,
      commentDraft: chatCommentDraft,
      onCommentDraftChange: setChatCommentDraft,
      draft: stagedDraft ?? forkDraft,
      onDraftConsumed: retireStagedDraft,
      hideRuntimeControls: surface === "assistant",
      ledge: composerLedge,
      dictation,
      conversation: composerConversation,
    },
    transcript: {
      sessionId,
      messages: transcriptMessages,
      timeline: state.timeline,
      chatComments,
      commentDraft: chatCommentDraft,
      onCommentDraftChange: setChatCommentDraft,
      onCommentSelectionChange: onChatCommentSelectionChange,
      sessionStreaming: streaming,
      runProgress: state.runProgress,
      queuedPeerCount: session?.queuedPeerPrompts?.length ?? 0,
      queuedBackgroundCount: session?.queuedBackgroundUpdates ?? 0,
      promptQueueStates: state.promptQueueStates,
      appearance: state.settings.appearance,
      sessionCanSteer,
      sessions,
      view: host.view,
      models,
      onAcceptCommitDryRun: actions.acceptCommitDryRun,
      ...(canCreateDrafts
        ? { onCreateDraftSession: actions.createDraftSession }
        : {}),
      defaultModel: session?.model,
      defaultThinkingLevel: session?.thinkingLevel,
      onForkMessage: forkMessage,
      onResendPrompt: resendPrompt,
      onOpenSession,
      onOpenTask: host.onOpenTask,
      onOpenBackgroundWork: host.onOpenBackgroundWork,
      onOpenWorktree: host.onOpenWorktree,
      onApplyTaskStatusSuggestion: applyTaskStatusSuggestion,
      onResolveApproval: actions.resolveApproval,
      approvalGrants,
      onRevokeApprovalGrant: actions.revokeApprovalGrant,
      accountModels: host.accountModels,
      onChoosePullRequestTask: actions.choosePullRequestTask,
      onPullRequestCardAction: runPullRequestCardAction,
      pendingQuestions: session?.pendingQuestions,
      answeredQuestions: session?.answeredQuestions,
      onRespondToQuestion: respondToQuestion,
      onLoadTimelineBlock: actions.loadTimelineBlock,
      onLiveBodyDemand: actions.setLiveBodyDemand,
      hasOlderMessages,
      loadingOlderMessages: state.timelineRangePending !== null,
      onLoadOlderMessages: actions.loadOlderTimeline,
      focusEntry: focus.transcriptFocusEntry,
      onFocusEntryApplied: focus.retireMessageFocus,
      pinToBottomToken: transcriptPin.token,
    },
  };
}

export type SessionChatModel = ReturnType<typeof useSessionChat>;
