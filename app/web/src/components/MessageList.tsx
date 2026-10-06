import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BookOpen,
  Bot,
  Check,
  ClipboardList,
  Copy,
  CornerDownRight,
  FileText,
  FolderKanban,
  Ellipsis,
  GitFork,
  Image as ImageIcon,
  MessageSquarePlus,
  RotateCcw,
} from "lucide-react";
import type {
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentType,
  AnsweredAgentQuestion,
  AppearanceSettings,
  DisplayAttachment,
  DisplayMessage,
  ModelOption,
  SessionListItem,
  TaskStatus,
  ThinkingLevel,
} from "@assistant/shared";
import type { LazyBlockKind, LiveBodyKey } from "@assistant/shared/session";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";
import { peerPromptCardOf } from "@assistant/shared/toolCards";
import {
  AssistantMessage,
  canRenderAssistantMessage,
  type ChatToolCommentTarget,
} from "./AssistantMessage.tsx";
import type { TranscriptViewPrefs } from "./transcriptView.ts";
import { TurnStatsRow } from "./TurnStatsRow.tsx";
import {
  accumulateTurnStats,
  EMPTY_TURN_STATS_SEED,
  finalResponseBoundary,
  type SessionTotals,
  type Turn,
  type TurnStatsSeed,
} from "@assistant/shared/turnStats";
import { PeerPromptCardView } from "./PeerPromptCard.tsx";
import { BackgroundWorkPromptCard } from "./BackgroundWorkPromptCard.tsx";
import { Spinner } from "./ui/load.tsx";
import { ChatActivityRow } from "./ChatActivityRow.tsx";
import { activityPreview } from "../lib/activityPreview.ts";
import { ProgressIndicator } from "./ProgressIndicator.tsx";
import {
  Markdown,
  type MarkdownFileReference,
  type MarkdownPaObjectReference,
  type MarkdownSessionReference,
} from "./Markdown.tsx";
import { copyWithToast } from "../lib/clipboard.ts";
import { transcriptWindowStart } from "../lib/transcriptWindow.ts";
import { transcriptTailKey } from "../lib/transcriptScroll.ts";
import { pointAt, rangeFromOffsets } from "../lib/textRanges.ts";
import {
  isTranscriptComment,
  type PendingTranscriptComment,
} from "../lib/chatCommentPrompt.ts";
import { sessionReferenceKey } from "../lib/transcriptKeys.ts";
import { mentionedSessionIds } from "../lib/transcriptMentions.ts";
import { isTransientMessageId } from "../lib/sessionPreview.ts";
import type { PromptQueueState } from "../hooks/useAssistant.ts";
import { useTranscriptScroll } from "../hooks/useTranscriptScroll.ts";
import { usePerfRenderCount } from "../lib/perfStats.ts";
import { serverHttpOrigin, withToken } from "../lib/serverOrigin.ts";
import { bundleFromOffsets, describeAnchor } from "../lib/describeAnchor.ts";
import {
  useSelectionAnchor,
  type CapturedSelection,
} from "../hooks/useSelectionAnchor.ts";
import type {
  NewPendingChatComment,
  PendingChatCommentsController,
} from "../hooks/usePendingChatComments.ts";
import { Popover } from "./Popover.tsx";

const CHAT_COMMENT_HIGHLIGHT = "pending-chat-comment";
/**
 * `anchor` is this transcript's own name (`useSelectionAnchor`): a held anchor
 * outlives the selection that made it, and this transcript can be mounted
 * beside another one (the Personal Assistant panel), so the two must not paint
 * and delete under one shared name.
 */
function chatCommentHighlightStyle(anchor: string): string {
  return `
  /* The composer-owned anchor; live selections use only the browser's paint. */
  ::highlight(${anchor}) {
    color: inherit;
    background-color: color-mix(in oklab, var(--accent) 32%, transparent);
  }
  ::highlight(${CHAT_COMMENT_HIGHLIGHT}) {
    color: inherit;
    background-color: color-mix(in oklab, #f5c518 34%, transparent);
  }
`;
}

function highlightsSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

function chatTargetAt(
  node: Node | null,
  root: HTMLElement,
): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node?.parentElement;
  const target = element?.closest<HTMLElement>("[data-chat-comment-target]");
  return target && root.contains(target) ? target : null;
}

function chatTargetAtPosition(
  position: number,
  root: HTMLElement,
): HTMLElement | null {
  const targets = Array.from(
    root.querySelectorAll<HTMLElement>("[data-chat-comment-target]"),
  );
  for (const target of targets) {
    const before = target.ownerDocument.createRange();
    before.setStart(root, 0);
    before.setEndBefore(target);
    const start = before.toString().length;
    const end = start + (target.textContent?.length ?? 0);
    if (position >= start && position <= end) return target;
  }
  return null;
}

export interface ToolTargetProjection {
  targetsByMessage: Map<string, ReadonlyMap<number, ChatToolCommentTarget>>;
}

/** Derive rendered tool bodies back to the tool-result entries they came from. */
export function chatToolCommentTargets(
  timeline: readonly ClientTimelineEntry[],
): ToolTargetProjection {
  const calls = new Map<
    string,
    { messageId: string; displayBlockIndex: number }
  >();
  const mutableTargets = new Map<string, Map<number, ChatToolCommentTarget>>();
  for (const entry of timeline) {
    if (entry.type !== "message") continue;
    if (entry.role === "assistant") {
      entry.content.forEach((block, blockIndex) => {
        if (block.type === "toolCall")
          calls.set(block.toolCallId, {
            messageId: entry.id,
            displayBlockIndex: blockIndex,
          });
      });
      continue;
    }
    if (entry.role !== "toolResult") continue;
    const owner = calls.get(entry.toolCallId);
    const blockIndex = entry.content.findIndex(
      (block) => block.type === "text",
    );
    if (!owner || blockIndex < 0) continue;
    const targets = mutableTargets.get(owner.messageId) ?? new Map();
    targets.set(owner.displayBlockIndex, { entryId: entry.id, blockIndex });
    mutableTargets.set(owner.messageId, targets);
  }
  return { targetsByMessage: mutableTargets };
}

function sameToolTargets(
  a: ReadonlyMap<number, ChatToolCommentTarget>,
  b: ReadonlyMap<number, ChatToolCommentTarget>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [blockIndex, target] of a) {
    const other = b.get(blockIndex);
    if (
      !other ||
      other.entryId !== target.entryId ||
      other.blockIndex !== target.blockIndex
    )
      return false;
  }
  return true;
}

/** Preserve row-level map identities when an unrelated timeline entry arrives. */
export function reuseStableChatToolTargets(
  next: ToolTargetProjection,
  previous: ToolTargetProjection | null,
): ToolTargetProjection {
  if (!previous) return next;
  for (const [messageId, targets] of next.targetsByMessage) {
    const held = previous.targetsByMessage.get(messageId);
    if (held && sameToolTargets(held, targets))
      next.targetsByMessage.set(messageId, held);
  }
  return next;
}

export interface TurnEndEntry {
  turn: Turn;
  cumulative: SessionTotals;
  contextDelta: number;
  showSessionCumulative: boolean;
}

function sameTotals(a: SessionTotals, b: SessionTotals): boolean {
  return (
    a === b ||
    (a.input === b.input &&
      a.output === b.output &&
      a.cacheRead === b.cacheRead &&
      a.cacheWrite === b.cacheWrite &&
      a.cost === b.cost)
  );
}

function sameMessageList(
  a: readonly DisplayMessage[],
  b: readonly DisplayMessage[],
): boolean {
  return a === b || (a.length === b.length && a.every((m, i) => m === b[i]));
}

function sameTurnEnd(a: TurnEndEntry, b: TurnEndEntry): boolean {
  return (
    a.contextDelta === b.contextDelta &&
    a.showSessionCumulative === b.showSessionCumulative &&
    sameTotals(a.cumulative, b.cumulative) &&
    a.turn.complete === b.turn.complete &&
    a.turn.lastAssistantId === b.turn.lastAssistantId &&
    sameMessageList(a.turn.messages, b.turn.messages) &&
    sameMessageList(a.turn.assistantMessages, b.turn.assistantMessages)
  );
}

/**
 * The same trick for the per-turn stats rows.
 *
 * `accumulateTurnStats` walks the WHOLE message list, so one streamed token
 * rebuilds a `Turn` object for every completed turn behind it — objects whose
 * content is identical (their messages are the same projected objects) but whose
 * identity is new, which re-renders every stats row in the transcript several
 * times a second. Handing back the previous entry when nothing in it moved is
 * what lets `TurnStatsRow`'s memo hold.
 */
