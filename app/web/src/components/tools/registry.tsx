import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import type {
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentType,
  AnsweredAgentQuestion,
  CommitDisplay,
  DisplayBlock,
  KnowledgeEntryCard,
  ModelOption,
  PushDisplay,
  TaskStatus,
  ThinkingLevel,
} from "@assistant/shared";
import type {
  LazyBlockKind,
  LazyBlockRef,
  LiveBodyKey,
} from "@assistant/shared/session";
import { ToolCallBlock, type ToolStatus } from "../common/ToolCallBlock.tsx";
import { PeerPromptCardView } from "../PeerPromptCard.tsx";
import { KnowledgeEntryToolCard } from "../KnowledgeEntryToolCard.tsx";
import { ServedFileCard } from "../ServedFileCard.tsx";
import { TaskManageToolCard } from "../TaskManageToolCard.tsx";
import { CollapsibleOutput } from "../common/CollapsibleOutput.tsx";
import {
  BashBody,
  EditDiffBody,
  FileExcerptBody,
} from "./NativeToolBodies.tsx";
import { JsonView } from "../common/JsonView.tsx";
import {
  acceptsAgentQuestionCard,
  acceptsGoogleWorkspaceCard,
  acceptsJiraCard,
  acceptsWorkshopDraftHandoffCard,
  knowledgeEntryCardOf,
  peerPromptCardOf,
  showFilesCardRowsOf,
  taskManagePayloadOf,
  worktreeCommitDisplayOf,
  worktreePushDisplayOf,
  type ShowFilesCardRow,
  type ToolCardCandidate,
} from "@assistant/shared/toolCards";
import { resolveShowFilesTarget } from "../../lib/showFilesCard.ts";
import { normalizedToolName } from "./toolName.ts";

export type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

/**
 * Callbacks/data the rich domain cards need, threaded from `AssistantMessage`.
 * All optional so body renderers (which need none of them) can ignore them.
 */
export interface ToolRenderContext {
  /** Ephemeral transcript target for the rendered tool-result body. */
  commentTarget?: { entryId: string; blockIndex: number };
  onCreateDraftSession?: (
    agentType: AgentType,
    draftText: string,
    notice?: string,
  ) => void;
  onOpenTask?: (taskId: string) => void;
  /**
   * Answer an agent's status suggestion from the transcript. It is an ordinary
   * user save (the same one the Backlog's Focus row sends) and deliberately
   * resumes nothing, so confirming costs no provider call.
   */
  onApplyTaskStatusSuggestion?: (task: {
    id: string;
    status: TaskStatus;
  }) => void;
  onOpenSession?: (id: string) => void;
  models?: ModelOption[];
  defaultModel?: ModelOption;
  defaultThinkingLevel?: ThinkingLevel;
  /** Live pending question flow for this session (drives the in-band ask_questions form). */
  pendingQuestion?: AgentQuestionRequest;
  /** Resolved question flows, so an answered ask_questions card shows the recorded answers. */
  answeredQuestions?: AnsweredAgentQuestion[];
  onRespondToQuestion?: (response: AgentQuestionResponse) => void;
  /** Said on the question card when its answers will have to wait for a turn to end. */
  questionResponseNotice?: string;
  onLoadTimelineBlock?: (
    entryId: string,
    blockIndex: number,
    kind: LazyBlockKind,
  ) => void;
  /** A rendered body starts/stops showing a LIVE block (see `AssistantActions.setLiveBodyDemand`). */
  onLiveBodyDemand?: (key: LiveBodyKey, wanted: boolean) => void;
  /**
   * Wrap long lines in native tool bodies instead of scrolling them (the chat
   * header's "Wrap long lines"). Off unless the user turns it on.
   */
  wrapLines?: boolean;
}

interface ToolRenderer {
  /**
   * Does this renderer apply to this specific block? For cards this encodes the
   * old `shouldRenderX` (name + args.render + output.renderKind + done/!isError).
   * For body renderers it's just a name match.
   */
  match: (block: ToolBlock) => boolean;
  /**
   * `"card"`: a standalone domain widget that REPLACES the whole tool
   * presentation and shows even when tools are hidden (no `ToolCallBlock`
   * wrapper). `"body"`: fills the body of a `ToolCallBlock` disclosure; only
   * shown when tools are visible.
   */
  variant: "card" | "body";
  render: (block: ToolBlock, ctx: ToolRenderContext) => ReactNode;
}

