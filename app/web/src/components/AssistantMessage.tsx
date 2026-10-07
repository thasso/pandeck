import {
  Fragment,
  Suspense,
  lazy,
  memo,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Bot, PackageCheck, Scissors } from "lucide-react";
import { ChatActivityRow } from "./ChatActivityRow.tsx";
import type {
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentType,
  AnsweredAgentQuestion,
  CompactionDisplay,
  ContextClearDisplay,
  DisplayBlock,
  DisplayMessage,
  ModelOption,
  TaskStatus,
  ThinkingLevel,
} from "@assistant/shared";
import type {
  LazyBlockKind,
  LazyBlockRef,
  LiveBodyKey,
} from "@assistant/shared/session";
import {
  Markdown,
  type MarkdownFileReference,
  type MarkdownPaObjectReference,
  type MarkdownSessionReference,
} from "./Markdown.tsx";
import { ThinkingBlock } from "./ThinkingBlock.tsx";
import type { TranscriptViewPrefs } from "./transcriptView.ts";
import { ProgressIndicator } from "./ProgressIndicator.tsx";
import { ServedFileCard } from "./ServedFileCard.tsx";
import {
  renderToolBlock,
  toolBlockIsVisible,
  type ToolRenderContext,
} from "./tools/registry.tsx";

const LazyCommitCard = lazy(() =>
  import("./CommitCard.tsx").then((module) => ({ default: module.CommitCard })),
);
const LazyPushCard = lazy(() =>
  import("./PushCard.tsx").then((module) => ({ default: module.PushCard })),
);
const LazyPullRequestCard = lazy(() =>
  import("./PullRequestCard.tsx").then((module) => ({
    default: module.PullRequestCard,
  })),
);
const LazyWorktreeProvisionCard = lazy(() =>
  import("./WorktreeProvisionCard.tsx").then((module) => ({
    default: module.WorktreeProvisionCard,
  })),
);
const LazyApprovalCard = lazy(() =>
  import("./ApprovalCard.tsx").then((module) => ({
    default: module.ApprovalCard,
  })),
);

const TOOL_VERBS: Record<string, string> = {
  bash: "Running command",
  read: "Reading files",
  write: "Writing file",
  edit: "Editing file",
  grep: "Searching",
  find: "Searching",
  ls: "Listing files",
};

function activityLabel(last: DisplayBlock | undefined): string | null {
  if (!last) return "Thinking";
  if (last.kind === "thinking") return "Thinking";
  if (last.kind === "tool") {
    if (!last.done) return TOOL_VERBS[last.name] ?? `Running ${last.name}`;
    return "Working";
  }
  if (last.kind === "text") return "Responding";
  // Terminal cards (commit/compaction/etc.) replace the turn — no activity label.
  return null;
}

export interface ChatToolCommentTarget {
  entryId: string;
  blockIndex: number;
}

