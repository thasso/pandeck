import {
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
  type ClipboardEvent as ReactClipboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  Check,
  ChevronDown,
  CornerDownRight,
  Cpu,
  GitFork,
  ListPlus,
  Mic,
  Paperclip,
  SendHorizontal,
  Square,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import {
  type ContextInfo,
  type ModelOption,
  type Harness,
  type PromptAttachment,
  type AgentType,
  type SpeechToTextStatus,
  type SessionMode,
  type SessionState,
  type SlashCommandInfo,
  clampThinkingLevelForModel,
  slashCommandApplies,
  type ThinkingLevel,
} from "@assistant/shared";
import type { AssistantActions, ForkDraft } from "../hooks/useAssistant.ts";
import { hasModeAxis } from "../lib/sessionCapabilities.ts";
import { insertTranscript } from "../lib/insertTranscript.ts";
import { refineText } from "../lib/refineText.ts";
import { showToast, TOAST_DWELL_MS } from "../lib/toast.ts";
import { useDictation } from "../hooks/useDictation.ts";
import { useTouchComposerMode } from "../hooks/useTouchComposerMode.ts";
import type {
  NewPendingChatComment,
  PendingChatCommentsController,
} from "../hooks/usePendingChatComments.ts";
import {
  serializeChatCommentPrompt,
  type PendingChatComment,
} from "../lib/chatCommentPrompt.ts";
import {
  clearBrowserDraft,
  useBrowserDraft,
} from "../hooks/useBrowserDraft.ts";
import {
  DictationDiscardButton,
  DictationLiveRegion,
  DictationToggleButton,
  DictationTrace,
  isDictationRecording,
  type DictationControlsData,
} from "./DictationControls.tsx";
import { AGENT_TYPE_DISPLAY } from "./agentTypeDisplay.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "./ui/input-group.tsx";
import { Badge } from "./ui/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { Item } from "./ui/item.tsx";
import { IconButton } from "./common/IconButton.tsx";
import { AttachmentThumbnail } from "./common/AttachmentThumbnail.tsx";
import { Switch } from "./ui/switch.tsx";
import { Command, CommandItem, CommandList } from "./ui/command.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import {
  ModelSelect,
  THINKING_LABELS,
  ThinkingSelect,
} from "./common/ModelThinkingSelect.tsx";
import {
  COMPOSER_ACTION_CLUSTER_CLASS,
  COMPOSER_ACTION_ROW_CLASS,
  COMPOSER_CARD_COLLAPSED_CLASS,
  COMPOSER_CARD_DRAG_SKIN_CLASS,
  COMPOSER_FIELD_CLASS,
  COMPOSER_FIELD_MAX_HEIGHT,
  autosizeComposerField,
  COMPOSER_SHELL_CLASS,
  COMPOSER_SHELL_PADDING_CLASS,
  composerFoldClass,
} from "./common/composerShell.ts";
import { ProviderIcon } from "./common/ProviderIcon.tsx";
import { EmptyBox } from "./common/load.tsx";
import { ChatDockPanel } from "./ChatDockPanel.tsx";
import { ComposerLedge } from "./ComposerLedge.tsx";
import { usePerfRenderCount } from "../lib/perfStats.ts";

interface BranchNavItem {
  id?: string;
  title: string;
  subtitle?: string;
  onOpen: () => void;
}

export interface BranchPanelInfo {
  currentTitle: string;
  parent?: BranchNavItem;
  children: BranchNavItem[];
}

interface Props {
  onSend: (text: string, attachments?: PromptAttachment[]) => void;
  /**
   * Queue a message behind the running turn, sent as the next turn once it
   * ends (`promptQueue.ts`). Its presence is what offers Queue while a turn
   * runs; a surface with no queue (the permanent Assistant) omits it. A queued
   * host command carries `command` and keeps its `/` in `text`.
   */
  onQueue?: (item: {
    text: string;
    attachments?: PromptAttachment[];
    command?: { name: string; rawArgs: string };
    /** Steer it into the running turn as soon as it is queued (Alt+Enter). */
    steerNow?: boolean;
  }) => void;
  onAbort: () => void;
  streaming: boolean;
  disabled: boolean;
  contextInfo: ContextInfo | null;
  session: SessionState | null;
  models: ModelOption[];
  slashCommands: SlashCommandInfo[];
  /**
   * Handle a slash command whose registry entry says `execution: "client"`
   * (e.g. /review, which navigates to a prefilled new-session draft). Returns
   * an inline error to show under the composer, or null when handled. A
   * surface that omits this refuses such commands with an error rather than
   * dispatching them to the server.
   */
  onClientSlashCommand?: (name: string, rawArgs: string) => string | null;
  actions: AssistantActions;
  focusToken?: number;
  draft?: ForkDraft | null;
  /**
   * The staged draft landed in the field, by token. A host holding it in state
   * that survives this composer (the reducer's fork draft does) must drop it
   * here: from now on the text belongs to the composer, and re-staging it on a
   * remount would undo every edit, clear and send since.
   */
  onDraftConsumed?: (token: number) => void;
  /** Whether a newly supplied draft should focus the textarea. Disable for touch-first staging flows. */
  draftAutoFocus?: boolean;
  branchInfo?: BranchPanelInfo | null;
  /**
   * Keep the fixed hint slot above the card, where a send-blocking hint can
   * appear (the new-session surface), so a hint coming and going never shifts
   * the layout.
   */
  reserveHintSlot?: boolean | undefined;
  /**
   * When set, sending is blocked and this reason renders as a hint above the
   * composer (the new-session landing's Worktree row is where it is answered). Used while a
   * Developer session is staged without the worktree it requires.
   */
  sendBlockedReason?: string | undefined;
  /** Disable Send without adding a second narration for a source described elsewhere. */
  sendBlocked?: boolean;
  isModelDisabled?: (model: ModelOption) => boolean;
  modelLocked?: boolean;
  thinkingLocked?: boolean;
  /**
   * The account the session runs on, for the runtime line under the card once
   * model and thinking are locked (a started session).
   */
  accountName?: string | undefined;
  /** Hide runtime model/thinking controls for server-configured special sessions. */
  hideRuntimeControls?: boolean;
  /**
   * A resting strip on the card's top edge (`ComposerLedge`): session state
   * that stays visible while the conversation goes on. Rendered above the card
   * in normal flow, joined to it while the card is visible and standing alone
   * on the dock's row while a phone has hidden the card.
   */
  ledge?: ReactNode;
  /**
   * Mobile viewport. Enables the focus-driven collapse (expanded only while the
   * composer is engaged; collapsed otherwise) so the virtual keyboard stays
   * under the user's control. Desktop keeps the composer permanently expanded.
   */
  mobile?: boolean;
  /**
   * Mobile: called when the composer starts or stops occupying the bottom edge —
   * expanded, or recording in its bar. The object dock's action row is the resting
   * bottom edge on a session screen (app/web/docs/ui-shell.md, Small Screens), so
   * the host stands that row down while this is true instead of stacking two bars.
   */
  onVisibilityChange?: (visible: boolean) => void;
  /**
   * Mobile: the unsent draft as the host should SHOW it while this composer is
   * hidden — its dock row is the resting composer and puts this on the face of its
   * field, since there is no collapsed bar here to show it. Emitted only while
   * hidden (and bounded), so typing costs the host nothing: a callback per keystroke
   * would re-render the transcript behind it.
   */
  onDraftPreviewChange?: (draft: string) => void;
  /**
   * Escape hatch for a host that owns the control which opens this composer — the
   * dock's compose action. iOS Safari only raises the keyboard for a focus INSIDE
   * the user gesture, so that host has to call focus synchronously from its own
   * handler; a token prop lands a frame later and costs the keyboard.
   */
  openRef?: RefObject<(() => void) | null>;
  /**
   * The same escape hatch for the file picker: the dock's row offers the paperclip
   * when a session hangs off no object, and the input it has to click lives in here.
   * Picking a file stages an attachment, which forces this composer open by itself.
   */
  attachRef?: RefObject<(() => void) | null>;
  /**
   * And for Send: the dock's row ends in the composer's own primary action, so a
   * draft can leave without opening the composer to press the same button again.
   * A ref rather than a prop callback because the draft lives HERE — the host only
   * ever sees a bounded preview of it (`onDraftPreviewChange`), which is not what
   * gets sent. Where sending is refused this OPENS instead: the reason is the
   * composer's own hint, and a closed composer is not showing it.
   */
  submitRef?: RefObject<(() => void) | null>;
  /**
   * Mobile: hand dictation to the host instead of recording here. The dock's action
   * row renders the trace, so it owns the recorder — this composer remembers its
   * caret, drops focus (which closes it and reveals that row) and asks the host to
   * start. Its presence also stands this composer's own recorder down, so there is
   * never a second owner competing for the microphone.
   */
  onRequestDictation?: (() => void) | undefined;
  /** Mobile: a finished transcript from the host's recorder, inserted at the remembered caret. */
  transcript?: { spoken: string; token: number } | null;
  /** Pre-session agent type shown in the top-left agent picker (before first message). */
  selectedAgentType?: AgentType | undefined;
  availableAgentTypes?: AgentType[] | undefined;
  onAgentTypeChange?: ((agentType: AgentType) => void) | undefined;
  /**
   * Persist the draft text browser-locally under this key: restored on mount
   * and key change, cleared on send. Give each composer instance its own key.
   */
  draftStorageKey?: string;
  /** Browser-local transcript comments submitted with this draft. */
  chatComments?: PendingChatCommentsController | undefined;
  /** A transcript anchor captured by MessageList for the shared comment mode. */
  commentDraft?: Omit<NewPendingChatComment, "body"> | null;
  /** Close the shared comment mode after cancel or attach. */
  onCommentDraftChange?: (
    draft: Omit<NewPendingChatComment, "body"> | null,
  ) => void;
  /**
   * Always use the focus-driven collapse regardless of viewport (the inspector
   * footer composer, which must stay compact on desktop too). The main chat
   * composer leaves this off and relies on `mobile` instead.
   */
  collapseWhenBlurred?: boolean;
  /**
   * Dictation availability. `enabled` is the user setting (hides the mic button);
   * `status` is what the server reported at connect — an unconfigured instance
   * (no model deployed, e.g. a PR preview) shows the button disabled with the
   * reason rather than failing at the first press.
   */
  dictation?: { enabled: boolean; status: SpeechToTextStatus | null };
}