// --- Lazy-loaded heavy domain cards (preserve code-splitting) ----------------

const LazyGoogleWorkspaceToolCard = lazy(() =>
  import("../GoogleWorkspaceToolCard.tsx").then((m) => ({
    default: m.GoogleWorkspaceToolCard,
  })),
);
const LazyJiraToolCard = lazy(() =>
  import("../JiraToolCard.tsx").then((m) => ({ default: m.JiraToolCard })),
);
const LazyWorkshopDraftHandoffToolCard = lazy(() =>
  import("../WorkshopDraftHandoffCard.tsx").then((m) => ({
    default: m.WorkshopDraftHandoffToolCard,
  })),
);
const LazyAgentQuestionToolCard = lazy(() =>
  import("../AgentQuestionToolCard.tsx").then((m) => ({
    default: m.AgentQuestionToolCard,
  })),
);
const LazyCommitToolCard = lazy(() =>
  import("../CommitCard.tsx").then((m) => ({ default: m.CommitCard })),
);
const LazyPushToolCard = lazy(() =>
  import("../PushCard.tsx").then((m) => ({ default: m.PushCard })),
);

function LazyCardFallback({ label = "Opening card…" }: { label?: string }) {
  return (
    <div className="my-2 rounded-xl border border-line bg-panel px-3 py-2 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

// --- shouldRenderX helpers (moved verbatim from AssistantMessage) ------------

/**
 * Card decisions come from `@assistant/shared/toolCards`, the ONE rule this
 * registry and the server's payload policy share: a payload the server keeps
 * whole on the wire is exactly a payload one of these renders. `done` is the
 * client's own precondition — a card is drawn from a completed result — and
 * is applied here, on top of the shared rule.
 */
function candidateOf(block: ToolBlock): ToolCardCandidate {
  return {
    name: block.name,
    args: block.args,
    output: block.output,
    isError: block.isError,
  };
}

function shouldRenderGoogleWorkspaceTool(block: ToolBlock): boolean {
  return block.done && acceptsGoogleWorkspaceCard(candidateOf(block));
}

function shouldRenderJiraTool(block: ToolBlock): boolean {
  return block.done && acceptsJiraCard(candidateOf(block));
}

function shouldRenderWorkshopDraftHandoffTool(block: ToolBlock): boolean {
  return block.done && acceptsWorkshopDraftHandoffCard(candidateOf(block));
}

/**
 * Only a payload that yields a VALID card matches: a partial, streaming or
 * malformed one has no card to show, so it stays an ordinary tool block rather
 * than a half-rendered card (the message is rendered as Markdown, and a
 * non-string there would throw inside the renderer). Unlike the other cards
 * this one also shows while the tool is still running — the sent half of a
 * peer exchange is a card from the moment it is queued.
 */
function peerPromptCardFrom(
  block: ToolBlock,
): import("@assistant/shared").PeerPromptCard | null {
  return peerPromptCardOf(candidateOf(block));
}

/**
 * Task MUTATIONS only: `task_manage` carries the `taskManage` render kind and
 * `task_read` deliberately does not, so a read stays an ordinary tool body while
 * a created Task or a status suggestion stays visible with tools hidden.
 */
function shouldRenderTaskManageTool(block: ToolBlock): boolean {
  return block.done && taskManagePayloadOf(candidateOf(block)) !== null;
}

function worktreeCommitDisplay(block: ToolBlock): CommitDisplay | null {
  return block.done ? worktreeCommitDisplayOf(candidateOf(block)) : null;
}

function worktreePushDisplay(block: ToolBlock): PushDisplay | null {
  return block.done ? worktreePushDisplayOf(candidateOf(block)) : null;
}

/**
 * `show_files` puts the files THEMSELVES in the chat: the card is the whole
 * point of the call, so it renders with tools hidden, and a payload that yields
 * no file stays an ordinary tool block rather than an empty card.
 */
function showFilesCardFrom(block: ToolBlock): ShowFilesCardRow[] | null {
  return block.done
    ? showFilesCardRowsOf(candidateOf(block), resolveShowFilesTarget)
    : null;
}

/**
 * `kb_show` exists to put a Knowledge Base file in front of the reader, so its
 * card shows with tools hidden; a payload that names no file stays an ordinary
 * tool block.
 */
function knowledgeEntryCardFrom(block: ToolBlock): KnowledgeEntryCard | null {
  return block.done ? knowledgeEntryCardOf(candidateOf(block)) : null;
}

function shouldRenderAgentQuestionTool(block: ToolBlock): boolean {
  // Always render the ask_questions flow in-band (interactive while pending, then a
  // read-only Q&A record) regardless of the show-tools toggle.
  return acceptsAgentQuestionCard(candidateOf(block));
}

/** Map a block to one of the native file/shell tool kinds (provider-agnostic), or null. */
function nativeToolKind(
  block: ToolBlock,
): "read" | "write" | "edit" | "bash" | null {
  const n = normalizedToolName(block.name).toLowerCase();
  if (n === "read") return "read";
  if (n === "write") return "write";
  if (n === "edit" || n === "multiedit") return "edit";
  if (n === "bash") return "bash";
  return null;
}

// --- Native-tool body helpers (ported from v2 tool-render.tsx) ---------------

function hasContent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/** First non-empty string among `keys` on the args object. */
function pickString(args: unknown, keys: string[]): string | undefined {
  if (args == null || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

const PATH_KEYS = ["path", "file_path", "filePath"];

function argsPath(block: ToolBlock): string | undefined {
  return pickString(block.args, PATH_KEYS);
}

/** Parse `text` as JSON only when it looks like an object/array; else give up. */
function parseJsonObject(text: string): { ok: boolean; value?: unknown } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("["))
    return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

function OutputBody({ output }: { output: string }) {
  const parsed = parseJsonObject(output);
  if (parsed.ok && typeof parsed.value === "object" && parsed.value !== null) {
    return <JsonView value={parsed.value} />;
  }
  return <CollapsibleOutput text={output} />;
}

/** One find/replace within an `edit` call. */
interface EditPart {
  oldText: string;
  newText: string;
}

/**
 * Read the edits out of an `edit` tool call's args. Accepts
 * `{ edits: [{ oldText, newText }] }` plus a single top-level
 * `old_string`/`new_string` (or `oldText`/`newText`) pair. Returns `null` when
 * the shape isn't recognized so the renderer can fall back to the JSON default.
 */
function readEdits(args: unknown): EditPart[] | null {
  if (args == null || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;

  const list = record["edits"];
  if (Array.isArray(list)) {
    const parts: EditPart[] = [];
    for (const entry of list) {
      if (entry == null || typeof entry !== "object") return null;
      const e = entry as Record<string, unknown>;
      const oldText = e["oldText"] ?? e["old_string"] ?? e["old"];
      const newText = e["newText"] ?? e["new_string"] ?? e["new"];
      if (typeof oldText !== "string" || typeof newText !== "string")
        return null;
      parts.push({ oldText, newText });
    }
    return parts.length > 0 ? parts : null;
  }

  const oldText = record["oldText"] ?? record["old_string"] ?? record["old"];
  const newText = record["newText"] ?? record["new_string"] ?? record["new"];
  if (typeof oldText === "string" && typeof newText === "string") {
    return [{ oldText, newText }];
  }
  return null;
}

/**
 * The fallback tool body: the call's `args` as a JSON tree (when non-empty) and
 * its `output` as a JSON tree (when the text parses to an object/array) or plain
 * truncatable text otherwise. Used by MCP and otherwise-unknown tools.
 */
function defaultToolBody(block: ToolBlock): ReactNode {
  const showInput = hasContent(block.args);
  const showOutput = block.output != null && block.output.length > 0;
  if (!showInput && !showOutput) return null;
  const labeled = showInput && showOutput;

  return (
    <div className="flex flex-col gap-2">
      {showInput && (
        <section className="flex flex-col gap-1">
          {labeled && (
            <span className="text-sm font-medium text-faint">Input</span>
          )}
          <JsonView value={block.args} defaultExpandedDepth={1} />
        </section>
      )}
      {showOutput && (
        <section className="flex flex-col gap-1">
          {labeled && (
            <span className="text-sm font-medium text-faint">Output</span>
          )}
          {!block.done ? (
            // Streaming: incomplete output may not parse — show plain text and
            // upgrade to the structured view once the result is final.
            <CollapsibleOutput text={block.output} />
          ) : (
            <OutputBody output={block.output} />
          )}
        </section>
      )}
    </div>
  );
}

// --- Native-tool body renderers (ported from v2) -----------------------------

/** First line of a `read` excerpt when the payload carries no numbers (pi). */
function readOffset(block: ToolBlock): number | undefined {
  if (block.args == null || typeof block.args !== "object") return undefined;
  const value = (block.args as Record<string, unknown>)["offset"];
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? value
    : undefined;
}

function readBody(block: ToolBlock, wrapLines: boolean): ReactNode {
  if (block.output == null || block.output.length === 0)
    return defaultToolBody(block);
  return (
    <FileExcerptBody
      text={block.output}
      filename={argsPath(block)}
      startLine={readOffset(block)}
      wrap={wrapLines}
    />
  );
}

function writeBody(block: ToolBlock, wrapLines: boolean): ReactNode {
  const content = pickString(block.args, ["content", "contents", "text"]);
  if (content == null) return defaultToolBody(block);
  return (
    <FileExcerptBody
      text={content}
      filename={argsPath(block)}
      wrap={wrapLines}
    />
  );
}

function editBody(block: ToolBlock, wrapLines: boolean): ReactNode {
  const edits = readEdits(block.args);
  if (edits == null) return defaultToolBody(block);
  return (
    <EditDiffBody
      resultDiff={block.resultDiff}
      edits={edits}
      wrap={wrapLines}
    />
  );
}

function bashBody(block: ToolBlock, wrapLines: boolean): ReactNode {
  return (
    <BashBody
      args={block.args}
      output={block.output ?? ""}
      running={!block.done}
      wrap={wrapLines}
    />
  );
}

// --- The registry ------------------------------------------------------------

const TOOL_RENDERERS: ToolRenderer[] = [
  // Cards first — domain widgets that replace the whole tool presentation.
  {
    match: shouldRenderGoogleWorkspaceTool,
    variant: "card",
    render: (block) => (
      <Suspense fallback={<LazyCardFallback />}>
        <LazyGoogleWorkspaceToolCard block={block} />
      </Suspense>
    ),
  },
  {
    match: shouldRenderJiraTool,
    variant: "card",
    render: (block) => (
      <Suspense fallback={<LazyCardFallback />}>
        <LazyJiraToolCard block={block} />
      </Suspense>
    ),
  },
  {
    match: shouldRenderWorkshopDraftHandoffTool,
    variant: "card",
    render: (block, ctx) => (
      <Suspense fallback={<LazyCardFallback />}>
        <LazyWorkshopDraftHandoffToolCard
          block={block}
          onCreateDraftSession={ctx.onCreateDraftSession}
        />
      </Suspense>
    ),
  },
  {
    match: (block) => peerPromptCardFrom(block) !== null,
    variant: "card",
    render: (block, ctx) => {
      const card = peerPromptCardFrom(block);
      return card ? (
        <PeerPromptCardView card={card} onOpenSession={ctx.onOpenSession} />
      ) : null;
    },
  },
  {
    match: shouldRenderTaskManageTool,
    variant: "card",
    render: (block, ctx) => (
      <TaskManageToolCard
        block={block}
        onOpenTask={ctx.onOpenTask}
        onApplyTaskStatusSuggestion={ctx.onApplyTaskStatusSuggestion}
      />
    ),
  },
  {
    match: (block) => worktreeCommitDisplay(block) !== null,
    variant: "card",
    render: (block) => {
      const commit = worktreeCommitDisplay(block);
      return commit ? (
        <Suspense fallback={<LazyCardFallback label="Opening commit…" />}>
          <LazyCommitToolCard commit={commit} />
        </Suspense>
      ) : null;
    },
  },
  {
    match: (block) => worktreePushDisplay(block) !== null,
    variant: "card",
    render: (block) => {
      const push = worktreePushDisplay(block);
      return push ? (
        <Suspense fallback={<LazyCardFallback label="Opening push…" />}>
          <LazyPushToolCard push={push} />
        </Suspense>
      ) : null;
    },
  },
  {
    match: (block) => showFilesCardFrom(block) !== null,
    variant: "card",
    render: (block) => {
      const rows = showFilesCardFrom(block);
      return rows ? (
        <>
          {rows.map((row, index) => (
            <ServedFileCard key={`${index}:${row.url}`} file={row} />
          ))}
        </>
      ) : null;
    },
  },
  {
    match: (block) => knowledgeEntryCardFrom(block) !== null,
    variant: "card",
    render: (block) => {
      const card = knowledgeEntryCardFrom(block);
      return card ? <KnowledgeEntryToolCard card={card} /> : null;
    },
  },
  {
    match: shouldRenderAgentQuestionTool,
    variant: "card",
    render: (block, ctx) => (
      <Suspense fallback={<LazyCardFallback label="Opening question…" />}>
        <LazyAgentQuestionToolCard
          block={block}
          pendingQuestion={ctx.pendingQuestion}
          answeredQuestions={ctx.answeredQuestions}
          onRespond={ctx.onRespondToQuestion}
          notice={ctx.questionResponseNotice}
        />
      </Suspense>
    ),
  },
  // Native-tool body renderers — provider-agnostic name match (pi's `read`/`edit`/
  // `bash`/`write` and the Claude SDK's `Read`/`Edit`/`MultiEdit`/`Bash`/`Write`),
  // filling a ToolCallBlock body.
  {
    match: (b) => nativeToolKind(b) === "read",
    variant: "body",
    render: (b, ctx) => readBody(b, Boolean(ctx.wrapLines)),
  },
  {
    match: (b) => nativeToolKind(b) === "write",
    variant: "body",
    render: (b, ctx) => writeBody(b, Boolean(ctx.wrapLines)),
  },
  {
    match: (b) => nativeToolKind(b) === "edit",
    variant: "body",
    render: (b, ctx) => editBody(b, Boolean(ctx.wrapLines)),
  },
  {
    match: (b) => nativeToolKind(b) === "bash",
    variant: "body",
    render: (b, ctx) => bashBody(b, Boolean(ctx.wrapLines)),
  },
];

// --- Entry points ------------------------------------------------------------

/** First of command/cmd/path/file_path/pattern/query, else joined keys. */
function loadLazyBlock(
  onLoad: ToolRenderContext["onLoadTimelineBlock"],
  ref: LazyBlockRef | undefined,
): void {
  if (!ref) return;
  onLoad?.(ref.entryId, ref.blockIndex, ref.kind);
}

function summarizeArgs(args: unknown): string {
  if (args && typeof args === "object") {
    const obj = args as Record<string, unknown>;
    const cmd =
      obj.command ??
      obj.cmd ??
      obj.path ??
      obj.file_path ??
      obj.pattern ??
      obj.query;
    if (typeof cmd === "string") return cmd;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "";
    return keys.join(", ");
  }
  return typeof args === "string" ? args : "";
}

function toolStatus(block: ToolBlock): ToolStatus {
  return !block.done ? "running" : block.isError ? "error" : "success";
}

function outputLineCount(block: ToolBlock): number | undefined {
  if (!block.done) return undefined;
  if (block.outputLazy?.lineCount !== undefined)
    return block.outputLazy.lineCount;
  if (block.outputLive?.lineCount !== undefined)
    return block.outputLive.lineCount;
  if (block.output.length === 0) return undefined;
  return block.output.split("\n").length;
}

/**
 * Whether a generic disclosure has anything to open: content in hand, or a
 * withheld body (lazy on the log, live on the stream) that arrives once the
 * block is expanded and visible. Decided from refs, not from the text — the
 * text is empty precisely BECAUSE it has not been asked for yet.
 */
function toolBodyAvailable(block: ToolBlock): boolean {
  return (
    hasContent(block.args) ||
    block.output.length > 0 ||
    block.argsLazy !== undefined ||
    block.outputLazy !== undefined ||
    block.argsLive !== undefined ||
    block.outputLive !== undefined
  );
}

/**
 * The generic disclosure: a `ToolCallBlock` whose body is built only once it
 * is expanded and has been near the viewport, whose withheld bodies are
 * fetched the moment it is visible (whether the reader opened it or the
 * transcript's expand-all did), and whose live bodies are subscribed to for
 * exactly as long as it can be seen.
 */
function GenericToolBlock({
  block,
  ctx,
}: {
  block: ToolBlock;
  ctx: ToolRenderContext & { showTools: boolean; expandTools: boolean };
}) {
  const [visible, setVisible] = useState(false);
  const { onLoadTimelineBlock, onLiveBodyDemand } = ctx;
  const { argsLazy, outputLazy, argsLive, outputLive } = block;
  useEffect(() => {
    if (!visible) return;
    loadLazyBlock(onLoadTimelineBlock, argsLazy);
    loadLazyBlock(onLoadTimelineBlock, outputLazy);
  }, [visible, argsLazy, outputLazy, onLoadTimelineBlock]);
  // Keyed on the identities, not the refs: a ref is replaced on every progress
  // frame, the demand only changes when a body appears, goes durable, or hides.
  const argsStream = argsLive?.streamId;
  const argsIndex = argsLive?.blockIndex;
  const outputStream = outputLive?.streamId;
  const outputIndex = outputLive?.blockIndex;
  useEffect(() => {
    if (!visible || !onLiveBodyDemand) return;
    const keys: LiveBodyKey[] = [];
    if (argsStream !== undefined && argsIndex !== undefined)
      keys.push({
        streamId: argsStream,
        blockIndex: argsIndex,
        kind: "toolInput",
      });
    if (outputStream !== undefined && outputIndex !== undefined)
      keys.push({
        streamId: outputStream,
        blockIndex: outputIndex,
        kind: "toolOutput",
      });
    for (const key of keys) onLiveBodyDemand(key, true);
    return () => {
      for (const key of keys) onLiveBodyDemand(key, false);
    };
  }, [
    visible,
    argsStream,
    argsIndex,
    outputStream,
    outputIndex,
    onLiveBodyDemand,
  ]);

  const summary = block.argsSummary ?? summarizeArgs(block.args);
  const matched = TOOL_RENDERERS.find((r) => r.match(block));
  const available = toolBodyAvailable(block);
  const renderBody = () => {
    const body = matched ? matched.render(block, ctx) : defaultToolBody(block);
    // Expanded before its body arrived: hold the height rather than the row.
    const shown = body ?? <div className="min-h-8" aria-busy="true" />;
    return ctx.commentTarget ? (
      <div
        data-chat-comment-target=""
        data-chat-entry-id={ctx.commentTarget.entryId}
        data-chat-block-index={ctx.commentTarget.blockIndex}
      >
        {shown}
      </div>
    ) : (
      shown
    );
  };
  return (
    <ToolCallBlock
      name={normalizedToolName(block.name)}
      status={toolStatus(block)}
      summary={summary || undefined}
      lineCount={outputLineCount(block)}
      defaultOpen={ctx.expandTools}
      onBodyVisibilityChange={setVisible}
    >
      {available ? renderBody : undefined}
    </ToolCallBlock>
  );
}

/**
 * The node to render for a tool block, or `null` when it should be hidden.
 *
 * Resolution: first matching renderer. If it's a `"card"`, render it (always
 * visible). Otherwise (body match or none): if `!showTools` return `null`; else
 * wrap the matched body renderer (or {@link defaultToolBody}) in a
 * `ToolCallBlock`, expanded when `ctx.expandTools` (the chat header's
 * expand/collapse-all tool control) is on.
 */
export function renderToolBlock(
  block: ToolBlock,
  ctx: ToolRenderContext & { showTools: boolean; expandTools: boolean },
): ReactNode {
  const matched = TOOL_RENDERERS.find((r) => r.match(block));
  if (matched?.variant === "card") {
    const card = matched.render(block, ctx);
    return ctx.commentTarget ? (
      <div
        data-chat-comment-target=""
        data-chat-entry-id={ctx.commentTarget.entryId}
        data-chat-block-index={ctx.commentTarget.blockIndex}
      >
        {card}
      </div>
    ) : (
      card
    );
  }
  if (!ctx.showTools) return null;
  return <GenericToolBlock block={block} ctx={ctx} />;
}

/** True if a card matches (so it's always visible) or `showTools` is on. */
export function toolBlockIsVisible(
  block: ToolBlock,
  showTools: boolean,
): boolean {
  if (showTools) return true;
  const matched = TOOL_RENDERERS.find((r) => r.match(block));
  return matched?.variant === "card";
}