interface Props {
  message: DisplayMessage;
  /** Visible provenance for a provider-initiated assistant turn. */
  originLabel?: string | undefined;
  /** Whether this durable message may expose transcript comment targets. */
  chatCommentable?: boolean;
  /** Tool-result entry targets, keyed by this message's rendered tool block index. */
  toolCommentTargets?: ReadonlyMap<number, ChatToolCommentTarget> | undefined;
  /** The transcript display flags, as one memoized object (see `transcriptView.ts`). */
  view: TranscriptViewPrefs;
  onAcceptCommitDryRun?: ((entryId: string) => void) | undefined;
  onCreateDraftSession?:
    | ((agentType: AgentType, draftText: string, notice?: string) => void)
    | undefined;
  onOpenTask?: ((taskId: string) => void) | undefined;
  onOpenWorktree?: ((worktreeId: string) => void) | undefined;
  /**
   * Re-run the first send whose worktree provisioning failed. Only the host
   * still holding that unsent prompt supplies it, so the Retry button appears
   * on the live card and nowhere else.
   */
  onRetryWorktreeProvision?: (() => void) | undefined;
  /** Answer an agent's status suggestion from the transcript (see `ToolRenderContext`). */
  onApplyTaskStatusSuggestion?:
    ((task: { id: string; status: TaskStatus }) => void) | undefined;
  models?: ModelOption[] | undefined;
  defaultModel?: ModelOption | undefined;
  defaultThinkingLevel?: ThinkingLevel | undefined;
  sessionReferences?: MarkdownSessionReference[];
  changedFiles?: MarkdownFileReference[];
  paObjectReferences?: MarkdownPaObjectReference[];
  onOpenSession?: ((id: string) => void) | undefined;
  onOpenChangedFile?: ((path: string) => void) | undefined;
  onOpenPaObject?: ((link: MarkdownPaObjectReference) => void) | undefined;
  onResolveApproval?:
    | ((
        approvalId: string,
        decision: import("@assistant/shared").ApprovalDecision,
        edits?: import("@assistant/shared").ApprovalResolutionEdits,
        forSession?: boolean,
      ) => void)
    | undefined;
  /** The viewed session's "Approve for session" grants. */
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
  /** The viewed session is running: gates the card's destructive cleanup. */
  sessionBusy?: boolean | undefined;
  /** The viewed session's worktree, and the other live sessions sharing it. */
  sessionWorktreeId?: string | undefined;
  worktreeLiveSiblings?: number;
  /** Live pending question flow + recorded answers, for the in-band ask_questions card. */
  pendingQuestion?: AgentQuestionRequest | undefined;
  answeredQuestions?: AnsweredAgentQuestion[] | undefined;
  onRespondToQuestion?: ((response: AgentQuestionResponse) => void) | undefined;
  questionResponseNotice?: string | undefined;
  onLoadTimelineBlock?:
    | ((entryId: string, blockIndex: number, kind: LazyBlockKind) => void)
    | undefined;
  /** A rendered body starts/stops showing a LIVE block (see `AssistantActions.setLiveBodyDemand`). */
  onLiveBodyDemand?: ((key: LiveBodyKey, wanted: boolean) => void) | undefined;
  actions?: ReactNode;
  /**
   * Block index before which to draw the "before final response" separator —
   * the point where the tool loop ended and the final answer begins (Task 118).
   */
  finalResponseSeparatorBeforeBlock?: number | undefined;
}