interface AttachmentDraft extends PromptAttachment {
  previewUrl?: string;
}

/**
 * TEMPORARY diagnostic for the on-device keyboard-dismiss collapse. Enable in the
 * browser console with `localStorage.composerKbDebug = "1"` to log viewport
 * overlap and the open→closed edge. Remove once the behavior is confirmed.
 */
function composerKeyboardDebugEnabled(): boolean {
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("composerKbDebug") === "1"
    );
  } catch {
    return false;
  }
}

const MAX_ATTACHMENTS = 8;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function formatTokens(value: number | null | undefined): string {
  if (value == null) return "unknown";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 100_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

function formatPercent(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1) return `${value.toFixed(1)}%`;
  return `${value.toFixed(1)}%`;
}

function formatCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

/** Recording duration as `m:ss`, for the dictation indicator. */
function guessMime(file: File): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".md")) return "text/markdown";
  if (name.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

function fileToAttachment(file: File): Promise<AttachmentDraft> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read file."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      const data = comma >= 0 ? result.slice(comma + 1) : result;
      const mimeType = guessMime(file);
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name:
          file.name ||
          (mimeType.startsWith("image/") ? "pasted-image.png" : "attachment"),
        mimeType,
        size: file.size,
        data,
        ...(mimeType.startsWith("image/")
          ? { previewUrl: URL.createObjectURL(file) }
          : {}),
      });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * How full the session's context window is, as text in the runtime strip under
 * the card. It grows with the strip (container queries) so it never crowds out
 * the model and effort: `42%` on a phone, `42% context` from 24rem, plus
 * `181k / 1.00M` from 28rem. Turns the warning colour from 80% on. The full
 * breakdown is its tooltip.
 */
function ContextStatus({ info }: { info: ContextInfo }) {
  const usage = info.context;
  const percent = usage?.percent ?? null;
  const live = info.currentTurn;
  const liveTokens = live ? live.output + live.thinking : 0;
  const cost = formatCost(info.cost);
  const tooltipId = "composer-context-tooltip";

  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        role="meter"
        aria-label="Context usage"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-describedby={tooltipId}
        className={`shrink-0 whitespace-nowrap tabular-nums ${percent !== null && percent >= 80 ? "text-warning" : ""}`}
      >
        {percent !== null ? `${Math.round(percent)}%` : "—"}
        <span className="hidden @sm:inline"> context</span>
        {usage ? (
          <span className="hidden @md:inline">
            {" "}
            · {formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)}
          </span>
        ) : null}
      </TooltipTrigger>
      {/* TooltipContent is a one-line row (`inline-flex items-center`) on an
          inverted surface: stack this panel, and tint with `text-background`. */}
      <TooltipContent
        id={tooltipId}
        side="top"
        className="w-72 max-w-none flex-col items-stretch gap-0"
      >
        <div className="mb-2 flex items-center justify-between gap-3 text-sm font-semibold">
          <span>Context</span>
          <span>{formatPercent(percent)}</span>
        </div>
        <div className="space-y-1 font-mono">
          <ContextRow
            label="Window"
            value={
              usage
                ? `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens`
                : "unknown"
            }
          />
          <ContextRow
            label="Tokens"
            value={`in ${formatTokens(info.tokenUsage.input)} · out ${formatTokens(info.tokenUsage.output)}`}
          />
          {info.tokenUsage.cacheRead > 0 && (
            <ContextRow
              label="Cached in"
              value={formatTokens(info.tokenUsage.cacheRead)}
            />
          )}
          {info.tokenUsage.cacheWrite > 0 && (
            <ContextRow
              label="Cache write"
              value={formatTokens(info.tokenUsage.cacheWrite)}
            />
          )}
          {liveTokens > 0 && (
            <ContextRow label="Live" value={`~${formatTokens(liveTokens)}`} />
          )}
          {cost && <ContextRow label="Cost" value={cost} />}
          <ContextRow
            label="Turns"
            value={`${info.messageCounts.user} turn · ${info.messageCounts.assistant} steps · ${info.messageCounts.toolCalls} tools`}
          />
          <div className="pt-1 text-xs text-background/70">
            Cached input is cumulative across internal model steps; some
            providers report reads but not writes.
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function ContextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <span className="shrink-0 text-background/70">{label}</span>
      <span className="min-w-0 truncate text-right">{value}</span>
    </div>
  );
}

/**
 * Build/Plan picker for coding personas. It follows the other runtime
 * selections rather than making mode the composer's lone segmented control.
 * The labelling is a binding epic decision (Task 305): it says "Plan" and
 * nothing more — no "read-only", no "safe", no lock glyph — because v1 Plan
 * keeps the shell and is a convention, not an enforced boundary.
 */
/**
 * Build/Plan as one switch labelled "Plan" — the word and nothing more (Task
 * 305): Build is the default a session works in and Plan the mode it opts
 * into, so the switch names the exception and off is Build.
 */
export function ModeSelector({
  mode,
  onChange,
}: {
  mode: SessionMode;
  onChange: (mode: SessionMode) => void;
}) {
  return (
    <label
      className="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground select-none hover:text-foreground"
      title={`Session mode: ${mode === "plan" ? "Plan" : "Build"}`}
    >
      <Switch
        size="sm"
        checked={mode === "plan"}
        onCheckedChange={(checked) => onChange(checked ? "plan" : "build")}
        aria-label="Plan mode"
      />
      <span className={mode === "plan" ? "text-foreground" : undefined}>
        Plan
      </span>
    </label>
  );
}

function RuntimeSettingsPanel({
  model,
  models,
  level,
  actions,
  isModelDisabled,
  modelLocked = false,
  thinkingLocked = false,
  agentType,
  availableAgentTypes,
  onAgentTypeChange,
  mode,
}: {
  model: ModelOption | undefined;
  models: ModelOption[];
  level: ThinkingLevel;
  actions: AssistantActions;
  isModelDisabled?: ((model: ModelOption) => boolean) | undefined;
  modelLocked?: boolean;
  thinkingLocked?: boolean;
  // Present only for a fresh, unprompted session — the agent type is fixed once
  // the first prompt is sent.
  agentType?: AgentType | undefined;
  availableAgentTypes?: AgentType[] | undefined;
  onAgentTypeChange?: ((agentType: AgentType) => void) | undefined;
  /** Build/Plan; absent when the session has no mode axis. */
  mode?: SessionMode | undefined;
}) {
  const setModelAndClampThinking = (nextModel: ModelOption) => {
    actions.setModel(nextModel.provider, nextModel.id);
    const clamped = clampThinkingLevelForModel(nextModel, level);
    if (clamped !== level) actions.setThinkingLevel(clamped);
  };

  return (
    <div className="space-y-3 text-sm">
      {agentType && availableAgentTypes && onAgentTypeChange ? (
        <section>
          <div className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Agent
          </div>
          <AgentTypeSelector
            agentType={agentType}
            availableAgentTypes={availableAgentTypes}
            onChange={onAgentTypeChange}
          />
        </section>
      ) : null}

      <section>
        <div className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Model
        </div>
        <ModelSelect
          models={models}
          value={model}
          variant="field"
          locked={modelLocked}
          isModelDisabled={isModelDisabled}
          onChange={setModelAndClampThinking}
        />
      </section>

      <section>
        <div className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Thinking
        </div>
        <ThinkingSelect
          model={model}
          value={level}
          variant="field"
          locked={thinkingLocked}
          onChange={(lvl) => actions.setThinkingLevel(lvl)}
        />
      </section>

      {mode ? (
        <section>
          <div className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Mode
          </div>
          <ModeSelector
            mode={mode}
            onChange={(next) => actions.setSessionMode(next)}
          />
        </section>
      ) : null}
    </div>
  );
}

/**
 * What an empty composer says, wherever it is resting: the textarea's own
 * placeholder, the collapsed bar's label, and the mobile dock row's field face
 * (`SessionDockActions`). One string, because those are three faces of the same
 * input and reading a different invitation on each is how a bottom edge stops
 * looking like the composer it is.
 */
export const COMPOSER_PLACEHOLDER = "Message the assistant…";
/** Its counterpart while a turn runs and none of those faces can accept text. */
export const COMPOSER_STREAMING_LABEL = "Streaming response…";
/**
 * How much of a draft a resting face may carry. It truncates to one line anyway;
 * this keeps a novel-length draft out of the host's state and off the wire between
 * the composer and the dock.
 */
const DRAFT_PREVIEW_MAX_CHARS = 200;