export function reuseStableTurnEnds(
  next: Map<string, TurnEndEntry>,
  previous: Map<string, TurnEndEntry> | null,
): Map<string, TurnEndEntry> {
  if (!previous) return next;
  for (const [messageId, entry] of next) {
    const held = previous.get(messageId);
    if (held && sameTurnEnd(held, entry)) next.set(messageId, held);
  }
  return next;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function AttachmentChip({
  attachment,
  onOpenTask,
}: {
  attachment: DisplayAttachment;
  onOpenTask?: ((taskId: string) => void) | undefined;
}) {
  // A Task attached to the session's first prompt renders as a compact, navigable
  // chip rather than a file block (the full Task rode along hidden for the model).
  if (attachment.role === "task-context") {
    const taskId = attachment.id.startsWith("taskctx-")
      ? attachment.id.slice("taskctx-".length)
      : undefined;
    const inner = (
      <>
        <ClipboardList size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 overflow-hidden truncate font-medium">
          {attachment.name}
        </span>
      </>
    );
    const cls =
      "mt-2 flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border border-accent/30 bg-accent-soft px-2.5 py-1.5 text-caption text-accent";
    return taskId && onOpenTask ? (
      <button
        type="button"
        onClick={() => onOpenTask(taskId)}
        className={`${cls} hover:bg-accent/15`}
        title="Open task details"
      >
        {inner}
      </button>
    ) : (
      <div className={cls}>{inner}</div>
    );
  }
  if (attachment.role === "project-context") {
    return (
      <div
        className="mt-2 flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border border-line bg-raised/60 px-2.5 py-1.5 text-caption text-muted"
        title="Project context was attached to this first prompt."
      >
        <FolderKanban size={13} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 overflow-hidden truncate font-medium">
          {attachment.name}
        </span>
      </div>
    );
  }
  if (attachment.role === "knowledge-context") {
    return (
      <div
        className="mt-2 flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border border-line bg-raised/60 px-2.5 py-1.5 text-caption text-muted"
        title="Knowledge entry context was attached to this first prompt."
      >
        <BookOpen size={13} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 overflow-hidden truncate font-medium">
          {attachment.name}
        </span>
      </div>
    );
  }
  const isImage =
    attachment.mimeType.startsWith("image/") &&
    (attachment.data || attachment.url);
  const imageSrc = attachment.data
    ? `data:${attachment.mimeType};base64,${attachment.data}`
    : attachment.url
      ? withToken(`${serverHttpOrigin()}${attachment.url}`)
      : undefined;
  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-line bg-raised/60">
      {isImage && imageSrc ? (
        <img
          src={imageSrc}
          alt={attachment.name}
          className="max-h-72 max-w-full object-contain"
        />
      ) : null}
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-caption text-muted">
        {attachment.mimeType.startsWith("image/") ? (
          <ImageIcon size={14} className="text-accent" />
        ) : (
          <FileText size={14} className="text-accent" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-fg">
          {attachment.name}
        </span>
        <span className="shrink-0 text-faint">
          {formatBytes(attachment.size)}
        </span>
      </div>
    </div>
  );
}

function messagePlainText(message: DisplayMessage): string {
  const origin = message.promptOrigin;
  if (
    origin?.kind === "system" &&
    origin.presentation?.kind === "background-work"
  ) {
    // Copy the browser presentation, never the model-only delivery envelope.
    return origin.presentation.updates
      .map((update) =>
        [
          ...new Set(
            [
              update.label,
              update.status,
              update.command,
              update.outcomeSummary,
            ].filter(Boolean),
          ),
        ].join("\n"),
      )
      .join("\n\n");
  }
  return message.blocks
    .map((b) =>
      b.kind === "text"
        ? b.text
        : b.kind === "peerPrompt"
          ? b.peerPrompt.message
          : "",
    )
    .filter(Boolean)
    .join("\n");
}

interface MessageActionsProps {
  message: DisplayMessage;
  align: "left" | "right";
  onForkMessage?:
    ((entryId: string, position: "before" | "at") => void) | undefined;
  onCommentMessage?: ((messageId: string) => void) | undefined;
  onResendPrompt?: ((text: string) => void) | undefined;
}

/**
 * @component MessageActionsBar
 * @purpose Compact icon-only action row shown underneath chat messages.
 * @useWhen Adding per-message actions such as copy, fork, retry, label, or export.
 * @avoidWhen The action belongs to a specific rich card/tool payload; keep those controls inside that card.
 * @intent Low-emphasis, below-message controls with accessible labels; never overlay message content.
 */
function MessageActionsBar({
  message,
  align,
  onForkMessage,
  onCommentMessage,
  onResendPrompt,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const text = messagePlainText(message);
  const forkEntryId =
    message.role === "user" ? message.forkBeforeEntryId : message.forkAtEntryId;
  const forkPosition = message.role === "user" ? "before" : "at";
  const forkTitle =
    message.role === "user" ? "Fork and edit prompt" : "Fork from here";
  const canCopy = Boolean(text && !message.streaming);
  // Only offer actions on messages with real answer text. A tool-only (or
  // thinking-only) assistant turn has no text, so it shows no action row — like
  // thinking output — avoiding a fork icon popping in below tool calls after the
  // turn completes (which shifted the layout).
  const canFork = Boolean(
    text && forkEntryId && onForkMessage && !message.streaming,
  );

  const copy = async () => {
    if (!text) return;
    const ok = await copyWithToast(text);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const canComment = Boolean(onCommentMessage && message.id !== "live");
  // Replay sends the text as a new turn in this session. Prompts with files
  // cannot be replayed: silently dropping their attachments would change the
  // request. Agent/system prompts are likewise not human actions to repeat.
  const origin = message.promptOrigin;
  const canResend = Boolean(
    text &&
    onResendPrompt &&
    message.role === "user" &&
    (!origin || origin.kind === "human") &&
    !message.blocks.some((b) => b.kind === "attachment") &&
    !message.streaming,
  );

  if (!canCopy && !canFork && !canComment && !canResend) return null;

  return (
    <div
      className={`mt-1 flex ${align === "right" ? "justify-end" : "justify-start"}`}
    >
      <div className="flex items-center gap-0.5 rounded-lg text-faint opacity-70 transition-opacity group-hover/message:opacity-100">
        {canCopy && (
          <button
            type="button"
            onClick={() => void copy()}
            title={copied ? "Copied" : "Copy message text"}
            aria-label={copied ? "Copied" : "Copy message text"}
            className="inline-flex size-7 items-center justify-center rounded-lg transition-colors hover:bg-raised hover:text-fg"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
        {canResend && text && (
          <button
            type="button"
            onClick={() => onResendPrompt?.(text)}
            title="Replay prompt in this session"
            aria-label="Replay prompt"
            className="inline-flex size-7 items-center justify-center rounded-lg transition-colors hover:bg-raised hover:text-accent"
          >
            <RotateCcw size={13} />
          </button>
        )}
        {canFork && forkEntryId && (
          <button
            type="button"
            onClick={() => onForkMessage?.(forkEntryId, forkPosition)}
            title={forkTitle}
            aria-label={forkTitle}
            className="inline-flex size-7 items-center justify-center rounded-lg transition-colors hover:bg-raised hover:text-accent"
          >
            <GitFork size={13} />
          </button>
        )}
        {canComment ? (
          <Popover
            align={align === "right" ? "right" : "left"}
            placement="top"
            title="More message actions"
            className="inline-flex size-7 items-center justify-center rounded-lg transition-colors hover:bg-raised hover:text-fg"
            button={<Ellipsis size={14} />}
          >
            {(close) => (
              <button
                type="button"
                onClick={() => {
                  close();
                  onCommentMessage?.(message.id);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-caption text-fg hover:bg-raised"
              >
                <MessageSquarePlus size={14} className="text-accent" />
                Comment on this message
              </button>
            )}
          </Popover>
        ) : null}
      </div>
    </div>
  );
}

const UserMessage = memo(function UserMessage({
  message,
  sessionReferences,
  changedFiles,
  paObjectReferences,
  onOpenSession,
  onOpenChangedFile,
  onOpenPaObject,
  onOpenTask,
  onOpenBackgroundWork,
  onForkMessage,
  onCommentMessage,
  onResendPrompt,
  chatCommentable,
  promptQueueState,
}: {
  message: DisplayMessage;
  sessionReferences: MarkdownSessionReference[];
  changedFiles: MarkdownFileReference[];
  paObjectReferences: MarkdownPaObjectReference[];
  onOpenSession?: ((id: string) => void) | undefined;
  onOpenChangedFile?: ((path: string) => void) | undefined;
  onOpenPaObject?: ((link: MarkdownPaObjectReference) => void) | undefined;
  onOpenTask?: ((taskId: string) => void) | undefined;
  onOpenBackgroundWork?: ((taskId: string) => void) | undefined;
  onForkMessage?: MessageActionsProps["onForkMessage"];
  onCommentMessage?: MessageActionsProps["onCommentMessage"];
  onResendPrompt?: MessageActionsProps["onResendPrompt"];
  chatCommentable: boolean;
  promptQueueState?: PromptQueueState | undefined;
}) {
  const origin = message.promptOrigin;
  const isHumanPrompt = !origin || origin.kind === "human";
  const originLabel = promptOriginLabel(origin);
  const peerPromptBlock = message.blocks.find((b) => b.kind === "peerPrompt");
  const backgroundWorkPresentation =
    origin?.kind === "system" && origin.presentation?.kind === "background-work"
      ? origin.presentation
      : undefined;
  if (backgroundWorkPresentation) {
    return (
      <div className="group/message min-w-0">
        <BackgroundWorkPromptCard
          presentation={backgroundWorkPresentation}
          onOpenBackgroundWork={onOpenBackgroundWork}
          actions={
            <MessageActionsBar
              message={message}
              align="left"
              onForkMessage={onForkMessage}
            />
          }
        />
      </div>
    );
  }
  if (peerPromptBlock && peerPromptBlock.kind === "peerPrompt") {
    return (
      <div className="group/message min-w-0">
        <PeerPromptCardView
          card={peerPromptBlock.peerPrompt}
          onOpenSession={onOpenSession}
          actions={
            <MessageActionsBar
              message={message}
              align="left"
              onForkMessage={onForkMessage}
            />
          }
        />
      </div>
    );
  }
  const body = message.blocks.map((block, blockIndex) => {
    if (block.kind === "text")
      return (
        <div
          key={blockIndex}
          {...(chatCommentable
            ? {
                "data-chat-comment-target": "",
                "data-chat-entry-id": message.id,
                "data-chat-block-index": blockIndex,
                "data-chat-render-block-index": blockIndex,
              }
            : {})}
        >
          <Markdown
            text={block.text}
            sessionReferences={sessionReferences}
            changedFiles={changedFiles}
            paObjectReferences={paObjectReferences}
            onOpenSession={onOpenSession}
            onOpenChangedFile={onOpenChangedFile}
            onOpenPaObject={onOpenPaObject}
          />
        </div>
      );
    if (block.kind === "attachment")
      return (
        <AttachmentChip
          key={block.attachment.id}
          attachment={block.attachment}
          onOpenTask={onOpenTask}
        />
      );
    return null;
  });
  const actions = (
    <MessageActionsBar
      message={message}
      align={isHumanPrompt ? "right" : "left"}
      onForkMessage={onForkMessage}
      onCommentMessage={onCommentMessage}
      onResendPrompt={onResendPrompt}
    />
  );
  if (!isHumanPrompt) {
    const preview =
      activityPreview(messagePlainText(message)) ||
      (message.blocks.some((block) => block.kind === "attachment")
        ? "Attachments"
        : "No message text");
    return (
      <div className="group/message min-w-0">
        <ChatActivityRow icon={Bot} title={originLabel} preview={preview}>
          <p className="mb-2 break-words text-caption text-muted">
            {originLabel}
          </p>
          {message.promptDelivery ? (
            <PromptDeliveryNote delivery={message.promptDelivery} />
          ) : null}
          {body}
          {actions}
        </ChatActivityRow>
        {promptQueueState ? (
          <PromptQueueCondition state={promptQueueState} />
        ) : null}
      </div>
    );
  }
  return (
    <div className="group/message flex flex-col items-end">
      {message.promptDelivery ? (
        <PromptDeliveryNote delivery={message.promptDelivery} />
      ) : null}
      <div className="min-w-0 max-w-[80%] rounded-2xl rounded-br-md bg-user px-3.5 py-2 text-body text-fg">
        {body}
      </div>
      {promptQueueState ? (
        <PromptQueueCondition state={promptQueueState} />
      ) : null}
      {actions}
    </div>
  );
});

/**
 * What a prompt waiting in the permanent Assistant's queue is DOING, said on
 * the prompt itself.
 *
 * A condition, so it is a quiet label under its own row rather than anything
 * announced (`docs/messaging.md`) — it is replaced by the next state and ends
 * when the durable entry lands, from which point the transcript's own run
 * indicator is what says the Assistant is working.
 */
const PROMPT_QUEUE_LABEL: Record<PromptQueueState, string> = {
  queued: "Queued",
  working: "Working",
};

function PromptQueueCondition({ state }: { state: PromptQueueState }) {
  return (
    <div className="mr-1 mt-1 flex items-center gap-1.5 text-caption text-muted">
      <Spinner size="xs" />
      <span>{PROMPT_QUEUE_LABEL[state]}</span>
    </div>
  );
}

/**
 * The fork boundary: everything ABOVE was written in the parent session and
 * copied here, everything below belongs to this one. Deliberately quiet — one
 * rule with a label, not a badge on every inherited row — and the label opens
 * the parent at the message this session was cut from.
 */
const ForkBoundaryMarker = memo(function ForkBoundaryMarker({
  parentTitle,
  onOpen,
}: {
  parentTitle: string;
  onOpen: () => void;
}) {
  return (
    <div data-fork-boundary className="flex items-center gap-2">
      <hr className="flex-1 border-line/60" />
      <button
        type="button"
        onClick={onOpen}
        title="Open the message this session was forked from"
        className="flex min-w-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-caption text-muted transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <GitFork size={12} className="shrink-0" />
        <span className="truncate">Forked from {parentTitle}</span>
      </button>
      <hr className="flex-1 border-line/60" />
    </div>
  );
});

/**
 * What happened to a message sent while a turn was running. A steer is marked
 * where the turn read it; a follow-up says it came after the reply, so the
 * transcript never implies the model saw it before answering.
 */
function PromptDeliveryNote({
  delivery,
}: {
  delivery: NonNullable<DisplayMessage["promptDelivery"]>;
}) {
  return (
    <div
      className={`mb-0.5 mr-1 inline-flex items-center gap-1 text-micro ${
        delivery === "steer" ? "text-accent" : "text-warning"
      }`}
    >
      <CornerDownRight size={11} aria-hidden />
      <span>
        {delivery === "steer"
          ? "Steered · read during the response"
          : "Arrived after the reply · sent as the next message"}
      </span>
    </div>
  );
}

function promptOriginLabel(origin: DisplayMessage["promptOrigin"]): string {
  if (!origin || origin.kind === "human") return "User prompt";
  if (origin.kind === "agent")
    return origin.agentId === "post-reload-continuation"
      ? "Agent continuation"
      : "Agent prompt";
  return origin.source ? `System prompt · ${origin.source}` : "System prompt";
}

interface Props {
  sessionId: string | undefined;
  messages: DisplayMessage[];
  /** Local-only content before the first durable turn, inside the same scroll owner. */
  intro?: ReactNode;
  /** Durable entries behind the rendered messages (tool-result target mapping). */
  timeline?: readonly ClientTimelineEntry[] | undefined;
  /** Browser-local annotations attached to this session's next composer send. */
  chatComments?: PendingChatCommentsController;
  /** The shared composer's active transcript anchor, if comment mode is open. */
  commentDraft?: Omit<NewPendingChatComment, "body"> | null;
  /** Opens or closes the shared composer mode with a captured transcript anchor. */
  onCommentDraftChange?: (
    draft: Omit<NewPendingChatComment, "body"> | null,
  ) => void;
  /** Keeps the composer and phone dock informed about the live selection. */
  onCommentSelectionChange?:
    | ((selection: { quote: string; onComment: () => void } | null) => void)
    | undefined;
  /** Authoritative session-level "a turn is running" flag (from server state). */
  sessionStreaming?: boolean;
  /**
   * Where a prompt waiting in the permanent Assistant's queue stands, keyed by
   * the row it is about. A condition on that message, rendered on it
   * (`docs/messaging.md`) — never announced, and never a session-wide state:
   * only the row whose id is in here says anything.
   */
  promptQueueStates?: Readonly<Record<string, PromptQueueState>>;
  /** Chat-transcript appearance toggles (turn separators + stats). */
  appearance?: AppearanceSettings;
  sessions?: SessionListItem[];
  changedFiles?: MarkdownFileReference[];
  paObjectReferences?: MarkdownPaObjectReference[];
  onOpenPaObject?: (link: MarkdownPaObjectReference) => void;
  /** The transcript display flags, as one memoized object (see `transcriptView.ts`). */
  view: TranscriptViewPrefs;
  onAcceptCommitDryRun?: (entryId: string) => void;
  onCreateDraftSession?: (
    agentType: AgentType,
    draftText: string,
    notice?: string,
  ) => void;
  models?: ModelOption[];
  defaultModel?: ModelOption | undefined;
  defaultThinkingLevel?: ThinkingLevel | undefined;
  onForkMessage?: (entryId: string, position: "before" | "at") => void;
  onResendPrompt?: (text: string) => void;
  onOpenSession?: (id: string) => void;
  onOpenChangedFile?: (path: string) => void;
  onOpenTask?: (taskId: string) => void;
  onOpenBackgroundWork?: (taskId: string) => void;
  onOpenWorktree?: (worktreeId: string) => void;
  /** Re-run a first send whose worktree provisioning failed (live card only). */
  onRetryWorktreeProvision?: (() => void) | undefined;
  /** Answer an agent's status suggestion from a Task card (see `ToolRenderContext`). */
  onApplyTaskStatusSuggestion?: (task: {
    id: string;
    status: TaskStatus;
  }) => void;
  onResolveApproval?: (
    approvalId: string,
    decision: import("@assistant/shared").ApprovalDecision,
    edits?: import("@assistant/shared").ApprovalResolutionEdits,
    forSession?: boolean,
  ) => void;
  /** The viewed session's "Approve for session" grants. */
  approvalGrants?:
    readonly import("@assistant/shared").ApprovalGrant[] | undefined;
  onRevokeApprovalGrant?: (sessionId: string, key: string) => void;
  /** Account/model combinations an editable approval card offers per row. */
  accountModels?: readonly import("@assistant/shared").AccountModelOption[];
  /** Answer a `choosing-task` pull-request card's Task-disambiguation prompt. */
  onChoosePullRequestTask?: (cardId: string, taskId: string | null) => void;
  /** Run a live pull-request card action (merge, update, cleanup, Task done). */
  onPullRequestCardAction?: (
    cardId: string,
    action: import("@assistant/shared").PullRequestCardAction,
    options?: import("@assistant/shared").PullRequestCardActionOptions,
  ) => void;
  pendingQuestion?: AgentQuestionRequest | undefined;
  answeredQuestions?: AnsweredAgentQuestion[] | undefined;
  onRespondToQuestion?: (response: AgentQuestionResponse) => void;
  sessionCanSteer?: boolean;
  onLoadTimelineBlock?: (
    entryId: string,
    blockIndex: number,
    kind: LazyBlockKind,
  ) => void;
  /**
   * A rendered body starts/stops showing a LIVE block, for the session this
   * list shows (see `AssistantActions.setLiveBodyDemand`). The list binds its
   * session id in, and the bound handler's identity changes with it: a row
   * that stays mounted across a session switch (the live row keeps its key
   * when both sessions stream) then re-registers its demand under the new id.
   */
  onLiveBodyDemand?: (
    sessionId: string,
    key: LiveBodyKey,
    wanted: boolean,
  ) => void;
  /**
   * A row to jump to and flash, once per token. It belongs to THIS session:
   * the host drops a focus naming another one, since a jump across sessions
   * resolves against the transcript that is about to be shown, not this one.
   */
  focusEntry?: { entryId: string; token: number } | null;
  /** Fired once the jump has actually landed on its row, so the host can retire it. */
  onFocusEntryApplied?: (token: number) => void;
  /**
   * Bumped by `App.tsx` whenever THIS browser submits something. A send follows
   * its own answer from wherever the reader was — it must not depend on having
   * been near the bottom, and it cannot be inferred from the rows either (an
   * attachments-only prompt echoes no optimistic row).
   */
  pinToBottomToken?: number;
  /**
   * Hands the scroll controller's view-change hold to whoever owns the display
   * preferences, and `null` on the way out. That hold has to run in the EVENT
   * that flips a flag — the layout it measures is the one the flip replaces —
   * and this component never sees that event: the menu lives in the header and
   * the mobile dock (`ChatHeaderMenu.tsx`).
   */
  onRegisterViewHold?: (hold: (() => void) | null) => void;
  loadingPreview?: boolean;
  onPreviewInteraction?: () => void;
  /**
   * Running turn stats for the entries BEFORE `messages` — the transcript is a
   * window of a long session, so the Session cumulative and the context delta
   * continue from here instead of restarting at the window.
   */
  turnStatsSeed?: TurnStatsSeed | undefined;
  /** The server holds entries older than `messages[0]`, fetchable on demand. */
  hasOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  onLoadOlderMessages?: () => void;
  /**
   * The session this transcript was forked out of. Drawn ONCE, after the last
   * row carrying `inheritedFrom` — the rows above it were written in that
   * session and copied here. Absent for a session that is not a fork; the
   * marker also stays hidden while the window opens past the boundary.
   */
  forkBoundary?: { parentTitle: string; onOpen: () => void } | undefined;
}

interface MessageRowProps {
  message: DisplayMessage;
  focusKey?: string | undefined;
  sessionReferences: MarkdownSessionReference[];
  changedFiles: MarkdownFileReference[];
  paObjectReferences: MarkdownPaObjectReference[];
  /** The transcript display flags, as one memoized object (see `transcriptView.ts`). */
  view: TranscriptViewPrefs;
  onAcceptCommitDryRun?: ((entryId: string) => void) | undefined;
  onCreateDraftSession?:
    | ((agentType: AgentType, draftText: string, notice?: string) => void)
    | undefined;
  models?: ModelOption[] | undefined;
  defaultModel?: ModelOption | undefined;
  defaultThinkingLevel?: ThinkingLevel | undefined;
  onForkMessage?:
    ((entryId: string, position: "before" | "at") => void) | undefined;
  onResendPrompt?: ((text: string) => void) | undefined;
  onOpenSession?: ((id: string) => void) | undefined;
  onOpenChangedFile?: ((path: string) => void) | undefined;
  onOpenPaObject?: ((link: MarkdownPaObjectReference) => void) | undefined;
  onOpenTask?: ((taskId: string) => void) | undefined;
  onOpenBackgroundWork?: ((taskId: string) => void) | undefined;
  onOpenWorktree?: ((worktreeId: string) => void) | undefined;
  /** Re-run a first send whose worktree provisioning failed (live card only). */
  onRetryWorktreeProvision?: (() => void) | undefined;
  /** Answer an agent's status suggestion from a Task card (see `ToolRenderContext`). */
  onApplyTaskStatusSuggestion?:
    ((task: { id: string; status: TaskStatus }) => void) | undefined;
  onResolveApproval?:
    | ((
        approvalId: string,
        decision: import("@assistant/shared").ApprovalDecision,
        edits?: import("@assistant/shared").ApprovalResolutionEdits,
        forSession?: boolean,
      ) => void)
    | undefined;
  approvalGrants?:
    readonly import("@assistant/shared").ApprovalGrant[] | undefined;
  onRevokeApprovalGrant?:
    ((sessionId: string, key: string) => void) | undefined;
  /** Account/model combinations an editable approval card offers per row. */
  accountModels?:
    readonly import("@assistant/shared").AccountModelOption[] | undefined;
  /** Answer a `choosing-task` pull-request card's Task-disambiguation prompt. */
  onChoosePullRequestTask?:
    ((cardId: string, taskId: string | null) => void) | undefined;
  /** Run a live pull-request card action (merge, update, cleanup, Task done). */
  onPullRequestCardAction?:
    | ((
        cardId: string,
        action: import("@assistant/shared").PullRequestCardAction,
        options?: import("@assistant/shared").PullRequestCardActionOptions,
      ) => void)
    | undefined;
  pendingQuestion?: AgentQuestionRequest | undefined;
  answeredQuestions?: AnsweredAgentQuestion[] | undefined;
  onRespondToQuestion?: ((response: AgentQuestionResponse) => void) | undefined;
  sessionCanSteer?: boolean;
  sessionStreaming?: boolean;
  /** This row's queue condition, when it is a prompt still waiting to run. */
  promptQueueState?: PromptQueueState | undefined;
  /** The viewed session's worktree and the other live sessions sharing it. */
  sessionWorktreeId?: string | undefined;
  worktreeLiveSiblings: number;
  onLoadTimelineBlock?:
    | ((entryId: string, blockIndex: number, kind: LazyBlockKind) => void)
    | undefined;
  onLiveBodyDemand?: ((key: LiveBodyKey, wanted: boolean) => void) | undefined;
  registerMessageElement: (
    messageId: string,
    focusKey: string | undefined,
    element: HTMLDivElement | null,
  ) => void;
  /** Block index before which to draw the "before final response" separator. */
  finalResponseSeparatorBeforeBlock?: number | undefined;
  chatCommentable: boolean;
  toolCommentTargets?: ReadonlyMap<number, ChatToolCommentTarget> | undefined;
  onCommentMessage?: ((messageId: string) => void) | undefined;
}

// Evaluated inside the memoized row, never by the whole-timeline projection.
function isSideActivityMessage(message: DisplayMessage): boolean {
  if (message.error) return false;
  if (message.role === "user") {
    return Boolean(
      (message.promptOrigin && message.promptOrigin.kind !== "human") ||
      message.blocks.some((block) => block.kind === "peerPrompt"),
    );
  }
  return (
    message.blocks.length > 0 &&
    message.blocks.every(
      (block) =>
        block.kind === "compaction" ||
        (block.kind === "tool" && peerPromptCardOf(block) !== null),
    )
  );
}

const MessageRow = memo(function MessageRow({
  message,
  focusKey,
  sessionReferences,
  changedFiles,
  paObjectReferences,
  view,
  onAcceptCommitDryRun,
  onCreateDraftSession,
  models,
  defaultModel,
  defaultThinkingLevel,
  onForkMessage,
  onResendPrompt,
  onOpenSession,
  onOpenChangedFile,
  onOpenPaObject,
  onOpenTask,
  onOpenBackgroundWork,
  onOpenWorktree,
  onRetryWorktreeProvision,
  onApplyTaskStatusSuggestion,
  onResolveApproval,
  approvalGrants,
  onRevokeApprovalGrant,
  accountModels,
  onChoosePullRequestTask,
  onPullRequestCardAction,
  pendingQuestion,
  answeredQuestions,
  onRespondToQuestion,
  sessionCanSteer,
  sessionStreaming,
  promptQueueState,
  sessionWorktreeId,
  worktreeLiveSiblings,
  onLoadTimelineBlock,
  onLiveBodyDemand,
  registerMessageElement,
  finalResponseSeparatorBeforeBlock,
  chatCommentable,
  toolCommentTargets,
  onCommentMessage,
}: MessageRowProps) {
  usePerfRenderCount("MessageRow");
  const setRowRef = useCallback(
    (el: HTMLDivElement | null) =>
      registerMessageElement(message.id, focusKey, el),
    [focusKey, message.id, registerMessageElement],
  );

  return (
    // Off iOS, `content-visibility: auto` lets the browser skip layout/paint for
    // rows scrolled out of view; `contain-intrinsic-size: auto` remembers each
    // row's real height once measured. The CSS disables that estimate on iOS,
    // where it can resolve under a touch without native scroll anchoring and
    // move the visible content. Popovers are portaled to the body (`Popover.tsx`),
    // so paint containment off iOS clips nothing.
    // The row itself must stay SQUARE-CORNERED: paint containment clips to the
    // row's own border box, and a radius on it bends that clip into the row's
    // four corners. The row draws nothing there, so the arc only eats what the
    // row's first line paints — the top-left of the first glyph, and the border
    // of a card that starts flush with the row (whose margin collapses out of
    // the row in WebKit), whose corner then reads as a fill-coloured arc.
    // What a row never rendered is worth is `--transcript-row-estimate`, which
    // `useTranscriptScroll` writes per session and re-measures from the rows on
    // screen: one constant cannot be right for both a phone's rows and a
    // desktop's, and the error lands as fiction in the scroll geometry above the
    // reader. The 240px here is the first paint's fallback only, and mirrors
    // `ROW_ESTIMATE_DEFAULT_PX` in `lib/transcriptScroll.ts`.
    <div
      ref={setRowRef}
      data-message-id={message.id}
      data-role={message.role}
      data-side-activity={isSideActivityMessage(message) || undefined}
      className="transcript-row"
    >
      {message.role === "user" ? (
        <UserMessage
          message={message}
          sessionReferences={sessionReferences}
          changedFiles={changedFiles}
          paObjectReferences={paObjectReferences}
          onOpenSession={onOpenSession}
          onOpenChangedFile={onOpenChangedFile}
          onOpenPaObject={onOpenPaObject}
          onOpenTask={onOpenTask}
          onOpenBackgroundWork={onOpenBackgroundWork}
          onForkMessage={onForkMessage}
          onCommentMessage={onCommentMessage}
          onResendPrompt={onResendPrompt}
          chatCommentable={chatCommentable}
          promptQueueState={promptQueueState}
        />
      ) : (
        <AssistantMessage
          message={message}
          {...(message.promptOrigin && message.promptOrigin.kind !== "human"
            ? { originLabel: promptOriginLabel(message.promptOrigin) }
            : {})}
          chatCommentable={chatCommentable}
          toolCommentTargets={toolCommentTargets}
          view={view}
          onAcceptCommitDryRun={onAcceptCommitDryRun}
          onCreateDraftSession={onCreateDraftSession}
          onOpenTask={onOpenTask}
          onOpenWorktree={onOpenWorktree}
          onRetryWorktreeProvision={onRetryWorktreeProvision}
          onApplyTaskStatusSuggestion={onApplyTaskStatusSuggestion}
          onResolveApproval={onResolveApproval}
          approvalGrants={approvalGrants}
          onRevokeApprovalGrant={onRevokeApprovalGrant}
          accountModels={accountModels}
          onChoosePullRequestTask={onChoosePullRequestTask}
          onPullRequestCardAction={onPullRequestCardAction}
          sessionBusy={sessionStreaming}
          sessionWorktreeId={sessionWorktreeId}
          worktreeLiveSiblings={worktreeLiveSiblings}
          pendingQuestion={pendingQuestion}
          answeredQuestions={answeredQuestions}
          onRespondToQuestion={onRespondToQuestion}
          questionResponseNotice={
            sessionStreaming && !sessionCanSteer
              ? "The agent is still responding. Your answers are recorded now and reach it as soon as this response finishes."
              : undefined
          }
          onLoadTimelineBlock={onLoadTimelineBlock}
          onLiveBodyDemand={onLiveBodyDemand}
          models={models}
          defaultModel={defaultModel}
          defaultThinkingLevel={defaultThinkingLevel}
          sessionReferences={sessionReferences}
          changedFiles={changedFiles}
          paObjectReferences={paObjectReferences}
          onOpenSession={onOpenSession}
          onOpenChangedFile={onOpenChangedFile}
          onOpenPaObject={onOpenPaObject}
          finalResponseSeparatorBeforeBlock={finalResponseSeparatorBeforeBlock}
          actions={
            <MessageActionsBar
              message={message}
              align="left"
              onForkMessage={onForkMessage}
              onCommentMessage={onCommentMessage}
            />
          }
        />
      )}
    </div>
  );
});

/** Rows rendered on arrival at a session, and how many more each "load earlier" adds. */
const WINDOW_INITIAL_ROWS = 120;
const WINDOW_STEP_ROWS = 240;

/**
 * Whether this row is the one a jump names. A row IS its durable entry, so its
 * own id answers for an anchor resolved server-side (a peer prompt, a `#m-`
 * deep link); the fork anchors are the same entry ids reached from the other
 * direction, and a row carrying one is still that entry's row.
 */
function messageHasEntry(message: DisplayMessage, entryId: string): boolean {
  return (
    message.id === entryId ||
    message.forkBeforeEntryId === entryId ||
    message.forkAtEntryId === entryId
  );
}

export function MessageList({
  sessionId,
  messages,
  intro,
  timeline = [],
  chatComments,
  commentDraft,
  onCommentDraftChange,
  onCommentSelectionChange,
  sessionStreaming = false,
  promptQueueStates,
  appearance,
  sessionCanSteer = false,
  sessions = [],
  changedFiles = [],
  paObjectReferences = [],
  view,
  onAcceptCommitDryRun,
  onCreateDraftSession,
  models,
  defaultModel,
  defaultThinkingLevel,
  onForkMessage,
  onResendPrompt,
  onOpenSession,
  onOpenChangedFile,
  onOpenPaObject,
  onOpenTask,
  onOpenBackgroundWork,
  onOpenWorktree,
  onRetryWorktreeProvision,
  onApplyTaskStatusSuggestion,
  onResolveApproval,
  approvalGrants,
  onRevokeApprovalGrant,
  accountModels,
  onChoosePullRequestTask,
  onPullRequestCardAction,
  pendingQuestion,
  answeredQuestions,
  onRespondToQuestion,
  onLoadTimelineBlock,
  onLiveBodyDemand: onSessionLiveBodyDemand,
  focusEntry,
  onFocusEntryApplied,
  pinToBottomToken,
  onRegisterViewHold,
  loadingPreview = false,
  onPreviewInteraction,
  turnStatsSeed = EMPTY_TURN_STATS_SEED,
  hasOlderMessages = false,
  loadingOlderMessages = false,
  onLoadOlderMessages,
  forkBoundary,
}: Props) {
  usePerfRenderCount("MessageList");
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  // Filter out completed assistant turns that only contain hidden thinking/tool
  // blocks. Rendering empty wrappers for those turns still participates in the
  // flex gap, which can create a large blank space before the final response.
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (m) =>
          m.role === "user" ||
          canRenderAssistantMessage(m, view.showThinking, view.showTools),
      ),
    [messages, view.showThinking, view.showTools],
  );
  // The last row this session inherited from its parent — where the fork
  // boundary marker goes. Read off the RENDERED rows so a hidden trailing row
  // cannot leave the marker attached to nothing.
  const forkBoundaryMessageId = useMemo(() => {
    if (!forkBoundary) return undefined;
    for (let i = visibleMessages.length - 1; i >= 0; i--)
      if (visibleMessages[i]!.inheritedFrom) return visibleMessages[i]!.id;
    return undefined;
  }, [visibleMessages, forkBoundary]);
  const allRows = useMemo(() => {
    const seen = new Map<string, number>();
    return visibleMessages.map((message) => {
      const occurrence = seen.get(message.id) ?? 0;
      seen.set(message.id, occurrence + 1);
      return {
        message,
        key: occurrence === 0 ? message.id : `${message.id}#${occurrence}`,
      };
    });
  }, [visibleMessages]);

  // Render a bounded window of the most recent rows. A long-running session runs
  // to thousands of messages, and every one of them is a real subtree — even
  // fully memoized, mounting them all costs the first paint, the DOM size and
  // every subsequent layout. Older rows are one tap away and the window only
  // ever grows within a session.
  const [windowLimit, setWindowLimit] = useState(WINDOW_INITIAL_ROWS);
  const [windowSessionId, setWindowSessionId] = useState(sessionId);
  const windowTopKey = useRef<string | null>(null);
  if (windowSessionId !== sessionId) {
    setWindowSessionId(sessionId);
    setWindowLimit(WINDOW_INITIAL_ROWS);
    windowTopKey.current = null;
  }
  const hiddenRowCount = transcriptWindowStart(
    allRows,
    windowLimit,
    windowTopKey.current,
  );
  const visibleRows = useMemo(
    () => (hiddenRowCount > 0 ? allRows.slice(hiddenRowCount) : allRows),
    [allRows, hiddenRowCount],
  );
  windowTopKey.current = visibleRows[0]?.key ?? null;
  // Mount far enough back that a row `count` from the newest exists: a restored
  // reading position or a cross-pane jump can name a row the window has not
  // reached yet.
  const requireRows = useCallback((count: number) => {
    setWindowLimit((limit) =>
      limit >= count ? limit : count + WINDOW_STEP_ROWS,
    );
  }, []);
  // Bound to the viewed session, and re-bound when it changes (see the prop).
  const onLiveBodyDemand = useMemo(
    () =>
      onSessionLiveBodyDemand && sessionId
        ? (key: LiveBodyKey, wanted: boolean) =>
            onSessionLiveBodyDemand(sessionId, key, wanted)
        : undefined,
    [onSessionLiveBodyDemand, sessionId],
  );
  // Every display flag reshapes the transcript: "show" mounts and unmounts whole
  // rows, "expand" opens every thinking block and tool call in them, and wrapping
  // re-flows the long ones. The reading position across one of these is MEASURED
  // by the host, in the event that flips it, because by this render the layout to
  // measure is already gone; this token is how the commit that reshaped the rows
  // is told apart from every other render, and it is where that hold starts.
  const viewToken = `${view.showThinking}${view.showTools}${view.expandThinking}${view.expandTools}${view.wrapToolLines}`;
  const tailKeyValue = transcriptTailKey(messages);
  const {
    containerRef,
    contentRef,
    syncAfterRender,
    holdVisibleRow,
    holdViewChange,
    commitViewChange,
    holdRow,
  } = useTranscriptScroll({
    sessionId,
    ...(tailKeyValue !== undefined ? { tailKey: tailKeyValue } : {}),
    restoreReady: !loadingPreview,
    ...(pinToBottomToken === undefined ? {} : { pinToken: pinToBottomToken }),
    onRequireRows: requireRows,
  });
  const commentEnabled = Boolean(sessionId && chatComments);
  const pendingSessionComments = useMemo(
    () =>
      sessionId
        ? (chatComments?.comments.filter(
            (comment): comment is PendingTranscriptComment =>
              isTranscriptComment(comment) &&
              comment.anchor.sessionId === sessionId,
          ) ?? [])
        : [],
    [chatComments?.comments, sessionId],
  );
  const hasPendingChatComments = pendingSessionComments.length > 0;
  const {
    selection,
    hold: holdSelection,
    release: releaseSelection,
    highlightName: anchorHighlight,
  } = useSelectionAnchor(contentRef, commentEnabled);
  // The transcript holds the selection only while Composer is editing it. Once
  // comment mode closes, unpaint and unlock it so the next selection can work.
  const previousCommentDraft = useRef(commentDraft);
  useEffect(() => {
    if (previousCommentDraft.current && !commentDraft) releaseSelection();
    previousCommentDraft.current = commentDraft;
  }, [commentDraft, releaseSelection]);
  useEffect(() => () => releaseSelection(), [releaseSelection]);

  const editorSessionRef = useRef(sessionId);
  useLayoutEffect(() => {
    if (editorSessionRef.current === sessionId) return;
    editorSessionRef.current = sessionId;
    onCommentDraftChange?.(null);
    releaseSelection();
  }, [onCommentDraftChange, releaseSelection, sessionId]);
  const previousCommentProjection = useRef<ToolTargetProjection | null>(null);
  const commentProjection = useMemo(() => {
    const next = reuseStableChatToolTargets(
      chatToolCommentTargets(timeline),
      previousCommentProjection.current,
    );
    previousCommentProjection.current = next;
    return next;
  }, [timeline]);
  const messageMeta = useMemo(
    () =>
      new Map(
        messages.map((message) => [
          message.id,
          { createdAt: message.createdAt },
        ]),
      ),
    [messages],
  );
  const messageMetaRef = useRef(messageMeta);
  messageMetaRef.current = messageMeta;

  const openCommentComposer = useCallback(
    (target: HTMLElement, captured?: CapturedSelection) => {
      if (!commentEnabled || !sessionId) return;
      const entryId = target.dataset.chatEntryId;
      const blockIndex = Number(target.dataset.chatBlockIndex);
      if (!entryId || !Number.isInteger(blockIndex)) return;
      const targetText = target.textContent ?? "";
      let selectors;
      if (captured?.bundle.position) {
        const root = contentRef.current;
        if (!root) return;
        // Selection state itself re-renders this component, and a Markdown
        // subtree may replace the cloned DOM Range. The bundle's raw root
        // offsets survive that. Translate them into this immutable block,
        // clamping the end when the drag crossed into a later target.
        const before = document.createRange();
        before.setStart(root, 0);
        before.setEndBefore(target);
        const targetStart = before.toString().length;
        const start = Math.max(0, captured.bundle.position.start - targetStart);
        const end = Math.min(
          targetText.length,
          captured.bundle.position.end - targetStart,
        );
        selectors = bundleFromOffsets(targetText, start, end);
      } else {
        const range = document.createRange();
        range.selectNodeContents(target);
        selectors = describeAnchor(range, target, targetText);
      }
      if (!selectors) return;
      const row = target.closest<HTMLElement>("[data-message-id]");
      const rowId = row?.dataset.messageId;
      const renderedBlock = target.closest<HTMLElement>(
        "[data-chat-render-block-index]",
      );
      const renderedBlockIndex = Number(
        renderedBlock?.dataset.chatRenderBlockIndex,
      );
      const rowCreatedAt = rowId
        ? messageMetaRef.current.get(rowId)?.createdAt
        : undefined;
      // Real comment targets are durable rendered rows. Without the row's
      // persistence time there is no stable coordinate that survives preview
      // hydration, so refuse rather than mixing a display index with entry seq.
      if (!rowId || !rowCreatedAt || !Number.isInteger(renderedBlockIndex))
        return;
      holdSelection();
      window.getSelection()?.removeAllRanges();
      onCommentDraftChange?.({
        sessionId,
        entryId,
        blockIndex,
        selectors,
        quote: selectors.quote.exact.replace(/\s+/g, " ").trim(),
        transcriptPosition: {
          rowCreatedAt,
          rowId,
          blockIndex: renderedBlockIndex,
        },
        entryCreatedAt: rowCreatedAt,
      });
    },
    [
      commentEnabled,
      sessionId,
      contentRef,
      holdSelection,
      onCommentDraftChange,
    ],
  );
  const commentOnSelection = useCallback(
    (captured: CapturedSelection) => {
      const root = contentRef.current;
      if (!root) return;
      const target =
        chatTargetAt(captured.startContainer, root) ??
        chatTargetAtPosition(captured.startPosition, root);
      if (target) openCommentComposer(target, captured);
    },
    [contentRef, openCommentComposer],
  );
  const commentOnMessage = useCallback(
    (messageId: string) => {
      const root = contentRef.current;
      if (!root) return;
      const row = Array.from(
        root.querySelectorAll<HTMLElement>("[data-message-id]"),
      ).find((candidate) => candidate.dataset.messageId === messageId);
      const directTargets = row
        ? Array.from(
            row.querySelectorAll<HTMLElement>("[data-chat-comment-target]"),
          )
        : [];
      const target =
        directTargets[directTargets.length - 1] ??
        row?.querySelector<HTMLElement>("[data-chat-comment-named-target]");
      if (target) openCommentComposer(target);
    },
    [contentRef, openCommentComposer],
  );
  const commentOnCurrentSelection = useCallback(() => {
    if (selection) commentOnSelection(selection);
  }, [commentOnSelection, selection]);
  useEffect(() => {
    onCommentSelectionChange?.(
      selection
        ? { quote: selection.quote, onComment: commentOnCurrentSelection }
        : null,
    );
  }, [commentOnCurrentSelection, onCommentSelectionChange, selection]);

  const commentRanges = useCallback(() => {
    if (!hasPendingChatComments) return [];
    const root = contentRef.current;
    if (!root) return [];
    const targets = Array.from(
      root.querySelectorAll<HTMLElement>("[data-chat-comment-target]"),
    );
    return pendingSessionComments.flatMap((comment) => {
      const target = targets.find(
        (candidate) =>
          candidate.dataset.chatEntryId === comment.anchor.entryId &&
          Number(candidate.dataset.chatBlockIndex) ===
            comment.anchor.blockIndex,
      );
      const position = comment.selectors.position;
      if (!target || !position) return [];
      const range = rangeFromOffsets(target, position.start, position.end);
      return range && range.toString() === comment.selectors.quote.exact
        ? [{ id: comment.id, range }]
        : [];
    });
  }, [contentRef, hasPendingChatComments, pendingSessionComments]);
  const paintCommentHighlights = useCallback(() => {
    if (!highlightsSupported()) return;
    const ranges = commentRanges().map((item) => item.range);
    if (ranges.length > 0)
      CSS.highlights.set(CHAT_COMMENT_HIGHLIGHT, new Highlight(...ranges));
    else CSS.highlights.delete(CHAT_COMMENT_HIGHLIGHT);
  }, [commentRanges]);
  useEffect(() => {
    paintCommentHighlights();
    return () => {
      if (highlightsSupported()) CSS.highlights.delete(CHAT_COMMENT_HIGHLIGHT);
    };
  }, [messages, paintCommentHighlights]);
  useEffect(() => {
    if (!hasPendingChatComments) return;
    const root = contentRef.current;
    if (!root || typeof MutationObserver === "undefined") return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        paintCommentHighlights();
      });
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [contentRef, hasPendingChatComments, paintCommentHighlights]);
  const openCommentAtPoint = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!chatComments || !hasPendingChatComments) return;
      if (
        (event.target as HTMLElement).closest(
          "a, button, input, textarea, select, [role='button']",
        )
      )
        return;
      const nativeSelection = window.getSelection();
      if (nativeSelection && !nativeSelection.isCollapsed) return;
      const point = pointAt(document, event.clientX, event.clientY);
      if (!point) return;
      const hit = commentRanges().find(({ range }) =>
        range.isPointInRange(point.node, point.offset),
      );
      if (hit) chatComments.select(hit.id);
    },
    [chatComments, hasPendingChatComments, commentRanges],
  );
  // The controller's own hold, handed to whoever owns the display preferences
  // (`App.tsx`): it is the only party that knows a flag is ABOUT to change.
  useLayoutEffect(() => {
    onRegisterViewHold?.(holdViewChange);
    return () => onRegisterViewHold?.(null);
  }, [holdViewChange, onRegisterViewHold]);
  const showEarlierRows = useCallback(() => {
    // Growing the window prepends rows, so the content under the viewport moves
    // down by exactly the height that was added — and by more, later, as the
    // newly mounted rows measure themselves. Holding the row at the top edge
    // covers both.
    holdVisibleRow();
    setWindowLimit((limit) => limit + WINDOW_STEP_ROWS);
  }, [holdVisibleRow]);
  // Locally held rows are consumed FIRST; only once they run out is the server
  // asked for the entries before them. Growing the window by the same step is
  // what makes the arriving rows visible instead of hidden behind the button.
  const loadOlderMessages = useCallback(() => {
    holdVisibleRow();
    setWindowLimit((limit) => limit + WINDOW_STEP_ROWS);
    onLoadOlderMessages?.();
  }, [holdVisibleRow, onLoadOlderMessages]);

  // Turn boundaries + per-turn stats (Task 118). Group on the FULL message list
  // (not the visibility-filtered one) so per-turn totals still count requests
  // whose tool/thinking blocks are hidden; then anchor the end-of-turn row to the
  // turn's last VISIBLE assistant row. Everything is durable/reconstructable, so
  // these render both live and on reload.
  const wantTurnEnd = Boolean(
    appearance?.separatorAtTurnEnd || appearance?.turnStatsRow,
  );
  const visibleIds = useMemo(
    () => new Set(visibleMessages.map((m) => m.id)),
    [visibleMessages],
  );
  const previousTurnEnds = useRef<Map<string, TurnEndEntry> | null>(null);
  const { turnEndByMessageId, finalBoundaryByMessageId } = useMemo(() => {
    const turnEnd = new Map<string, TurnEndEntry>();
    const finalBoundary = new Map<string, number>();
    if (!appearance)
      return {
        turnEndByMessageId: turnEnd,
        finalBoundaryByMessageId: finalBoundary,
      };
    // The running stats continue from the SEED — what the server computed for
    // the entries before this window — so a windowed transcript does not
    // silently under-count. The walk itself is shared with the server, which is
    // what makes the seeded rows equal the unwindowed ones.
    for (const {
      turn,
      cumulative,
      contextDelta,
      showSessionCumulative,
      partial,
    } of accumulateTurnStats(messages, turnStatsSeed)) {
      // A leading FRAGMENT gets no turn-end row: the window opened inside that
      // turn, so its totals cover only the visible part — a number that would be
      // wrong now and would change under the reader the moment the rest of the
      // turn is loaded. The row appears once the whole turn is here.
      if (
        wantTurnEnd &&
        !partial &&
        turn.complete &&
        turn.assistantMessages.length > 0
      ) {
        const anchor = [...turn.assistantMessages]
          .reverse()
          .find((m) => visibleIds.has(m.id));
        if (anchor)
          turnEnd.set(anchor.id, {
            turn,
            cumulative,
            contextDelta,
            showSessionCumulative,
          });
      }
      // The before-final separator only makes sense when tool activity is visible.
      if (appearance.separatorBeforeFinalResponse && view.showTools) {
        const boundary = finalResponseBoundary(turn);
        if (boundary)
          finalBoundary.set(boundary.messageId, boundary.blockIndex);
      }
    }
    const heldTurnEnd = reuseStableTurnEnds(turnEnd, previousTurnEnds.current);
    previousTurnEnds.current = heldTurnEnd;
    return {
      turnEndByMessageId: heldTurnEnd,
      finalBoundaryByMessageId: finalBoundary,
    };
  }, [
    messages,
    visibleIds,
    appearance,
    wantTurnEnd,
    view.showTools,
    turnStatsSeed,
  ]);

  // Only the sessions this transcript MENTIONS: the autolink resolves a bare
  // session id in the text to its title, so a session no message names has
  // nothing to contribute — and naming one (which the server does from the
  // first prompt of every session anyone starts) would otherwise be a content
  // change for every message on screen. The scan uses the same pattern the
  // remark plugin matches with, so a link that will be resolved is one that
  // survives this filter.
  const mentionedIds = useMemo(() => mentionedSessionIds(messages), [messages]);
  const mentionedSessions = useMemo(
    () =>
      sessions.filter((session) => mentionedIds.has(session.id.toLowerCase())),
    [sessions, mentionedIds],
  );
  const referenceKey = sessionReferenceKey(mentionedSessions);
  const sessionReferences = useMemo(
    () => mentionedSessions.map(({ id, title }) => ({ id, title })),
    // Session list broadcasts often only change volatile state (running/unread)
    // or nothing but the ORDER — the list is sorted by `updatedAt`, so any agent
    // turn anywhere in the app re-sorts it. Keep Markdown link props stable
    // unless the linkable id/title data changed.
    // oxlint-disable-next-line react/exhaustive-deps -- `referenceKey` IS the id/title content of `mentionedSessions`; depending on the array would rebuild every Markdown link prop on each re-sort
    [referenceKey],
  );
  // What the `/pr` card's cleanup would take away with the checkout: the viewed
  // session's worktree and the OTHER sessions still live on it (a review or
  // fork session is the ordinary neighbour). Scalars, so a memoized row is not
  // re-rendered by the identity of a fresh object.
  const sessionWorktreeId = sessions.find(
    (session) => session.id === sessionId,
  )?.worktreeId;
  const worktreeLiveSiblings = sessionWorktreeId
    ? sessions.filter(
        (session) =>
          session.id !== sessionId &&
          session.worktreeId === sessionWorktreeId &&
          !session.settledAt &&
          !session.archived,
      ).length
    : 0;
  const registerMessageElement = useCallback(
    (
      _messageId: string,
      focusKey: string | undefined,
      el: HTMLDivElement | null,
    ) => {
      if (!focusKey) return;
      if (el) messageRefs.current.set(focusKey, el);
      else messageRefs.current.delete(focusKey);
    },
    [],
  );

  // A cross-pane jump can target a message older than the window. Handing the
  // row to the scroll controller widens the window AND keeps the row in place
  // while the cards around it settle; retry until the transcript holds it, then
  // once per token.
  const allRowsRef = useRef(allRows);
  allRowsRef.current = allRows;
  const focusHandled = useRef<number | null>(null);
  // The two fields, not the request object: `focusEntry` is rebuilt by its host
  // on every render, and these are the whole of what both effects read.
  const focusToken = focusEntry?.token ?? null;
  const focusEntryId = focusEntry?.entryId ?? null;
  useLayoutEffect(() => {
    if (focusToken === null || focusEntryId === null) return;
    if (focusHandled.current === focusToken) return;
    const rows = allRowsRef.current;
    const index = rows.findIndex(({ message }) =>
      messageHasEntry(message, focusEntryId),
    );
    const row = index < 0 ? undefined : rows[index];
    if (!row) return;
    focusHandled.current = focusToken;
    holdRow(row.message.id, { rowsFromEnd: rows.length - index, center: true });
  }, [focusToken, focusEntryId, allRows.length, holdRow]);

  // The flash follows the row rather than the jump: widening the window is what
  // mounts it, so this re-runs when the window grows. Landing on the row is also
  // where the jump is SPENT: the host is told, so a later visit to this session
  // opens where the reader left it instead of replaying an old jump.
  useLayoutEffect(() => {
    if (focusToken === null || focusEntryId === null) return;
    const target = messageRefs.current.get(focusEntryId);
    if (!target) return;
    target.animate(
      [
        {
          backgroundColor:
            "color-mix(in srgb, var(--color-accent) 18%, transparent)",
        },
        { backgroundColor: "transparent" },
      ],
      { duration: 1400, easing: "ease-out" },
    );
    onFocusEntryApplied?.(focusToken);
    // Telling the host RETIRES the jump, so a re-run finds no `focusEntry` and
    // stops — which is what keeps `onFocusEntryApplied` safe to depend on.
  }, [focusToken, focusEntryId, sessionId, windowLimit, onFocusEntryApplied]);

  // Rows that arrive or change shape without a resize (a new message, a view
  // toggle) still need the controller to re-apply; everything that changes
  // height LATER — a lazily mounted card, a commit card turning into a commit,
  // Shiki, an image — reaches it through the hook's own ResizeObserver.
  // `sessionStreaming` belongs here for the same reason as `messages`: it mounts
  // the standalone Thinking row below the turn just submitted, and that row
  // arrives with the message list unchanged.
  //
  // The commit that carries a display change is the one exception, and it is
  // told apart here rather than in the controller: it starts the hold the host
  // measured when the reader asked for the change, which may have been several
  // interruptible transition attempts ago.
  const committedViewToken = useRef(viewToken);
  useLayoutEffect(() => {
    if (committedViewToken.current !== viewToken) {
      committedViewToken.current = viewToken;
      commitViewChange();
      return;
    }
    syncAfterRender();
  }, [
    messages,
    sessionStreaming,
    windowLimit,
    viewToken,
    syncAfterRender,
    commitViewChange,
  ]);

  // The pointer/touch/wheel handlers below report real interaction with a
  // reconnect preview, which is what keeps its rows on screen (`App.tsx`
  // `preservePreviewMessages`). Scroll events are NOT that signal: they also
  // fire for the scroll controller's own scrolling.
  return (
    <div
      ref={containerRef}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      onPointerDown={() => {
        if (loadingPreview) onPreviewInteraction?.();
      }}
      onTouchMove={() => {
        if (loadingPreview) onPreviewInteraction?.();
      }}
      onWheel={() => {
        if (loadingPreview) onPreviewInteraction?.();
      }}
    >
      {commentEnabled ? (
        <style>{chatCommentHighlightStyle(anchorHighlight)}</style>
      ) : null}
      {/* Rows are spaced with margins, not a flat `gap`, so consecutive
          assistant rows can be tightened: a turn that streams as ONE assistant
          message (blocks at gap-3) splits into SEVERAL assistant rows once
          committed, so assistant→assistant uses the same 12px (mt-3) as the
          intra-message block gap — keeping spacing stable across that
          transition — while turn boundaries (→user / user→assistant) keep the
          airier 20px (mt-5). */}
      <div
        ref={contentRef}
        onClick={openCommentAtPoint}
        className="mx-auto flex w-full max-w-3xl flex-col px-4 py-6 [&>*]:mt-5 [&>*:first-child]:mt-0 [&>[data-role=assistant]+[data-role=assistant]]:mt-3"
      >
        {intro && hiddenRowCount === 0 && !hasOlderMessages ? (
          <div className="flex flex-col">{intro}</div>
        ) : null}
        {hiddenRowCount > 0 ? (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={showEarlierRows}
              className="rounded-full border border-line bg-surface px-3 py-1.5 text-caption text-muted transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Load {Math.min(hiddenRowCount, WINDOW_STEP_ROWS)} earlier{" "}
              {hiddenRowCount === 1 ? "message" : "messages"}
              {hiddenRowCount > WINDOW_STEP_ROWS
                ? ` (${hiddenRowCount} older)`
                : ""}
            </button>
          </div>
        ) : hasOlderMessages ? (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={loadOlderMessages}
              disabled={loadingOlderMessages}
              className="rounded-full border border-line bg-surface px-3 py-1.5 text-caption text-muted transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
            >
              {loadingOlderMessages
                ? "Loading earlier messages…"
                : "Load earlier messages"}
            </button>
          </div>
        ) : null}
        {visibleRows.map(({ message: m, key }) => {
          const focusKey =
            focusEntry && messageHasEntry(m, focusEntry.entryId)
              ? focusEntry.entryId
              : undefined;
          const turnEnd = turnEndByMessageId.get(m.id);
          const rowCanComment = Boolean(
            m.createdAt && !isTransientMessageId(m.id),
          );
          const toolCommentTargets =
            commentEnabled && rowCanComment
              ? commentProjection.targetsByMessage.get(m.id)
              : undefined;
          const chatCommentable = Boolean(
            commentEnabled &&
            rowCanComment &&
            m.blocks.some((block) => block.kind === "text"),
          );
          const hasCommentTarget =
            chatCommentable || Boolean(toolCommentTargets?.size);
          return (
            <Fragment key={key}>
              <MessageRow
                message={m}
                focusKey={focusKey}
                finalResponseSeparatorBeforeBlock={finalBoundaryByMessageId.get(
                  m.id,
                )}
                sessionReferences={sessionReferences}
                changedFiles={changedFiles}
                paObjectReferences={paObjectReferences}
                view={view}
                onAcceptCommitDryRun={onAcceptCommitDryRun}
                onCreateDraftSession={onCreateDraftSession}
                models={models}
                defaultModel={defaultModel}
                defaultThinkingLevel={defaultThinkingLevel}
                onForkMessage={onForkMessage}
                onResendPrompt={onResendPrompt}
                onOpenSession={onOpenSession}
                onOpenChangedFile={onOpenChangedFile}
                onOpenPaObject={onOpenPaObject}
                onOpenTask={onOpenTask}
                onOpenBackgroundWork={onOpenBackgroundWork}
                onOpenWorktree={onOpenWorktree}
                onRetryWorktreeProvision={onRetryWorktreeProvision}
                onApplyTaskStatusSuggestion={onApplyTaskStatusSuggestion}
                onResolveApproval={onResolveApproval}
                approvalGrants={approvalGrants}
                onRevokeApprovalGrant={onRevokeApprovalGrant}
                accountModels={accountModels}
                onChoosePullRequestTask={onChoosePullRequestTask}
                onPullRequestCardAction={onPullRequestCardAction}
                pendingQuestion={pendingQuestion}
                answeredQuestions={answeredQuestions}
                onRespondToQuestion={onRespondToQuestion}
                sessionCanSteer={sessionCanSteer}
                sessionStreaming={sessionStreaming}
                promptQueueState={promptQueueStates?.[m.id]}
                sessionWorktreeId={sessionWorktreeId}
                worktreeLiveSiblings={worktreeLiveSiblings}
                onLoadTimelineBlock={onLoadTimelineBlock}
                onLiveBodyDemand={onLiveBodyDemand}
                registerMessageElement={registerMessageElement}
                chatCommentable={chatCommentable}
                toolCommentTargets={toolCommentTargets}
                onCommentMessage={
                  hasCommentTarget ? commentOnMessage : undefined
                }
              />
              {forkBoundary && m.id === forkBoundaryMessageId && (
                <ForkBoundaryMarker
                  parentTitle={forkBoundary.parentTitle}
                  onOpen={forkBoundary.onOpen}
                />
              )}
              {turnEnd && (
                <div data-turn-end className="flex flex-col gap-1.5">
                  {appearance?.separatorAtTurnEnd && (
                    <hr className="border-line/60" />
                  )}
                  {appearance?.turnStatsRow && (
                    <TurnStatsRow
                      turn={turnEnd.turn}
                      sessionCumulative={turnEnd.cumulative}
                      contextDelta={turnEnd.contextDelta}
                      showSessionCumulative={turnEnd.showSessionCumulative}
                      perRun={Boolean(appearance?.turnStatsPerRequest)}
                    />
                  )}
                </div>
              )}
            </Fragment>
          );
        })}
        {/* When a turn is running but no message is the live streaming one yet
            (e.g. the user prompt was just submitted and the assistant entry
            hasn't opened), show a standalone activity indicator. Once the live
            assistant message exists it renders its own indicator instead. */}
        {sessionStreaming && !messages.some((m) => m.streaming) && (
          <div data-role="assistant">
            <ProgressIndicator label="Thinking" />
          </div>
        )}
      </div>
    </div>
  );
}