function LazyCardFallback({ label = "Opening card…" }: { label?: string }) {
  return (
    <div className="my-2 rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function ToolGroupNoticeCard({
  title,
  summary,
  tools = [],
}: {
  title: string;
  summary?: string | undefined;
  tools?: string[] | undefined;
}) {
  const shownTools = tools.slice(0, 6);
  return (
    <div className="my-2 flex items-start gap-2 rounded-xl border border-primary/25 bg-accent px-3 py-2 text-sm text-muted-foreground">
      <PackageCheck size={15} className="mt-0.5 shrink-0 text-primary" />
      <div className="min-w-0">
        <div className="font-medium text-foreground">{title}</div>
        {summary && <div className="mt-0.5">{summary}</div>}
        {shownTools.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {shownTools.map((tool) => (
              <span
                key={tool}
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
              >
                {tool}
              </span>
            ))}
            {tools.length > shownTools.length && (
              <span className="px-1.5 py-0.5 text-xs text-muted-foreground">
                +{tools.length - shownTools.length} more
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CompactionCard({
  compaction,
  sessionReferences = [],
  changedFiles = [],
  paObjectReferences = [],
  onOpenSession,
  onOpenChangedFile,
  onOpenPaObject,
}: {
  compaction: CompactionDisplay;
  sessionReferences?: MarkdownSessionReference[];
  changedFiles?: MarkdownFileReference[];
  paObjectReferences?: MarkdownPaObjectReference[];
  onOpenSession?: ((id: string) => void) | undefined;
  onOpenChangedFile?: ((path: string) => void) | undefined;
  onOpenPaObject?: ((link: MarkdownPaObjectReference) => void) | undefined;
}) {
  return (
    <ChatActivityRow
      icon={Scissors}
      title="Context"
      preview={
        compaction.tokensAfter === undefined
          ? `Compacted from ${compaction.tokensBefore.toLocaleString()} tokens`
          : `Compacted ${compaction.tokensBefore.toLocaleString()} → ${compaction.tokensAfter.toLocaleString()} tokens`
      }
    >
      {compaction.firstKeptEntryId ? (
        <div className="mt-1 text-sm text-muted-foreground">
          First kept entry: {compaction.firstKeptEntryId}
        </div>
      ) : null}
      <div className="mt-2 text-sm text-foreground">
        <Markdown
          text={compaction.summary}
          sessionReferences={sessionReferences}
          changedFiles={changedFiles}
          paObjectReferences={paObjectReferences}
          onOpenSession={onOpenSession}
          onOpenChangedFile={onOpenChangedFile}
          onOpenPaObject={onOpenPaObject}
        />
      </div>
    </ChatActivityRow>
  );
}

/**
 * The `/clear` boundary. A compaction keeps a summary worth opening; a clear
 * keeps nothing, so this is a rule across the transcript instead of a card: the
 * messages above it stay readable history, the model's context starts below it.
 */
function ContextClearCard({
  contextClear,
}: {
  contextClear: ContextClearDisplay;
}) {
  return (
    <div className="my-3 flex items-center gap-3" role="separator">
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span className="text-sm text-muted-foreground">
        {contextClear.tokensBefore === undefined
          ? "Context cleared"
          : `Context cleared — ${contextClear.tokensBefore.toLocaleString()} tokens dropped`}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}

export function canRenderAssistantMessage(
  message: DisplayMessage,
  showThinking: boolean,
  showTools: boolean,
): boolean {
  const { blocks, streaming } = message;
  const last = blocks[blocks.length - 1];
  const progress = streaming ? activityLabel(last) : null;

  const hasVisibleBlock = blocks.some(
    (b) =>
      b.kind === "text" ||
      b.kind === "commit" ||
      b.kind === "push" ||
      b.kind === "pullRequest" ||
      b.kind === "approval" ||
      b.kind === "artifact" ||
      b.kind === "compaction" ||
      b.kind === "contextClear" ||
      b.kind === "toolGroupNotice" ||
      (b.kind === "thinking" && showThinking) ||
      (b.kind === "tool" && toolBlockIsVisible(b, showTools)),
  );

  return Boolean(hasVisibleBlock || progress || message.error);
}

function loadLazyBlock(
  onLoad: Props["onLoadTimelineBlock"],
  ref: LazyBlockRef | undefined,
): void {
  if (!ref) return;
  onLoad?.(ref.entryId, ref.blockIndex, ref.kind);
}

/**
 * A thinking block whose withheld body is fetched (lazy, from the log) or
 * subscribed to (live, from the stream) for exactly as long as it is expanded
 * and near the viewport — whether the reader opened it, the transcript's
 * expand-all did, or it opened itself while streaming.
 */
function LazyThinkingBlock({
  block,
  streaming,
  defaultOpen,
  onLoadTimelineBlock,
  onLiveBodyDemand,
}: {
  block: Extract<DisplayBlock, { kind: "thinking" }>;
  streaming: boolean;
  defaultOpen: boolean;
  onLoadTimelineBlock?: Props["onLoadTimelineBlock"];
  onLiveBodyDemand?: Props["onLiveBodyDemand"];
}) {
  const [visible, setVisible] = useState(false);
  const { lazy, live } = block;
  useEffect(() => {
    if (visible) loadLazyBlock(onLoadTimelineBlock, lazy);
  }, [visible, lazy, onLoadTimelineBlock]);
  // Keyed on the identity, not the ref: a ref is replaced on every progress
  // frame, the demand only changes when the body appears, lands, or hides.
  const liveStream = live?.streamId;
  const liveIndex = live?.blockIndex;
  useEffect(() => {
    if (
      !visible ||
      !onLiveBodyDemand ||
      liveStream === undefined ||
      liveIndex === undefined
    )
      return;
    const key: LiveBodyKey = {
      streamId: liveStream,
      blockIndex: liveIndex,
      kind: "thinking",
    };
    onLiveBodyDemand(key, true);
    return () => onLiveBodyDemand(key, false);
  }, [visible, liveStream, liveIndex, onLiveBodyDemand]);
  return (
    <ThinkingBlock
      streaming={streaming}
      defaultOpen={defaultOpen}
      bodyAvailable={
        block.text.trim().length > 0 ||
        (lazy?.fullLength ?? 0) > 0 ||
        (live?.length ?? 0) > 0
      }
      onBodyVisibilityChange={setVisible}
    >
      {block.text}
    </ThinkingBlock>
  );
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  originLabel,
  chatCommentable = false,
  toolCommentTargets,
  view,
  onAcceptCommitDryRun,
  onCreateDraftSession,
  onOpenTask,
  onOpenWorktree,
  onRetryWorktreeProvision,
  onApplyTaskStatusSuggestion,
  models,
  defaultModel,
  defaultThinkingLevel,
  sessionReferences = [],
  changedFiles = [],
  paObjectReferences = [],
  onOpenSession,
  onOpenChangedFile,
  onOpenPaObject,
  onResolveApproval,
  approvalGrants,
  onRevokeApprovalGrant,
  accountModels,
  onChoosePullRequestTask,
  onPullRequestCardAction,
  sessionBusy,
  sessionWorktreeId,
  worktreeLiveSiblings,
  pendingQuestion,
  answeredQuestions,
  onRespondToQuestion,
  questionResponseNotice,
  onLoadTimelineBlock,
  onLiveBodyDemand,
  actions,
  finalResponseSeparatorBeforeBlock,
}: Props) {
  const { blocks, streaming } = message;
  const last = blocks[blocks.length - 1];
  const progress = streaming ? activityLabel(last) : null;

  // A turn whose only blocks are thinking/tools renders nothing when those are
  // hidden, avoiding empty spacing between visible turns.
  if (!canRenderAssistantMessage(message, view.showThinking, view.showTools))
    return null;

  const toolCtx: ToolRenderContext & {
    showTools: boolean;
    expandTools: boolean;
  } = {
    showTools: view.showTools,
    expandTools: view.expandTools,
    wrapLines: view.wrapToolLines,
    ...(onCreateDraftSession !== undefined ? { onCreateDraftSession } : {}),
    ...(onOpenTask !== undefined ? { onOpenTask } : {}),
    ...(onApplyTaskStatusSuggestion !== undefined
      ? { onApplyTaskStatusSuggestion }
      : {}),
    ...(onOpenSession !== undefined ? { onOpenSession } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(defaultThinkingLevel !== undefined ? { defaultThinkingLevel } : {}),
    ...(pendingQuestion !== undefined ? { pendingQuestion } : {}),
    ...(answeredQuestions !== undefined ? { answeredQuestions } : {}),
    ...(onRespondToQuestion !== undefined ? { onRespondToQuestion } : {}),
    ...(questionResponseNotice !== undefined ? { questionResponseNotice } : {}),
    ...(onLoadTimelineBlock !== undefined ? { onLoadTimelineBlock } : {}),
    ...(onLiveBodyDemand !== undefined ? { onLiveBodyDemand } : {}),
  };

  const renderBlock = (block: DisplayBlock, i: number) => {
    if (block.kind === "text") {
      return (
        <div
          key={i}
          {...(chatCommentable
            ? {
                "data-chat-comment-target": "",
                "data-chat-entry-id": message.id,
                "data-chat-block-index": i,
                "data-chat-render-block-index": i,
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
            tableLayout="breakout"
          />
        </div>
      );
    }
    if (block.kind === "thinking") {
      if (!view.showThinking) return null;
      const isLast = i === blocks.length - 1;
      return (
        <LazyThinkingBlock
          key={i}
          block={block}
          streaming={Boolean(streaming) && isLast}
          defaultOpen={view.expandThinking}
          onLoadTimelineBlock={onLoadTimelineBlock}
          onLiveBodyDemand={onLiveBodyDemand}
        />
      );
    }
    if (block.kind === "tool") {
      const target = toolCommentTargets?.get(i);
      const rendered = renderToolBlock(
        block,
        target ? { ...toolCtx, commentTarget: target } : toolCtx,
      );
      if (!rendered) return null;
      return target ? (
        <div
          key={i}
          data-chat-comment-named-target=""
          data-chat-entry-id={target.entryId}
          data-chat-block-index={target.blockIndex}
          data-chat-render-block-index={i}
        >
          {rendered}
        </div>
      ) : (
        <Fragment key={i}>{rendered}</Fragment>
      );
    }
    if (block.kind === "commit") {
      return (
        <Suspense key={i} fallback={<LazyCardFallback />}>
          <LazyCommitCard
            commit={block.commit}
            onAccept={onAcceptCommitDryRun}
          />
        </Suspense>
      );
    }
    if (block.kind === "push") {
      return (
        <Suspense key={i} fallback={<LazyCardFallback />}>
          <LazyPushCard push={block.push} />
        </Suspense>
      );
    }
    if (block.kind === "pullRequest") {
      return (
        <Suspense key={i} fallback={<LazyCardFallback />}>
          <LazyPullRequestCard
            pullRequest={block.pullRequest}
            sessionBusy={sessionBusy}
            sessionWorktreeId={sessionWorktreeId}
            worktreeLiveSiblings={worktreeLiveSiblings}
            onChooseTask={onChoosePullRequestTask}
            onAction={onPullRequestCardAction}
          />
        </Suspense>
      );
    }
    if (block.kind === "worktreeProvision") {
      return (
        <Suspense key={i} fallback={<LazyCardFallback />}>
          <LazyWorktreeProvisionCard
            provision={block.provision}
            onRetry={onRetryWorktreeProvision}
            onOpenWorktree={onOpenWorktree}
          />
        </Suspense>
      );
    }
    if (block.kind === "artifact") {
      return <ServedFileCard key={i} file={block.artifact} />;
    }
    if (block.kind === "compaction") {
      return (
        <CompactionCard
          key={i}
          compaction={block.compaction}
          sessionReferences={sessionReferences}
          changedFiles={changedFiles}
          paObjectReferences={paObjectReferences}
          onOpenSession={onOpenSession}
          onOpenChangedFile={onOpenChangedFile}
          onOpenPaObject={onOpenPaObject}
        />
      );
    }
    if (block.kind === "contextClear") {
      return <ContextClearCard key={i} contextClear={block.contextClear} />;
    }
    if (block.kind === "toolGroupNotice") {
      return (
        <ToolGroupNoticeCard
          key={i}
          title={block.title}
          summary={block.summary}
          tools={block.tools}
        />
      );
    }
    if (block.kind === "approval") {
      return (
        <Suspense key={i} fallback={<LazyCardFallback />}>
          <LazyApprovalCard
            approval={block.approval}
            onResolve={onResolveApproval}
            grants={approvalGrants}
            onRevokeGrant={onRevokeApprovalGrant}
            accountModels={accountModels}
            onOpenSession={onOpenSession}
          />
        </Suspense>
      );
    }
    return null;
  };

  return (
    <div className="group/message flex">
      {/* One uniform vertical rhythm for every block (text / thinking / tool /
          cards / progress / error). `gap-3` is the sole spacer; `[&>*]:!my-0`
          cancels each block's own margins so cards (my-2) and zero-margin
          thinking/tool blocks all sit the same distance apart — and it matches
          the assistant-row gap in MessageList so spacing is stable whether the
          turn renders as one streaming message or splits into committed rows. */}
      <div className="assistant-message-content flex min-w-0 flex-1 flex-col gap-3 [&>*]:!my-0">
        {originLabel ? (
          <div className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/20 bg-accent px-2 py-0.5 text-xs font-medium text-primary">
            <Bot size={11} className="shrink-0" />
            <span className="min-w-0 truncate">{originLabel}</span>
          </div>
        ) : null}
        {blocks.map((block, i) => {
          // The "before final response" separator: marks where the tool loop
          // ended and the final answer begins. `renderBlock` returns null for a
          // hidden block, so only draw the rule when the boundary block renders.
          const content = renderBlock(block, i);
          if (i !== finalResponseSeparatorBeforeBlock || !content)
            return content;
          return (
            <Fragment key={i}>
              <hr className="border-border/60" />
              {content}
            </Fragment>
          );
        })}

        {progress && <ProgressIndicator label={progress} />}

        {message.error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-sm text-destructive">
            <AlertTriangle size={13} />
            {message.error}
          </div>
        )}

        {actions}
      </div>
    </div>
  );
});