function AgentTypeSelector({
  agentType,
  availableAgentTypes,
  onChange,
}: {
  agentType: AgentType;
  availableAgentTypes: AgentType[];
  onChange: (agentType: AgentType) => void;
}) {
  const current = AGENT_TYPE_DISPLAY[agentType];
  const label = current.label;
  const Icon = current.Icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" />}
        title="Agent type"
      >
        <Icon />
        <span>{label}</span>
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="w-64">
        {availableAgentTypes.map((type) => {
          const display = AGENT_TYPE_DISPLAY[type];
          return (
            <DropdownMenuItem key={type} onClick={() => onChange(type)}>
              <display.Icon />
              <span className="min-w-0 flex-1">
                <span className="block">{display.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {display.desc}
                </span>
              </span>
              {type === agentType ? <Check /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface SlashState {
  active: boolean;
  exact: SlashCommandInfo | undefined;
  items: SlashCommandInfo[];
}

function slashState(
  text: string,
  commands: SlashCommandInfo[],
  agentType: AgentType | undefined,
  harness: Harness | undefined,
): SlashState {
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("\n")) {
    return { active: false, exact: undefined, items: [] };
  }
  const allowed = commands.filter((cmd) =>
    slashCommandApplies(cmd, agentType, harness),
  );
  const body = text.slice(1);
  const match = body.match(/^(\S*)(?:\s+([\s\S]*))?$/);
  const token = match?.[1] ?? "";
  const hasArgs = match?.[2] !== undefined;
  const exact = allowed.find((cmd) => cmd.name === token);
  const items = allowed.filter((cmd) => cmd.name.startsWith(token)).slice(0, 8);
  return { active: !hasArgs, exact, items };
}

/**
 * Match a submitted line against the FULL slash command registry by name —
 * intentionally NOT filtered by applicability. Slash commands are a universal
 * concept: any registered command is intercepted by us and never forwarded to
 * the model. Applicability (agentType/harness) is checked separately so an
 * inapplicable command produces a clear error instead of being sent as a prompt.
 * Returns null for `//…` (literal slash escape) and for unregistered slashes
 * (e.g. a provider's own `/model` — those pass through as normal text).
 */
function matchKnownSlash(text: string, commands: SlashCommandInfo[]) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const match = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1]!;
  const cmd = commands.find((item) => item.name === name);
  if (!cmd) return null;
  return { cmd, rawArgs: match[2] ?? "" };
}

export type SlashSubmit =
  /** Not a registered slash command: submit as an ordinary prompt. */
  | { kind: "send" }
  | { kind: "error"; message: string }
  /** Dispatch `runSlashCommand` to the server. */
  | { kind: "host"; name: string; rawArgs: string }
  /** Handle in the web app via `onClientSlashCommand`; never reaches the wire. */
  | { kind: "client"; name: string; rawArgs: string };

/**
 * What submitting the composer does about slash commands. Pure and exported
 * for tests, because the decision is the contract: a registered command is
 * ALWAYS intercepted (inapplicable ones error instead of going to the model),
 * and a client-execution command never reaches `runSlashCommand`.
 */
export function resolveSlashSubmit(
  value: string,
  commands: SlashCommandInfo[],
  context: {
    agentType?: AgentType;
    harness?: Harness;
    streaming: boolean;
    attachmentCount: number;
    commentCount: number;
  },
): SlashSubmit {
  const command = matchKnownSlash(value, commands);
  if (!command) return { kind: "send" };
  if (!slashCommandApplies(command.cmd, context.agentType, context.harness)) {
    return {
      kind: "error",
      message: `/${command.cmd.name} is not available for this session.`,
    };
  }
  if (context.streaming) {
    return {
      kind: "error",
      message: "Cannot run slash commands while the agent is streaming.",
    };
  }
  if (context.attachmentCount > 0) {
    return {
      kind: "error",
      message: "Slash commands do not support attachments yet.",
    };
  }
  if (context.commentCount > 0) {
    return {
      kind: "error",
      message: "Slash commands do not support attached comments yet.",
    };
  }
  return {
    kind: command.cmd.execution === "client" ? "client" : "host",
    name: command.cmd.name,
    rawArgs: command.rawArgs,
  };
}

/**
 * Memoized: the composer sits under `App`, which re-renders for every socket
 * message — up to several a second while any agent runs, and once per animation
 * frame for the streamed tokens of the chat it is attached to. None of that is
 * about the composer, and re-rendering it re-runs a large body plus its model,
 * thinking, mode and context controls.
 *
 * That makes every prop here a stability contract; `App.tsx` holds the handlers
 * (`submitPrompt` over a ref, since a send reads far too much state for an
 * honest dependency list) and the objects. `composerPropsAudit.test.ts` pins it.
 */
export const Composer = memo(function Composer({
  onSend,
  onQueue,
  onAbort,
  streaming,
  disabled,
  contextInfo,
  session,
  models,
  slashCommands,
  onClientSlashCommand,
  actions,
  focusToken,
  draft,
  onDraftConsumed,
  draftAutoFocus = true,
  branchInfo,
  reserveHintSlot = false,
  sendBlockedReason,
  sendBlocked = false,
  isModelDisabled,
  modelLocked = false,
  thinkingLocked = false,
  accountName,
  hideRuntimeControls = false,
  ledge,
  mobile = false,
  onVisibilityChange,
  onDraftPreviewChange,
  openRef,
  attachRef,
  submitRef,
  onRequestDictation,
  transcript,
  selectedAgentType,
  availableAgentTypes,
  onAgentTypeChange,
  draftStorageKey,
  chatComments,
  commentDraft,
  onCommentDraftChange,
  collapseWhenBlurred = false,
  dictation,
}: Props) {
  usePerfRenderCount("Composer");
  const [text, setText] = useBrowserDraft(draftStorageKey);
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  // Deliberately independent from `text`: leaving comment mode must restore the
  // prompt byte-for-byte, including whitespace the user has not sent yet.
  const [commentBody, setCommentBody] = useState("");
  /**
   * The comment this composer currently holds, if it is EDITING one rather than
   * writing a new one. Selecting a pending comment (from the chip's list, or by
   * tapping its highlight in the transcript) loads it here: one place where a
   * comment is written, whether it exists yet or not, instead of a second
   * editor inside the chip.
   */
  const activeCommentId = chatComments?.activeCommentId ?? null;
  const liveEditing = activeCommentId
    ? (chatComments?.comments.find(
        (comment) => comment.id === activeCommentId,
      ) ?? null)
    : null;
  // The comment as this edit found it. It is what a save is compared against
  // (another tab may change it meanwhile), and it keeps the edit open if the
  // comment is sent or removed elsewhere, so the typed text is never taken
  // away. Seeded when a DIFFERENT comment takes the composer: keying off the
  // body instead would overwrite what is being typed on every keystroke.
  const editBase = useRef<PendingChatComment | null>(null);
  /**
   * Which edit is open. A save resolves after the store's cross-tab lock, by
   * which time the reader may have opened another comment: its answer may act
   * only on the edit that sent it.
   */
  const editGeneration = useRef(0);
  /** The field's text as last rendered, for a save that resolves later. */
  const commentBodyNow = useRef(commentBody);
  commentBodyNow.current = commentBody;
  /** One save of an edit at a time: a second Save waits for the first. */
  const editSavePending = useRef(false);
  if ((editBase.current?.id ?? null) !== activeCommentId) {
    editGeneration.current += 1;
    editBase.current = liveEditing;
    if (liveEditing) setCommentBody(liveEditing.body);
  }
  const editingComment = activeCommentId
    ? (liveEditing ?? editBase.current)
    : null;
  /** Writing a comment, new or existing: the prompt's controls step aside. */
  const commentMode = Boolean(commentDraft || editingComment);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isRefining, setIsRefining] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  // Which accordion field the context sheet starts expanded on. Set by the
  // opener (manual opens reset it to null); the panel remounts per open.
  // Whether the currently-open sheet was opened from OUTSIDE the composer (the
  // hero quick-start "All…", the Developer auto-open). Closing such a sheet must
  // not refocus the textarea — that would pop the mobile keyboard the user never
  // had open. Composer-chrome opens reset this to false.
  const [sheetOpenedExternally, setSheetOpenedExternally] = useState(false);
  const touchComposerMode = useTouchComposerMode();
  const [isFocused, setIsFocused] = useState(false);
  const [composerPinnedOpen, setComposerPinnedOpen] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<AttachmentDraft[]>([]);
  /** Caret at the moment dictation started; the collapse clears the live selection. */
  const caretBeforeDictationRef = useRef<number | null>(null);

  const focusComposer = ({ sync = false }: { sync?: boolean } = {}) => {
    if (sync) {
      flushSync(() => setIsFocused(true));
      ref.current?.focus({ preventScroll: true });
      return;
    }
    setIsFocused(true);
    requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
  };

  /**
   * Set while the mic has been handed to the host's row (`onRequestDictation`).
   * Staged attachments and chat comments normally keep the composer expanded,
   * but the hand-over only works by HIDING it — the dock row that records mounts
   * in its place — so this overrides that hold until the composer is engaged
   * again. Without it a mic tap with a comment chip attached did nothing: the
   * composer stayed up, the row never mounted, and the request expired unseen.
   */
  const [handedToHostDictation, setHandedToHostDictation] = useState(false);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // A new comment and an edit are the SAME slot in this composer, so opening
  // either closes the other; both take the caret, because the user asked to
  // write.
  const selectComment = chatComments?.select;
  useEffect(() => {
    if (!commentDraft) return;
    setCommentBody("");
    selectComment?.(null);
    // Twice: the transcript clears the page selection while it captures the
    // anchor, and a focus that lands before that settles can be dropped.
    requestAnimationFrame(() => {
      ref.current?.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        if (document.activeElement !== ref.current)
          ref.current?.focus({ preventScroll: true });
      });
    });
  }, [commentDraft, selectComment]);
  const editingCommentId = editingComment?.id ?? null;
  useEffect(() => {
    if (!editingCommentId) return;
    onCommentDraftChange?.(null);
    requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    // `onCommentDraftChange` is the host's `useState` setter, so listing it
    // keeps this to "a different comment was opened" — and makes that
    // assumption something the linter checks rather than a claim in a comment.
  }, [editingCommentId, onCommentDraftChange]);
  // Leaving comment mode: the body was scratch space, never a saved draft.
  useEffect(() => {
    if (!commentMode) setCommentBody("");
  }, [commentMode]);

  useEffect(() => {
    return () => {
      for (const a of attachmentsRef.current)
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    };
  }, []);

  useEffect(() => {
    if (disabled) return;
    ref.current?.focus({ preventScroll: true });
  }, [disabled, focusToken]);

  // A staged draft (fork, review handoff) wins over the browser-local text —
  // including the storage reload above, which runs first ONLY because it is
  // declared first: a handoff that lands the draft and the new
  // `draftStorageKey` in the same commit must end on the draft, not on what
  // the destination happened to have stored. Keep this effect below it.
  // Keyed on the TOKEN: the staged draft object is rebuilt by its host on every
  // render, so it is read through a ref — depending on it would keep re-staging
  // the same text over whatever has been typed since.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onDraftConsumedRef = useRef(onDraftConsumed);
  onDraftConsumedRef.current = onDraftConsumed;
  const draftToken = draft?.token ?? null;
  useEffect(() => {
    const staged = draftRef.current;
    if (!staged) return;
    setText(staged.text);
    setAttachmentError(null);
    if (draftAutoFocus)
      requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    // Staged once, then it is ordinary composer text: the persistence effect
    // above has it under this session's draft key, so a remount restores what
    // the user last left in the field rather than the handoff.
    onDraftConsumedRef.current?.(staged.token);
  }, [draftToken, draftAutoFocus, setText]);

  const activeComposerDraft = commentMode ? commentBody : text;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    autosizeComposerField(el, COMPOSER_FIELD_MAX_HEIGHT);
  }, [activeComposerDraft]);

  const addFiles = async (files: FileList | File[]) => {
    if (disabled) return;
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    setAttachmentError(null);

    const slots = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length);
    if (slots === 0) {
      setAttachmentError(
        `You can attach up to ${MAX_ATTACHMENTS} files per message.`,
      );
      return;
    }

    const accepted = incoming.slice(0, slots).filter((file) => {
      if (file.size <= MAX_FILE_SIZE) return true;
      setAttachmentError(
        `${file.name || "Attachment"} is larger than ${formatBytes(MAX_FILE_SIZE)}.`,
      );
      return false;
    });
    if (incoming.length > slots) {
      setAttachmentError(
        `Only ${slots} more attachment${slots === 1 ? "" : "s"} can be added.`,
      );
    }
    if (accepted.length === 0) return;

    try {
      const loaded = await Promise.all(accepted.map(fileToAttachment));
      setAttachments((current) =>
        [...current, ...loaded].slice(0, MAX_ATTACHMENTS),
      );
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const removed = current.find((a) => a.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((a) => a.id !== id);
    });
  };

  const slash = slashState(
    text,
    slashCommands,
    session?.agentType,
    session?.harness,
  );
  const selectedSlash =
    slash.items[Math.min(slashIndex, Math.max(0, slash.items.length - 1))];
  // The autocomplete menu shows while a slash token is being typed, unless the
  // user dismissed it with Escape (re-opens as soon as the text changes again).
  const slashMenuOpen =
    slash.active && slash.items.length > 0 && !slashDismissed;

  useEffect(() => {
    setSlashIndex(0);
    setSlashDismissed(false);
  }, [text, session?.agentType, session?.harness, slashCommands]);

  useEffect(() => {
    if (
      !branchInfo ||
      (branchInfo.parent ? 1 : 0) + branchInfo.children.length === 0
    ) {
      setBranchesOpen(false);
    }
  }, [branchInfo]);

  const applySlash = (cmd: SlashCommandInfo) => {
    setText(`/${cmd.name} `);
    requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
  };

  const clearAttachments = () => {
    for (const a of attachments)
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    setAttachments([]);
  };

  const refineDraft = async () => {
    if (disabled || isRefining) return;
    const draft = (commentMode ? commentBody : text).trim();
    if (!draft) return;

    setAttachmentError(null);
    setIsRefining(true);
    try {
      const refined = await refineText(draft, {
        ...(session?.sessionId !== undefined
          ? { sessionId: session?.sessionId }
          : {}),
        ...(session?.agentType !== undefined
          ? { agentType: session?.agentType }
          : {}),
        includeContext: true,
      });
      if (commentMode) setCommentBody(refined);
      else setText(refined);
      requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRefining(false);
    }
  };

  /**
   * Dictation. The transcript is inserted at the caret and never sent — it is a
   * draft you can read and optionally hand to the refine wand next door.
   * `useDictation` enforces a single owner across every mounted composer, and on
   * mobile the owner is the dock's action row instead (`onRequestDictation`).
   *
   * Land a finished transcript in the draft: at the caret remembered when dictation
   * started (recording drops focus, so there is no live selection to trust), never
   * sent, and with the editor focused so it can be corrected first.
   *
   * NOTE: this focus is NOT inside a user gesture (the text arrives from the
   * network), and iOS Safari only raises the keyboard for gesture-initiated focus —
   * so the composer reliably opens, but the keyboard may need one tap. Deliberate:
   * the alternative is keeping the textarea focused throughout recording, which is
   * the keyboard thrash this whole flow exists to remove.
   */
  const insertDictated = (spoken: string) => {
    // The composer stays usable while the utterance decodes, so a draft edited
    // in the meantime moves the caret: prefer the live selection when the
    // editor has focus, and never trust a remembered caret past the text.
    const activeDraft = commentMode ? commentBody : text;
    const node = ref.current;
    const live =
      node && document.activeElement === node
        ? { start: node.selectionStart, end: node.selectionEnd }
        : null;
    const remembered = Math.min(
      caretBeforeDictationRef.current ?? activeDraft.length,
      activeDraft.length,
    );
    const start = live?.start ?? remembered;
    const next = insertTranscript(
      activeDraft,
      spoken,
      start,
      live?.end ?? start,
    );
    if (commentMode) setCommentBody(next.text);
    else setText(next.text);
    caretBeforeDictationRef.current = null;
    focusComposer();
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.setSelectionRange(next.selectionStart, next.selectionStart);
    });
  };

  const dictationInstanceId = useId();
  const speech = useDictation({
    instanceId: dictationInstanceId,
    available: Boolean(dictation?.status?.configured) && !onRequestDictation,
    maxUtteranceSeconds: dictation?.status?.maxUtteranceSeconds ?? 120,
    onTranscript: (spoken) => insertDictated(spoken),
    // Dictation failures are transient feedback about a gesture, so they belong
    // in the toast stack (which floats above the composer and dismisses itself),
    // not in the error slot under the bar — that slot is about the draft you are
    // about to send and sticks around until something replaces it.
    onError: (message) =>
      showToast(message, {
        tone: "error",
        durationMs: TOAST_DWELL_MS,
        key: "dictation",
      }),
  });

  // Shown whenever the USER has dictation on. An instance with no model deployed
  // (a PR preview) must still show the button, disabled, carrying the reason —
  // hiding it there looks like the feature was never built, and the reason below
  // exists precisely to be read.
  const dictationAvailable = Boolean(dictation?.enabled);
  const dictationDisabledReason =
    speech.unavailableReason ??
    (dictation?.status?.configured === false
      ? (dictation.status.reason ??
        "Dictation is not configured on this server.")
      : undefined) ??
    (speech.busyElsewhere
      ? "Dictation is in use in another composer"
      : undefined);
  // Forces the compact bar (the recording surface). Only while the microphone is
  // actually open: once the utterance is with the recognizer the composer is
  // editable again, so a slow decode no longer holds the draft hostage.
  const recording = isDictationRecording(speech.phase);

  // A transcript recorded by the host's row. Only a token CHANGE while mounted
  // fires, and the ref seeds with the mount-time token, so remounting across
  // surfaces cannot re-insert the last thing that was said.
  const lastTranscriptToken = useRef(transcript?.token);
  // `insertDictated` closes over the whole draft, so it is read at the moment
  // the token moves rather than depended on: as a dependency it would re-run
  // this effect on every keystroke, where only the ref guard above stops the
  // last utterance being inserted again.
  const insertDictatedRef = useRef(insertDictated);
  insertDictatedRef.current = insertDictated;
  useEffect(() => {
    if (!transcript || transcript.token === lastTranscriptToken.current) return;
    lastTranscriptToken.current = transcript.token;
    insertDictatedRef.current(transcript.spoken);
  }, [transcript]);

  // The hand-over override ends the moment the user engages the composer again;
  // from then on staged comments and attachments hold it open as usual.
  useEffect(() => {
    if (isFocused) setHandedToHostDictation(false);
  }, [isFocused]);

  /**
   * Start dictation from the expanded composer: remember the caret, drop focus so
   * the keyboard goes away, and let the force-collapse below hand the bar over to
   * the recording states. From there the flow is identical to starting collapsed.
   */
  const startDictationFromComposer = () => {
    caretBeforeDictationRef.current =
      ref.current?.selectionStart ??
      (commentMode ? commentBody.length : text.length);
    blurComposer();
    // Where the host owns the recorder (mobile), blurring closes this composer and
    // reveals the row that will record; all this has to do is ask it to start.
    if (onRequestDictation) {
      setHandedToHostDictation(true);
      onRequestDictation();
      return;
    }
    speech.toggle();
  };

  /**
   * Start/stop from the collapsed bar. Nothing is focused here, so there is no
   * meaningful caret to insert at — the transcript appends to the end of the
   * draft, and any caret remembered by an earlier expanded start is dropped.
   */
  const toggleDictationFromBar = () => {
    if (speech.phase === "idle") caretBeforeDictationRef.current = null;
    speech.toggle();
  };

  // While a turn runs, a message QUEUES: it lands in the queue strip, whose
  // rows steer it in or drop it. Alt+Enter queues it and steers it in at once
  // where the provider takes a steer. A surface with no queue (the permanent
  // Assistant) still steers directly.
  const providerCanSteer = Boolean(session?.canSteer);
  const queueing = streaming && Boolean(onQueue);
  const canSend = !streaming || providerCanSteer || Boolean(onQueue);

  /**
   * Comment mode's three answers. They are the composer's, not the chip's: the
   * comment being written is IN this field, so cancelling, deleting and saving
   * it belong beside the send button that would otherwise be the only way out.
   */
  const submitComment = () => {
    const body = commentBody.trim();
    if (!body) return;
    if (editingComment && chatComments) {
      if (editSavePending.current) return;
      editSavePending.current = true;
      const base = editBase.current ?? editingComment;
      const generation = editGeneration.current;
      void chatComments.update(base.id, body, base.body).then((result) => {
        editSavePending.current = false;
        // Another comment took the composer meanwhile: this answer is not its.
        if (editGeneration.current !== generation) return;
        if (result.status === "saved") {
          setAttachmentError(null);
          if (commentBodyNow.current.trim() !== body) {
            // Typed on while the save waited: keep that text open, based on
            // what was just stored, so the next Save goes straight through.
            editBase.current = { ...base, body };
            return;
          }
          chatComments.select(null);
          return;
        }
        if (result.status === "conflict") {
          // Rebase on what the other tab saved, so a second Save is a
          // deliberate overwrite rather than the silent one this refuses.
          editBase.current = result.current;
          setAttachmentError(
            "This comment was changed in another tab. Save again to replace it with your text.",
          );
          return;
        }
        setAttachmentError(
          result.status === "missing"
            ? "This comment was sent or removed in another tab. Your text is still here to copy."
            : "This browser couldn't store the change (storage full or unavailable). Your text is still here.",
        );
      });
      return;
    }
    if (!commentDraft) return;
    // App state can outlive a transcript unmount. Never let an old selection
    // attach to the session now on screen.
    if (commentDraft.sessionId !== session?.sessionId) {
      onCommentDraftChange?.(null);
      return;
    }
    // A comment storage refused stays in the field, with the reason beside it.
    if (chatComments && !chatComments.add({ ...commentDraft, body })) {
      setAttachmentError(
        "This browser couldn't store the comment (storage full or unavailable). Your text is still here.",
      );
      return;
    }
    onCommentDraftChange?.(null);
  };
  const cancelComment = () => {
    if (editingComment) chatComments?.select(null);
    else onCommentDraftChange?.(null);
  };
  /** Only an EXISTING comment can be deleted; a draft is what cancel is for. */
  const deleteComment = editingComment
    ? () => chatComments?.remove(editingComment.id)
    : undefined;

  // A send empties the field AND its stored copy at once: the send can move this
  // composer (the first prompt carries it from the new-session landing into the
  // transcript's dock), and the composer mounted there reads storage before this
  // one's persistence effect would have cleared it.
  const clearSentText = () => {
    setText("");
    clearBrowserDraft(draftStorageKey);
  };

  const submit = (alternate = false) => {
    if (disabled || !canSend || sendBlocked || sendBlockedReason) return;
    const steerNow = alternate && providerCanSteer;
    const outgoing = attachments.map(
      ({ previewUrl: _previewUrl, ...attachment }) => attachment,
    );
    const deliver = (prompt: string) => {
      if (queueing && onQueue)
        onQueue({
          text: prompt,
          ...(outgoing.length ? { attachments: outgoing } : {}),
          ...(steerNow ? { steerNow: true } : {}),
        });
      else onSend(prompt, outgoing);
    };
    const value = text.trim();
    const pendingComments = chatComments?.comments ?? [];
    if (!value && attachments.length === 0 && pendingComments.length === 0)
      return;

    if (value.startsWith("//")) {
      deliver(serializeChatCommentPrompt(value.slice(1), pendingComments));
      clearAttachments();
      chatComments?.clear(pendingComments.map((comment) => comment.id));
      clearSentText();
      setAttachmentError(null);
      finishSubmit();
      return;
    }

    // A registered slash command is ALWAYS intercepted — never forwarded to
    // the model — regardless of provider/harness (resolveSlashSubmit owns the
    // decision and its guard errors).
    const slashAction = resolveSlashSubmit(value, slashCommands, {
      ...(session?.agentType !== undefined
        ? { agentType: session?.agentType }
        : {}),
      ...(session?.harness !== undefined ? { harness: session?.harness } : {}),
      // A queued command runs when the turn is over, so "not while streaming"
      // does not apply to it.
      streaming: streaming && !queueing,
      attachmentCount: attachments.length,
      commentCount: pendingComments.length,
    });
    if (slashAction.kind === "error") {
      setAttachmentError(slashAction.message);
      return;
    }
    if (slashAction.kind === "client" && queueing) {
      setAttachmentError(
        `/${slashAction.name} runs in the app right away, so it cannot be queued.`,
      );
      return;
    }
    if (slashAction.kind === "client") {
      // Everything this composer clears for the command happens BEFORE handing
      // over, never after: a client command may stage a new draft into THIS
      // composer synchronously (the host's staging path commits with
      // `flushSync`, which also flushes the `draft` effect below), so a
      // trailing `setText("")` would wipe the prompt the command just filled
      // in. On an error the command text goes back so it can be corrected.
      const restore = text;
      setText("");
      setAttachmentError(null);
      // A client command may navigate in the same batch, changing
      // `draftStorageKey` before the persistence effect can clear the OLD
      // key's stored draft — remove it here so returning to this session does
      // not restore the command that already ran. Before the handover for the
      // same reason: the draft it stages must be the last thing persisted.
      clearBrowserDraft(draftStorageKey);
      const error = onClientSlashCommand
        ? onClientSlashCommand(slashAction.name, slashAction.rawArgs)
        : `/${slashAction.name} is not available here.`;
      if (error) {
        setText(restore);
        setAttachmentError(error);
        return;
      }
      finishSubmit();
      return;
    }
    if (slashAction.kind === "host") {
      if (queueing && onQueue)
        onQueue({
          text: value,
          command: { name: slashAction.name, rawArgs: slashAction.rawArgs },
        });
      else actions.runSlashCommand(slashAction.name, slashAction.rawArgs);
      clearSentText();
      setAttachmentError(null);
      finishSubmit();
      return;
    }

    deliver(serializeChatCommentPrompt(value, pendingComments));
    clearAttachments();
    // Only what this prompt carried: a comment moved in from a document while
    // it was being sent waits for the next one.
    chatComments?.clear(pendingComments.map((comment) => comment.id));
    clearSentText();
    setAttachmentError(null);
    finishSubmit();
  };

  // After sending, drop the pin and — where the composer collapses (mobile / the
  // inspector footer) — blur so the virtual keyboard closes and it returns to the
  // compact bar. The desktop chat composer keeps focus for rapid follow-ups.
  const finishSubmit = () => {
    setComposerPinnedOpen(false);
    if (collapsible) blurComposer();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (commentMode) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelComment();
        return;
      }
      // The prompt's own rule: Enter sends the comment, Shift+Enter breaks the
      // line, and a thumb keyboard's return key is a newline (there is no other
      // way to type one there).
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.nativeEvent.isComposing &&
        !touchComposerMode
      ) {
        e.preventDefault();
        submitComment();
      }
      return;
    }
    if (slashMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slash.items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slash.items.length) % slash.items.length);
        return;
      }
      // Enter/Tab completes the highlighted command into the prompt (with a
      // trailing space) WITHOUT submitting, so the user can still add
      // arguments. Submitting/running happens on a subsequent Enter once the
      // menu has closed (it closes as soon as a space/args follow the token).
      if ((e.key === "Tab" || e.key === "Enter") && selectedSlash) {
        e.preventDefault();
        applySlash(selectedSlash);
        return;
      }
      if (e.key === "Escape") {
        // Close the menu without clearing the typed text. Stop propagation so
        // app-level Escape handlers don't also react.
        e.preventDefault();
        e.stopPropagation();
        setSlashDismissed(true);
        return;
      }
    }
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      !touchComposerMode
    ) {
      e.preventDefault();
      submit(e.altKey);
    }
  };

  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter(
      (file) => file.type.startsWith("image/") || file.size > 0,
    );
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
  };

  const model = session?.model;
  const thinkingLevel = session?.thinkingLevel ?? "off";
  // Build/Plan is offered only where the axis exists (coding personas, both
  // harnesses). The rendered mode is the session record's — for a live session
  // that is the server's answer, which wins over any stale client pick.
  const sessionMode: SessionMode = session?.mode ?? "build";
  const modeAxis =
    !hideRuntimeControls &&
    hasModeAxis({
      ...(session?.harness !== undefined ? { harness: session?.harness } : {}),
      ...(session?.agentType !== undefined
        ? { agentType: session?.agentType }
        : {}),
    });
  // The composer picks no runtime: a new session chooses agent, account,
  // model and effort on its landing (`NewSessionQuickStart`), a started one
  // has them fixed. Either way one quiet line under the card states it:
  // account, model, effort — the same composer before and after the first
  // message.
  const runtimeShown = !hideRuntimeControls;
  // Model and effort are what the reader checks; the account is what gives
  // way, so the strip truncates only the account (`runtimeAccount`).
  const runtimeAccount = runtimeShown ? accountName : undefined;
  const runtimeModel = runtimeShown
    ? [
        model ? (model.name ?? model.id) : undefined,
        model?.reasoning ? THINKING_LABELS[thinkingLevel] : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const runtimeLine = [runtimeAccount, runtimeModel]
    .filter(Boolean)
    .join(" · ");
  const branchCount =
    (branchInfo?.parent ? 1 : 0) + (branchInfo?.children.length ?? 0);
  const showBranches = Boolean(branchInfo && branchCount > 0);
  const canSubmit =
    !disabled &&
    !commentMode &&
    canSend &&
    !sendBlocked &&
    !sendBlockedReason &&
    (text.trim().length > 0 ||
      attachments.length > 0 ||
      Boolean(chatComments?.comments.length));
  const primaryAction = streaming && (!canSend || !canSubmit) ? "stop" : "send";
  // Focus-driven collapse. It applies only where a permanently-expanded composer
  // is costly — on mobile (virtual keyboard) and in the inspector footer
  // (`collapseWhenBlurred`); the desktop chat composer stays expanded. When
  // collapsible, expand only while the composer is engaged: the textarea is
  // focused, a chrome tap pinned it open (so tapping a button does not collapse
  // it mid-interaction), a file is being dragged, or an attachment is staged (the
  // collapsed bar cannot show attachments). Unsent text survives via the draft
  // and shows as a preview in the collapsed bar, so hiding it here is safe.
  const collapsible = collapseWhenBlurred || mobile;
  // Recording forces the compact bar EVERYWHERE, including the desktop chat
  // composer that never collapses otherwise: the bar is the recording surface, so
  // one flow serves both entry points and both viewports.
  // On mobile there is no collapsed BAR: the object dock's action row is the resting
  // bottom edge on a session screen (ui-shell.md, Small Screens) and the dictation
  // surface as well, so this composer is either expanded or takes up no room at all.
  // Everywhere else the bar is still the collapsed presentation and the place
  // recording happens.
  const barless = mobile;
  // Its own dock sheets anchor to this card (`bottom-full`), so a barless composer
  // stays EXPANDED while one is open — with the keyboard down, as on desktop. It
  // used to collapse for the height; collapsing to nothing instead would leave the
  // sheet hanging off the screen's bottom edge over the dock row.
  const composerSheetOpen = runtimeOpen || branchesOpen;
  const compact =
    recording ||
    (collapsible &&
      !isFocused &&
      !composerPinnedOpen &&
      !dragActive &&
      (handedToHostDictation ||
        (attachments.length === 0 &&
          !chatComments?.comments.length &&
          // A comment being written holds it open for the same reason an
          // attachment does: the comment box is IN this card, so a barless
          // composer that collapsed here would leave the phone with nothing to
          // type into.
          !commentMode)) &&
      !(barless && composerSheetOpen));
  const hidden = compact && barless;

  // The host owns the bottom edge while this composer is not using it, and shows the
  // draft on the field it rests as (the bar used to show that text itself). Reported
  // only while HIDDEN: that is the only state anyone can see it in, and a keystroke
  // that travels to the host would re-render the transcript behind this card.
  useEffect(() => {
    onVisibilityChange?.(!hidden);
  }, [hidden, onVisibilityChange]);
  const draftPreview = hidden
    ? text.trim().slice(0, DRAFT_PREVIEW_MAX_CHARS)
    : "";
  useEffect(() => {
    if (!hidden) return;
    onDraftPreviewChange?.(draftPreview);
  }, [hidden, draftPreview, onDraftPreviewChange]);
  // Opening from the host's control must focus INSIDE its gesture or iOS keeps the
  // keyboard down, so this is a live callback rather than a token prop.
  useEffect(() => {
    if (!openRef) return;
    openRef.current = () => focusComposer({ sync: true });
    return () => {
      openRef.current = null;
    };
  });
  // Same shape, same reason: the picker must open inside the host's own gesture, or
  // iOS treats it as programmatic and refuses.
  useEffect(() => {
    if (!attachRef) return;
    attachRef.current = () => fileRef.current?.click();
    return () => {
      attachRef.current = null;
    };
  });
  // Send from the host's row. Same live-ref shape (it has to see the CURRENT draft,
  // not the one a token prop was rendered with), and no dependency array for the
  // same reason. A blocked send opens the composer instead of silently doing
  // nothing: the hint that says why is up there, above the card.
  useEffect(() => {
    if (!submitRef) return;
    submitRef.current = () => {
      if (sendBlockedReason) {
        focusComposer({ sync: true });
        return;
      }
      submit();
    };
    return () => {
      submitRef.current = null;
    };
  });

  // Collapse-when-blurred: unpin only on a pointer interaction that is truly
  // outside the composer — clicks inside it or inside a portaled popover
  // (model/thinking pickers render via Popover into document.body) must not
  // collapse the composer mid-selection. Focus/blur alone is unreliable here
  // because popover options steal focus outside composerRef.
  useEffect(() => {
    if (!collapsible) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        target &&
        (composerRef.current?.contains(target) ||
          target.closest("[data-popover-panel]"))
      )
        return;
      setComposerPinnedOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [collapsible]);

  // Collapse when the on-screen keyboard is dismissed via the OS "hide keyboard"
  // control. That gesture hides the keyboard WITHOUT blurring the textarea, so
  // `isFocused` stays true and the composer would otherwise stay expanded until
  // the next scroll. Detect the keyboard the same way `useMobileKeyboardInset`
  // does (viewport overlap below the layout height, measured after layout in a
  // rAF, across the full event set) and, on the open→closed edge while our
  // textarea still holds focus, drop focus + pin so the composer collapses.
  useEffect(() => {
    if (!collapsible) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const KEYBOARD_MIN_PX = 120;
    let keyboardOpen = false;
    const measure = () => {
      const layoutHeight =
        window.innerHeight || document.documentElement.clientHeight;
      const overlap = Math.max(0, layoutHeight - (vv.height + vv.offsetTop));
      const nowOpen = overlap > KEYBOARD_MIN_PX;
      const focused = document.activeElement === ref.current;
      if (composerKeyboardDebugEnabled()) {
        console.debug("[composer] keyboard", {
          overlap: Math.round(overlap),
          keyboardOpen,
          nowOpen,
          focused,
        });
      }
      if (keyboardOpen && !nowOpen && focused) {
        ref.current?.blur();
        setIsFocused(false);
        setComposerPinnedOpen(false);
      }
      keyboardOpen = nowOpen;
    };
    const onChange = () => window.requestAnimationFrame(measure);
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    window.addEventListener("resize", onChange);
    return () => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, [collapsible]);

  const focusComposerFromPointer = (event: ReactPointerEvent) => {
    if (disabled || (event.pointerType === "mouse" && event.button !== 0))
      return;
    event.preventDefault();
    focusComposer({ sync: true });
  };

  // Opening a dock panel (context/runtime/branches) drops textarea focus AND the
  // pin so the composer collapses to its compact bar — the mobile keyboard closes
  // and the sheet gets the full height. (Also used by submit, which wants the same
  // collapse.)
  const blurComposer = () => {
    ref.current?.blur();
    setIsFocused(false);
    setComposerPinnedOpen(false);
  };
  // Closing a dock sheet returns to composing: refocus the textarea (sync, so iOS
  // reopens the keyboard within the tap gesture) and re-expand — no extra tap.
  // EXCEPT when the sheet was opened externally (the user wasn't composing):
  // then closing just dismisses, and they tap the composer when ready.
  const dismissSheetsAndFocus = () => {
    setRuntimeOpen(false);
    setBranchesOpen(false);
    if (sheetOpenedExternally) {
      setSheetOpenedExternally(false);
      return;
    }
    focusComposer({ sync: true });
  };

  const preventNonInteractiveComposerTouch = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (
      compact ||
      disabled ||
      (event.pointerType !== "touch" && event.pointerType !== "pen")
    )
      return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const interactive = target.closest(
      'button, a, input, textarea, select, [role="button"], [contenteditable="true"]',
    );
    if (interactive) return;
    // On mobile, tapping inert composer chrome should be a true no-op: it
    // must not focus the textarea, and it must not blur an already-focused
    // textarea (which would close the keyboard and allow read-mode collapse).
    event.preventDefault();
  };

  const focusTextareaFromTouch = (
    event: ReactPointerEvent<HTMLTextAreaElement>,
  ) => {
    if (
      disabled ||
      (event.pointerType !== "touch" && event.pointerType !== "pen")
    )
      return;
    if (document.activeElement === event.currentTarget) return;
    // iOS Safari otherwise auto-scrolls/pans the whole fixed-height app shell
    // to bring the focused textarea into view. Focus it ourselves with
    // preventScroll so the composer stays anchored above the keyboard.
    event.preventDefault();
    flushSync(() => setIsFocused(true));
    event.currentTarget.focus({ preventScroll: true });
  };

  return (
    <div
      className={`${COMPOSER_SHELL_CLASS} ${hidden ? "pb-0" : COMPOSER_SHELL_PADDING_CLASS}`}
    >
      {/* Fixed-height hint slot above the composer card: reserved whenever a
          send-blocking hint CAN appear (staged-context surfaces), so toggling
          the hint never shifts the layout. */}
      {reserveHintSlot || sendBlockedReason ? (
        <div
          className="mb-1 flex h-5 items-center justify-center px-2"
          aria-live="polite"
        >
          {sendBlockedReason ? (
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {sendBlockedReason}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* The dock panels anchor to THIS box (`bottom-full`), which holds only the
          ledge and the card: anchored to the shell they sat above the hint slot
          too, and on a phone that reserved slot read as a gap between the panel
          and the card it is supposed to be joined to. */}
      <div className="relative">
        <ChatDockPanel
          open={!hideRuntimeControls && runtimeOpen}
          title="Runtime"
          icon={<Cpu size={14} />}
          minimizable={false}
          onClose={dismissSheetsAndFocus}
        >
          <RuntimeSettingsPanel
            model={model}
            models={models}
            level={thinkingLevel}
            actions={actions}
            isModelDisabled={isModelDisabled}
            modelLocked={modelLocked}
            thinkingLocked={thinkingLocked}
            agentType={selectedAgentType}
            availableAgentTypes={availableAgentTypes}
            onAgentTypeChange={onAgentTypeChange}
            mode={modeAxis ? sessionMode : undefined}
          />
        </ChatDockPanel>
        <ChatDockPanel
          open={branchesOpen && showBranches}
          title="Session branches"
          icon={<GitFork size={14} />}
          onClose={dismissSheetsAndFocus}
        >
          {branchInfo ? (
            <BranchPanel
              info={branchInfo}
              onClose={() => setBranchesOpen(false)}
            />
          ) : null}
        </ChatDockPanel>
        {slashMenuOpen ? (
          // The command menu is a strip of its own on the shelf while a slash
          // is typed, standing in for the resting strips rather than floating
          // over them; it stays up with the phone keyboard, which it is for.
          <ComposerLedge joined={!hidden} keepWithKeyboard>
            <Command
              shouldFilter={false}
              value={slash.items[slashIndex]?.name ?? ""}
              onValueChange={(name) => {
                const index = slash.items.findIndex((cmd) => cmd.name === name);
                if (index >= 0) setSlashIndex(index);
              }}
              className="h-auto rounded-none! bg-transparent p-0"
            >
              <div className="flex h-7 shrink-0 items-center border-b px-2.5 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">
                  ↑↓ to navigate · ↵ to select · esc to dismiss ·&nbsp;
                  <span className="font-mono">//</span>&nbsp;sends a literal
                  slash
                </span>
              </div>
              <CommandList className="max-h-64 divide-y">
                {slash.items.map((cmd, index) => (
                  <CommandItem
                    key={cmd.name}
                    value={cmd.name}
                    onSelect={() => applySlash(cmd)}
                    onMouseEnter={() => setSlashIndex(index)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applySlash(cmd);
                    }}
                    className="items-start gap-3 rounded-none px-2.5"
                  >
                    <span className="mt-0.5 font-mono text-sm text-primary">
                      /{cmd.name}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-foreground">
                        {cmd.description}
                      </span>
                      <span className="block truncate font-mono text-sm text-muted-foreground">
                        {cmd.usage}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </ComposerLedge>
        ) : ledge ? (
          <ComposerLedge joined={!hidden}>{ledge}</ComposerLedge>
        ) : null}
        <InputGroup
          ref={composerRef}
          onPointerDownCapture={(e) => {
            // Pin ONLY while the composer is already expanded, where the pin exists
            // to stop a chrome tap from collapsing it mid-interaction. Pinning while
            // it is compact is actively harmful: it flips `compact` synchronously
            // inside this very gesture, so the collapsed bar becomes `inert` before
            // the click lands and the tap is swallowed — a mic tap merely expanded
            // the composer, and the abort tap did nothing. The compact bar's own
            // controls expand explicitly (`onExpandPointer`) when they mean to.
            if (!compact) setComposerPinnedOpen(true);
            preventNonInteractiveComposerTouch(e);
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null))
              return;
            setDragActive(false);
          }}
          onDrop={onDrop}
          data-compact={compact || undefined}
          // Zero-height rather than unmounted when hidden: the textarea has to stay in
          // the DOM so the dock's compose control can focus it INSIDE its own gesture,
          // which is the only way iOS raises the keyboard on the first tap.
          // Opaque: InputGroup's own fill is transparent (dark: `bg-input/30`),
          // which lets the transcript scrolling underneath show through. No
          // focus border or ring either: the composer is the page's one text
          // field and its caret already says where focus is. Disabled stays
          // opaque too (InputGroup fades the whole box to 50% and tints it):
          // the field's own disabled style dims the text. Its corners are
          // deliberately rounder than the theme radius and do not follow it:
          // the composer is the one object on the page meant to read as such.
          className={`relative z-10 h-auto flex-col items-stretch rounded-composer bg-background dark:bg-card field-focus-visible:border-input field-focus-visible:ring-0 field-disabled:bg-background field-disabled:opacity-100 dark:field-disabled:bg-card ${hidden ? COMPOSER_CARD_COLLAPSED_CLASS : ""} ${dragActive ? COMPOSER_CARD_DRAG_SKIN_CLASS : ""}`}
        >
          {/* Compact single-row bar — the collapsed presentation everywhere except a
            barless mobile composer, which collapses to nothing and lets the object
            dock's action row be the bottom edge. Recording brings it back there. */}
          <div
            aria-hidden={!compact || barless}
            inert={!compact || barless ? true : undefined}
            // Folded away for a BARLESS composer too, rather than left standing
            // inside a card held at zero height: the card collapses by folding
            // both halves, which is the only version of it that can animate.
            className={`overflow-hidden ${composerFoldClass(!compact || barless)}`}
          >
            <div className="min-h-0 min-w-0">
              <CompactComposerBar
                streaming={streaming}
                disabled={disabled}
                primaryAction={primaryAction}
                onAbort={onAbort}
                onExpand={() => focusComposer()}
                onExpandPointer={focusComposerFromPointer}
                touchComposerMode={touchComposerMode}
                draftPreview={text.trim() ? text.trim() : undefined}
                dictation={
                  dictationAvailable
                    ? {
                        phase: speech.phase,
                        peaks: speech.peaks,
                        elapsedSeconds: speech.elapsedSeconds,
                        uploading: speech.uploading,
                        ...(dictationDisabledReason !== undefined
                          ? { disabledReason: dictationDisabledReason }
                          : {}),
                        onToggle: toggleDictationFromBar,
                        onCancel: speech.cancel,
                      }
                    : undefined
                }
              />
            </div>
          </div>

          {/* Full composer content — animates out when collapsed. */}
          <div
            aria-hidden={compact}
            inert={compact ? true : undefined}
            className={`min-w-0 ${composerFoldClass(compact)}`}
          >
            <div
              className={`min-h-0 min-w-0 ${compact ? "overflow-hidden" : "overflow-visible"}`}
            >
              {/* No context chips: the new-session landing and the title bar
                  state the project, worktree and Task, and the shelf strips the
                  document and a staged review. */}

              {/* Nothing states the passage here. It is selected and highlighted
                in the transcript directly above, the user is the one who just
                picked it, and the placeholder plus the row's own actions already
                say this field is holding a comment. */}
              <InputGroupTextarea
                ref={ref}
                rows={1}
                value={commentMode ? commentBody : text}
                disabled={disabled}
                onChange={(e) => {
                  if (commentMode) setCommentBody(e.target.value);
                  else {
                    setComposerPinnedOpen(true);
                    setText(e.target.value);
                  }
                }}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onPointerDown={focusTextareaFromTouch}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                placeholder={
                  commentMode
                    ? editingComment
                      ? "Edit this comment…"
                      : "Add a comment…"
                    : streaming
                      ? queueing
                        ? "Queue a message for after this response…"
                        : providerCanSteer
                          ? "Send a message to steer…"
                          : "Wait for this provider to finish before sending…"
                      : COMPOSER_PLACEHOLDER
                }
                className={COMPOSER_FIELD_CLASS}
              />

              {attachments.length > 0 && (
                // `pt-1.5 pr-1.5` leaves room for each tile's remove button,
                // which sits over its top-right corner.
                <div className="mt-2 flex max-w-full flex-wrap gap-2 px-1 pt-1.5 pr-1.5">
                  {attachments.map((attachment) => (
                    <AttachmentThumbnail
                      key={attachment.id}
                      name={attachment.name}
                      mimeType={attachment.mimeType}
                      size={attachment.size}
                      src={attachment.previewUrl}
                      onRemove={() => removeAttachment(attachment.id)}
                    />
                  ))}
                </div>
              )}

              <InputGroupAddon
                align="block-end"
                className={COMPOSER_ACTION_ROW_CLASS}
              >
                <Input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.currentTarget.files)
                      void addFiles(e.currentTarget.files);
                    e.currentTarget.value = "";
                  }}
                />
                <div className="flex min-w-0 items-center gap-1">
                  {/* The prompt's controls, and only the prompt's: a comment has
                    no attachments, no session context and no runtime, so in
                    comment mode the row keeps its geometry and empties. */}
                  <div className="flex shrink-0 items-center gap-1">
                    {commentMode ? null : (
                      <IconButton
                        label="Attach files or images"
                        title="Attach files or images"
                        onClick={() => fileRef.current?.click()}
                        disabled={disabled}
                      >
                        <Paperclip />
                      </IconButton>
                    )}
                  </div>
                  {!hideRuntimeControls && !commentMode ? (
                    <div className="flex shrink-0 items-center gap-1">
                      {modeAxis ? (
                        <ModeSelector
                          mode={sessionMode}
                          onChange={(mode) => actions.setSessionMode(mode)}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className={COMPOSER_ACTION_CLUSTER_CLASS}>
                  {showBranches && !commentMode && (
                    <IconButton
                      label="Conversation branches"
                      onClick={() => {
                        if (branchesOpen) {
                          dismissSheetsAndFocus();
                          return;
                        }
                        setRuntimeOpen(false);
                        setSheetOpenedExternally(false);
                        blurComposer();
                        setBranchesOpen(true);
                      }}
                      title="Conversation branches"
                      aria-expanded={branchesOpen}
                      className="relative"
                      data-open={branchesOpen && showBranches}
                    >
                      <GitFork size={15} />
                      {branchCount > 1 && (
                        <Badge className="absolute -right-1 -top-1">
                          {branchCount}
                        </Badge>
                      )}
                    </IconButton>
                  )}
                  <IconButton
                    label="Refine draft prompt"
                    busy={isRefining}
                    onClick={() => void refineDraft()}
                    disabled={
                      disabled ||
                      isRefining ||
                      !(commentMode ? commentBody : text).trim()
                    }
                    title="Refine draft prompt"
                  >
                    <WandSparkles />
                  </IconButton>
                  {dictationAvailable && (
                    <IconButton
                      label="Start dictation"
                      // One gesture: this collapses the composer (dropping the keyboard)
                      // and hands recording to the compact bar, so starting from a
                      // half-typed draft and starting from collapsed are the same flow.
                      onClick={startDictationFromComposer}
                      disabled={
                        disabled ||
                        speech.phase === "transcribing" ||
                        Boolean(dictationDisabledReason)
                      }
                      // Stopping un-forces the compact bar, so on desktop THIS button
                      // is what the user sees while the server decodes — it carries
                      // the transcribing spinner the bar's toggle shows elsewhere.
                      busy={speech.phase === "transcribing"}
                      title={dictationDisabledReason ?? "Dictate"}
                    >
                      <Mic />
                    </IconButton>
                  )}
                  <DictationLiveRegion phase={speech.phase} />
                  {/* Comment mode's own three answers, in the order they escalate:
                    leave it, destroy it, save it. */}
                  {commentMode ? (
                    <IconButton
                      label={editingComment ? "Cancel edit" : "Cancel comment"}
                      onClick={cancelComment}
                    >
                      <X />
                    </IconButton>
                  ) : null}
                  {deleteComment ? (
                    <IconButton
                      label="Delete comment"
                      variant="destructive"
                      onClick={deleteComment}
                    >
                      <Trash2 />
                    </IconButton>
                  ) : null}
                  {/* One button: Stop while the field is empty, Queue (or,
                    with no queue here, Steer) once something is typed. */}
                  <InputGroupButton
                    size="icon-sm"
                    variant={
                      primaryAction === "stop" && !commentMode
                        ? "secondary"
                        : "default"
                    }
                    onClick={
                      commentMode
                        ? submitComment
                        : primaryAction === "stop"
                          ? onAbort
                          : () => submit()
                    }
                    disabled={
                      commentMode
                        ? !commentBody.trim()
                        : primaryAction === "send" && !canSubmit
                    }
                    title={
                      commentMode
                        ? editingComment
                          ? "Save comment"
                          : "Attach comment"
                        : primaryAction === "stop"
                          ? "Stop"
                          : streaming
                            ? queueing
                              ? touchComposerMode || !providerCanSteer
                                ? "Queue it"
                                : "Queue it (Enter) · queue and steer in now (Alt+Enter)"
                              : "Steer the response"
                            : touchComposerMode
                              ? "Send message"
                              : "Send message (Enter)"
                    }
                    aria-label={
                      commentMode
                        ? editingComment
                          ? "Save comment"
                          : "Attach comment"
                        : primaryAction === "stop"
                          ? "Stop response"
                          : streaming
                            ? queueing
                              ? "Queue message"
                              : "Steer response"
                            : "Send message"
                    }
                  >
                    {commentMode ? (
                      <Check size={16} />
                    ) : primaryAction === "stop" ? (
                      <Square size={14} className="fill-current" />
                    ) : queueing ? (
                      <ListPlus size={16} />
                    ) : streaming ? (
                      <CornerDownRight size={16} />
                    ) : (
                      <SendHorizontal size={16} />
                    )}
                  </InputGroupButton>
                </div>
              </InputGroupAddon>
            </div>
          </div>
        </InputGroup>
        {/* The runtime as a strip under the card, the same object as the
            ledges above it: what the session runs on, resting where the
            composer ends. A statement, not a control — nothing to unfold. */}
        {/* Shown in comment mode too: the card swaps its field and actions,
            and the dock around it keeps its shape. */}
        {(runtimeLine || contextInfo?.context) && !hidden ? (
          <ComposerLedge joined edge="bottom">
            {/* `@container`: the context sizes join only where they fit. */}
            {/* Shorter and smaller than the strips on the shelf above: a
                footnote to the card, not a row to act on. */}
            <div className="@container relative flex h-5 min-w-0 items-center justify-center gap-1 px-2.5 text-xs text-muted-foreground">
              {/* The strip doubles as the context gauge: a faint fill from the
                  left as wide as the window is full, behind the text (the
                  ledge is its stacking context), warning-tinted from 80%. */}
              {contextInfo?.context?.percent != null ? (
                <div
                  aria-hidden
                  className={`absolute inset-y-0 left-0 -z-10 transition-all duration-500 ease-out ${contextInfo.context.percent >= 80 ? "bg-warning/20" : "bg-primary/10"}`}
                  style={{
                    width: `${Math.max(0, Math.min(100, contextInfo.context.percent))}%`,
                  }}
                />
              ) : null}
              {runtimeLine ? (
                <>
                  {model ? (
                    <ProviderIcon
                      provider={model.provider}
                      size={12}
                      className="shrink-0"
                    />
                  ) : null}
                  {runtimeAccount ? (
                    <span className="min-w-0 truncate" title={runtimeLine}>
                      {runtimeAccount}
                    </span>
                  ) : null}
                  {runtimeAccount && runtimeModel ? (
                    <span aria-hidden className="shrink-0">
                      ·
                    </span>
                  ) : null}
                  {runtimeModel ? (
                    <span
                      className="shrink-0 whitespace-nowrap"
                      title={runtimeLine}
                    >
                      {runtimeModel}
                    </span>
                  ) : null}
                </>
              ) : null}
              {contextInfo?.context ? (
                <>
                  {runtimeLine ? (
                    <span aria-hidden className="shrink-0">
                      ·
                    </span>
                  ) : null}
                  <ContextStatus info={contextInfo} />
                </>
              ) : null}
            </div>
          </ComposerLedge>
        ) : null}
      </div>
      {attachmentError ? (
        <div className="mt-1.5 px-2 text-sm text-destructive">
          {attachmentError}
        </div>
      ) : null}
    </div>
  );
});

/**
 * The collapsed composer bar, which doubles as the dictation surface.
 *
 * Recording lives HERE rather than in an overlay because the collapsed bar is the
 * one composer state that does not involve the textarea, and therefore the one
 * state that does not raise the virtual keyboard. Starting from here means the
 * keyboard is never summoned and never has to be dismissed; the expanded composer
 * collapses into this bar to record, so there is a single flow either way.
 *
 * Three states over one row:
 *   idle         preview · mic · send
 *   recording    waveform + elapsed · discard · STOP (where the mic was)
 *   transcribing waveform frozen · spinner
 *
 * The idle state is DESKTOP-ONLY territory now (plus hosts that opt in with
 * `collapseWhenBlurred`): a mobile session screen rests on the object dock's
 * action row instead, and two bottom bars is one too many. Recording still brings
 * this bar up on mobile, which is why it keeps all three states.
 */
function CompactComposerBar({
  streaming,
  disabled,
  primaryAction,
  onAbort,
  onExpand,
  onExpandPointer,
  touchComposerMode,
  draftPreview,
  dictation,
}: {
  streaming: boolean;
  disabled: boolean;
  primaryAction: "send" | "stop";
  onAbort: () => void;
  onExpand: () => void;
  onExpandPointer: (event: ReactPointerEvent) => void;
  touchComposerMode: boolean;
  /** Remembered draft text shown in the collapsed bar instead of the hint. */
  draftPreview?: string | undefined;
  /** Omitted entirely when dictation is unavailable or disabled in settings. */
  dictation?: DictationControlsData | undefined;
}) {
  const phase = dictation?.phase ?? "idle";
  // Only RECORDING takes the bar; while the utterance decodes the composer is
  // usable again (see `isDictationRecording`), with the mic showing its spinner.
  const busy = isDictationRecording(phase);
  const label = streaming
    ? COMPOSER_STREAMING_LABEL
    : (draftPreview ?? COMPOSER_PLACEHOLDER);
  const expandHint = touchComposerMode
    ? "Tap to compose"
    : "Click or press / to compose";

  return (
    <div className="flex min-w-0 items-center gap-1 px-1">
      {busy && dictation ? (
        // While recording the bar belongs to the audio: the draft preview is
        // replaced by the trace (you cannot read your draft while talking) and
        // tapping the bar must NOT expand the composer.
        <DictationTrace dictation={dictation} />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onPointerDown={onExpandPointer}
          onClick={onExpand}
          disabled={disabled}
          title={expandHint}
          aria-label={expandHint}
          aria-expanded={false}
          className="min-w-0 flex-1 justify-start"
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </Button>
      )}

      {phase === "recording" && dictation && (
        <DictationDiscardButton onCancel={dictation.onCancel} />
      )}

      {dictation && (
        <DictationToggleButton dictation={dictation} disabled={disabled} />
      )}

      {/* Send is hidden while the bar is recording — there is nothing to send
          yet, and its slot is what makes room for stop at the thumb edge. */}
      {!busy && (
        <IconButton
          label={primaryAction === "stop" ? "Stop response" : "Compose message"}
          variant={primaryAction === "stop" ? "secondary" : "default"}
          onPointerDown={primaryAction === "stop" ? undefined : onExpandPointer}
          onClick={primaryAction === "stop" ? onAbort : onExpand}
          disabled={disabled && primaryAction !== "stop"}
          title={primaryAction === "stop" ? "Stop" : "Compose message"}
        >
          {primaryAction === "stop" ? (
            <Square size={14} className="fill-current" />
          ) : (
            <SendHorizontal size={16} />
          )}
        </IconButton>
      )}
    </div>
  );
}

function BranchPanel({
  info,
  onClose,
}: {
  info: BranchPanelInfo;
  onClose: () => void;
}) {
  return (
    <div className="space-y-2 text-sm">
      {info.parent && (
        <BranchSection title="Parent">
          <BranchItem item={info.parent} onClose={onClose} tone="parent" />
        </BranchSection>
      )}

      <BranchSection title="Current">
        <div className="rounded-xl border border-primary/25 bg-accent px-3 py-2">
          <div className="truncate font-medium text-foreground">
            {info.currentTitle}
          </div>
          <div className="mt-0.5 text-sm text-muted-foreground">
            Current session
          </div>
        </div>
      </BranchSection>

      <BranchSection title="Children">
        {info.children.length ? (
          <div className="space-y-1">
            {info.children.map((child) => (
              <BranchItem
                key={child.id ?? child.title}
                item={child}
                onClose={onClose}
                tone="child"
              />
            ))}
          </div>
        ) : (
          <EmptyBox variant="inline">No child sessions yet.</EmptyBox>
        )}
      </BranchSection>
    </div>
  );
}

function BranchSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </section>
  );
}

function BranchItem({
  item,
  onClose,
  tone,
}: {
  item: BranchNavItem;
  onClose: () => void;
  tone: "parent" | "child";
}) {
  return (
    <Item
      render={<button type="button" />}
      variant="outline"
      size="sm"
      onClick={() => {
        onClose();
        item.onOpen();
      }}
      className="w-full items-start gap-2"
    >
      <GitFork
        size={13}
        className={
          tone === "parent"
            ? "mt-0.5 shrink-0 rotate-180 text-primary"
            : "mt-0.5 shrink-0 text-primary"
        }
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">
          {item.title}
        </span>
        {item.subtitle ? (
          <span className="mt-0.5 block truncate text-sm text-muted-foreground">
            {item.subtitle}
          </span>
        ) : null}
      </span>
    </Item>
  );
}
