/**
 * Wire protocol shared between the assistant server and web UI.
 *
 * Types only (no runtime deps) so both the tsx server and the Vite client
 * can import it directly from source.
 */
import type {
  ClientSessionSnapshot,
  ClientTimelineEntry,
  ClientRuntimeEvent,
  TimelineCacheDescriptor,
} from "./runtimeEvents.ts";
import type { BuildInfo } from "./buildInfo.ts";
import { CLAUDE_SDK_PROVIDER, type Harness } from "./harnesses.ts";
import type { TurnStatsSeed } from "./turnStats.ts";
import type { AgentStopReason, AgentUsage } from "./session/content.ts";
import type { PromptOrigin } from "./session/origin.ts";
import type {
  PromptDelivery,
  SessionEntry,
  SessionEntryOrigin,
} from "./session/entries.ts";
import type { PaObjectLinkResolution } from "./objectLinks.ts";
import type { UsageIndicator } from "./usage.ts";
import type { ApprovalGrant } from "./approvalGrants.ts";
import type {
  CommentTarget,
  CommentThread,
  SelectorBundle,
} from "./comments.ts";
import type {
  ReviewFinding,
  WorkflowCeilingRaise,
  WorkflowRunLimits,
  WorkflowRunSummary,
} from "./workflow.ts";
import {
  isTerminalWorkflowRunLifecycle,
  pendingWorkflowRunAttention,
} from "./workflow.ts";
import type { SkillLibraryList, SkillToggles } from "./skills.ts";
import type { PeerSpawnRuntime } from "./peerRuntimes.ts";
import type { SettingsSectionId } from "./settingsRegistry.ts";
import {
  THINKING_LEVELS,
  supportedThinkingLevelsForModel,
} from "./thinkingLevels.ts";
import type { ThinkingLevel } from "./thinkingLevels.ts";
import { clampInt } from "./memoryValidation.ts";
import type {
  MemoryListFilter,
  MemoryListResult,
  MemoryLineage,
  MemoryLoadBatch,
  MemoryMutateOperation,
  MemoryMutateResult,
  MemorySettings,
} from "./memory.ts";

// Re-export the memory and workflow domain contracts + validators so
// `@assistant/shared` consumers get them from the package root alongside the
// rest of the protocol.
export * from "./memory.ts";
export * from "./memoryValidation.ts";
export * from "./workflow.ts";
export * from "./skills.ts";
export * from "./comments.ts";
export * from "./thinkingLevels.ts";
export * from "./peerRuntimes.ts";
export * from "./approvalGrants.ts";
export * from "./harnesses.ts";
export { SESSION_TIMELINE_PROJECTION_VERSION } from "./runtimeEvents.ts";
export type { TimelineCacheDescriptor } from "./runtimeEvents.ts";
export type { TurnStatsSeed } from "./turnStats.ts";

/**
 * A partial update applied by SPREADING it over a base (`{ ...base, ...patch }`),
 * where an ABSENT key leaves the field alone and a key set to `undefined`
 * CLEARS it.
 *
 * `Partial<T>` cannot say that under `exactOptionalPropertyTypes`: it maps
 * `k?: V` to `k?: V`, so `{ k: undefined }` is rejected and the only way to
 * type-check the call is to drop the key — which silently means the OPPOSITE
 * thing, leaving the old value in place. A patch that clears has to say so in
 * its type; see `docs/linting.md`.
 */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * Apply a {@link Patch} to a base object: an absent key is left alone, and a
 * key whose value is `undefined` is REMOVED.
 *
 * Use this instead of `{ ...base, ...patch }`, which leaves a cleared key
 * PRESENT with the value `undefined` — a shape the base type says cannot exist.
 * That is a type-soundness fix, not a bug fix: no consumer in this repo could
 * observe the difference, because a cleared field is only ever read for its
 * value (`card.busyAction` truthily, `settings.apiKey` re-guarded by a `typeof`
 * check) and every persistence and wire hop is `JSON.stringify`, which already
 * drops undefined-valued keys. It removes the hazard for the NEXT consumer —
 * one that enumerates keys, tests `in`, or deep-equals two of these objects
 * would see a field the type promised was absent.
 *
 * `protocol.test.ts` pins the semantics: `typecheck` cannot, because the cast
 * below makes `{ ...base, ...patch } as T` compile just as happily.
 */
export function applyPatch<T extends object>(base: T, patch: Patch<T>): T {
  const next = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

/**
 * Which persona a session presents: its system prompt and toolset. Independent
 * of the {@link Harness} that runs it — every persona runs on either engine —
 * and fixed for the session's lifetime. The one persona type for the wire, the
 * server and the web client.
 *
 * `personal-assistant` is the permanent singleton Personal Assistant persona and
 * `workflow-coordinator` drives Workflow Runs. Both are server-owned: they can
 * never be created through an ordinary client command or persona picker (see
 * {@link isOrdinarilyCreatableAgentType}), only through their dedicated
 * acquisition paths.
 */
export const AGENT_TYPE_IDS = [
  "assistant",
  "workshop",
  "developer",
  "personal-assistant",
  "workflow-coordinator",
] as const;

export type AgentType = (typeof AGENT_TYPE_IDS)[number];

/** Whether an arbitrary string names a persona (a value read off a record). */
export function isAgentType(value: string): value is AgentType {
  return (AGENT_TYPE_IDS as readonly string[]).includes(value);
}

/** The stable key of the permanent singleton Personal Assistant persona. */
export const PERSONAL_ASSISTANT_AGENT_TYPE = "personal-assistant" as const;

/** Whether a persona is the singleton Personal Assistant (server-owned). */
export function isPersonalAssistantAgentType(
  agentType: AgentType | undefined,
): boolean {
  return agentType === PERSONAL_ASSISTANT_AGENT_TYPE;
}

/**
 * The persona keys an ordinary client command / persona picker may create.
 * Server-owned `personal-assistant` and `workflow-coordinator` personas are
 * intentionally excluded: they are created only by their dedicated runtime
 * paths, so a crafted client payload supplying either key must be rejected
 * before any session side effect.
 */
export const ORDINARILY_CREATABLE_AGENT_TYPES: readonly AgentType[] = [
  "assistant",
  "workshop",
  "developer",
];

/** Whether a client may ordinarily create a session with this persona key. */
export function isOrdinarilyCreatableAgentType(
  agentType: string | undefined,
): agentType is AgentType {
  return (
    agentType === "assistant" ||
    agentType === "workshop" ||
    agentType === "developer"
  );
}

/**
 * The code-editing personas (Workshop and Developer) that get file/shell tools,
 * git-worktree/commit/review treatment, and toolGroups. The Assistant persona has
 * none of that. Use this instead of comparing to `"workshop"` directly so the
 * Developer persona is never accidentally excluded.
 */
export function isCodingAgentType(agentType: AgentType | undefined): boolean {
  return agentType === "workshop" || agentType === "developer";
}

/**
 * A selectable agent type, as advertised by the server and shown in the
 * Composer's agent-type picker (dev-only ones are omitted in prod). Keyed by the
 * clean {@link AgentType}, independent of harness.
 */
export interface AgentInfo {
  agentType: AgentType;
  label: string;
  /** True for agents only offered in dev mode (informational; the server already filters). */
  devOnly?: boolean;
}

/**
 * How much a session is allowed to CHANGE, independent of harness, persona and
 * model. `build` is the ordinary session: every tool the persona has. `plan`
 * removes the file-mutating NATIVE tools from the next turn onwards; reads,
 * search, shell and the whole `mcp__pa__*` toolset stay.
 *
 * That subtraction is the WHOLE guarantee: `plan` is not a read-only session
 * and not a sandbox. Shell commands still run and the `mcp__pa__*` tools still
 * write, so a Plan session can still change the working tree — enforcing that
 * boundary needs an OS-level sandbox, not this flag.
 *
 * A per-turn tool policy, NOT the Claude CLI's own `permissionMode: "plan"`
 * (which halts tool execution generally and owns its own exit protocol).
 */
export type SessionMode = "build" | "plan";

export const SESSION_MODES: SessionMode[] = ["build", "plan"];

/** The mode a session runs in unless one was chosen. */
export const DEFAULT_SESSION_MODE: SessionMode = "build";

/** Normalize arbitrary (persisted or client) input to a known mode. */
export function sessionModeOrDefault(mode: string | undefined): SessionMode {
  return SESSION_MODES.includes(mode as SessionMode)
    ? (mode as SessionMode)
    : DEFAULT_SESSION_MODE;
}

/**
 * WHOSE session this is, persisted with the session row itself and never
 * derived from who or what started it: provenance is not a scope, so two
 * sessions with the same initiator can hold different scopes and one scope says
 * nothing about who asked for the run.
 *
 * - `user` — a conversation the user owns. The ONLY scope a broad/default
 *   projection (sidebar, session lists, unread counts, day scan, default
 *   lookup) includes.
 * - `internal` — a server-only helper run that exists to attribute token/cost
 *   usage (titles, commit messages, …). Never user-facing.
 * - `subagent` — a session PA runs on the user's behalf under a subagent
 *   thread. Excluded from every default projection: it is reached through the
 *   subagent registry, not the sidebar.
 *
 * Scope is a SESSION property, not a run property, and it is fixed when the row
 * is written — before anything live can observe the session.
 */
export type SessionScope = "user" | "internal" | "subagent";

export const SESSION_SCOPES: SessionScope[] = ["user", "internal", "subagent"];

/** The scope of a session nothing classified otherwise: the user's own. */
export const DEFAULT_SESSION_SCOPE: SessionScope = "user";

/**
 * Normalize a persisted or wire scope value, FAILING CLOSED: an unrecognized
 * value resolves to `internal` rather than to the user's scope, so a row this
 * build cannot classify is hidden instead of leaking into a user projection.
 * Widening a scope is always a deliberate act, never a parse fallback.
 */
export function sessionScopeOrFailClosed(
  scope: string | null | undefined,
): SessionScope {
  return SESSION_SCOPES.includes(scope as SessionScope)
    ? (scope as SessionScope)
    : "internal";
}

/** A model the user has credentials for, offered in the model picker. */
export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  /** Whether the model supports a thinking/reasoning budget. */
  reasoning: boolean;
  /**
   * Thinking levels this provider/model can actually accept. Older servers may
   * omit this; clients should fall back to all levels for reasoning models and
   * only `off` for non-reasoning models.
   */
  supportedThinkingLevels?: ThinkingLevel[];
  contextWindow: number;
  /**
   * Picker label for the provider when the id is not one: the user-chosen name
   * of the app's OpenAI-compatible endpoint.
   */
  providerName?: string;
}

/**
 * A model offered under one specific provider account. Settings pickers list
 * account/model combinations so choosing a model also chooses the account;
 * session/composer pickers keep using the plain {@link ModelOption}.
 */
export interface AccountModelOption extends ModelOption {
  credentialProfileId: string;
  accountName: string;
  /** True when the owning account is disabled (kept visible only as a current pin). */
  accountDisabled?: boolean;
}

export function clampThinkingLevelForModel(
  model: ModelOption | undefined,
  level: ThinkingLevel,
): ThinkingLevel {
  const availableLevels = supportedThinkingLevelsForModel(model);
  if (availableLevels.includes(level)) return level;
  const requestedIndex = THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) return availableLevels[0] ?? "off";
  for (let i = requestedIndex; i < THINKING_LEVELS.length; i += 1) {
    const candidate = THINKING_LEVELS[i];
    if (candidate && availableLevels.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i -= 1) {
    const candidate = THINKING_LEVELS[i];
    if (candidate && availableLevels.includes(candidate)) return candidate;
  }
  return availableLevels[0] ?? "off";
}

/** Safe projection of a PA-owned provider credential profile. Never contains a token. */
export type CredentialProfileProvider = "openai-codex" | "claude";
export type CredentialProfileStatus =
  "disconnected" | "connecting" | "ready" | "error";
export interface CredentialProfileSummary {
  id: string;
  name: string;
  provider: CredentialProfileProvider;
  /** Disabled profiles remain available to already-bound sessions but are omitted from new-session and Usage account choices. */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  status: CredentialProfileStatus;
  error?: string;
  setup?: {
    path: string;
    command: string;
    detail: string;
    verificationUri?: string;
    userCode?: string;
  };
  /** Where this account is currently used. Only present when explicitly requested. */
  usage?: CredentialProfileUsage;
}

/** One configured model slot that names a provider account. */
export interface CredentialProfileSlotUsage {
  /** Stable slot key from the server-side settings slot registry. */
  key: string;
  label: string;
  /** Settings section id the slot is edited in, for deep links. */
  section: string;
}

/**
 * What depends on one provider account, so disabling or deleting it is an
 * informed decision. Settings pins move to automatic; bound sessions keep
 * running on the account (including their forks, `/clear` and drafts).
 */
export interface CredentialProfileUsage {
  /** Settings slots explicitly pinned to this account. */
  pinnedSlots: CredentialProfileSlotUsage[];
  /** Sessions durably bound to this account. */
  boundSessionCount: number;
  /** Set when this account is the current automatic pick for its provider. */
  automaticForProvider?: CredentialProfileProvider;
  /** The account automatic work would move to if this one were disabled. */
  automaticFallback?: { id: string; name: string };
}

/** Browser terminal projection for one official Claude CLI login process. */
export type ClaudeLoginTerminalStatus =
  "connecting" | "ready" | "error" | "cancelled";
export type ClaudeLoginServerMessage =
  | {
      type: "snapshot";
      profileId: string;
      status: ClaudeLoginTerminalStatus;
      output: string;
      startedAt: number;
      error?: string;
    }
  | { type: "output"; chunk: string }
  | { type: "status"; status: ClaudeLoginTerminalStatus; error?: string };
export type ClaudeLoginClientMessage =
  { type: "input"; data: string } | { type: "cancel" };

/**
 * Claude SDK picker models — the in-process Claude Agent SDK offered as an
 * Anthropic provider in the model picker.
 */
export const CLAUDE_SDK_MODELS: ModelOption[] = [
  {
    provider: CLAUDE_SDK_PROVIDER,
    id: "opus",
    name: "Claude Opus",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    contextWindow: 200_000,
  },
  {
    provider: CLAUDE_SDK_PROVIDER,
    id: "sonnet",
    name: "Claude Sonnet",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    contextWindow: 200_000,
  },
  {
    provider: CLAUDE_SDK_PROVIDER,
    id: "haiku",
    name: "Claude Haiku",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    contextWindow: 200_000,
  },
  // Fable's thinking is always on, so `off` is omitted from its levels. The
  // server's model list is authoritative for the picker; this optimistic entry
  // mirrors it. 1M context window.
  {
    provider: CLAUDE_SDK_PROVIDER,
    id: "fable",
    name: "Claude Fable",
    reasoning: true,
    supportedThinkingLevels: ["low", "medium", "high", "xhigh"],
    contextWindow: 1_000_000,
  },
];

export function isClaudeSdkModel(
  model: { provider: string; id: string } | undefined,
): boolean {
  return model?.provider === CLAUDE_SDK_PROVIDER;
}

/**
 * Human label for a model-picker provider group. A provider that carries its
 * own display name uses it and the `claude-sdk` provider gets a friendly label;
 * everything else keeps its raw provider string (so github-copilot/openai render
 * unchanged).
 */
export function providerLabel(provider: string, providerName?: string): string {
  if (providerName?.trim()) return providerName.trim();
  if (provider === CLAUDE_SDK_PROVIDER) return "Claude SDK";
  return provider;
}

/**
 * Picker model for the in-process Claude SDK provider, by alias, so the
 * `claude-sdk` provider is preserved on the synthetic optimistic session.
 */
export function claudeSdkModelOption(
  id: string | undefined,
  contextWindow?: number,
): ModelOption | undefined {
  const alias = claudeModelAlias(id);
  const base = CLAUDE_SDK_MODELS.find((model) => model.id === alias);
  if (!base) return undefined;
  // Keep the model's own context window (e.g. 1M for Fable) unless the caller
  // supplies a learned value to override it.
  return contextWindow ? { ...base, contextWindow } : base;
}

export function claudeModelAlias(id: string | undefined): string {
  const value = (id ?? "sonnet").toLowerCase();
  if (value.includes("opus")) return "opus";
  if (value.includes("haiku")) return "haiku";
  if (value.includes("fable")) return "fable";
  return "sonnet";
}

/** Stable key for a model across the wire and in settings (`provider:id`). */
export function modelKey(m: { provider: string; id: string }): string {
  return `${m.provider}:${m.id}`;
}

/**
 * The provider/model every unconfigured helper slot falls back to: session
 * naming, commit and PR messages, prompt refinement, task intake, the memory
 * processor, worktree naming, the permanent assistant, and
 * `selectPiModelWithFallback`'s own last-resort preference.
 *
 * It was `github-copilot`/`gpt-4.1` — the catalog's last non-reasoning Copilot
 * model — until pi 0.87 dropped that id. Keep it a model the bundled pi
 * actually lists, or every slot the user never touched resolves to nothing.
 */
export const DEFAULT_HELPER_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-6-luna",
} as const;

/**
 * User preferences for the model picker. An overlay on the live model list:
 * models the registry offers but settings don't mention stay visible, ordered
 * after the explicitly arranged ones — so newly available models just appear.
 */
export interface ModelSettings {
  /** Model keys ({@link modelKey}) hidden from the picker. */
  hidden: string[];
  /** Preferred order of model keys; unlisted models follow in default order. */
  order: string[];
}

/**
 * Display-level appearance and panel-visibility toggles. They never affect
 * prompts, provider requests, or durable content. All are individually toggleable.
 */
export interface AppearanceSettings {
  /** Horizontal rule between the last tool activity of a turn and its final answer text. */
  separatorBeforeFinalResponse: boolean;
  /** Horizontal rule after a completed turn, marking the turn boundary. */
  separatorAtTurnEnd: boolean;
  /** Muted per-turn + session cumulative token/cost stats row at the turn end. */
  turnStatsRow: boolean;
  /**
   * Expand the stats row with a per-provider-request cache breakdown (one row per
   * request in the turn), so a cache miss on any single request is visible instead
   * of averaged into the turn sum. Only meaningful when {@link turnStatsRow} is on.
   */
  turnStatsPerRequest: boolean;
  /** Offer Knowledge in the desktop right-panel picker; does not disable the Knowledge Base. */
  knowledgePanelEnabled: boolean;
  /** Offer Worktree in the desktop right-panel picker; does not disable worktrees. */
  worktreePanelEnabled: boolean;
}

/**
 * The provider account a configured model slot runs on. Unset means automatic:
 * the first enabled account of the slot model's provider, which is also the
 * fallback when the pinned account is disabled or deleted — pinning an account
 * must never be able to break background automation.
 */
export interface CredentialProfilePin {
  credentialProfileId?: string;
}

/** Configurable identity/model profile for the singleton Personal Assistant session. */
export interface PermanentAssistantSettings extends CredentialProfilePin {
  name: string;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  additionalInstructions: string;
}

/** Settings for the dedicated no-tool agent that names sessions after the first prompt. */
export interface SessionNamingSettings extends CredentialProfilePin {
  enabled: boolean;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/** Settings for the dedicated no-tool agent that drafts commit messages. */
export interface CommitAgentSettings extends CredentialProfilePin {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/** Settings for the dedicated no-tool agent that drafts pull requests. */
export interface PrAgentSettings extends CredentialProfilePin {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * Settings for the `convert_pdf` tool's Claude fallback (scanned/image PDFs
 * transcribed via a document block). The offline pdf2md path needs no settings;
 * only the Claude fallback has a controllable model/thinking level. Document
 * blocks are Claude-only, so `provider` is expected to be `claude-sdk`.
 */
export interface PdfConversionSettings extends CredentialProfilePin {
  /** Master switch for the paid Claude fallback. When off, scanned PDFs return low-text only. */
  fallbackEnabled: boolean;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  timeoutMs: number;
}

/** Settings for the dedicated no-tool agent that scans meeting minutes for action items. */
export interface MeetingMinutesScannerSettings extends CredentialProfilePin {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  maxSourceChars: number;
  maxSnippetChars: number;
  timeoutMs: number;
}

/** Model used for the calendar's per-day assistant session (the day scan + chat). */
export interface CalendarDaySessionSettings extends CredentialProfilePin {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * The user's own accounts across day-scan sources, so the correlation layer can
 * resolve "me"/"mine" deterministically. All optional; unset identities degrade
 * that source's own-involvement signals instead of breaking collection.
 */
export interface DayScanIdentities {
  googleEmail?: string;
  jiraAccountId?: string;
  jiraEmail?: string;
  githubLogin?: string;
  tempoAccountId?: string;
}

/**
 * Automatic morning collection so the day-prep view is ready before the day
 * starts (plan phase 8). Builds on the per-day lock/coalescing and the separate
 * collection/synthesis triggers.
 */
export interface DayScanScheduleSettings {
  /** When true, the server runs a collection each day at `time` in the user's timezone. */
  enabled: boolean;
  /** Local time-of-day "HH:MM" (24h) in the user's timezone ({@link ProfileSettings}) the morning run fires. */
  time: string;
  /** Also run synthesis after the scheduled collection so the report is ready. */
  synthesize: boolean;
}

/**
 * The app's user. The timezone is the ONE zone every user-local day and time
 * resolves in — the day scan and its schedule, calendar days, memory temporal
 * rules, "today" for Tasks, and the local times integration tools report.
 */
export interface ProfileSettings {
  /** How prompts and comments name the user; "" leaves them unnamed. */
  displayName: string;
  /** IANA timezone; "" (or an invalid stored value) follows the server host's zone. */
  timeZone: string;
  /**
   * Read-only projection: the zone in effect — `timeZone` when valid, else the
   * server host's zone, else "UTC". Ignored on save.
   */
  effectiveTimeZone: string;
}

/** Settings for the deterministic daily scanner (collection + synthesis pipeline). */
export interface DayScanSettings {
  identities: DayScanIdentities;
  /** `auto` = high AND medium candidates auto-create Tasks (only low needs acceptance); `review` = all require acceptance. */
  taskProposalPolicy: "auto" | "review";
  /** Maximum issues selected for Jira changelog fetches per run. */
  changelogIssueCap: number;
  /** Maximum minutes documents pushed through extraction/curation per run; the rest defer. */
  maxMinutesDocsPerRun: number;
  /** Automatic morning collection/synthesis schedule. */
  schedule: DayScanScheduleSettings;
}

/** Settings for the dedicated no-tool agent that refines dictated draft prompts. */
export interface PromptRefinementSettings extends CredentialProfilePin {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * One `spoken → written` rewrite applied to a dictated transcript. Decoder-level
 * hotword biasing is unavailable for the shipped Parakeet model (it needs a BPE
 * vocab the model archive does not include), so domain jargon is fixed after
 * decoding instead. Matching is case-insensitive and word-boundary anchored.
 */
export interface SpeechVocabularyEntry {
  /** Spoken form as the recognizer tends to render it, e.g. `forge joe`. */
  from: string;
  /** Written form to substitute, e.g. `Forgejo`. */
  to: string;
}

/** User-editable settings for composer dictation (speech to text). */
export interface SpeechToTextSettings {
  /** Master switch for the composer mic button. */
  enabled: boolean;
  /** Which installed model to use; empty selects the first available one. Never a filesystem path. */
  modelId: string;
  /** Recognizer inference threads. */
  numThreads: number;
  /** Stop the warm recognizer after this long without an utterance (0 keeps it resident). */
  idleShutdownSeconds: number;
  /** Hard cap on a single utterance; the client stops recording at this point. */
  maxUtteranceSeconds: number;
  /** Post-decode jargon rewrites. */
  vocabulary: SpeechVocabularyEntry[];
}

/**
 * Whether this server instance can actually transcribe, and why not when it
 * cannot. Sent on `ready` so the composer can disable the mic button with a
 * real reason instead of failing at the first press. Deliberately deployment
 * state, not user settings: the model lives in the Nix store and PR preview
 * instances intentionally ship without it.
 */
/** Bounds the server clamps dictation settings to; 0 idle seconds keeps the recognizer resident. */
export const SPEECH_TO_TEXT_LIMITS = {
  numThreads: { min: 1, max: 32 },
  idleShutdownSeconds: { min: 0, max: 24 * 3600 },
  maxUtteranceSeconds: { min: 5, max: 300 },
  vocabularyEntries: 200,
} as const;

export interface SpeechToTextStatus {
  /** True when both a recognizer binary and a complete model directory were found. */
  configured: boolean;
  /** Human-readable explanation when `configured` is false. */
  reason?: string;
  /** Selected model id, when one resolved. */
  modelId?: string;
  /** Model ids this instance could switch to. */
  availableModelIds: string[];
  /** Utterance cap echoed from settings so the client can enforce the same bound. */
  maxUtteranceSeconds: number;
}

/**
 * Browser → server frames on `/ws/speech`. `warm` starts model loading while
 * browser microphone setup runs; audio itself arrives as binary frames
 * (little-endian signed 16-bit mono PCM) between `start` and `stop`. Kept out
 * of {@link ClientMessage} so the
 * session socket's exhaustive validator registry is unaffected.
 */
export type SpeechClientMessage =
  /** Begin background model loading before browser microphone capture is ready. */
  | { type: "warm"; utteranceId: string }
  | { type: "start"; utteranceId: string; sampleRate: number }
  | { type: "stop"; utteranceId: string }
  | { type: "cancel"; utteranceId: string };

/** Server → browser frames on `/ws/speech`. */
export type SpeechServerMessage =
  | { type: "accepted"; utteranceId: string }
  | {
      type: "transcript";
      utteranceId: string;
      text: string;
      audioMs: number;
      decodeMs: number;
    }
  | { type: "error"; utteranceId?: string; message: string };

/** Response of the one-shot `POST /api/speech/transcribe` fallback used when the socket dies. */
export interface SpeechTranscribeResponse {
  text: string;
  audioMs: number;
  decodeMs: number;
}

export { applySpeechVocabulary } from "./speechVocabulary.ts";

/** Settings for the dedicated agent that curates Task intake context into a usable Task. */
export interface TaskIntakeAgentSettings extends CredentialProfilePin {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** Project registry id automatically linked to newly imported Tasks; empty disables automatic linking. */
  projectId: string;
  /** Optional style/context guidance appended without weakening the fixed safety/schema contract. */
  additionalInstructions: string;
}

/** How a worktree branch is folded back into its base branch. */
export type WorktreeMergeStrategy = "squash" | "merge" | "rebase";

/** Settings for the dedicated no-tool agent that names worktree folders/branches. */
export interface WorktreeNamingSettings extends CredentialProfilePin {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/** Settings for the agent session that resolves merge conflicts (needs tools). */
export interface WorktreeMergeAgentSettings extends CredentialProfilePin {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/** Settings for git worktree management. */
/** Longest automatic remote-fetch interval; 0 turns the fetch off. */
export const MAX_WORKTREE_REMOTE_FETCH_MINUTES = 24 * 60;

export interface WorktreeSettings {
  /** Global root folder new worktrees are created under (projects can override). */
  root: string;
  namingAgent: WorktreeNamingSettings;
  mergeAgent: WorktreeMergeAgentSettings;
  defaultMergeStrategy: WorktreeMergeStrategy;
  /** Minutes between background remote checks; 0 disables them. */
  remoteFetchMinutes: number;
}

/** Pi provider id the app registers the OpenAI-compatible endpoint under. */
export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";

/**
 * How an OpenAI-compatible endpoint takes thinking control — pi's
 * `thinkingFormat` values that need no further configuration. "none" sends
 * none and treats every model as non-reasoning.
 */
export const OPENAI_COMPATIBLE_THINKING_FORMATS = [
  "none",
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "zai",
  "qwen",
  "qwen-chat-template",
  "string-thinking",
] as const;
export type OpenAiCompatibleThinkingFormat =
  (typeof OPENAI_COMPATIBLE_THINKING_FORMATS)[number];

/** A model discovered from an OpenAI-compatible endpoint's `/models`. */
export interface OpenAiCompatibleModelInfo {
  id: string;
  name: string;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  ownedBy?: string;
  status?: string;
  parameterCount?: number;
  sizeBytes?: number;
}

/** Public OpenAI-compatible provider configuration shown in settings. */
export interface OpenAiCompatibleSettings {
  enabled: boolean;
  /** Display name, shown as the provider in the model picker. */
  name: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  thinkingFormat: OpenAiCompatibleThinkingFormat;
  models: OpenAiCompatibleModelInfo[];
}

/** Patch sent by the settings UI. Secret fields are write-only and never echoed back. */
export interface OpenAiCompatibleSettingsPatch {
  enabled?: boolean;
  name?: string;
  baseUrl?: string;
  thinkingFormat?: OpenAiCompatibleThinkingFormat;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface OpenAiCompatibleConnectionStatus {
  ok: boolean;
  checkedAt: number;
  message: string;
  models: OpenAiCompatibleModelInfo[];
}

/** Public web-search (Brave) configuration shown in settings; secret-free. */
export interface BraveSettings {
  enabled: boolean;
  apiKeyConfigured: boolean;
}

/** Patch sent by the settings UI. The API key is write-only and never echoed back. */
export interface BraveSettingsPatch {
  enabled?: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface BraveConnectionStatus {
  ok: boolean;
  checkedAt: number;
  message: string;
}

/** Public Context7 docs-search configuration shown in settings; secret-free. */
export interface Context7Settings {
  enabled: boolean;
  apiKeyConfigured: boolean;
}

/** Patch sent by the settings UI. The API key is write-only and never echoed back. */
export interface Context7SettingsPatch {
  enabled?: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface Context7ConnectionStatus {
  ok: boolean;
  checkedAt: number;
  message: string;
}

/** Public, non-secret GitHub integration configuration shown in settings. */
export interface GithubSettings {
  enabled: boolean;
  /** Whether a personal access token is saved server-side. The token itself is never sent to the browser. */
  tokenConfigured: boolean;
  /** Optional default owner (org or user) used when a tool call omits one. */
  defaultOwner: string;
  /**
   * Whether the loopback package proxy runs for agent builds (defaults on).
   * It authenticates GitHub PACKAGE registries server-side so builds never hold
   * the token; see `docs/package-proxy.md`.
   */
  packageProxyEnabled: boolean;
}

/** Patch sent by the settings UI. The token is write-only and never echoed back. */
export interface GithubSettingsPatch {
  enabled?: boolean;
  token?: string;
  clearToken?: boolean;
  defaultOwner?: string;
  packageProxyEnabled?: boolean;
}

export interface GithubConnectionStatus {
  ok: boolean;
  checkedAt: number;
  message: string;
  /** Resolved GitHub login of the authenticated token, when known. */
  login?: string;
  /** OAuth scopes reported for the token, when known (classic PATs only). */
  scopes?: string[];
}

/**
 * Public, non-secret Forgejo integration configuration shown in settings.
 * Forgejo is self-hosted, so unlike GitHub the instance base URL is user
 * configuration (non-secret, echoed back); only the access token is a secret.
 */
export interface ForgejoSettings {
  enabled: boolean;
  /** Base URL of the Forgejo/Gitea instance, e.g. https://git.example.com. */
  baseUrl: string;
  /** Whether an access token is saved server-side. The token itself is never sent to the browser. */
  tokenConfigured: boolean;
  /** Optional default owner (org or user) used when a tool call omits one. */
  defaultOwner: string;
}

/** Patch sent by the settings UI. The token is write-only and never echoed back. */
export interface ForgejoSettingsPatch {
  enabled?: boolean;
  baseUrl?: string;
  token?: string;
  clearToken?: boolean;
  defaultOwner?: string;
}

export interface ForgejoConnectionStatus {
  ok: boolean;
  checkedAt: number;
  message: string;
  /** Resolved Forgejo login of the authenticated token, when known. */
  login?: string;
  /** Reported Forgejo/Gitea server version, when known. */
  version?: string;
}

/**
 * Settings for the in-process Claude Agent SDK agent (`claude-sdk`), driven
 * in-process via `@anthropic-ai/claude-agent-sdk`.
 */
export interface ClaudeSdkSettings {
  enabled: boolean;
}

/** Request body for the prompt-refinement HTTP endpoint. */
export interface PromptRefineRequest {
  text: string;
  sessionId?: string;
  /** Which persona/toolset the refinement should tailor itself to. */
  agentType?: AgentType;
  includeContext?: boolean;
}

/** Response body for the prompt-refinement HTTP endpoint. */
export interface PromptRefineResponse {
  refinedText: string;
}

/** Public, non-secret Jira integration configuration shown in settings. */
export interface JiraSettings {
  enabled: boolean;
  /** Atlassian host; static deployment config (config.ts). Shown read-only in the UI. */
  jiraHost: string;
  /** Atlassian account email used for Jira API Basic auth. */
  atlassianEmail: string;
  /** Whether an Atlassian API token is saved server-side. The token itself is never sent to the browser. */
  atlassianTokenConfigured: boolean;
}

/** Compact Jira issue metadata used to enrich linked-ticket UI rows. */
export interface JiraLinkedIssue {
  key: string;
  summary: string;
  url: string;
}

export interface JiraLinkedIssuesResponse {
  issues: JiraLinkedIssue[];
}

/** Live title/state for a GitHub issue or pull request linked to a Task. */
export interface GithubLinkedIssue {
  /** Canonical `owner/repo#123` ref, as stored on the Task. */
  ref: string;
  title: string;
  state: "open" | "closed" | "merged";
  isPullRequest: boolean;
  url: string;
}

export interface GithubLinkedIssuesResponse {
  issues: GithubLinkedIssue[];
}

/** Patch sent by the settings UI. Secret fields are write-only and never echoed back. */
export interface JiraSettingsPatch {
  enabled?: boolean;
  atlassianEmail?: string;
  atlassianToken?: string;
  clearAtlassianToken?: boolean;
}

export interface JiraConnectionStatus {
  ok: boolean;
  checkedAt: number;
  message: string;
  /** Resolved Atlassian accountId of the authenticated user, when known. */
  accountId?: string;
  /** Resolved display name of the authenticated user, when known. */
  displayName?: string;
}

/**
 * Public, non-secret Confluence integration configuration shown in settings.
 * Confluence has no credentials of its own: it authenticates as the same
 * Atlassian account as Jira, so the settings page reports whether that
 * dependency is satisfied rather than asking for a second token.
 */
export interface ConfluenceSettings {
  enabled: boolean;
  /** Atlassian host serving Confluence; static deployment config, shown read-only. */
  confluenceHost: string;
  /** Whether the Jira integration supplies usable Atlassian credentials. */
  credentialsAvailable: boolean;
}

/** Patch sent by the settings UI. Confluence owns only its enable switch. */
export interface ConfluenceSettingsPatch {
  enabled?: boolean;
}

export interface ConfluenceConnectionStatus {
  ok: boolean;
  checkedAt: number;
  message: string;
  /** Resolved Atlassian accountId of the authenticated user, when known. */
  accountId?: string;
  /** Resolved display name of the authenticated user, when known. */
  displayName?: string;
}

/** Public, non-secret Tempo integration configuration shown in settings. */
export interface TempoSettings {
  enabled: boolean;
  /** Tempo API v4 base URL. Defaults to the public Tempo Cloud API. */
  apiBaseUrl: string;
  /** OAuth redirect URI that must be registered on the Tempo OAuth app. */
  redirectUri: string;
  /** Whether static Tempo OAuth client id and secret are configured in app config/environment. */
  oauthClientConfigured: boolean;
  /** Whether a Tempo refresh token is saved server-side. The token itself is never sent to the browser. */
  refreshTokenConfigured: boolean;
  /** Jira accountId used as the Tempo worklog author, resolved via the Jira integration when known. */
  authorAccountId: string;
}

/** Patch sent by the settings UI for runtime Tempo preferences/authorization state. */
export interface TempoSettingsPatch {
  enabled?: boolean;
  apiBaseUrl?: string;
  clearTokens?: boolean;
}

export interface TempoConnectionStatus {
  ok: boolean;
  checkedAt: number;
  message: string;
}

/** Public, non-secret Google Workspace integration configuration shown in settings. */
export interface GoogleSettings {
  enabled: boolean;
  /** OAuth redirect URI that must be registered on the Google Cloud OAuth client. */
  redirectUri: string;
  /** Google account email discovered during OAuth/testing, if known. */
  accountEmail: string;
  /** Google API scopes requested by this app. Gmail permits approval-gated archiving. */
  scopes: string[];
  /** Whether a static OAuth web client ID and secret are configured in app config/environment. */
  oauthClientConfigured: boolean;
  /** Whether a Google refresh token is saved server-side. The token itself is never sent to the browser. */
  refreshTokenConfigured: boolean;
  /** Whether the connected grant includes the Gmail permission needed to archive. */
  gmailArchiveAuthorized: boolean;
  /** Gmail label used by meeting-minutes discovery. */
  gmailMinutesLabelName: string;
}

/** Patch sent by the settings UI for runtime Google Workspace preferences/authorization state. */
export interface GoogleSettingsPatch {
  enabled?: boolean;
  clearTokens?: boolean;
  gmailMinutesLabelName?: string;
}

export interface GoogleConnectionStatus {
  ok: boolean;
  checkedAt: number;
  message: string;
  calendar?: { ok: boolean; message: string };
  gmail?: { ok: boolean; message: string };
  drive?: { ok: boolean; message: string };
  meet?: { ok: boolean; message: string };
}

/** Minimal, secret-free Slack state needed by the end-user settings UI. */
export interface SlackSettings {
  enabled: boolean;
  oauthClientConfigured: boolean;
  userTokenConfigured: boolean;
  botTokenConfigured: boolean;
  /** The workspace is connected: OAuth stores the user and bot tokens together. */
  connected: boolean;
  huddlesEnabled: boolean;
  clientTokenConfigured: boolean;
  clientCookieConfigured: boolean;
}

/** Patch sent by the settings UI. Secret fields are write-only and never echoed back. */
export interface SlackSettingsPatch {
  enabled?: boolean;
  /** Disconnect the workspace: clears the user and bot tokens OAuth stored. */
  disconnect?: boolean;
  userToken?: string;
  botToken?: string;
  huddlesEnabled?: boolean;
  clientToken?: string;
  clientCookieD?: string;
  clearUserToken?: boolean;
  clearBotToken?: boolean;
  clearClientToken?: boolean;
  clearClientCookie?: boolean;
}

export interface SlackConnectionStatus {
  ok: boolean;
  checkedAt: number;
  message: string;
}

/** Independent health for the experimental browser-backed Huddle capability. */
export interface SlackHuddleConnectionStatus {
  ok: boolean;
  checkedAt: number;
  message: string;
}

export type ToolGroupId = "browser" | "browser-raw-mcp";

/** Browser tool-group preferences: both packs are ordinary deferred/gated catalog groups (see tools/catalog.ts). */
export interface BrowserToolSettings {
  /** Launch a visible browser window instead of headless mode. */
  headed: boolean;
  /** Advanced escape hatch: expose the raw Playwright MCP passthrough tool (browser_mcp_call). */
  rawMcpEnabled: boolean;
}

/** One catalog tool's exposure row in a session's Tools inspector. */
export interface SessionToolExposureTool {
  name: string;
  /** Catalog tool-group id + label the tool belongs to. */
  group: string;
  groupLabel: string;
  /** Catalog loading tier: eager tools are always in the model context. */
  loading: "eager" | "deferred";
  /** Usable right now (integration gates + tool-group approval applied). */
  usable: boolean;
  /** Definition currently loaded into the model context. */
  loaded: boolean;
  /** Exact catalog definition size (wire name + description + JSON schema). */
  definitionChars: number;
  /** Whether this session has actually called the tool. */
  used: boolean;
  /** Approximate definition size in tokens, when the harness reports it. */
  tokens?: number;
}

/** How a batch of deferred tools got loaded into the model context. */
export interface SessionToolLoadEvent {
  at: number;
  /** find_tools (pi loader), reopen (transcript seed), tool_search (Claude native). */
  via: "find_tools" | "reopen" | "tool_search";
  names: string[];
}

/**
 * One time a coding session pulled a library skill's BODY into the model
 * context. A frozen name only makes the skill available (name + description);
 * the instructions arrive through Claude's `Skill` tool or, on pi, a read of
 * the materialized `SKILL.md` — the convention pi's prompt asks for.
 */
export interface SessionSkillInvocation {
  at: number;
  /** Declared library skill name, never plugin-qualified. */
  name: string;
  via: "skill_tool" | "read";
}

/** Session-level deferred-tool exposure projection (Tools inspector section). */
export interface SessionToolExposure {
  counts: {
    total: number;
    eager: number;
    usable: number;
    loaded: number;
    loadedButUnused: number;
    loadedButUnusedDefinitionChars: number;
  };
  tools: SessionToolExposureTool[];
  /** Bounded, newest-last load trail. */
  loadEvents: SessionToolLoadEvent[];
}

export interface SessionArtifact {
  id: string;
  sessionId: string;
  kind: "screenshot" | "trace" | "video" | "download" | "file";
  label: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  url: string;
  sourceTool?: string;
}

/**
 * One file a `show_files` call put in front of the user. The tool checks the
 * file and hands back this row; the chat renders each one as a
 * `ServedFileCard`, which re-derives the source AND the kind from {@link url}
 * through the shared document-target resolver. Nothing here may declare how the
 * file is presented — a row carries no mime or kind on purpose, so a crafted
 * one cannot dress a document up as a picture.
 */
export interface ShowFilesCardFile {
  /** App-relative address: `/api/files/<path>` or `/api/session-artifacts/<session>/<path>`. */
  url: string;
  /** File name as it sits on disk. */
  name: string;
  /** Caption: the agent's label for a single file, otherwise the name. */
  label: string;
  /** Bytes, from the stat that proved the file is there. */
  size: number;
  /** Markdown the AGENT may paste to place the same file inside its own reply. */
  snippet: string;
}

/** Structured `show_files` output: one card per file, in the order asked for. */
export interface ShowFilesCard {
  files: ShowFilesCardFile[];
}

/**
 * One Knowledge entry a `kb_show_entry` call put in front of the user, as the
 * shortcut into the reading surfaces: the chat card opens it in the right
 * panel's Knowledge tab, or in the main Knowledge route.
 *
 * Identity comes from the KB index, never from the caller: the tool resolves
 * the entry and re-spells its id, title and path here, so a card can only ever
 * name an entry that exists. {@link note} is the agent's own one line about why
 * it is showing this entry and is rendered as plain text.
 */
export interface KnowledgeEntryCard {
  /** Durable `kb.id`; the card's `pa://knowledge/<id>` address. */
  entryId: string;
  /** Entry title from its frontmatter. */
  title: string;
  /** Entry folder path in the KB repository, for orientation. */
  path: string;
  /** Frontmatter summary, when the entry has one. */
  summary?: string;
  /** The agent's reason for showing it, shown under the title. */
  note?: string;
}

export interface PendingPostReloadContinuation {
  id: string;
  message: string;
  reason?: string;
  createdAt: number;
}

/** Public server configuration needed to create one browser installation's Web Push subscription. */
export interface WebPushConfigResponse {
  applicationServerKey: string;
}

/** The serializable subset of a browser PushSubscription accepted by the server. */
export interface WebPushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * Which of Apple's two push hosts a device token is valid against. It follows the
 * `aps-environment` entitlement the iOS app was signed with, and a token sent to
 * the wrong one is rejected as `BadDeviceToken` — so the app reports its own
 * value rather than the server assuming either.
 */
export type ApnsEnvironment = "development" | "production";

/** One iOS installation's APNs registration, as the native shell reports it. */
export interface ApnsDeviceInput {
  /** Lowercase hex device token from `registerForRemoteNotifications`. */
  token: string;
  environment: ApnsEnvironment;
  /**
   * Stable id for this INSTALLATION, which the device token is not.
   *
   * Apple mints a fresh token whenever the app is reinstalled or restored and
   * leaves the old one working for a while, so a store keyed on the token
   * accumulates a row per install and the phone buzzes once per row. Keying on
   * the installation is what makes a new token REPLACE its predecessor.
   */
  installId?: string;
  /** Free text for the settings page, e.g. the device model. */
  label?: string;
}

/**
 * Whether this server can push to an iOS installation at all.
 *
 * `configured` is false until an APNs auth key is placed under the data
 * directory; the app uses it to decide whether to register a device token or fall
 * back to raising alerts over the live socket, which only works while it runs.
 */
export interface ApnsConfigResponse {
  configured: boolean;
  /** Bundle identifier the stored key pushes to, when one is configured. */
  bundleId?: string;
  /** How many installations are registered, for the settings page. */
  deviceCount: number;
}

/**
 * What one real push attempt did. Answers the settings page's test, which is the
 * only way to see an APNs rejection: Apple reports it to the server and never to
 * the device.
 */
export interface ApnsDeliveryReport {
  delivered: number;
  /** One human-readable line per installation that did not get it. */
  failures: string[];
}

export interface BrowserRuntimeInfo {
  sessionId: string;
  sessionFile?: string;
  sessionTitle?: string;
  agentKind: AgentType;
  agentStatus: "running" | "idle" | "not-live";
  connectedToCurrentSession: boolean;
  pid?: number;
  status: "starting" | "running" | "exited" | "error";
  headed: boolean;
  outputDir: string;
  startedAt: number;
  lastUsedAt: number;
  lastTool?: string;
  error?: string;
}

/**
 * The persisted, user-editable application settings. One field per settings
 * section so new sections can be added without reshaping existing ones.
 */
export interface AppSettings {
  models: ModelSettings;
  permanentAssistant: PermanentAssistantSettings;
  sessionNaming: SessionNamingSettings;
  commitAgent: CommitAgentSettings;
  prAgent: PrAgentSettings;
  meetingMinutesScanner: MeetingMinutesScannerSettings;
  pdfConversion: PdfConversionSettings;
  calendarDaySession: CalendarDaySessionSettings;
  dayScan: DayScanSettings;
  promptRefinement: PromptRefinementSettings;
  speechToText: SpeechToTextSettings;
  taskIntakeAgent: TaskIntakeAgentSettings;
  browserTools: BrowserToolSettings;
  /** Governance for session-owned background work ([Task-467](pa://task/467)). */
  backgroundWork: BackgroundWorkSettings;
  jira: JiraSettings;
  confluence: ConfluenceSettings;
  tempo: TempoSettings;
  google: GoogleSettings;
  slack: SlackSettings;
  openAiCompatible: OpenAiCompatibleSettings;
  brave: BraveSettings;
  context7: Context7Settings;
  github: GithubSettings;
  forgejo: ForgejoSettings;
  claudeSdk: ClaudeSdkSettings;
  worktrees: WorktreeSettings;
  /** Root folder under which projects are cloned/provisioned (per-repo dir = projectsRoot/<project id>). */
  projectsRoot: string;
  /** Agent memory system settings (Task 91). */
  memory: MemorySettings;
  /**
   * Runtimes the user has pre-approved for agents to start ordinary peer
   * sessions on ([Task-595](pa://task/595)), in display order. Empty means an
   * agent must go through the approval card for every batch.
   */
  peerSpawnRuntimes: PeerSpawnRuntime[];
  /**
   * Maximum hops in one uninterrupted causal agent-to-agent prompt chain.
   * A human-origin prompt closes the chain and resets this loop guard.
   */
  sessionPeerPromptMaxHops: number;
  /**
   * Global on/off state for the user-owned skills library
   * ([Task-613](pa://task/613)), keyed by declared skill name. Sparse: a name
   * with no entry is OFF, so this section names what the user turned ON rather
   * than describing the whole library. Project and session scopes come later.
   */
  skills: SkillToggles;
  /** Chat-transcript appearance toggles (Task 118). */
  appearance: AppearanceSettings;
  /** Who the app works for: display name and the timezone local days resolve in. */
  profile: ProfileSettings;
}

/** Slash commands offered by the server. */
export interface SlashCommandInfo {
  name: string;
  description: string;
  usage: string;
  /** Which agent personas this command applies to (keyed by {@link AgentType}). */
  agentTypes: AgentType[];
  /**
   * Which harnesses can run this command. Omitted = every harness (the command
   * is harness-independent, e.g. /commit, /compact and /clear). Set this only
   * for a command that depends on one runtime's own machinery.
   */
  harnesses?: Harness[];
  /**
   * Where the command executes once the composer intercepts it. Omitted =
   * "host": the composer dispatches `runSlashCommand` and the server runs it
   * against the viewed session. "client" commands are handled entirely in the
   * web app (e.g. /review navigates to a prefilled new-session draft) and
   * never reach the wire; the server rejects them if dispatched anyway. One
   * registry and one help list either way.
   */
  execution?: "host" | "client";
}

/**
 * Whether a slash command applies to a session with the given agentType + harness.
 * Used by BOTH the web composer (to populate the autocomplete menu and to decide
 * whether to intercept a typed command) and the server (to validate before
 * dispatch). `undefined` axes are treated permissively (a not-yet-created session
 * still offers/accepts the command). Slash commands are a universal concept:
 * a known command is ALWAYS intercepted by us, never forwarded to the model.
 */
export function slashCommandApplies(
  cmd: SlashCommandInfo,
  agentType: AgentType | undefined,
  harness: Harness | undefined,
): boolean {
  if (agentType && !cmd.agentTypes.includes(agentType)) return false;
  if (harness && cmd.harnesses && !cmd.harnesses.includes(harness))
    return false;
  return true;
}

/** A persisted web session, shown in the sidebar. */
/** Per-status counts of Tasks linked to a conversation (via `context` edges). */
export type SessionTaskProgress = Record<TaskStatus, number>;

export interface SessionObjectRef {
  objectType: Exclude<
    import("./objectLinks.ts").PaObjectType,
    "session" | "approval"
  >;
  id: string;
  source: "initial-context" | "comment-handoff" | "manual";
  linkedAt: number;
}

/**
 * What exactly a session is blocked on when it needs the user (`awaitingInput`).
 *
 * `task-choice` is a `/pr` card that drafted nothing because several Tasks
 * could be the one: it is its own kind rather than a `question` because the
 * answer is a click on that card, not a reply in the composer.
 */
export type SessionAttentionKind = "question" | "approval" | "task-choice";

/** The last run failure on a session, kept until a new run starts. */
export interface SessionRunFailure {
  at: number;
  /** Bounded, human-readable failure text; never a stack trace. */
  message: string;
}

/** What raised a session's attention revision: a run that ENDED, either way. */
export type SessionOutcomeKind = "completed" | "failed";

/**
 * Durable attention state for a session whose outcomes are the USER's to
 * acknowledge (see {@link isDirectlyOwnedSession}).
 *
 * The revision is the whole point: Settle acknowledges the outcome the user
 * OBSERVED, not "whatever is true when the command lands", so a completion that
 * arrives between the render and the click cannot be settled away by it. It
 * moves only on a completion or a failure — never on a turn starting, tool
 * activity, reading the transcript, or routing to the session — which is what
 * lets a settled session run its next turn without climbing back out of the
 * shelf.
 *
 * Present only once a revision has been raised, so `kind` and `at` always
 * describe the revision the row carries.
 */
export interface SessionOutcomeAttention {
  /** Monotonic, one bump per outcome. */
  revision: number;
  /** The revision an explicit Settle acknowledged; 0 when never settled. */
  settledRevision: number;
  kind: SessionOutcomeKind;
  at: number;
}

/**
 * The outcome the user has NOT acknowledged yet, or `undefined` when the
 * session's attention is settled through its latest one. ONE derivation for
 * both sides: the server decides with it whether a settled row is still
 * settled, and the browser projects the card's status from the same answer.
 */
export function pendingSessionOutcome(
  attention: SessionOutcomeAttention | undefined,
): SessionOutcomeAttention | undefined {
  return attention && attention.revision > attention.settledRevision
    ? attention
    : undefined;
}

/** Compositional activity below one immediate parent session. */
export interface SubagentDelegationSummary {
  /** Every accepted child run that has not reached a terminal state. */
  activeCount: number;
  /** Child runs not yet admitted to provider execution, including predecessor waits. */
  startingCount: number;
  /** Child runs executing or doing host-side terminal processing. */
  workingCount: number;
  /** Child runs paused on an exact required response from their parent. */
  awaitingParentCount: number;
}

/**
 * Who currently owns an agent-spawned peer session.
 *
 * `coordinator` is a spawn whose ownership has been tracked since creation (or
 * that the user handed back) and that the coordinator runs — messaging it does
 * not change that; `taken-over` records that the user explicitly took it over
 * (`setSpawnOwnership`) and now owns it; `unknown` is the fail-closed
 * value for a spawn edge created before ownership tracking, or whose stored
 * metadata cannot be classified. `unknown` is NOT coordinator-owned: a consumer
 * that hides coordinator-owned children must keep an unknown one reachable.
 */
export type SpawnOwnership = "coordinator" | "taken-over" | "unknown";

/** What the user may set a spawned session's owner to: never `unknown`. */
export type SettableSpawnOwnership = Exclude<SpawnOwnership, "unknown">;

/**
 * Whether this SESSION belongs directly to the user rather than to its
 * coordinator. This is the first gate for an outcome attention event.
 *
 * Everything the user drives directly qualifies: a session they started (no
 * spawn edge at all), one they took over, and — conservatively — one whose
 * edge predates ownership tracking. Only a session still being driven by its
 * coordinator does not: its completion belongs to the run above it, and
 * promoting it to a top-level inbox event would announce work the user never
 * asked for personally. The server separately decides whether a directly owned
 * coordinator run is an intermediate peer wake or a user-facing outcome.
 */
export function isDirectlyOwnedSession(
  ownership: SpawnOwnership | undefined,
): boolean {
  return ownership !== "coordinator";
}

/** Stable placeholder while a new session's dedicated naming agent runs. */
export const UNLABELED_SESSION_TITLE = "Unlabeled Session";

export interface SessionListItem {
  /** Stable session id (matches `SessionState.sessionId`); used in the URL. */
  id: string;
  /**
   * Whose session this is ({@link SessionScope}). Default projections carry
   * only `user` rows, so a row without it is the user's; a client must not
   * infer scope from anything else on the row.
   */
  scope?: SessionScope;
  /** Which engine runs this session (pi / claude-sdk). */
  harness: Harness;
  /** Which persona/toolset this session emulates, independent of harness. */
  agentType: AgentType;
  title: string;
  /** True while the dedicated naming agent is generating this session's title. */
  titleGenerationPending?: boolean;
  /** When the session was first created; insert-only, so it never moves. */
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** True while this session's agent run is currently active on the server. */
  isStreaming?: boolean;
  /** When the currently active run started, so elapsed labels stay honest. */
  runStartedAt?: number;
  /**
   * Activity delegated to immediate child runs. Independent of this session's
   * own provider turn (`isStreaming`/`runStartedAt`). Omitted when dormant.
   */
  delegation?: SubagentDelegationSummary;
  /**
   * Session-owned background work (shell commands and monitors) that survives
   * the provider turn. A separate component on purpose: it never sets or
   * derives `isStreaming`, `runStartedAt`, `unread` or the viewed session's
   * `runState`, so a provider-idle session can still be visibly busy. Omitted
   * when the session owns no active work.
   */
  backgroundActivity?: SessionBackgroundActivity;
  /** True when the session is paused on a pending question and needs the user to answer. */
  awaitingInput?: boolean;
  /** Which kind of human decision `awaitingInput` is waiting for. */
  attention?: SessionAttentionKind;
  /** The last run failure, cleared as soon as a new run starts. */
  lastError?: SessionRunFailure;
  /**
   * A turn was cut off mid-flight when the server process died, so the session's
   * transcript is missing it entirely. NOT a failure: the work is waiting to be
   * continued, and the next prompt of any kind clears this. Never set while the
   * session is streaming — an unfinished turn that is still running is just a
   * running turn.
   */
  interruptedRun?: { at: number };
  /**
   * True while peer-prompt work is on its way into this session — queued
   * behind its next turn, mid-delivery, or waiting out a retry backoff.
   */
  queuedWork?: boolean;
  /**
   * The peers that still owe this session a reply, by session id: it asked
   * (`responseRequested`), their turn ended without the answer, and nothing
   * from them — nor from a peer they handed the work to, on that handoff's
   * chain — has reached it since. A request still being delivered is not
   * listed. Omitted when none. What makes a quiet tree STALLED rather than
   * done: nothing is moving, and someone still owes an answer (the Sessions
   * inbox's `spawnTreeStall`).
   */
  awaitingRepliesFrom?: string[];
  /**
   * When the user settled this session out of the Sessions inbox working set.
   * Distinct from `archived`: a settled session stays in the ordinary list.
   *
   * Present only while the settlement still HOLDS: an outcome raised after it
   * ({@link outcomeAttention}) takes the row back out of the shelf, so no
   * consumer has to combine the two to know where the row belongs.
   */
  settledAt?: number;
  /**
   * Durable attention state for a directly owned session, absent until its
   * first outcome. Carries the revision a Settle from this row must
   * acknowledge, and — while it is unacknowledged — the outcome the card
   * states independently of transcript unread state.
   */
  outcomeAttention?: SessionOutcomeAttention;
  /** Task status counts for Session Tasks and linked durable Tasks. */
  taskProgress?: SessionTaskProgress;
  /** The coordinator session that durably created this peer via `session_spawn`. */
  spawnedBySessionId?: string;
  /**
   * Ownership of that spawn edge. Only present together with
   * `spawnedBySessionId`, and never inferred from titles or role words.
   */
  spawnOwnership?: SpawnOwnership;
  /** Source session/message when this session was forked, if known. */
  forkOrigin?: SessionForkOrigin;
  /** True for forked sessions before their first new prompt triggers a title refresh. */
  forkAutoRenamePending?: boolean;
  /** True when a response arrived that the user has not viewed since. */
  unread?: boolean;
  /** Runtime model used by the session, when known from persisted/live metadata. */
  model?: { provider: string; id: string; name?: string };
  /** Thinking/reasoning level used by the session, when known. */
  thinkingLevel?: ThinkingLevel;
  /** Immutable credential profile selected before this session's first prompt. */
  credentialProfileId?: string;
  /** True when the user archived the session; hidden from the default sidebar list. */
  archived?: boolean;
  /** The primary Project context this session was started with, if linked. */
  projectId?: string;
  /** The worktree this session executes in, if linked. */
  worktreeId?: string;
  /**
   * The session's `in_worktree` edge points at a worktree that is REMOVED or
   * whose folder is gone, and the user has not acknowledged running it in the
   * app working directory anyway. Distinct from having no edge at all (which is
   * an ordinary app-CWD session): running here would silently retarget the
   * agent at the wrong repository, so the server refuses until acknowledged.
   */
  worktreeMissing?: boolean;
  /** Structured first-class objects this session is explicitly related to. */
  objectRefs?: SessionObjectRef[];
  /**
   * The live `/pr` card this session owns, when it has one. Present so a list
   * row can state delivery; the card itself stays in the session's transcript.
   */
  pullRequest?: SessionPullRequestSummary;
}

/**
 * What a session with a dead `in_worktree` edge is blocked on, phrased for the
 * user. ONE wording for both sides, like {@link settleBlockedReason}: the server
 * refuses sends with it and the browser's banner explains the same block, so the
 * two can never disagree about why nothing can be sent.
 */
export const WORKTREE_MISSING_BLOCKED_REASON =
  "The worktree this session ran in no longer exists — sending would run the agent in the app directory instead.";

/**
 * How long a session must stay OPEN before reading it counts as having read it
 * — the mail-client dwell. Clearing "unread" on the click itself re-sorts the
 * Sessions inbox out from under the card you just aimed at (it drops out of the
 * attention tier while a working session climbs past it), and a session you
 * opened by mistake should still be waiting for you afterwards.
 *
 * ONE value for both sides, like `settleBlockedReason`: the server holds the
 * durable read mark back for this long, and the browser holds back its own "the
 * session I am looking at is never unread" rule for the same time, so the card
 * does not move twice.
 */
export const SESSION_READ_DWELL_MS = 3_000;

/**
 * Why this session may NOT leave the Sessions inbox working set, phrased as a
 * sentence fragment ("it is still running."), or `undefined` when settling is
 * allowed. ONE implementation on purpose: the browser disables the action with
 * this reason and the server refuses the command with it, so the two can never
 * disagree about what "done enough to leave" means.
 *
 * Unsettling is never blocked — it only ever adds work back to the visible set.
 */
export function settleBlockedReason(
  session: SessionListItem,
): string | undefined {
  if (session.isStreaming) return "it is still running.";
  const delegationReason = delegationObligationReason({
    activeRunCount: session.delegation?.activeCount ?? 0,
    unadmittedResultCount: 0,
    ownedManagedWorktreeCount: 0,
  });
  if (delegationReason) return delegationReason;
  const backgroundReason = backgroundWorkBlockedReason(
    session.backgroundActivity,
  );
  if (backgroundReason) return backgroundReason;
  if (session.attention === "approval")
    return "it is waiting for your approval.";
  if (session.attention === "task-choice")
    return "it is waiting for you to pick a Task.";
  if (session.attention === "question" || session.awaitingInput)
    return "it is waiting for your answer.";
  if (session.queuedWork) return "work is queued behind it.";
  return undefined;
}

/**
 * Why a formal Workflow Run may NOT be settled right now, phrased as the same
 * sentence fragment {@link settleBlockedReason} uses ("Cannot settle: …"), or
 * `undefined` when settling is allowed ([Task-677](pa://task/677)).
 *
 * ONE implementation on purpose, like the session rule: the run's inbox item
 * disables its Settle with this reason and the server refuses the command with
 * it, so the two can never disagree. It is read from the run's summary and
 * its recipe card projection — the same two things the browser rendered — and
 * a run whose projection is absent answers from the summary alone, which
 * knows no gate and therefore blocks nothing.
 *
 * A gate is an UNRESOLVED user decision: settling would put the item down
 * while the run still cannot move without an answer, and the wake rule would
 * bring the same item straight back. A cancellation in flight is the other
 * case — its end is about to raise a new revision, so acknowledging the pause
 * before it would only hide the item for a moment.
 */
/**
 * The sessions a run OWNS, from the structured ids its recipe projection
 * carries: the coordinator, the implementer, every review pass's newest
 * reviewer, the fixer and the verdict. ONE membership answer for both sides —
 * the browser folds exactly these under the run's inbox item, and the server
 * settles exactly these with the run — and the only answer either may have: a
 * title is free text an agent renames, so a rule reading "reviewer" out of one
 * would hide whatever session the user happened to call that.
 */
export function workflowRunRoleSessionIds(card: WorkflowRunCard): string[] {
  const ids = [
    card.coordinatorSessionId,
    card.implementerSessionId,
    card.fixerSessionId,
    card.verdictSessionId,
    ...(card.reviewerSessions ?? []).map((pass) => pass.sessionId),
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

export function workflowRunSettleBlockedReason(
  run: WorkflowRunSummary,
  card: WorkflowRunCard | undefined,
): string | undefined {
  if (card?.cancelRequested) return "it is being cancelled.";
  if (run.lifecycle !== "paused") return undefined;
  if (card?.ceilingDecision)
    return "it is waiting for your decision at its ceiling.";
  if (card?.mergeDecisionReady) return "it is waiting for your merge decision.";
  return undefined;
}

/**
 * Whether a formal Workflow Run is in the Sessions inbox WORKING SET — an item
 * of its own, with its role sessions folded under it. Three answers, one per
 * shape of the run:
 *
 * - A run still WORKING is live work and always an item (Task-676).
 * - A run that ENDED is an item exactly while its outcome is unacknowledged;
 *   once settled it leaves for good, since a terminal run raises no further
 *   event, and a historical run that never carried a cursor never arrives.
 * - A PAUSED run is an item while its pause is unacknowledged, or while it
 *   waits at a user gate Settle is refused for anyway. Settling a failure pause
 *   parks the run on its Task, where Retry and Resume are; resuming it makes
 *   it live again, and its next pause or ending wakes it. A paused run with no
 *   cursor at all is shown rather than lost — the migration gives every paused
 *   run one, so this is only the fail-open answer for a row this browser
 *   cannot otherwise read.
 *
 * Shared because the run's roles are taken OUT of the spawn forest
 * ({@link spawnClusterForest}) exactly while the run is an item, and the server
 * has to take the same rows out before it settles a coordinator's peers.
 */
export function workflowRunInWorkingSet(
  run: WorkflowRunSummary,
  card: WorkflowRunCard | undefined,
): boolean {
  const pending = pendingWorkflowRunAttention(run.attention) !== undefined;
  if (isTerminalWorkflowRunLifecycle(run.lifecycle)) return pending;
  if (run.lifecycle === "paused")
    return (
      pending ||
      run.attention === undefined ||
      workflowRunSettleBlockedReason(run, card) !== undefined
    );
  return true;
}

/**
 * Which working-set run owns each role session, from the structured ids on
 * the runs' card projections; the first run to name a session keeps it. Runs
 * not in the working set ({@link workflowRunInWorkingSet}) own nothing: a
 * settled run releases its sessions to what they would be on their own.
 */
export function workflowRunOwnerBySession(
  runs: readonly WorkflowRunSummary[],
  cards: Readonly<Record<string, WorkflowRunCard>>,
): Map<string, string> {
  const owner = new Map<string, string>();
  for (const run of runs) {
    const card = cards[run.id];
    if (!card || !workflowRunInWorkingSet(run, card)) continue;
    for (const sessionId of workflowRunRoleSessionIds(card))
      if (!owner.has(sessionId)) owner.set(sessionId, run.id);
  }
  return owner;
}

/**
 * Whether this row sits on the Settled shelf RIGHT NOW: the user put it down,
 * and it is not blocking on a human decision. A question, an approval and a
 * pull request waiting for a Task choice keep their own forced visibility —
 * whatever the shelf says, work that cannot proceed without an answer must
 * never be hidden inside a collapsed row.
 *
 * RUNNING is deliberately not on that list. A settled session's next turn
 * starting is not news (the server raises no attention for it), so it stays on
 * the shelf and comes back when the turn produces an OUTCOME — which is also
 * why `settledAt` alone is the whole question here: the server withholds it
 * from a row whose latest outcome is still unacknowledged. A peer a
 * coordinator still owns raises no outcome of its own; the server unsettles it
 * on a FAILURE alone, its completion being the coordinator's to act on.
 *
 * ONE implementation for both sides: the browser partitions the inbox with it,
 * and a shelved row folds only while live work hangs below it
 * ({@link spawnClusterForest}), so the server reads the same answer when a
 * Settle cascades to a coordinator's peers.
 */
export function isShelvedSession(session: SessionListItem): boolean {
  if (session.settledAt === undefined) return false;
  return !(
    session.attention === "approval" ||
    session.attention === "task-choice" ||
    session.attention === "question" ||
    session.awaitingInput
  );
}

/**
 * Whether a session is HISTORY in a spawn tree: put down
 * ({@link isShelvedSession}) and doing nothing now — no turn running, no
 * background job. A shelved session runs its next turn from the shelf, so
 * "shelved" alone would hide a peer its coordinator just set going again. ONE
 * predicate for the inbox's fold ({@link spawnClusterForest}), the composer
 * ledge and the server's Settle cascade, so the three agree on what is live.
 * Queued work, a retained host or running subagents do NOT make a shelved
 * session live here: they are not a turn or a job the user waits on. They
 * still block a Settle ({@link settleBlockedReason}), so a dormant session kept
 * in a fold by live work below it can refuse its coordinator's Settle in its
 * own words, exactly as the server would.
 */
export function isDormantInSpawnTree(session: SessionListItem): boolean {
  return (
    isShelvedSession(session) &&
    !session.isStreaming &&
    (session.backgroundActivity?.activeCount ?? 0) <= 0
  );
}

/**
 * The spawn forest the Sessions inbox folds: which member each member folds
 * into, once that edge is eligible AND bounded. Every member ends up in exactly
 * one cluster, and a member with no parent is the root of its own.
 */
export interface SpawnClusterForest {
  /** The spawner each folded member folds into; a root has no entry. */
  parentOf: ReadonlyMap<string, string>;
  /** The folded children of each member, in list order; a leaf has no entry. */
  childrenOf: ReadonlyMap<string, readonly string[]>;
  /** Every member once, parents before children. */
  order: readonly string[];
}

/**
 * The membership a coordinator and the peers it still owns are ONE Sessions
 * inbox item by (Task-675), from the durable spawn edge and its ownership and
 * nothing else — never a title or a role word.
 *
 * `members` are the candidates: the unarchived rows not owned by a working-set
 * Workflow Run ({@link spawnClusterMembers}). A child folds only when its
 * ownership is `coordinator` and its spawner is a member: `taken-over` is the
 * user's own session, `unknown` fails closed (`docs/agent-workflows.md`), and a
 * spawner that is archived, deleted or a run's role leaves its child standing
 * on its own. A DORMANT child ({@link isDormantInSpawnTree}: shelved, and
 * neither running a turn nor holding background jobs) folds only while live
 * work hangs below it — a non-dormant member folding into it, at any depth.
 * Otherwise the shelf is where the user put it, and folding it would take it
 * off; with live work under it, leaving it out would cut that work loose from
 * the coordinator above, and the top level is for the sessions the user drives.
 * A shelved peer its coordinator set running again is live work itself: it
 * runs from the shelf, raising no outcome, and folding it is what keeps that
 * run visible and lets it refuse its coordinator's Settle like any running
 * peer.
 * A child that is settled but asking is not shelved at all, so it folds — which
 * is how its question can refuse its coordinator's Settle.
 *
 * Depth is unbounded: every folded descendant belongs to its root however deep
 * the chain runs. The walk down from every root still DETACHES a cycle —
 * whichever of its sessions sorts first becomes a root, deterministically — so
 * every member is assigned exactly once and malformed edges cannot hang it.
 * (Liveness below is read before that break, so a dormant member caught in a
 * cycle with a live one may fold with nothing live under it — harmless, and
 * only on edges no real spawn produces.)
 *
 * ONE forest for both sides: the browser folds its cards along it, and the
 * server settles a coordinator's descendants along it
 * ({@link spawnClusterDescendantIds}) — so a Settle can never shelve a session
 * the card did not fold, nor leave one it did.
 */
export function spawnClusterForest(
  members: readonly SessionListItem[],
): SpawnClusterForest {
  const ids = new Set(members.map((session) => session.id));
  const dormant = new Set(
    members.filter(isDormantInSpawnTree).map((session) => session.id),
  );
  const edgeOf = new Map<string, string>();
  for (const session of members) {
    if (session.spawnOwnership !== "coordinator") continue;
    const parentId = session.spawnedBySessionId;
    if (!parentId || parentId === session.id || !ids.has(parentId)) continue;
    edgeOf.set(session.id, parentId);
  }
  // A dormant member keeps its edge while a live one folds into it: walk up
  // from every live edge and mark the dormant spawners on the way. The
  // walk stops at the first spawner that folds anyway — live, or already
  // marked — and at a repeat, so a cycle costs one lap.
  const liveBelow = new Set<string>();
  for (const [childId, firstParent] of edgeOf) {
    if (dormant.has(childId)) continue;
    const seen = new Set([childId]);
    let parentId: string | undefined = firstParent;
    while (
      parentId !== undefined &&
      dormant.has(parentId) &&
      !liveBelow.has(parentId) &&
      !seen.has(parentId)
    ) {
      liveBelow.add(parentId);
      seen.add(parentId);
      parentId = edgeOf.get(parentId);
    }
  }

  const parentOf = new Map<string, string>();
  const candidates = new Map<string, string[]>();
  for (const session of members) {
    const parentId = edgeOf.get(session.id);
    if (parentId === undefined) continue;
    if (dormant.has(session.id) && !liveBelow.has(session.id)) continue;
    parentOf.set(session.id, parentId);
    const siblings = candidates.get(parentId);
    if (siblings) siblings.push(session.id);
    else candidates.set(parentId, [session.id]);
  }

  const order: string[] = [];
  const visited = new Set<string>();
  const walk = (seeds: readonly string[]) => {
    const queue: string[] = [];
    for (const id of seeds) {
      visited.add(id);
      order.push(id);
      queue.push(id);
    }
    // A cursor, not `shift()`: a long chain must not pay to re-index the
    // queue on every step.
    for (let head = 0; head < queue.length; head += 1) {
      const id = queue[head] as string;
      for (const childId of candidates.get(id) ?? []) {
        // An entry that has since detached (cycle) is no longer a child.
        if (parentOf.get(childId) !== id || visited.has(childId)) continue;
        visited.add(childId);
        order.push(childId);
        queue.push(childId);
      }
    }
  };
  walk([...ids].filter((id) => !parentOf.has(id)));
  // Whatever the walk never reached is behind a spawn cycle, so it has no root
  // to be reached from. Promote one of its sessions and walk again; each pass
  // assigns at least that one, so this terminates on any input.
  while (order.length < ids.size) {
    const stranded = [...ids]
      .filter((id) => !visited.has(id))
      .sort((a, b) => (a < b ? -1 : 1));
    const first = stranded[0] as string;
    parentOf.delete(first);
    walk([first]);
  }

  const childrenOf = new Map<string, string[]>();
  for (const session of members) {
    const parentId = parentOf.get(session.id);
    if (parentId === undefined) continue;
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(session.id);
    else childrenOf.set(parentId, [session.id]);
  }
  return { parentOf, childrenOf, order };
}

/**
 * The candidates {@link spawnClusterForest} is built from: every unarchived
 * row that no working-set Workflow Run owns. A run's own sessions belong to
 * the run, wherever they would otherwise have landed — a card, a cluster, or
 * the Settled shelf — so they are neither folded into a coordinator nor
 * settled with one.
 */
export function spawnClusterMembers(
  sessions: readonly SessionListItem[],
  runs: readonly WorkflowRunSummary[],
  cards: Readonly<Record<string, WorkflowRunCard>>,
): SessionListItem[] {
  const owner = workflowRunOwnerBySession(runs, cards);
  return sessions.filter(
    (session) => !session.archived && !owner.has(session.id),
  );
}

/**
 * The peers `rootId` still coordinates, at every depth the forest folds under
 * it, parents before children. This is exactly what the root's cluster card
 * shows folded, so it is also exactly what a Settle on that card shelves: the
 * browser optimistically, the server through each peer's current outcome
 * revision ({@link spawnClusterSettleBlockedReason} is the matching refusal).
 */
export function spawnClusterDescendantIds(
  rootId: string,
  forest: SpawnClusterForest,
): string[] {
  const descendants = [...(forest.childrenOf.get(rootId) ?? [])];
  for (let head = 0; head < descendants.length; head += 1) {
    const id = descendants[head] as string;
    descendants.push(...(forest.childrenOf.get(id) ?? []));
  }
  return descendants;
}

/**
 * Why `rootId` may NOT be settled right now, cluster included, or `undefined`
 * when it may: its own {@link settleBlockedReason}, else the first folded
 * descendant's, in the forest's order. A peer's FAILURE never blocks it:
 * settling the coordinator settles the peer with it, and acknowledging that
 * failure is what the Settle is for.
 *
 * ONE selector for every surface that offers a session's Settle — the cluster
 * card, a folded peer's row, the inspector — and for the server's refusal, so
 * the reason a disabled button shows is the reason the command would fail
 * with. `byId` is EVERY projected row, not only the forest's members: a
 * session that is no member — a working-set run's role, an archived row —
 * folds nothing and answers its own reason alone, which is why every session
 * may be asked, not only a coordinator.
 */
export function spawnClusterSettleBlockedReason(
  rootId: string,
  byId: ReadonlyMap<string, SessionListItem>,
  forest: SpawnClusterForest,
): string | undefined {
  for (const id of [rootId, ...spawnClusterDescendantIds(rootId, forest)]) {
    const session = byId.get(id);
    const reason = session ? settleBlockedReason(session) : undefined;
    if (reason) return reason;
  }
  return undefined;
}

/**
 * {@link spawnClusterSettleBlockedReason} for EVERY forest member at once, in
 * one bottom-up sweep instead of one descendant walk per member — the shape a
 * surface that disables every row's Settle needs, since with unbounded depth a
 * walk per member is quadratic on a long chain. Same answer per id: the
 * member's own reason, else that of its first blocked descendant in forest
 * order. The forest's `order` restricted to one subtree IS that subtree's
 * breadth-first order, so "first" is simply the lowest position. Members with
 * no reason are absent.
 */
export function spawnClusterSettleBlockedReasons(
  byId: ReadonlyMap<string, SessionListItem>,
  forest: SpawnClusterForest,
): Map<string, string> {
  const position = new Map(forest.order.map((id, index) => [id, index]));
  const own = new Map<string, string>();
  for (const id of forest.order) {
    const session = byId.get(id);
    const reason = session ? settleBlockedReason(session) : undefined;
    if (reason) own.set(id, reason);
  }
  const earlier = (a: string | undefined, b: string | undefined) =>
    a === undefined ||
    (b !== undefined && (position.get(b) ?? 0) < (position.get(a) ?? 0))
      ? b
      : a;
  const firstBlockedBelow = new Map<string, string>();
  for (let index = forest.order.length - 1; index >= 0; index -= 1) {
    const id = forest.order[index] as string;
    let first: string | undefined;
    for (const childId of forest.childrenOf.get(id) ?? []) {
      first = earlier(first, own.has(childId) ? childId : undefined);
      first = earlier(first, firstBlockedBelow.get(childId));
    }
    if (first !== undefined) firstBlockedBelow.set(id, first);
  }
  const reasons = new Map<string, string>();
  for (const id of forest.order) {
    const below = firstBlockedBelow.get(id);
    const reason = own.get(id) ?? (below ? own.get(below) : undefined);
    if (reason) reasons.set(id, reason);
  }
  return reasons;
}

/** A renderable part of an assistant turn, in arrival order. */
export type TaskStatus = "todo" | "doing" | "done";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type TaskDueFilter = "overdue" | "today" | "upcoming" | "unscheduled";
/** Filter on {@link TaskSummary.scheduledFor} — the day work was planned for. */
export type TaskScheduledFilter =
  "past" | "today" | "tomorrow" | "upcoming" | "unplanned";
export type TaskCreatedBy = "user" | "agent";
export type TaskExternalLinkType = "source" | "related";
/**
 * Provider a Task link points at. `forgejo` is self-hosted, so it has no fixed
 * host: it matches the configured instance (see {@link isForgejoInstanceUrl})
 * rather than a pattern.
 */
export type TaskExternalLinkSource =
  "slack" | "jira" | "github" | "forgejo" | "unknown";

const TASK_EXTERNAL_LINK_SOURCES: readonly string[] = [
  "slack",
  "jira",
  "github",
  "forgejo",
  "unknown",
];

/**
 * Whether a caller-supplied value names a provider. Both server coercion sites
 * (Task saves and the Task tools) use it so a new provider is one edit here
 * rather than a whitelist that degrades a valid source to `unknown` when missed.
 */
export function isTaskExternalLinkSource(
  value: unknown,
): value is TaskExternalLinkSource {
  return (
    typeof value === "string" && TASK_EXTERNAL_LINK_SOURCES.includes(value)
  );
}

/**
 * Whether `url` belongs to the Forgejo instance configured at `baseUrl`.
 *
 * Host AND port must match, and a base URL with a path (an instance served at
 * `https://example.com/git`) requires that prefix: an instance at
 * `http://localhost:3000` must not claim every other `localhost` link. Protocol
 * is deliberately ignored — http/https on the same host:port is one instance.
 * Shared so the server classifier and its browser twin cannot drift.
 */
export function isForgejoInstanceUrl(
  url: string,
  baseUrl: string | undefined,
): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    if (target.host.toLowerCase() !== base.host.toLowerCase()) return false;
    const basePath = base.pathname.replace(/\/+$/, "");
    return (
      !basePath ||
      target.pathname === basePath ||
      target.pathname.startsWith(`${basePath}/`)
    );
  } catch {
    return false;
  }
}

/**
 * The canonical `owner/repo#123` form of a GitHub issue or pull-request
 * reference, or null when `value` is not one. Accepts that form (a `/pull/` or
 * `/issues/` github.com URL too) so a pasted link and a typed ref land as the
 * same Task link. Owner and repo keep their casing; GitHub resolves them
 * case-insensitively, which is why de-duplication ignores case.
 */
export function normalizeGithubIssueRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  // Owners are alphanumeric with inner hyphens; repositories also take `.`
  // and `_` anywhere, so `nodejs/.github` is a real target.
  const owner = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
  const repo = "[A-Za-z0-9._-]{1,100}";
  const url = new RegExp(
    `^https?://(?:www\\.)?github\\.com/(${owner})/(${repo})/(?:issues|pull)/(\\d+)(?:[/?#].*)?$`,
    "i",
  ).exec(text);
  const ref = url ?? new RegExp(`^(${owner})/(${repo})#(\\d+)$`).exec(text);
  if (!ref || ref[2] === "." || ref[2] === "..") return null;
  const number = Number(ref[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return `${ref[1]}/${ref[2]}#${number}`;
}

/** Canonical, case-insensitively de-duplicated refs; order preserved, invalid ones dropped. */
export function normalizeGithubIssueRefs(values: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(values) ? values : []) {
    const ref = normalizeGithubIssueRef(value);
    if (!ref || seen.has(ref.toLowerCase())) continue;
    seen.add(ref.toLowerCase());
    out.push(ref);
  }
  return out;
}

/** The parts of a canonical ref from {@link normalizeGithubIssueRef}. */
export function parseGithubIssueRef(
  ref: string,
): { owner: string; repo: string; number: number } | null {
  const canonical = normalizeGithubIssueRef(ref);
  const match = canonical ? /^([^/]+)\/([^#]+)#(\d+)$/.exec(canonical) : null;
  return match
    ? { owner: match[1]!, repo: match[2]!, number: Number(match[3]) }
    : null;
}

/** Who authored a Task comment. `system` is reserved for future lifecycle events. */
export type TaskCommentAuthorKind = "user" | "agent" | "system";

export interface TaskCommentAuthor {
  kind: TaskCommentAuthorKind;
  name: string;
  /** Originating agent session id, when an agent left the comment. */
  sessionId?: string;
}

/**
 * One append-only comment in a Task's chronological activity trace. Users (web)
 * and agents (`task_manage` comments) leave context, decisions, updates, and
 * follow-ups; comments are never edited or deleted individually.
 */
export interface TaskComment {
  id: string;
  taskId: string;
  author: TaskCommentAuthor;
  body: string;
  createdAt: number;
}

export interface TaskExternalLink {
  url: string;
  /** Whether this URL is a source artifact for the Task or merely related context. */
  type: TaskExternalLinkType;
  /** Provider/source inferred from the URL when omitted or set to unknown. */
  source: TaskExternalLinkSource;
  title?: string;
  addedAt?: number;
}

/**
 * How a session became linked to a Task. `task-start` means the session was
 * created to work on the Task (via "Start a session" on the Task), and the Task
 * was attached to its first prompt. `reference` (default) means the session
 * merely touched the Task (agent task tools, manual link) without being spawned
 * from it.
 */
export type TaskSessionOrigin = "task-start" | "reference";

export interface TaskSessionRef {
  /** Which engine runs this session (pi / claude-sdk). */
  harness?: Harness;
  /** Which persona/toolset this session emulates, independent of harness. */
  agentType?: AgentType;
  sessionId: string;
  sessionFile?: string;
  /** Defaults to `reference` when absent. */
  origin?: TaskSessionOrigin;
  /** When the Task context was attached to this session (for `task-start`). */
  attachedAt?: number;
}

/** Session link fields a Task LIST consumer can use; server-local metadata stays on detail reads. */
export type TaskSummarySessionRef = Pick<
  TaskSessionRef,
  "sessionId" | "origin"
>;

/** Compact reference to a durable Task, used for session→task back-links. */
export interface TaskBackRef {
  id: string;
  title: string;
  status: TaskStatus;
}

/**
 * An AGENT's suggestion about where a Task should stand, awaiting the user's
 * answer.
 *
 * Recorded INSTEAD of the suggested status: an agent's "done" is a report, not
 * evidence, and eagerly-completed Tasks used to disappear from every open list
 * while the work was unfinished. The Task is never moved TO the suggested
 * status by the suggestion itself, so it is visible without being trusted.
 *
 * A `done` suggestion does move a `doing` Task to `todo`, which is a different
 * statement: the agent stopped working on it. Both halves of "I finished, and I
 * am no longer working on it" are true at once, and saying them in one write is
 * what removes the corrective second call.
 *
 * There are exactly TWO values and no third. Saying nothing means "leave it in
 * doing", which is the truth when work is paused mid-flight.
 *
 * A suggestion whose `to` already EQUALS the Task's status has been answered:
 * it stays as provenance — how the Task got there, e.g. an agent completing it
 * at the user's request — and no surface may render it as a pending question.
 */
export interface TaskStatusSuggestion {
  /** `done` = the agent says it is finished; `todo` = hand it back unfinished. */
  to: "done" | "todo";
  at: number;
  /** The agent session that made the suggestion, for tracing it to its run. */
  sessionId?: string;
  /** One short line saying why, shown with the suggestion. */
  reason?: string;
}

/**
 * WHERE a Task came from. Every field here is DURABLE — persisted at creation
 * and returned by every read — because the Backlog's Inbox uses it to say what
 * produced an arrival, and a source field the server quietly discarded would
 * make that line lie. `toolCallId` used to sit here, written by `task_manage`,
 * read by nothing and dropped on the round trip; it was removed rather than
 * given a column no consumer wanted.
 */
export interface TaskSource {
  createdBy: TaskCreatedBy;
  /** Which persona/toolset created this Task, when an agent did. */
  agentType?: AgentType;
  /** The session that created it, for tracing an arrival back to its run. */
  sessionId?: string;
}

/** Lightweight task metadata used for indexes, side panels, and list views. */
export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  descriptionPreview?: string;
  projectId?: string;
  /** Jira issues explicitly linked to this Task. */
  jiraIssueKeys?: string[];
  /**
   * GitHub issues (or pull requests, which share the numbering) explicitly
   * linked to this Task, as canonical `owner/repo#123` refs — see
   * {@link normalizeGithubIssueRefs}.
   */
  githubIssues?: string[];
  /** External source/related links such as Slack permalinks or Jira URLs. */
  externalLinks?: TaskExternalLink[];
  /** Backlog scheduling: date-only deadline in YYYY-MM-DD form. */
  dueDate?: string;
  /**
   * When the user intends to WORK on this, in YYYY-MM-DD form. Deliberately
   * distinct from {@link dueDate}: a deadline is imposed from outside, a plan is
   * a choice, and either the user or an agent planning the day may set it. It is
   * a DATE rather than a today/tomorrow enum so it cannot go stale — a Task
   * planned for yesterday reads as unfinished instead of silently still
   * claiming to be today's work.
   */
  scheduledFor?: string;
  /** Planning priority. Missing means normal priority. */
  priority?: TaskPriority;
  sessionRefs?: TaskSummarySessionRef[];
  /** Parent Task id for Backlog subtask hierarchy. Missing means this Task is at the root level. */
  parentId?: string;
  /** Manual ordering position for sibling Tasks. Lower sorts first. */
  sortOrder?: number;
  source: TaskSource;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  /** Archived Tasks are hidden from default Task lists but remain recoverable. */
  archivedAt?: number;
  /** Commit hash that included this completed task, when known. */
  commitHash?: string;
  /** Number of activity-trace comments on this Task, for list badges. */
  commentCount?: number;
  /** An agent suggests a status for this Task; the user has not answered yet. */
  statusSuggestion?: TaskStatusSuggestion;
  /**
   * When the USER processed this Task. Unset means it is still waiting in the
   * Backlog's Inbox — the surface for work that arrived on its own (meeting
   * minutes, Slack intake, an agent noticing something) rather than being typed
   * in. A Task TYPED DIRECTLY INTO THE BACKLOG is born triaged; there is nothing
   * to decide about something you just wrote down. That is deliberately not the
   * same as "created by the user": a Slack shortcut import honestly records the
   * user as its creator and is still an arrival that waits here.
   */
  triagedAt?: number;
}

/**
 * The lean list projection of a full Task. This explicit allowlist is the ONE
 * place that narrows {@link TaskItem} to {@link TaskSummary}, so storage-only
 * fields and newly added detail fields cannot accidentally widen every list
 * payload.
 *
 * It lives in the shared package because BOTH sides project: the server builds
 * every list item and state event with it, and the browser settles an
 * optimistic create against the mutator's full reply with it. A second,
 * hand-written narrowing in the client would put `description` into the list
 * (and into the shell cache), and would make the authoritative echo of a row
 * the client itself projected compare unequal.
 */
export function taskSummaryOf(item: TaskItem): TaskSummary {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    ...(item.descriptionPreview
      ? { descriptionPreview: item.descriptionPreview }
      : {}),
    ...(item.projectId ? { projectId: item.projectId } : {}),
    ...(item.jiraIssueKeys?.length
      ? { jiraIssueKeys: item.jiraIssueKeys }
      : {}),
    ...(item.githubIssues?.length ? { githubIssues: item.githubIssues } : {}),
    ...(item.externalLinks?.length
      ? { externalLinks: item.externalLinks }
      : {}),
    ...(item.dueDate ? { dueDate: item.dueDate } : {}),
    ...(item.scheduledFor ? { scheduledFor: item.scheduledFor } : {}),
    ...(item.priority && item.priority !== "normal"
      ? { priority: item.priority }
      : {}),
    ...(item.sessionRefs?.length
      ? {
          sessionRefs: item.sessionRefs.map((ref) => ({
            sessionId: ref.sessionId,
            ...(ref.origin ? { origin: ref.origin } : {}),
          })),
        }
      : {}),
    ...(item.parentId ? { parentId: item.parentId } : {}),
    ...(item.sortOrder !== undefined ? { sortOrder: item.sortOrder } : {}),
    source: item.source,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.completedAt !== undefined
      ? { completedAt: item.completedAt }
      : {}),
    ...(item.archivedAt !== undefined ? { archivedAt: item.archivedAt } : {}),
    ...(item.commitHash ? { commitHash: item.commitHash } : {}),
    ...(item.commentCount ? { commentCount: item.commentCount } : {}),
    ...(item.statusSuggestion
      ? { statusSuggestion: item.statusSuggestion }
      : {}),
    ...(item.triagedAt !== undefined ? { triagedAt: item.triagedAt } : {}),
  };
}

/** Full task document: a summary plus the Markdown body and full server session metadata. */
export interface TaskItem extends Omit<TaskSummary, "sessionRefs"> {
  description: string;
  descriptionPath?: string;
  /** Time this task was recorded as included in a commit. */
  committedAt?: number;
  sessionRefs?: TaskSessionRef[];
}

export interface TaskListRequest {
  status?: TaskStatus;
  projectId?: string;
  priority?: TaskPriority;
  due?: TaskDueFilter;
  scheduled?: TaskScheduledFilter;
  sessionId?: string;
  query?: string;
  includeArchived?: boolean;
}

export interface TaskSaveRequest {
  id?: string;
  /**
   * REQUIRED on a create, optional on an update, where omitting it leaves the
   * stored title alone. A surface that is not editing the title must omit it
   * rather than echo a copy back: a save built from a snapshot (an agent's
   * recorded Task card in a transcript, a cached row) would otherwise rewrite a
   * title that has since changed, and nobody confirming a status means to rename
   * anything.
   */
  title?: string;
  description?: string;
  status?: TaskStatus;
  projectId?: string | null;
  jiraIssueKeys?: string[];
  githubIssues?: string[];
  externalLinks?: TaskExternalLink[];
  dueDate?: string | null;
  scheduledFor?: string | null;
  priority?: TaskPriority | null;
  parentId?: string | null;
  /**
   * Mark this Task processed (or put it back in the Inbox). Any ordinary user
   * save triages implicitly — editing a Task means you have seen it — so this
   * exists for the one act that changes nothing else: dismissing a Task from
   * the Inbox because it needs no action.
   */
  triaged?: boolean;
  /** Intentionally attach the active chat/workshop session to this task. */
  linkCurrentSession?: boolean;
  /**
   * Dismiss a pending {@link TaskStatusSuggestion} without applying it. Needed
   * as its own flag because rejecting a suggestion changes no other field, and
   * an ordinary save must not silently discard it.
   */
  clearStatusSuggestion?: boolean;
}

export interface TaskListResponse {
  request: TaskListRequest;
  /**
   * Always summaries. A Task's Markdown body is fetched one Task at a time
   * (`getTask` → `taskDetail`), so no list can put it on the wire.
   */
  items: TaskSummary[];
  updatedAt: number;
}

export interface TaskReorderPlacement {
  id: string;
  /** Parent Task id after the move. Missing/null means root level. */
  parentId?: string | null;
}

export interface TaskProjectAssignmentUpdate {
  id: string;
  projectId: string | null;
}

/* ----------------------------- project registry ---------------------------- */

export type ProjectStatus = "active" | "archived";
export type ProjectLocalPathKind = "repo" | "workspace" | "folder";
export type ProjectLocalPathMatch = "exact" | "prefix";
export type ProjectJiraLinkRole =
  "primary" | "related" | "fallback" | "customer" | "historical";

export interface ProjectLocalPath {
  path: string;
  kind?: ProjectLocalPathKind;
  match?: ProjectLocalPathMatch;
  notes?: string;
}

export interface ProjectJiraLink {
  projectKey?: string;
  issueKey?: string;
  role?: ProjectJiraLinkRole;
  notes?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  /** Required short Jira-style display key, e.g. PD for Pandeck. */
  key: string;
  /** User-selected accent color for compact badges/dots, as a CSS color string. */
  color?: string;
  status?: ProjectStatus;
  /** Parent Project id for manual sidebar Project tree hierarchy. */
  parentId?: string | null;
  /** Manual ordering position among sibling Projects. */
  sortOrder?: number;
  /** Minimal legacy hierarchy fact; the full local-path records remain detail-only. */
  primaryPath?: string;
  /** Whether this Project can spawn a worktree before one exists. */
  hasRepoPath?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Full Project document, returned only by the keyed Project detail read. */
export interface ProjectRecord extends ProjectSummary {
  description?: string;
  tags?: string[];
  localPaths?: ProjectLocalPath[];
  jira?: ProjectJiraLink[];
  aliases?: string[];
  /** Per-project override for where new worktrees are created (falls back to settings.worktrees.root). */
  worktreeRoot?: string;
  /** Git URL to clone/provision this project's repo from (uses ambient git+ssh). The clone becomes the main checkout. */
  repoUrl?: string;
}

/** The sole narrowing used by server events and direct-reply reconciliation. */
export function projectSummaryOf(project: ProjectRecord): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    key: project.key,
    ...(project.color ? { color: project.color } : {}),
    ...(project.status ? { status: project.status } : {}),
    ...(project.parentId !== undefined ? { parentId: project.parentId } : {}),
    ...(project.sortOrder !== undefined
      ? { sortOrder: project.sortOrder }
      : {}),
    ...(project.localPaths?.[0]?.path?.trim()
      ? { primaryPath: project.localPaths[0].path.trim().replace(/\/+$/, "") }
      : {}),
    ...(project.localPaths?.some(
      (path) => path.kind === "repo" || path.kind === "workspace",
    )
      ? { hasRepoPath: true }
      : {}),
    ...(project.createdAt ? { createdAt: project.createdAt } : {}),
    ...(project.updatedAt ? { updatedAt: project.updatedAt } : {}),
  };
}

export interface ProjectListRequest {
  query?: string;
  tag?: string;
  status?: ProjectStatus;
  includeArchived?: boolean;
}

export interface ProjectListResponse {
  request: ProjectListRequest;
  projects: ProjectSummary[];
  updatedAt: number;
}

export interface ProjectReorderPlacement {
  id: string;
  parentId?: string | null;
}

/** User-facing lifecycle state of a peer prompt (sanitized; no internal ids). */
export type PeerPromptState =
  | "queued"
  | "delivered"
  | "acknowledged"
  | "completed"
  | "awaiting_response"
  | "replied"
  | "retrying"
  | "interrupted"
  | "cancelled"
  | "expired"
  | "failed";

/**
 * A sanitized, in-chat peer-prompt card. Rendered both as the sender's tool
 * result (`direction: "sent"`) and as the recipient's transcript block
 * (`direction: "received"`). Carries no file/task/thread/relay ids, file paths,
 * reply syntax, or the model delivery envelope — only decision-useful text plus
 * the one navigable id in {@link PeerPromptCard.peerSessionId}.
 */
export interface PeerPromptCard {
  direction: "sent" | "received";
  /**
   * Opaque reconciliation key (not the raw message/session id). The client
   * overlays live `peerPromptCardUpdate` state/failureReason patches onto the
   * card sharing this key, so lifecycle changes update the rendered card in
   * place instead of freezing the creation-time snapshot.
   */
  messageKey: string;
  /** Short sender title/label. */
  senderTitle: string;
  /** Short recipient title/label (sender card only). */
  recipientTitle?: string;
  /**
   * The OTHER party's session id: the recipient on a sent card, the sender on a
   * received one. The card's one deliberate id, so the reader can open that
   * session from the card; neither side learns anything new from it (the sender
   * named the target itself, and the delivery envelope already names the sender
   * to the recipient). Optional: cards logged before it existed have none.
   */
  peerSessionId?: string;
  /** The actual peer prompt text, as Markdown (not the model envelope). */
  message: string;
  responseRequested: boolean;
  /** Optional linked Task title for context (never the raw id). */
  taskTitle?: string;
  /** Human-readable reason for a failed/interrupted/retrying/cancelled outcome. */
  failureReason?: string;
  state: PeerPromptState;
}

/** One sanitized message inside a durable peer-prompt thread projection. */
export interface PeerPromptThreadMessage {
  /**
   * Opaque stable key for reconciliation, never displayed. It is also the key
   * this message's card carries in THIS session's transcript, so it addresses
   * the message for `resolveTimelineAnchor` (see {@link TimelineAnchorTarget}).
   */
  id: string;
  direction: "sent" | "received";
  /**
   * An EXCERPT of the message, already in the form the reader sees
   * ({@link peerPromptExcerpt}) — never the message itself.
   *
   * These are long structured agent briefs: 50 of them at full length made a
   * coordinator's `SessionState` 130 KB, which rode on its snapshot AND on
   * every `state` broadcast it made, so that a collapsed panel could draw two
   * clamped lines of each. The full text is read where it is worth reading —
   * the other party's transcript, which every bubble links to.
   */
  message: string;
  state: PeerPromptState;
  responseRequested: boolean;
  taskTitle?: string;
  /** Human-readable reason for a failed/interrupted/retrying/cancelled outcome. */
  failureReason?: string;
  createdAt: number;
}

/**
 * Characters of a peer-prompt message the history projection carries. Enough to
 * IDENTIFY the message in a list, which is all the Peer prompts section renders
 * (two clamped lines); it is not enough to read one, deliberately.
 */
export const PEER_PROMPT_EXCERPT_CHARS = 140;

/**
 * The one-glance form of a peer-prompt message: its first characters, collapsed
 * to running text. Built SERVER-side so the bytes are never sent, and rendered
 * verbatim — a second truncation on the client would only add a second ellipsis.
 */
export function peerPromptExcerpt(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > PEER_PROMPT_EXCERPT_CHARS
    ? `${flat.slice(0, PEER_PROMPT_EXCERPT_CHARS - 1).trimEnd()}…`
    : flat;
}

/** A sanitized peer-prompt conversation between this session and one other party. */
export interface PeerPromptThread {
  /** Opaque stable key for reconciliation; never displayed. */
  conversationId: string;
  otherPartyTitle: string;
  /**
   * The other party's session id, so the thread can link to that conversation —
   * the same field a transcript {@link PeerPromptCard} carries, and for the same
   * reason. Conversation/message/chain ids stay opaque.
   */
  peerSessionId: string;
  messages: PeerPromptThreadMessage[];
}

/** Bounded, sanitized peer-prompt history for one session (sender + recipient). */
export interface PeerPromptThreadsProjection {
  threads: PeerPromptThread[];
  /** True when older threads/messages were omitted from this bounded view. */
  truncated: boolean;
}

/**
 * A message the reader asked to jump to, before it is known WHERE it sits.
 *
 * - `peerPrompt` — a peer-prompt message addressed by the opaque key its card
 *   carries in the VIEWED session ({@link PeerPromptThreadMessage.id}). It
 *   resolves to the same message's card in the OTHER party's transcript, which
 *   is where the Peer prompts section sends the reader.
 * - `entry` — an entry addressed directly, by our own durable log entry id (a
 *   fork origin, or a `#m-<entryId>` deep link the browser reloaded on).
 * - `approval` — an approval card, by its id (the composer's pending-approval
 *   strip, a `pa://approval/<id>` link). A card is not a log entry, so it
 *   resolves to its own row id (`approvalMessageId`) at the index of the turn
 *   that proposed it.
 */
export type TimelineAnchorTarget =
  | { kind: "peerPrompt"; messageKey: string }
  | { kind: "entry"; sessionId: string; entryId: string }
  | { kind: "approval"; approvalId: string };

/**
 * Where a jump target lives: the session holding it, the id of the TRANSCRIPT
 * ROW it renders in (a tool result folds into the assistant entry that declared
 * its call), and that row's index in the session's client timeline — which is
 * what lets a windowed transcript load exactly as far back as the anchor
 * without paging blindly.
 */
export interface TimelineAnchor {
  sessionId: string;
  entryId: string;
  index: number;
}

export type DisplayBlock =
  | { kind: "text"; text: string }
  | { kind: "attachment"; attachment: DisplayAttachment }
  | {
      kind: "thinking";
      text: string;
      lazy?: import("./session/index.ts").LazyBlockRef;
      /** In-flight body the wire omitted; rendered text arrives by subscription. */
      live?: import("./session/index.ts").LiveBodyRef;
    }
  | { kind: "commit"; commit: CommitDisplay }
  | { kind: "push"; push: PushDisplay }
  | { kind: "pullRequest"; pullRequest: PullRequestCard }
  | { kind: "worktreeProvision"; provision: WorktreeProvisionDisplay }
  | { kind: "approval"; approval: ApprovalCard }
  | { kind: "artifact"; artifact: SessionArtifact }
  | { kind: "compaction"; compaction: CompactionDisplay }
  | { kind: "contextClear"; contextClear: ContextClearDisplay }
  | {
      kind: "toolGroupNotice";
      title: string;
      summary?: string;
      tools?: string[];
    }
  | { kind: "peerPrompt"; peerPrompt: PeerPromptCard }
  | {
      kind: "tool";
      toolId: string;
      name: string;
      args: unknown;
      argsLazy?: import("./session/index.ts").LazyBlockRef;
      argsLive?: import("./session/index.ts").LiveBodyRef;
      argsSummary?: string;
      output: string;
      outputLazy?: import("./session/index.ts").LazyBlockRef;
      outputLive?: import("./session/index.ts").LiveBodyRef;
      isError: boolean;
      done: boolean;
      /**
       * A provider-supplied display diff carrying the file's REAL line numbers
       * (pi's edit tools put one in the tool result's `details.diff`). Rendering
       * only — never model context, and absent for harnesses/tools that do not
       * produce one, where the renderer diffs the call's own old/new strings and
       * omits line numbers rather than inventing snippet-relative ones.
       */
      resultDiff?: string;
    };

export type TempoWorklogMutationAction = "create" | "update";

export interface TempoWorklogMutationItemDisplay {
  clientId: string;
  action: TempoWorklogMutationAction;
  worklogId?: string | null;
  issueKey: string;
  issueId?: string | null;
  issueSummary?: string | null;
  issueUrl?: string | null;
  date: string;
  startTime: string;
  timeSpentSeconds: number;
  duration: string;
  activityKey: string;
  description: string;
  resultWorklogId?: string | null;
  resultSelf?: string | null;
  error?: string;
}

export interface JiraIssueMutationFieldChangeDisplay {
  fieldId: string;
  label: string;
  from?: string | null;
  to?: string | null;
  operation?: string | null;
  /** Server-only execution value for Jira REST writes; not secret-bearing. */
  value?: unknown;
}

export interface JiraIssueLinkChangeDisplay {
  op: "add" | "remove";
  /** Link type name, e.g. "Blocks", "Duplicate", "Relates". */
  type: string;
  /** Direction from the subject issue: outward uses the type's outward phrase, inward the inward phrase. */
  direction: "inward" | "outward";
  /** Human-readable relationship phrase, e.g. "blocks" or "is blocked by". */
  relationship: string;
  /** The issue on the other end of the link. */
  targetIssueKey: string;
  targetIssueUrl?: string | null;
  /** Existing issue link id; required for op=remove. */
  linkId?: string | null;
  /** Execution outcome, populated after approval. */
  resultOk?: boolean;
  error?: string;
}

/** edit (default) = transition/field/link an existing issue; create = new issue; comment = add a comment; rank = reorder issues in a backlog. */
export type JiraIssueMutationOperation = "edit" | "create" | "comment" | "rank";

/** Where a rank item places its issues: next to a named issue, or at an end of a bounded scope. */
export type JiraIssueRankPosition = "before" | "after" | "top" | "bottom";

/**
 * The bounded ordering a top/bottom rank takes its anchor from. Jira has no
 * "move to top" call, so an end position only means something inside a scope
 * it can read in rank order.
 */
export type JiraIssueRankScopeDisplay =
  | {
      kind: "board";
      boardId: number;
      /** Board epics rank as their own list, separate from the backlog below them. */
      epics: boolean;
    }
  | { kind: "parent"; parentIssueKey: string };

/**
 * One Jira Agile rank call. A batch is expressed as a chain — the first issue
 * moves to the requested position, each later issue lands after its
 * predecessor — so a partially applied batch keeps the requested relative
 * order instead of reversing it.
 */
export interface JiraIssueRankStepDisplay {
  issueKey: string;
  placement: "before" | "after";
  /** The issue this step ranks against; a previous step's issue for chained steps. */
  relativeToIssueKey: string;
  /** Execution outcome, populated after approval. */
  resultOk?: boolean;
  error?: string;
}

export interface JiraIssueMutationItemDisplay {
  clientId: string;
  /** Empty for a create item until the issue is created; the new key lands in resultIssueKey. */
  issueKey: string;
  operation?: JiraIssueMutationOperation;
  issueId?: string | null;
  issueUrl?: string | null;
  issueSummary?: string | null;
  currentStatus?: string | null;
  targetTransitionId?: string | null;
  targetTransitionName?: string | null;
  targetStatus?: string | null;
  fieldChanges: JiraIssueMutationFieldChangeDisplay[];
  linkChanges?: JiraIssueLinkChangeDisplay[];
  /** create: the new issue's project key, issue type, summary, and optional description. */
  createProjectKey?: string;
  createIssueType?: string;
  createSummary?: string;
  /** CommonMark/GFM source converted to Atlassian Document Format when executed. */
  createDescription?: string;
  /** Parent issue for a new sub-task or other Jira issue type that accepts parent. */
  createParentIssue?: string;
  /** comment: the CommonMark/GFM body converted to ADF and posted on issueKey. */
  commentBody?: string;
  /** rank: the issues to move, in the order they should end up. */
  rankIssueKeys?: string[];
  rankPosition?: JiraIssueRankPosition;
  /** The issue the first ranked issue is placed against; resolved from the scope for top/bottom. */
  rankTargetIssueKey?: string | null;
  /** The bounded ordering a top/bottom request was resolved against. */
  rankScope?: JiraIssueRankScopeDisplay;
  /** The chained rank calls, applied in order on approval. */
  rankSteps?: JiraIssueRankStepDisplay[];
  /** Ordering observed in the scope after execution. */
  rankResultOrder?: string[];
  /** create result: the created issue key. */
  resultIssueKey?: string | null;
  resultIssueUrl?: string | null;
  /** Non-fatal partial-execution diagnostic, e.g. issue created but a requested link was denied. */
  warning?: string;
  error?: string;
}

export type GithubPrMutationOperation =
  "create" | "edit" | "ready" | "review" | "comment" | "assign";
export type GithubPrReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** One inline review comment in a `github_review_pull_request` proposal. */
export interface GithubPrInlineCommentDisplay {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  body: string;
  /** Rendered as a fenced GitHub ```suggestion block when executed. */
  suggestion?: string;
}

export type ForgejoPrMutationOperation =
  "create" | "edit" | "ready" | "review" | "comment";
/**
 * Forgejo's `ReviewStateType`, which is NOT GitHub's review event vocabulary:
 * the approving verdict is `APPROVED` (not `APPROVE`) and asking for changes is
 * `REQUEST_CHANGES` (not `CHANGES_REQUESTED`).
 */
export type ForgejoPrReviewEvent = "COMMENT" | "APPROVED" | "REQUEST_CHANGES";

/**
 * One inline review comment in a `forgejo_review_pull_request` proposal.
 * Forgejo's `CreatePullReviewComment` anchors by POSITION rather than by diff
 * side, so `side` is a display-level choice translated on execution: `RIGHT`
 * becomes `new_position` and `LEFT` becomes `old_position`.
 */
export interface ForgejoPrInlineCommentDisplay {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  body: string;
  /** Rendered as a fenced ```suggestion block when executed. */
  suggestion?: string;
}

/* ------------------------------------------------------------------ *
 * Unified approval subsystem (Task 108).
 *
 * ONE harness-neutral, persistent, interactive approval card used by every
 * agent-proposed mutation (GitHub/Forgejo PR writes, Jira/Tempo edits, commit
 * dry-runs). The agent proposes; the card renders with the decision info and
 * Approve/Reject; on the user's decision the server executes the action,
 * records the decision+result durably, resumes the session with a hidden
 * outcome prompt (so the agent learns what happened), and the card reflects the
 * final state. A pending approval marks the session `awaitingInput`, driving the
 * same sidebar attention indicator as a pending question.
 * ------------------------------------------------------------------ */
export type ApprovalKind =
  | "githubPullRequest"
  | "githubIssue"
  | "githubBranchDelete"
  | "forgejoPullRequest"
  | "forgejoRelease"
  | "gitTag"
  | "jiraIssue"
  | "confluencePage"
  | "tempoWorklog"
  | "gmailArchive"
  | "commit"
  | "sessionSpawn"
  | "managedPullRequestMerge"
  | "projectCreate"
  | "settingsInput";
/**
 * pending → executing → executed | failed (approved path); rejected (declined);
 * superseded (a newer card from the same session replaced it while pending).
 */
export type ApprovalStatus =
  "pending" | "executing" | "executed" | "failed" | "rejected" | "superseded";
export type ApprovalDecision = "approved" | "rejected";

export interface GithubPullRequestApprovalBody {
  kind: "githubPullRequest";
  operation: GithubPrMutationOperation;
  repo: string;
  title?: string;
  head?: string;
  base?: string;
  prBody?: string;
  draft?: boolean;
  pullNumber?: number;
  reviewEvent?: GithubPrReviewEvent;
  reviewSummary?: string;
  inlineComments?: GithubPrInlineCommentDisplay[];
  commentBody?: string;
  replyToCommentId?: number;
  /**
   * assign: the people change proposed for `pullNumber`. Review requests
   * (`requested_reviewers`, users and org team SLUGS) and issue-level
   * `assignees` are INDEPENDENT lists on the same pull request — asking someone
   * to review is not assigning it to them. Every list holds only what changes;
   * an absent one leaves that list untouched, and logins are stored resolved
   * (no `@me`, no leading `@`).
   */
  addReviewers?: string[];
  removeReviewers?: string[];
  addReviewerTeams?: string[];
  removeReviewerTeams?: string[];
  addAssignees?: string[];
  removeAssignees?: string[];
  resultNumber?: number;
}

export type GithubIssueMutationOperation =
  "create" | "edit" | "comment" | "label";

/**
 * A GitHub issue write proposal. `number` may name a pull request for `label`,
 * `comment` and the issue-level `edit` fields: GitHub keeps those on the issue
 * that backs every PR. Lists hold only what changes; an absent list or field is
 * left untouched, and logins are stored resolved (no `@me`, no leading `@`).
 */
export interface GithubIssueApprovalBody {
  kind: "githubIssue";
  operation: GithubIssueMutationOperation;
  repo: string;
  /** Target issue or pull request; absent on create. */
  number?: number;
  /** create: the title; edit: the replacement title. */
  title?: string;
  /** create: the description; edit: the complete replacement description. */
  issueBody?: string;
  state?: "open" | "closed";
  stateReason?: "completed" | "not_planned";
  /** create only. */
  labels?: string[];
  assignees?: string[];
  /** label (and edit): labels to add or remove. */
  addLabels?: string[];
  removeLabels?: string[];
  addAssignees?: string[];
  removeAssignees?: string[];
  commentBody?: string;
  /**
   * Labels the repository did not have when the card was prepared: GitHub
   * CREATES a label it is asked to add, so the card says so up front.
   */
  newLabels?: string[];
  resultNumber?: number;
}

/** One branch a {@link GithubBranchDeleteApprovalBody} removes. */
export interface GithubBranchDeleteItem {
  branch: string;
  /**
   * The commit the branch pointed at when proposed. Approval deletes THAT
   * revision: a branch that moved since is refused rather than deleted.
   */
  headSha: string;
  /** Open pull requests using the branch as head or base, when proposed. */
  openPullRequests?: Array<{
    number: number;
    title: string;
    url: string;
    role: "head" | "base";
  }>;
  deleted?: boolean;
  error?: string;
}

/**
 * Remote branch deletion on GitHub. The default branch and protected branches
 * are refused when proposing AND again when executing.
 */
export interface GithubBranchDeleteApprovalBody {
  kind: "githubBranchDelete";
  repo: string;
  items: GithubBranchDeleteItem[];
}

/**
 * A Forgejo PR write proposal. Deliberately its own kind rather than a
 * provider-generic one: cards already persisted under `githubPullRequest` must
 * stay readable, and the two providers differ in the details below.
 */
export interface ForgejoPullRequestApprovalBody {
  kind: "forgejoPullRequest";
  operation: ForgejoPrMutationOperation;
  repo: string;
  title?: string;
  head?: string;
  base?: string;
  prBody?: string;
  /**
   * Forgejo's create option has no `draft` field — a draft is the `WIP: ` title
   * prefix, applied when the proposal executes.
   */
  draft?: boolean;
  pullNumber?: number;
  reviewEvent?: ForgejoPrReviewEvent;
  reviewSummary?: string;
  inlineComments?: ForgejoPrInlineCommentDisplay[];
  commentBody?: string;
  /**
   * Reply arm: Forgejo has no reply-to-comment endpoint, so a reply is a new
   * comment added to an existing REVIEW, anchored at `replyPath`/`replyLine`.
   */
  replyToReviewId?: number;
  replyPath?: string;
  replyLine?: number;
  replySide?: "LEFT" | "RIGHT";
  resultNumber?: number;
}

/**
 * A Forgejo release proposal: publish tag `tag` at `targetSha` with `notes`.
 *
 * The target is a resolved COMMIT, never a branch name: the user approves a
 * specific revision, and the tag lands there even if the branch moved while the
 * card sat pending. `targetRef`/`targetSubject` only name what that sha was when
 * the proposal was made.
 */
export interface ForgejoReleaseApprovalBody {
  kind: "forgejoRelease";
  repo: string;
  tag: string;
  targetSha: string;
  targetRef?: string;
  targetSubject?: string;
  name?: string;
  notes?: string;
  prerelease?: boolean;
  draft?: boolean;
}

/** A checked local Git tag push, executed only after the user approves this exact target. */
export interface GitTagApprovalBody {
  kind: "gitTag";
  repoPath: string;
  remote: string;
  branch: string;
  tag: string;
  targetSha: string;
  /** SHA-256 of the resolved push URL, without persisting its credentials. */
  pushUrlFingerprint: string;
  /** Human-readable destination URL with any URL userinfo removed. */
  pushUrlDisplay: string;
}

/** A hosting provider a Project repository can be created on or linked from. */
export type ProjectRepositoryProvider = "github" | "forgejo";

/**
 * The repository side of a {@link ProjectCreateApprovalBody}: a new one to
 * create, or an existing one to link by clone URL.
 */
export type ProjectCreateRepository =
  | {
      /**
       * Create it on `provider` under `owner`. It is created with a README
       * commit, so a worktree can branch from it immediately.
       */
      mode: "create";
      provider: ProjectRepositoryProvider;
      owner: string;
      name: string;
      private: boolean;
      description?: string;
    }
  | {
      mode: "link";
      url: string;
      /** Set when the URL belongs to a configured provider. */
      provider?: ProjectRepositoryProvider;
      /** `owner/name` on `provider`. */
      repo?: string;
      /**
       * The repository had no commits when proposed. Approval re-reads that
       * and commits a README.md through the provider API if it is still (or
       * has become) empty, since a worktree cannot branch from an empty
       * repository.
       */
      seedReadme?: boolean;
    };

/**
 * The Personal Assistant asking the user for a setting it may not handle
 * itself ([Task-729](pa://task/729)): a secret the user types into the card,
 * or an account the user connects in the browser. The card never carries the
 * value. A secret travels only in the approving decision's
 * {@link SettingsInputResolutionEdits}, is written by the server on approval
 * and stored nowhere else; a connection resolves itself once the OAuth
 * callback has stored the grant.
 */
export interface SettingsInputApprovalBody {
  kind: "settingsInput";
  /**
   * Registry path of a `secret` or `oauth` setting, e.g. `github.token`, or
   * `accounts.<id>` for an account sign-in.
   */
  path: string;
  /** The setting's label, e.g. "Personal access token". */
  label: string;
  /** The Settings page section it belongs to. */
  section: SettingsSectionId;
  /** `signIn`: sign in a Claude or OpenAI account (a credential profile). */
  mode: "secret" | "connect" | "signIn";
  /** The account a `signIn` card signs in. */
  account?: { id: string; provider: CredentialProfileProvider };
  /** Why the assistant asks, in its words. */
  reason?: string;
  /** Whether a value was already set when the card was raised. */
  wasConfigured: boolean;
}

/**
 * An agent proposing a NEW Project: the registry record, optionally its
 * repository, and a clone into the managed checkout. Nothing exists until the
 * user approves; the `result*` fields record what execution produced.
 */
export interface ProjectCreateApprovalBody {
  kind: "projectCreate";
  project: {
    id: string;
    name: string;
    key: string;
    description?: string;
    tags?: string[];
    color?: string;
    parentId?: string;
    aliases?: string[];
    jira?: ProjectJiraLink[];
  };
  repository?: ProjectCreateRepository;
  /** Directory the repository is cloned into; absent when not cloning. */
  cloneDir?: string;
  /**
   * Set as soon as the repository exists or is identified — also on a card
   * that failed later, where it is what finishing by hand needs.
   */
  resultRepoUrl?: string;
  resultWebUrl?: string;
}

/**
 * replace/append/prepend rewrite the body; comment adds a footer comment;
 * delete trashes the page. uploadAttachment adds a file to the page, or a new
 * version of one it already has; deleteAttachment trashes one.
 */
export type ConfluencePageMutationOperation =
  | "create"
  | "edit"
  | "comment"
  | "delete"
  | "uploadAttachment"
  | "deleteAttachment";

/** Where an edit's Markdown lands relative to the page's existing body. */
export type ConfluenceBodyPlacement = "replace" | "append" | "prepend";

export interface ConfluencePageMutationItemDisplay {
  clientId: string;
  operation: ConfluencePageMutationOperation;
  /** Existing page id for edit/comment/delete; absent on create until the page exists. */
  pageId?: string;
  pageUrl?: string | null;
  /** Current title for an existing page, or the title a create will use. */
  title?: string | null;
  /** edit: a new title, when the proposal renames the page. */
  newTitle?: string | null;
  spaceKey?: string | null;
  spaceName?: string | null;
  parentId?: string | null;
  parentTitle?: string | null;
  /** CommonMark/GFM source converted to Atlassian Document Format when executed. */
  body?: string;
  placement?: ConfluenceBodyPlacement;
  /**
   * The page's current body as Markdown, so the card shows what an edit
   * replaces rather than only what it writes.
   */
  currentBody?: string;
  /** Page version the proposal was built against; the write refuses on drift. */
  baseVersion?: number;
  /**
   * ADF node types present in the current page that Markdown cannot carry back
   * (macros, layouts, media). A replace would drop them, so the card says so.
   */
  lossyNodes?: string[];
  labelsAdded?: string[];
  labelsRemoved?: string[];
  /** edit and uploadAttachment: the version comment Confluence records. */
  versionMessage?: string;
  /** uploadAttachment/deleteAttachment: the file the item writes or removes. */
  attachment?: ConfluenceAttachmentMutationDisplay;
  resultPageId?: string | null;
  resultPageUrl?: string | null;
  resultVersion?: number | null;
  /** Non-fatal partial-execution diagnostic, e.g. page written but a label failed. */
  warning?: string;
  error?: string;
}

export interface ConfluenceAttachmentMutationDisplay {
  /** File name on the page, which is how Confluence tells attachments apart. */
  fileName: string;
  /** The attachment a new version replaces, or the one a delete removes. */
  existingId?: string;
  /** Its version when proposed; the write refuses when it moved. */
  baseVersion?: number;
  mediaType?: string | null;
  size?: number | null;
  /** upload: where the bytes came from — a host path or a session attachment name. */
  source?: string;
  /**
   * upload: the session attachment holding the exact bytes that were
   * proposed, and their SHA-256. A host path is copied there at proposal time,
   * so what uploads is what the user approved even if the file changes.
   */
  stagedAttachmentId?: string;
  sha256?: string;
  resultId?: string | null;
  resultVersion?: number | null;
}

export interface ConfluencePageApprovalBody {
  kind: "confluencePage";
  confluenceHost?: string;
  items: ConfluencePageMutationItemDisplay[];
}

export interface JiraIssueApprovalBody {
  kind: "jiraIssue";
  jiraHost?: string;
  items: JiraIssueMutationItemDisplay[];
}

export interface TempoWorklogApprovalBody {
  kind: "tempoWorklog";
  jiraHost?: string;
  timezone?: string;
  items: TempoWorklogMutationItemDisplay[];
}

/** One frozen Gmail message the user is deciding whether to archive. */
export interface GmailArchiveApprovalItem {
  messageId: string;
  threadId: string;
  sender: string;
  subject: string;
  gmailUrl: string;
}

/**
 * An all-or-nothing Gmail archive proposal. The message ids are resolved when
 * the card is created, so mail arriving in one of these threads later is not
 * swept into an older approval.
 */
export interface GmailArchiveApprovalBody {
  kind: "gmailArchive";
  items: GmailArchiveApprovalItem[];
}

/**
 * An agent asking to merge its own managed pull request into the repository's
 * provider-reported DEFAULT branch — the one managed delivery step that is
 * never pre-authorized by the app (only by the user's own session grant,
 * `approvalGrants.ts`). Every field is FROZEN evidence about the decision the
 * user is answering, taken when the card was created; none of it is trusted at
 * execution time, which re-reads the same facts and refuses on any drift.
 */
export interface ManagedPullRequestMergeApprovalBody {
  kind: "managedPullRequestMerge";
  provider: GitHostingProviderKind;
  /** `owner/repo` as the provider names it. */
  repo: string;
  worktreeId: string;
  projectId?: string;
  number: number;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  /** Provider-reported default branch; equal to `baseBranch` by construction. */
  defaultBranch: string;
  /** Exact head SHA the readiness evidence below was gathered for. */
  headSha: string;
  method: PullRequestMergeMethod;
  /** Methods the repository allowed when the card was created. */
  supportedMethods: PullRequestMergeMethod[];
  deleteRemoteBranch: boolean;
  /** Exact-head check verdict, in the check watcher's vocabulary. */
  checks: {
    state: "success" | "failure" | "pending" | "none";
    total?: number;
    finished: boolean;
    truncated?: boolean;
  };
  /** Hosted review state; absent = the provider could not be asked. */
  review?: WorktreePullRequestReview;
  mergeable: boolean | null;
  draft: boolean;
  linkedTask?: { id: string; title: string };
  /** Set once the approved merge landed. */
  resultMerged?: boolean;
  /** Set once the approved merge landed and reported the branch outcome. */
  resultBranchDeleted?: boolean;
}

export interface CommitApprovalBody {
  kind: "commit";
  message: string;
  files: string[];
  branch?: string;
  insertions?: number;
  deletions?: number;
}

/**
 * One proposed peer session in a {@link SessionSpawnApprovalBody}.
 *
 * The runtime fields are RESOLVED values, never the agent's raw hint: the card
 * shows what would actually run, and `modelWarning` says why that differs from
 * what was asked for. The user re-picks account/model/thinking in the card, so
 * these are also the defaults its controls open on.
 */
export interface SessionSpawnApprovalItem {
  /** Stable within the card; the key an edit addresses. */
  rowId: string;
  /** The new session's title — there is no separate label, and auto-naming is suppressed. */
  title: string;
  agentType: "developer" | "assistant";
  /** The opening prompt, delivered as a peer prompt from the proposing session. */
  prompt: string;
  responseRequested: boolean;
  provider: string;
  modelId: string;
  modelName?: string;
  credentialProfileId: string;
  accountName?: string;
  thinkingLevel: ThinkingLevel;
  /** What the agent asked for and why it is not what resolved. */
  modelWarning?: string;
  worktreeId?: string;
  worktreeName?: string;
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskTitle?: string;
  /** The user dropped this row at approve time; nothing was created. */
  skipped?: boolean;
  /** The session this row created, once executed. */
  resultSessionId?: string;
  /** This row's own failure; the rest of the batch still ran. */
  error?: string;
}

/**
 * A batch of peer sessions an agent proposes to spawn (`session_spawn`).
 *
 * The card is the cost gate: the agent may hint a model, but nothing is created
 * until a human approves, and the human owns the final account/model/thinking
 * per row. Approving also delivers each row's opening prompt.
 */
export interface SessionSpawnApprovalBody {
  kind: "sessionSpawn";
  items: SessionSpawnApprovalItem[];
}

export type ApprovalBody =
  | GithubPullRequestApprovalBody
  | GithubIssueApprovalBody
  | GithubBranchDeleteApprovalBody
  | ForgejoPullRequestApprovalBody
  | ForgejoReleaseApprovalBody
  | GitTagApprovalBody
  | JiraIssueApprovalBody
  | ConfluencePageApprovalBody
  | TempoWorklogApprovalBody
  | GmailArchiveApprovalBody
  | CommitApprovalBody
  | SessionSpawnApprovalBody
  | ManagedPullRequestMergeApprovalBody
  | ProjectCreateApprovalBody
  | SettingsInputApprovalBody;

/**
 * The user's per-row adjustments, sent WITH the approve decision rather than
 * patched onto the card first: the stored card stays the agent's proposal, the
 * edits live in the browser until Approve, and applying them is part of the one
 * atomic resolution. A rejected edit leaves the card pending.
 */
export interface SessionSpawnResolutionEdits {
  kind: "sessionSpawn";
  items: Array<{
    rowId: string;
    /** Drop this row: approve the rest of the batch without it. */
    skip?: boolean;
    provider?: string;
    modelId?: string;
    credentialProfileId?: string;
    thinkingLevel?: ThinkingLevel;
  }>;
}

/**
 * The secret a settings-input card's Save submits. It exists only in this
 * message and the server's memory while the approval executes: no card,
 * store, log or agent ever receives it.
 */
export interface SettingsInputResolutionEdits {
  kind: "settingsInput";
  value: string;
}

/** Edits carried by a `resolveApproval` decision, discriminated like the body. */
export type ApprovalResolutionEdits =
  SessionSpawnResolutionEdits | SettingsInputResolutionEdits;

/**
 * @payload ApprovalCard
 * @purpose Store-driven, harness-neutral approval card for an agent-proposed mutation.
 * @renderWhen A mutation tool prepares a proposal, or its status changes via approvalUpdate.
 * @client Render shared chrome (title/status/Approve+Reject) switching on `body.kind`; the action executes ONLY after Approve.
 */
export interface ApprovalCard {
  renderKind: "approval";
  id: string;
  sessionId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  /** Short human title, e.g. "Create pull request" / "Edit 2 Jira issues". */
  title: string;
  /** One-line description of what will happen when approved. */
  summary?: string;
  createdAt: number;
  /** Tool call that issued this proposal; anchors the card at its conversational position. */
  sourceToolCallId?: string;
  resolvedAt?: number;
  decision?: ApprovalDecision;
  /** Short human outcome after execution (also fed back to the agent). */
  resultSummary?: string;
  /** Primary result link, e.g. the opened PR URL. */
  resultUrl?: string;
  /**
   * Why it failed; on a pending card, why an auto-approval handed it back; on
   * an executed card, why its outcome could not reach the agent.
   */
  error?: string;
  /**
   * Every operation this card performs was already granted for the session, so
   * it executes without a click. Cleared again if the grant disappeared before
   * it ran, which leaves an ordinary pending card.
   */
  autoApproved?: boolean;
  /** The user chose "Approve for session", granting this card's operations. */
  grantedForSession?: boolean;
  /** Id of the newer card that replaced this one (status `superseded`). */
  supersededBy?: string;
  body: ApprovalBody;
}

/**
 * A completed context compaction, rendered as a durable transcript card. Both
 * harnesses produce one, but they know different things about it: pi reports the
 * first retained session entry, while the Claude CLI reports the post-compaction
 * context size. Everything beyond `summary`/`tokensBefore` is therefore optional
 * and renderers must degrade instead of inventing a value.
 */
export interface CompactionDisplay {
  summary: string;
  tokensBefore: number;
  /** Context tokens after compaction, when the harness measures it (claude-sdk). */
  tokensAfter?: number;
  /** Id of the first entry kept in context, when the harness exposes one (pi). */
  firstKeptEntryId?: string;
}

/**
 * A completed `/clear`, rendered as a durable transcript card. Unlike a
 * compaction nothing carries forward — there is no summary — so the card marks
 * the boundary: the messages above it stay in the transcript but are no longer
 * the model's context. `tokensBefore` is what was dropped, absent when the
 * harness never measured a context size (a session cleared before its first
 * turn reports nothing rather than a made-up zero).
 */
export interface ContextClearDisplay {
  tokensBefore?: number;
}

export interface CommitBlockerDisplay {
  kind: string;
  file?: string;
  reason: string;
}

export interface CommitFileChange {
  path: string;
  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "untracked"
    | "changed";
  additions?: number;
  deletions?: number;
  sessionTouched?: boolean;
}

export interface CommitTotals {
  files: number;
  additions: number;
  deletions: number;
}

export interface CommitDisplay {
  entryId?: string;
  status: "committed" | "dry-run" | "blocked" | "failed";
  dryRun: boolean;
  forced: boolean;
  /** Set when only the caller's pre-staged index was reviewed and committed. */
  stagedOnly?: boolean;
  repoRoot?: string;
  commitHash?: string;
  commitMessage?: string;
  blockers: CommitBlockerDisplay[];
  warnings: string[];
  files: CommitFileChange[];
  totals: CommitTotals;
  /** Session Tasks considered relevant context for this commit. */
  addressedTasks?: TaskSummary[];
  canAcceptDryRun?: boolean;
  error?: string;
}

/**
 * The rich render payload for app-side `/push` and checked `worktree_push`
 * result cards. Projected from the server's `PushWorkflowResult`.
 */
export interface PushDisplay {
  status: "pushed" | "up-to-date" | "failed";
  repoRoot?: string;
  remote?: string;
  branch?: string;
  /** `--force` was requested (runs as `--force-with-lease`). */
  forced: boolean;
  /** The branch had no upstream, so the push set one (`--set-upstream`). */
  setUpstream: boolean;
  /** Exact local commit published by a checked managed-worktree push. */
  localHead?: string;
  /** Exact remote oid leased by a checked forced publication. */
  expectedRemoteHead?: string;
  /** Combined git stdout/stderr for display. */
  output?: string;
  error?: string;
}

/**
 * Live, durable, store-driven card for `/pr`, managed agent delivery, and
 * workflow publication. Mirrors {@link ApprovalCard}: created by the server, injected into session
 * snapshots on attach, and updated in place via `pullRequestCardUpdate` as the
 * `pullRequestWatcher` observes CI/review/mergeability and as the user answers
 * a Task-disambiguation prompt.
 *
 * `choosing-task` → `creating` → `open` → `merged` | `closed`, or `failed` from
 * `creating` on a drafting/provider error. An EXISTING pull request is adopted
 * straight into `open`/`merged`/`closed` (whatever it already is) — reusing one
 * never goes through `choosing-task`/`creating`.
 */
export type PullRequestCardStatus =
  "choosing-task" | "creating" | "open" | "merged" | "closed" | "failed";

/**
 * How a pull request is merged. Chosen PER MERGE on the card rather than
 * configured once: the right method depends on the branch in front of you, and
 * the provider's own refusal (branch protection, required checks) is the
 * authority on whether it is allowed.
 */
export const PULL_REQUEST_MERGE_METHODS = [
  "squash",
  "merge",
  "rebase",
] as const;

export type PullRequestMergeMethod =
  (typeof PULL_REQUEST_MERGE_METHODS)[number];

/**
 * The actions a live card offers (stage 3). All four are USER-initiated and
 * never automatic:
 * - `merge` — merge the pull request (method per merge) and, unless the click
 *   opted out, delete the remote branch as part of the same provider call.
 * - `update-with-main` — deterministic rebase onto the base branch; only a
 *   CONFLICT hands the work to the session's agent.
 * - `cleanup` — the local counterpart of a remote merge: refresh the exact
 *   base target, verify the branch is contained there, remove the worktree with
 *   its branch, and settle the session. Offered only once merged.
 * - `mark-task-done` — write the linked Task `done` directly, because clicking
 *   this button IS the answer to the suggestion the merge left behind.
 */
export const PULL_REQUEST_CARD_ACTIONS = [
  "merge",
  "update-with-main",
  "cleanup",
  "mark-task-done",
] as const;

export type PullRequestCardAction = (typeof PULL_REQUEST_CARD_ACTIONS)[number];

/**
 * What one `merge` click decided. Both fields belong to the CLICK, not to the
 * card: the method is chosen per merge, and so is whether the remote head
 * branch goes with it. The same shape names them on the wire and in the client
 * handlers, so no surface can offer one of the two and quietly drop the other.
 */
export interface PullRequestCardActionOptions {
  mergeMethod?: PullRequestMergeMethod;
  /**
   * Default true: the remote head branch is deleted as part of the merge call.
   * `false` KEEPS it — the explicit opt-out, per merge.
   */
  deleteBranch?: boolean;
}

export interface PullRequestCard {
  renderKind: "pullRequest";
  id: string;
  sessionId: string;
  status: PullRequestCardStatus;
  createdAt: number;
  updatedAt: number;
  /** Tool call that issued this card; anchors it at its conversational position. */
  sourceToolCallId?: string;
  provider?: GitHostingProviderKind;
  number?: number;
  url?: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  draft?: boolean;
  body?: string[];
  warnings: string[];
  linkedTask?: TaskSummary;
  /** An existing pull request for the branch was adopted rather than created. */
  reused?: boolean;
  /** Present only while `status === "choosing-task"`. */
  taskCandidates?: TaskSummary[];
  /** Set once `status === "creating"` failed. */
  error?: string;
  /** Combined CI status for the PR's head commit, kept current while `open`. */
  ci?: WorktreeCiStatus;
  /** Review state, kept current while `open`. */
  review?: WorktreePullRequestReview;
  /** null = the provider cannot answer it yet; poll again. */
  mergeable?: boolean | null;
  /**
   * A CONFIRMED base conflict, surfaced directly so a renderer need not infer
   * it. Not merely `mergeable === false`: a single `false` is also what a
   * queued conflict check answers, so this is claimed only once a second read
   * of the same head reproduces it (or a merge attempt was refused for it).
   */
  conflicts?: boolean;
  /**
   * Worktree this delivery card targets, when it has one. This may differ from
   * the caller session's checkout. Local actions (`update-with-main`, `cleanup`)
   * act on that checkout, so a card without it
   * offers neither — a plain clone has nothing to rebase or remove.
   */
  worktreeId?: string;
  /**
   * The card action running right now, server-side. Durable rather than local
   * button state: merging and cleanup outlive a reload, and a second click must
   * be refused whether or not it comes from the tab that started the first.
   */
  busyAction?: PullRequestCardAction;
  /**
   * The last `update-with-main` conflicted and its rebase prompt was ACCEPTED
   * by this session's agent: the branch is that agent's work now, so the button
   * says so instead of offering a click that would start a second rebase on it.
   * Durable, because the handoff outlives a reload — but it is only ever the
   * LAST action's fact: the next action clears it, and so does a watcher poll
   * that sees a new head (the rebase landed, or the branch moved some other
   * way). A renderer pairs it with the session actually running; an agent that
   * gave up must not leave the card a dead end.
   */
  rebaseHandedOff?: boolean;
  /**
   * What the repository allows for this pull request, refreshed with the
   * card's provider polls. A merge surface offers only the reported methods
   * and offers none while this is unknown; runtime revalidation at merge time
   * remains authoritative over anything shown here.
   */
  repositoryCapabilities?: PullRequestRepositoryCapabilities;
  /** Outcome of the last finished action, in the user's words. */
  actionMessage?: string;
  /** Why the last action failed. Cleared when the next one starts. */
  actionError?: string;
  /** The local cleanup ran: the worktree and its branch are gone. */
  cleanedUp?: boolean;
}

/**
 * The pull-request card a session OWNS, projected onto its LIST row
 * (`SessionListItem.pullRequest`).
 *
 * A `/pr` card is durable state that only its own session's transcript carries,
 * so a list surface could not say "this is the session with the red checks"
 * without opening every session in it. This is that fact and nothing more: the
 * fields a ROW can state, never the body, the warnings or the linked Task the
 * card itself renders.
 *
 * ONE card per session, even when the session has several (a re-run `/pr`, a
 * second pull request later): the newest card that is still MOVING
 * (`choosing-task` / `creating` / `open`), else the newest terminal one. A row
 * is one line; ranking several cards on it would say less than the one that is
 * still going.
 */
export interface SessionPullRequestSummary {
  status: PullRequestCardStatus;
  /** Absent until the pull request exists (`choosing-task`, `creating`, `failed`). */
  number?: number;
  /**
   * Combined CI status for the head commit, as the watcher last saw it. It is a
   * SNAPSHOT and the watcher stops polling the moment the card leaves `open`,
   * so a reader must not rank it against a terminal status — see
   * `lib/sessionDelivery.ts`, where that mistake showed a merged pull request as
   * permanently failing.
   */
  ci?: WorktreeCiStatus;
  /** Human review state while the PR is open. Absent = not known, never "clean". */
  review?: WorktreePullRequestReview;
  /** A confirmed base conflict, as `PullRequestCard.conflicts` states it. */
  conflicts?: boolean;
  /** The pull request is a draft: open, but not asking for review yet. */
  draft?: boolean;
}

/**
 * Worktree provisioning for a session that was started with "+ New worktree"
 * staged: the checkout is created BEFORE the session exists (a session's cwd is
 * fixed at construction in both harnesses), so this card is the session's
 * genesis entry and precedes the first user prompt in the transcript.
 *
 * The same shape renders live and durably: the browser builds the in-progress /
 * failed card from `worktreeProvision` progress messages, and the server appends
 * the `created` one to the durable log once the session exists. A `failed` card
 * therefore never becomes durable — a failed provision creates no session at all.
 */
export interface WorktreeProvisionDisplay {
  state: WorktreeProvisionPhase;
  projectId: string;
  /** Branch/folder suffix, once the naming agent has answered. */
  branch?: string;
  /** The main checkout's branch this one forked from. */
  baseBranch?: string;
  /** Set from `created` on; the card links to the worktree with it. */
  worktreeId?: string;
  /** Task the worktree was created for, when one was staged. */
  taskId?: string;
  /** Blocker text for `failed`, taken from the thrown error — never scripted. */
  error?: string;
}

/**
 * Provisioning progress, in order. `naming` and `creating` are transient;
 * `created` and `failed` are terminal.
 */
export type WorktreeProvisionPhase =
  "naming" | "creating" | "submodules" | "created" | "failed";

/**
 * Marks an attachment with a special meaning so the UI can render it differently
 * and the server can act on it. `task-context` is a Backlog Task attached to a
 * session's first prompt when the session was started from that Task; the model
 * receives the Task id/title/description, and the UI renders a compact, navigable
 * chip instead of a file chip. The attachment id is `taskctx-<taskId>`.
 * `project-context` is standalone Session Project context selected before the
 * first prompt; the model receives registry context and the UI renders a compact
 * context chip instead of a file chip. `knowledge-context` is a structured KB
 * entry reference; the model receives only compact metadata and is nudged to use
 * KB tools rather than receiving pasted raw entry content.
 */
export type AttachmentRole =
  "task-context" | "project-context" | "knowledge-context";

export interface DisplayAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /**
   * Base64 payload. Used for the optimistic live echo (pi) or an inline
   * preview where we have the bytes handy. History messages use `url` instead
   * so we don't re-ship megabytes on every turn end.
   */
  data?: string;
  /**
   * HTTP path served by `/api/session-image/…`. Preferred for images in
   * history; the live echo may use `data` instead.
   */
  url?: string;
  /** Special role for non-file attachments (e.g. an attached Task). */
  role?: AttachmentRole;
}

export type ProviderErrorKind =
  | "quota"
  | "rate_limit"
  | "timeout"
  | "auth"
  | "server"
  | "network"
  | "aborted"
  | "unknown";

export interface ProviderErrorInfo {
  kind: ProviderErrorKind;
  title: string;
  summary: string;
  detail?: string;
  rawMessage: string;
  retryable?: boolean;
  provider?: string;
  model?: string;
  api?: string;
  responseId?: string;
  authMode?: "subscription" | "api_key" | "unknown";
  /** HTTP status code when the provider error payload exposed one. */
  statusCode?: number;
  /** Provider plan/subscription hint, for example Codex plan_type. */
  planType?: string;
  /** Provider-specific limit bucket, for example workspace_member_usage_limit_reached. */
  limitType?: string;
  /** Epoch seconds when the relevant exhausted limit resets. */
  resetAt?: number;
  /** Seconds until the relevant exhausted limit resets. */
  resetInSeconds?: number;
  /** Provider-specific limit name such as Codex active limit. */
  activeLimit?: string;
  /** Short structured facts extracted from headers/body for display/debugging. */
  facts?: Array<{ label: string; value: string }>;
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  blocks: DisplayBlock[];
  /** ISO persistence time used to interleave store-backed cards with the durable transcript. */
  createdAt?: string;
  /** Provenance for user-role turns; absent/undefined means a human prompt. */
  promptOrigin?: PromptOrigin;
  /** How a user prompt sent during a running turn reached the model. */
  promptDelivery?: PromptDelivery;
  /** Stable pi session entry to fork before (used for user-prompt retry/edit forks). */
  forkBeforeEntryId?: string;
  /** Stable pi session entry to fork at/inclusive (used for assistant-response continuations). */
  forkAtEntryId?: string;
  /**
   * Set when this row was inherited from the session this one was forked out
   * of. The transcript draws ONE fork-boundary marker after the last such row
   * rather than badging each of them.
   */
  inheritedFrom?: SessionEntryOrigin;
  streaming?: boolean;
  error?: string;
  errorInfo?: ProviderErrorInfo;
  /** Provider-neutral completion marker for non-successful partial turns. */
  stopReason?: AgentStopReason;
  /**
   * Durable per-response accounting for an assistant turn, projected from the
   * source entry so the chat can render per-turn/per-run stats. One assistant
   * `DisplayMessage` corresponds to one completed provider run, which may span
   * multiple internal model requests in a tool loop.
   */
  usage?: AgentUsage;
  /** Model that produced this assistant response, when reported. */
  model?: string;
  /** ISO-8601 generation span (duration derived), when reported. */
  startedAt?: string;
  completedAt?: string;
}

export type NoticeSeverity = "info" | "warning" | "error";

/**
 * The object a notice or error is ABOUT.
 *
 * `docs/messaging.md`: a failure lives on its object, and one that cannot name
 * its object may not be shown globally. Carrying the reference on the wire is
 * what lets a client put a message where it belongs — previously it matched on
 * the message TEXT, which is not an interface and silently reroutes the moment
 * anyone rewords a sentence. It reuses the app's first-class object vocabulary
 * (`objectLinks.ts`) rather than a taxonomy of its own, so a target is already
 * addressable and already has a label.
 *
 * `id` is absent when the failure is about the COLLECTION rather than any one
 * of its members — a list that could not be read. That failure is still owned
 * by something the client renders (the pane), so it needs a target for the same
 * reason a single object's does; what it does not have is a member to name.
 */
export interface MessageTarget {
  type: import("./objectLinks.ts").PaObjectType;
  id?: string;
}

export interface SessionForkOrigin {
  /** Which engine runs the parent session (pi / claude-sdk). */
  harness?: Harness;
  /** Which persona/toolset the parent session emulates, independent of harness. */
  agentType?: AgentType;
  /**
   * The parent's provider-native transcript path. pi-only: a claude-sdk fork
   * identifies its parent by session id alone, so consumers must fall back to
   * {@link parentSessionId} (the UI's back-link already does).
   */
  parentSessionFile?: string;
  parentSessionId?: string;
  parentEntryId?: string;
  position?: "before" | "at";
  createdAt?: number;
}

/** Why an idle session is paused, when the reason should be surfaced in the UI. */
export type SessionIdleReason =
  | "awaiting_question"
  | "awaiting_approval"
  /** A `/pr` card is waiting for the user to pick which Task the PR is for. */
  | "awaiting_task_choice";

export interface SessionState {
  sessionId: string;
  sessionFile?: string;
  /** Which engine runs this session (pi / claude-sdk). */
  harness: Harness;
  /** Which persona/toolset this session emulates, independent of harness. */
  agentType: AgentType;
  /** If this session was forked, the source session/message for UI back-links. */
  forkOrigin?: SessionForkOrigin;
  model?: ModelOption;
  thinkingLevel: ThinkingLevel;
  /**
   * Build vs Plan for this session ({@link SessionMode}). Absent is tolerated
   * for legacy projections and behaves as `build`. Unlike model/thinking it is
   * NOT frozen by the first prompt: it is a
   * per-turn tool policy the user may flip at any time.
   */
  mode?: SessionMode;
  /** True when this provider can accept a user steering prompt during a running turn. */
  canSteer?: boolean;
  /** Messages waiting for the running turn to end; absent when there are none. */
  promptQueue?: PromptQueueState;
  /**
   * Why the session is idle, when it's idle for a specific reason the UI should
   * surface (rather than just "done"). Currently only a pending question; modeled
   * as a union so more reasons (e.g. awaiting approval) can be added.
   */
  idleReason?: SessionIdleReason;
  /** Active interactive question flow requested by an agent tool, if any. */
  pendingQuestion?: AgentQuestionRequest;
  /**
   * Resolved question flows for this session, keyed by their tool call, so the
   * in-band `ask_questions` card can render the user's recorded answers (and
   * survive reconnect). Capped to the most recent few.
   */
  answeredQuestions?: AnsweredAgentQuestion[];
  /** Session Tasks linked to this conversation, shown in the session task drawer. */
  tasks?: TaskSummary[];
  /** Durable Tasks explicitly linked to this conversation. */
  relatedGlobalTasks?: TaskSummary[];
  /**
   * The durable Task this session was created to work on, if it was started from
   * a Task ("Start a session" on the Task detail). Distinct from
   * `relatedGlobalTasks`: this is the origin back-link, not just a reference.
   */
  originTask?: TaskBackRef;
  /**
   * Deferred-tool exposure for this session: which catalog tools exist, which
   * are usable (gates/approval), and which are LOADED into the model context
   * (eager tier + on-demand loads), plus the load-event trail. Present for
   * every persona on both harnesses.
   */
  toolExposure?: SessionToolExposure;
  /**
   * Library skill names frozen when this coding session started. Present for
   * coding personas, including an empty list; never recomputed for rendering.
   * A frozen skill is AVAILABLE to the model, not in its context: only its
   * name and description are; `skillInvocations` records the loads.
   */
  activeSkills?: string[];
  /**
   * Bounded, newest-last trail of library-skill loads this session actually
   * made — calls whose result arrived without error — derived from the
   * committed transcript. Present exactly when `activeSkills` is.
   */
  skillInvocations?: SessionSkillInvocation[];
  /** Session-managed screenshots/traces/downloads created by workshop browser tools. */
  artifacts?: SessionArtifact[];
  /** Queued automatic follow-up that will run after the dev server reloads. */
  pendingPostReloadContinuation?: PendingPostReloadContinuation;
  /** Running Playwright MCP/browser instances known to the server. */
  browserRuntimes?: BrowserRuntimeInfo[];
  /** Bounded, sanitized peer-prompt history involving this session. */
  peerPrompts?: PeerPromptThreadsProjection;
  /** The worktree this session executes in (via its `in_worktree` link), if any. */
  worktreeId?: string;
  /**
   * True when `worktreeId` points at a worktree that no longer exists and the
   * user has not acknowledged it (see
   * {@link WORKTREE_MISSING_BLOCKED_REASON}). The session view shows the
   * banner and keeps the composer disabled while it is set.
   */
  worktreeMissing?: boolean;
}

export type AgentQuestionStyle =
  "text" | "textarea" | "single_choice" | "multi_choice" | "confirm";

export interface AgentQuestionChoice {
  id: string;
  label: string;
  description?: string;
}

export interface AgentQuestion {
  id: string;
  title: string;
  prompt?: string;
  helpText?: string;
  style: AgentQuestionStyle;
  required: boolean;
  choices?: AgentQuestionChoice[];
  /** For choice/confirm questions, allow a free-form answer or clarification. */
  allowTypedAnswer?: boolean;
  typedAnswerLabel?: string;
  placeholder?: string;
  defaultChoiceIds?: string[];
  defaultText?: string;
}

export interface AgentQuestionRequest {
  requestId: string;
  toolCallId: string;
  sessionId: string;
  title: string;
  intro?: string;
  questions: AgentQuestion[];
  createdAt: number;
}

export type AgentQuestionAnswerDisposition = "answered" | "discuss" | "skipped";

export interface AgentQuestionAnswer {
  questionId: string;
  choiceIds?: string[];
  text?: string;
  disposition: AgentQuestionAnswerDisposition;
}

export interface AgentQuestionResponse {
  requestId: string;
  status: "submitted" | "cancelled";
  answers: AgentQuestionAnswer[];
  cancelledReason?: string;
  submittedAt: number;
}

/**
 * A resolved question flow surfaced on {@link SessionState} so the durable in-band
 * `ask_questions` card can show what the user answered. The questions themselves
 * come from the tool call's args; this carries only the correlation + the response.
 */
export interface AnsweredAgentQuestion {
  toolCallId: string;
  requestId: string;
  title: string;
  intro?: string;
  /** The normalized questions, so the card renders the Q&A without the tool args. */
  questions: AgentQuestion[];
  response: AgentQuestionResponse;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ContextUsageInfo {
  /** Estimated current context tokens, or null when pi cannot know yet (e.g. right after compaction). */
  tokens: number | null;
  contextWindow: number;
  /** Context usage percentage, or null when tokens is unknown. */
  percent: number | null;
}

export interface CurrentTurnUsageEstimate {
  /** Estimated generated text tokens in the in-flight assistant turn (not included in tokenUsage yet). */
  output: number;
  /** Estimated generated thinking tokens in the in-flight assistant turn (not included in tokenUsage yet). */
  thinking: number;
  toolCalls: number;
}

/** Token/cost/context information exposed by pi's AgentSession statistics. */
export type WorktreeChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "changed";

/* --------------------------------- worktrees -------------------------------
 * Git worktrees are first-class objects: a project's main checkout (derived
 * from its localPaths) plus spawned worktrees where agent sessions run.
 * Worktrees own changes; sessions/tasks link to them via `in_worktree` edges.
 * -------------------------------------------------------------------------- */

export type WorktreeStatusKind = "active" | "removed";

/**
 * A worktree record (resolved row + edges). Spawned worktrees are durable DB
 * rows; the project's **main checkout** is emitted as a synthetic record
 * (`id = "main:<projectId>"`, `isMain: true`) derived live from the project's
 * localPaths — it is never stored. Main is read + session + review only: no
 * merge-back and no remove.
 */
export interface WorktreeRecord {
  id: string;
  projectId: string;
  /** The project's main checkout (synthetic record), not a spawned worktree. */
  isMain?: boolean;
  /** Absolute path of the project's main checkout this worktree was spawned from. */
  mainRepoRoot: string;
  /** Absolute path of the worktree folder. */
  path: string;
  /** Branch checked out in the worktree (== the generated name suffix). */
  branch: string;
  /** Branch the worktree was forked from; the merge-back target. */
  baseBranch: string;
  /** Merge-base with baseBranch recorded when this merge-back target was selected. */
  baseCommit: string;
  status: WorktreeStatusKind;
  /** Sessions executing in this worktree (via `in_worktree` edges). */
  sessionIds: string[];
  /** Tasks implemented in this worktree (via `in_worktree` edges). */
  taskIds: string[];
  createdAt: number;
  updatedAt: number;
  removedAt?: number;
  /**
   * Phase of a merge-back that is still in flight, from the worktree's
   * persisted merge state. Carried on the RECORD rather than only pushed as a
   * `worktreeMergeUpdate` event so a browser that reconnects — or subscribes
   * after the event went out — still learns that a merge is stuck on
   * conflicts. Absent means no merge is in flight.
   */
  mergePhase?: WorktreeMergePhase;
  /**
   * That merge's own bounded message, when it has one. A surface reporting a
   * merge outcome must say what the merge said rather than assert anything
   * about the repository's resulting state — a failure can land after a rebase
   * has already rewritten the branch, or with the base checkout's index and
   * tree already moved, so "nothing changed" is not ours to claim.
   */
  mergeMessage?: string;
}

/** Live git state of one worktree, computed on demand and pushed by the watcher. */
export interface WorktreeGitStatus {
  worktreeId: string;
  branch: string | null;
  /** Short HEAD oid, if any. */
  head: string | null;
  dirty: boolean;
  filesChanged: number;
  untracked: number;
  additions: number;
  deletions: number;
  /** Commits the worktree branch is ahead of / behind its base branch. */
  ahead: number;
  behind: number;
  /**
   * Commits ahead of / behind the branch's tracked REMOTE upstream (push
   * state). Absent when no upstream is configured — a push would set one.
   */
  upstream?: {
    ahead: number;
    behind: number;
    /** Git's resolved short upstream name (for example `fork/feature`). */
    name?: string;
  };
  /**
   * Commits the LOCAL base branch is ahead of / behind its tracked remote.
   * Absent on the main checkout (whose `upstream` is this same relationship)
   * and when the base branch has no tracking ref. `name` is Git's resolved
   * short upstream name; it stays optional so clients can read older servers
   * without inventing a remote label.
   */
  baseUpstream?: { ahead: number; behind: number; name?: string };
  /**
   * The recorded base branch resolves to no LOCAL commit — deleted, renamed,
   * never pulled — so `ahead`, `behind` and `merged` answer nothing about
   * containment and carry their unknown values (0/0/false). Never read that as
   * delivered work.
   *
   * This says nothing about the REMOTE: no local ref proves a remote lacks the
   * branch, so a flow that fetches the base (Retire, `/pr` cleanup, merge) may
   * still verify delivery authoritatively. Only such a flow's own refusal can
   * establish that containment is unknowable; a surface that never fetches
   * (the worktree inspector's Remove) is answered by this field alone.
   */
  baseUnresolved?: boolean;
  /** Branch fully contained in the base branch (ancestry or squash patch-id). */
  merged: boolean;
  updatedAt: number;
  /**
   * When the repo's remote-tracking refs were last refreshed. Every `behind`
   * count above is only as current as this, so a consumer that renders them
   * must degrade rather than assert freshness: ABSENT means we have never
   * fetched, NOT that the refs are current.
   */
  fetchedAt?: number;
  /**
   * When this worktree's git state last actually CHANGED, as opposed to when it
   * was last looked at. `updatedAt` is stamped by every scan — including a
   * routine rescan after a fetch that found nothing — so ordering or ageing a
   * list by it makes every watched worktree look freshly active every few
   * minutes. Use this for "when did something happen here".
   *
   * ABSENT means no transition has been WITNESSED, not that nothing ever
   * happened: change detection is in-memory, so a restart re-observes every
   * worktree with nothing to compare against. Claiming `now` there would mark
   * every quiet worktree freshly active on each deploy, so the first
   * observation records a baseline and reports nothing. Consumers must fall
   * back to something they can justify rather than substituting a value.
   */
  changedAt?: number;
}

/* ------------------------- worktree write operations ------------------------ */

/** POST /api/worktrees/:id/commit body. */
export interface WorktreeCommitRequest {
  message: string;
  /** Repo-relative paths to commit; absent/empty = everything (git add -A). */
  paths?: string[];
}

export interface WorktreeCommitResponse {
  worktreeId: string;
  status: "committed" | "nothing-to-commit";
  /** Short oid of the created commit. */
  commitHash?: string;
}

/** POST /api/worktrees/:id/auto-commit body/result. */
export interface WorktreeAutoCommitRequest {
  /** Override safety blockers, matching `/commit --force`. */
  force?: boolean;
}

export interface WorktreeAutoCommitResponse {
  worktreeId: string;
  result: CommitDisplay;
}

/** POST /api/worktrees/:id/clean result. */
export interface WorktreeCleanResponse {
  worktreeId: string;
  status: "cleaned" | "nothing-to-clean";
  /** Tracked + ordinary untracked paths discarded from the pre-clean status. */
  filesDiscarded: number;
}

/** POST /api/worktrees/:id/push body. */
export interface WorktreePushRequest {
  /** Safe force (`--force-with-lease`). */
  force?: boolean;
}

export interface WorktreePushResponse {
  worktreeId: string;
  status: "pushed" | "up-to-date" | "failed";
  remote?: string;
  branch?: string;
  setUpstream: boolean;
  /** Combined git output for display. */
  output: string;
  error?: string;
}

/** Deterministic POST actions that synchronize a clean worktree or main checkout. */
export type WorktreeSyncOperation =
  "pull-rebase" | "rebase-main" | "fast-forward-main";

export interface WorktreeSyncResponse {
  worktreeId: string;
  operation: WorktreeSyncOperation;
  status: "updated" | "up-to-date";
  /** Full oid before the operation and after its successful completion. */
  previousHead: string;
  head: string;
}

/** POST /api/worktrees/:id/retire body. */
export interface WorktreeRetireRequest {
  /** Delete the spawned worktree's local branch; defaults to true. */
  deleteBranch?: boolean;
  /** Discard git work after an explicit lost-work confirmation. */
  force?: boolean;
}

/** The direct result of the confirmed retire flow. */
export type WorktreeRetireResponse =
  | {
      worktreeId: string;
      status: "retired";
      branch: string;
      baseBranch: string;
      branchDeleted: boolean;
      settledSessions: number;
      /**
       * Whether this retirement PROVED the branch delivered — containment
       * against the refreshed base target — rather than skipping the question.
       * False when `force` was given (that is exactly the licence to skip it),
       * when the branch was kept (nothing was discarded, so nothing needed
       * proving), and for a pending branch-cleanup retry, whose oid-bound
       * deletion also succeeds on an already-absent branch and so proves
       * nothing either.
       *
       * A surface must not claim verification this did not perform. Nor is
       * false the OPPOSITE claim: it says this retirement did not establish
       * delivery, never that the branch was undelivered.
       */
      deliveryVerified: boolean;
    }
  | {
      worktreeId: string;
      status: "refused";
      branch: string;
      baseBranch: string;
      refusal: string;
      /**
       * What refused, which decides whether the user has an answer to it.
       * `"sessions"` is a session gate: `force` never overrides one, so a
       * surface must not offer it. `"delivery"` (delivery could not be verified
       * against the refreshed base) and `"git-guard"` (a dirty tree, unmerged
       * commits, a merge in progress) are the refusals `force` answers — and
       * since this one was produced by the authoritative refresh, it is what a
       * surface may escalate from, rather than guessing from local status.
       * `"permissions"` is the checkout holding files another user owns: no
       * consent makes them deletable, so it is not escalatable either.
       */
      refusalKind: WorktreeRetireRefusalKind;
    };

/** What refused a retirement; see `WorktreeRetireResponse.refusalKind`. */
export type WorktreeRetireRefusalKind =
  "sessions" | "delivery" | "git-guard" | "permissions";

/* ----------------------------- git hosting (PR/CI) --------------------------
 * Provider-abstract pull-request + CI surface resolved from a selected push
 * remote (`origin` by default). Forgejo and GitHub share the same seam.
 */

/**
 * The provider kinds, as a value — a client that puts one in a URL has to be
 * able to reject anything else, and a second hand-written list of the same two
 * strings is how a route starts accepting a provider the app does not have.
 */
export const GIT_HOSTING_PROVIDER_KINDS = ["forgejo", "github"] as const;

export type GitHostingProviderKind =
  (typeof GIT_HOSTING_PROVIDER_KINDS)[number];

export function isGitHostingProviderKind(
  value: string,
): value is GitHostingProviderKind {
  return (GIT_HOSTING_PROVIDER_KINDS as readonly string[]).includes(value);
}

export interface WorktreePullRequestInfo {
  number: number;
  url: string;
  title: string;
  state: "open" | "merged" | "closed";
}

export interface WorktreeCiStatus {
  state: "success" | "failure" | "pending" | "error";
  /** Where to inspect the runs (commit status page). */
  url?: string;
  /** Number of individual status contexts/checks. */
  total: number;
}

/**
 * Human review state on an OPEN pull request. Present only when the provider
 * could actually be asked: absence means unknown, never "nobody objected".
 */
export interface WorktreePullRequestReview {
  /** A reviewer asked for changes and that review still stands. */
  changesRequested: boolean;
  /**
   * Open (unresolved) review threads. OPTIONAL because thread resolution is
   * not reachable over the REST surfaces we use — reporting 0 where we cannot
   * tell would read as "all resolved", which is exactly the lie the inbox's
   * absent-is-unknown rule exists to prevent.
   */
  unresolvedThreads?: number;
}

/**
 * Point-in-time detail for ONE pull request, as `pullRequestWatcher.ts` polls
 * it: everything the live card's `open` sub-state needs beyond `ciStatus`.
 *
 * `mergeable: null` = the provider cannot answer yet, so a poller must retry
 * rather than render it as a conflict. GitHub answers null literally right
 * after a push while it recomputes; Forgejo has no unknown value of its own and
 * reports `false` for every draft/WIP pull request, so the provider seam maps
 * that onto the same `null`.
 */
export interface PullRequestDetail {
  number: number;
  state: "open" | "merged" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  draft: boolean;
  headSha: string;
  headBranch: string;
  baseBranch: string;
}

/**
 * Outcome of a merge through the hosting seam. A provider REFUSAL (branch
 * protection, required checks, a stale mergeability answer) arrives as a thrown
 * error carrying the provider's own words, never as `merged: false` — so a
 * result in hand always means the pull request is merged.
 */
export interface PullRequestMergeResult {
  number: number;
  method: PullRequestMergeMethod;
  /** The remote head branch was deleted as part of the same call. */
  branchDeleted: boolean;
  /** Present when deletion was asked for and refused (protected branch, …). */
  branchDeleteError?: string;
}

/**
 * Outcome of closing a pull request WITHOUT merging. The provider write either
 * threw (nothing changed, or nothing that could be confirmed) or landed; a
 * landed write whose confirmation read failed is an honest PARTIAL rather than
 * either a success claim or a failure, and the watcher reconciles it.
 */
export interface PullRequestCloseResult {
  number: number;
  /** The provider confirmed the pull request is closed and unmerged. */
  closed: boolean;
  /** Head SHA the close was accepted against, as the provider reported it. */
  headSha: string;
  /** The write landed but its confirmation could not be completed; why. */
  unconfirmedReason?: string;
}

/**
 * What ONE repository allows for its pull requests, read from provider
 * repository metadata rather than assumed.
 *
 * Every field is OPTIONAL and absence means UNKNOWN — never "all methods are
 * supported" and never a guessed `main`/`master`. A consumer that cannot see a
 * fact fails closed: direct merge, default-branch classification and closing
 * all refuse rather than proceed on a default.
 */
export interface PullRequestRepositoryCapabilities {
  /** Exact provider-reported default branch. Absent = could not be read. */
  defaultBranch?: string;
  /**
   * Merge methods the repository currently allows, in the shared vocabulary's
   * own order. Absent = unknown; an EMPTY array is a real answer (the
   * repository allows none of the three).
   */
  mergeMethods?: PullRequestMergeMethod[];
  /** Provider/project default, only when repository metadata defines one. */
  defaultMergeMethod?: PullRequestMergeMethod;
  /** The provider exposes closing a pull request without merging. */
  canClose?: boolean;
  /** The merge seam can delete the remote head branch as part of the merge. */
  canDeleteBranchOnMerge?: boolean;
  /** Repository setting: head branches are deleted on merge by default. */
  deleteBranchOnMergeDefault?: boolean;
  /** Why the read is unknown, when it was attempted and failed. */
  unknownReason?: string;
}

/** GET /api/worktrees/:id/hosting. Fields absent when unknown/not applicable. */
export interface WorktreeHostingStatusResponse {
  worktreeId: string;
  /** Absent = the repo's remote resolves to no configured provider. */
  provider?: GitHostingProviderKind;
  repoWebUrl?: string;
  /** Open PR for the worktree branch (never for main checkouts). */
  pr?: WorktreePullRequestInfo;
  /** Combined CI status for the worktree HEAD. */
  ci?: WorktreeCiStatus;
  /** Review state of `pr`, when there is one and the provider answered. */
  review?: WorktreePullRequestReview;
  /**
   * What the repository allows for pull requests. Absent (or with absent
   * fields) = unknown: a merge picker offers only what is reported here and
   * nothing at all while it is unknown.
   */
  capabilities?: PullRequestRepositoryCapabilities;
}

/**
 * One open pull request on a project's repo, as the PR list reports it. Richer
 * than {@link WorktreePullRequestInfo} because this list is browsed rather than
 * attached to a branch you already have: it carries the head/base branches (so
 * the client can tell which PRs already have a local worktree), authorship, and
 * whether it is waiting on YOU.
 */
export interface HostedPullRequest {
  number: number;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  author?: string;
  /** Opened by the authenticated user. False when the identity is unknown. */
  mine: boolean;
  /** The authenticated user's review was requested. */
  reviewRequested: boolean;
  draft?: boolean;
  updatedAt?: number;
}

/**
 * Open pull requests for ONE project's repository. A server-side projection
 * now: the inventory below is what reaches a client, and a project whose
 * provider could not be reached simply contributes nothing here.
 */
export interface ProjectPullRequests {
  projectId: string;
  provider: GitHostingProviderKind;
  repoWebUrl: string;
  pullRequests: HostedPullRequest[];
}

/**
 * ONE pull request as the Pull Requests view inventories it: its identity, what
 * the provider currently says about it, and the LOCAL objects it is joined to.
 *
 * Richer than {@link HostedPullRequest} in two directions. It carries the
 * hosting detail a decision needs (CI, review, mergeability, the exact head,
 * what the repository allows), and it carries state beyond `open`: a MERGED or
 * CLOSED pull request stays inventoried while a local worktree for its head
 * branch still exists, because that checkout is the thing left to clean up.
 *
 * Absence means UNKNOWN throughout, never a negative answer — the rule the
 * hosting projection next to it already follows.
 */
export interface PullRequestInventoryItem {
  /** Registered project whose repository holds this pull request. */
  projectId: string;
  provider: GitHostingProviderKind;
  /**
   * `owner/repo`, lowercased — the repository half of this pull request's
   * identity, the same one the server joins on (`pullRequestIdentity.ts`).
   *
   * It is on the wire because a CLIENT has to name the repository too. One
   * project can hold two of them — a spawned worktree may publish to a
   * `pushurl` repository its main checkout does not list — and both number a
   * pull request 7, so project + number ADDRESSES NOTHING: two rows would share
   * one URL, both would highlight, and a detail surface would open whichever
   * came first.
   */
  repositoryKey: string;
  repoWebUrl: string;
  number: number;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  author?: string;
  /**
   * Opened by the authenticated user. False when the identity is unknown — and
   * a merged/closed cleanup-queue entry is derived from the local branch rather
   * than from the open-PR list, so it can no longer state this either.
   */
  mine: boolean;
  /** The authenticated user's review was requested (open pull requests only). */
  reviewRequested: boolean;
  draft?: boolean;
  updatedAt?: number;
  /**
   * `merged`/`closed` appear only for a pull request whose head branch still
   * has a local worktree: that is the cleanup queue, and it is what keeps a
   * merged pull request visible until its checkout is gone.
   */
  state: "open" | "merged" | "closed";
  /** Combined CI status for the pull request's head commit. */
  ci?: WorktreeCiStatus;
  /** Review state, read only for an OPEN pull request. */
  review?: WorktreePullRequestReview;
  /**
   * THREE-valued, exactly as {@link PullRequestDetail#mergeable}: `null` means
   * the provider cannot answer yet and a surface must ask again rather than
   * render a conflict. Absent = not read (a terminal pull request has nothing
   * to merge).
   */
  mergeable?: boolean | null;
  /** Provider-reported head SHA, for an action that must pin the exact head. */
  headSha?: string;
  /**
   * What the repository allows, read for an OPEN pull request. Absent (or with
   * absent fields) = unknown, and a merge surface then offers nothing.
   */
  capabilities?: PullRequestRepositoryCapabilities;
  /**
   * Active spawned worktree of the same project whose branch IS `headBranch`.
   * Absent = this pull request has no local checkout.
   */
  worktreeId?: string;
  /**
   * Sessions reachable from this pull request: those linked to `worktreeId`,
   * plus those whose `/pr` card names the same provider and number. IDs only —
   * the client already holds the session rows and resolves them itself.
   */
  sessionIds: string[];
  /** Tasks linked through those `/pr` cards and through `worktreeId`. IDs only. */
  taskIds: string[];
}

/**
 * GET /api/pull-requests — the Pull Requests view's locally persisted inventory
 * snapshot: the open pull requests that are yours or waiting on your review,
 * plus the merged/closed ones whose local worktree is still around. The server
 * refreshes it against providers in the background; this read itself performs
 * no provider calls.
 *
 * A project whose provider could not be reached during a completed build keeps
 * its last persisted items rather than turning an outage into an empty answer.
 */
export type PullRequestInventoryResponse =
  | {
      /** No provider-backed snapshot has landed yet. This is loading, not empty. */
      status: "cold";
      items: [];
      fetchedAt: null;
    }
  | {
      status: "ready";
      items: PullRequestInventoryItem[];
      /** Oldest project refresh represented here, for staleness display. */
      fetchedAt: number;
    };

/**
 * POST /api/pull-requests/merge — the Pull Requests view's ONE "Merge & clean
 * up" action.
 *
 * It is neither the `/pr` card's action (card-bound) nor the worktree page's
 * merge (worktree-bound): this view has no card and need not have a worktree,
 * so it addresses the pull request by the same FOUR components its route and
 * the server's join key are made of. Everything else — the head and base
 * branches, the exact head, the checkout to remove — is re-derived from that
 * identity on the server; a branch, SHA or path from the client would let a
 * stale surface merge something it never showed.
 *
 * Each consequence the dialog offers to opt out of has its own field, and an
 * omitted one is the SAFE answer rather than the convenient one: an absent
 * `removeWorktree` removes no checkout.
 */
export interface PullRequestViewMergeRequest {
  projectId: string;
  provider: GitHostingProviderKind;
  /** `owner/repo`, lowercased — `PullRequestInventoryItem.repositoryKey`. */
  repositoryKey: string;
  number: number;
  /**
   * Required while the pull request is OPEN; the server never defaults it,
   * because merging with a strategy the user did not choose is not a detail it
   * gets to decide. Ignored for a pull request that is already merged or
   * closed, which this action then only cleans up after.
   */
  method?: PullRequestMergeMethod;
  /**
   * Delete the remote head branch as part of the merge call. Default true,
   * exactly as the card's merge — the checkbox is the per-merge opt-out.
   */
  deleteRemoteBranch?: boolean;
  /**
   * Remove the local worktree for this pull request and delete its local
   * branch. Default FALSE: a checkout is never deleted because a field was
   * missing, however the surface that sent it was checked.
   */
  removeWorktree?: boolean;
  /**
   * Discard local git work the removal would otherwise refuse, after explicit
   * lost-work consent. Only ever an answer to a refusal this endpoint already
   * returned — see {@link WorktreeRetireResponse.refusalKind}.
   */
  forceRemoveWorktree?: boolean;
}

/** What happened to the pull request itself. */
export type PullRequestViewMergeOutcome =
  | {
      status: "merged";
      method: PullRequestMergeMethod;
      headBranch: string;
      baseBranch: string;
      /**
       * What happened to the REMOTE head branch, never what was asked for:
       * `kept` is the opt-out, `not-deleted` is a deletion the provider refused
       * or could not confirm (with `remoteBranchError` when it said why).
       */
      remoteBranch: "deleted" | "kept" | "not-deleted";
      remoteBranchError?: string;
    }
  | {
      /**
       * Nothing was merged because there was nothing left to merge: the pull
       * request was already terminal when this ran. The cleanup half still
       * runs — that is the whole reason the view lists it.
       */
      status: "already-terminal";
      state: "merged" | "closed";
    };

/**
 * What happened to the LOCAL checkout. A refusal or failure here never turns a
 * landed merge into a failed action: the merge is reported above as what it
 * was, and this says exactly what became of the worktree, the branch and the
 * sessions.
 */
export type PullRequestViewCleanupOutcome =
  | { status: "not-requested" }
  /** No local worktree of this project holds this pull request's head branch. */
  | { status: "no-worktree" }
  | {
      status: "retired";
      worktreeId: string;
      branch: string;
      baseBranch: string;
      branchDeleted: boolean;
      settledSessions: number;
      /** See {@link WorktreeRetireResponse}: only a check that RAN proves this. */
      deliveryVerified: boolean;
    }
  | {
      status: "refused";
      worktreeId: string;
      refusal: string;
      /** Which refusals `forceRemoveWorktree` may answer; `sessions` is never one. */
      refusalKind: WorktreeRetireRefusalKind;
    }
  | { status: "failed"; worktreeId?: string; error: string };

/**
 * The per-phase report of one Merge & clean up. A 200 means the action ran, not
 * that everything in it succeeded: the phases are separate answers precisely so
 * a cleanup that refused cannot be mistaken for a merge that did not land.
 */
export interface PullRequestViewMergeResponse {
  number: number;
  merge: PullRequestViewMergeOutcome;
  cleanup: PullRequestViewCleanupOutcome;
  /**
   * The Tasks this merge actually WROTE a `done` suggestion on. Empty whenever
   * no linked Task existed, one was already done, a suggestion already stood or
   * the write failed — never what the caller hoped for.
   */
  taskSuggestions: TaskSummary[];
}

/**
 * POST /api/pull-requests/check — what this pull request IS, read under its own
 * mutation lock. It is a POST because it takes that lock, not because it writes:
 * it attempts nothing.
 *
 * It exists for one question a surface cannot otherwise answer: a request whose
 * RESPONSE was lost may have merged, and the client cannot tell. Re-issuing the
 * merge would answer it only while that merge is still possible — a pull
 * request that has since become a draft, or conflicted, or whose method the
 * repository no longer allows, would refuse every attempt forever and leave the
 * surface permanently uncertain. Asking for the STATE cannot refuse for those
 * reasons, and because it runs under the same lock its answer is necessarily
 * after the lost request finished.
 */
export interface PullRequestViewCheckRequest {
  projectId: string;
  provider: GitHostingProviderKind;
  /** `owner/repo`, lowercased — the same identity the merge request carries. */
  repositoryKey: string;
  number: number;
}

/**
 * What the check found LOCALLY, as three distinct answers.
 *
 * `ambiguous` is why this is a union rather than an optional id: two checkouts
 * on the head branch is not "no checkout". Collapsing it into an absent id
 * would let a surface announce that nothing local is left while two worktrees
 * are still there — and suppress the cleanup that would deal with them.
 */
export type PullRequestViewCheckoutState =
  | { status: "none" }
  | { status: "one"; worktreeId: string }
  | { status: "ambiguous"; reason: string };

export interface PullRequestViewCheckResponse {
  number: number;
  /** The provider's answer, read under the lock. */
  state: "open" | "merged" | "closed";
  /** Open but not asking for review; a merge would be refused. */
  draft?: boolean;
  /** Three-valued as everywhere: `null` is "the provider is still checking". */
  mergeable?: boolean | null;
  /** The local checkout situation, which decides what cleanup still applies. */
  checkout: PullRequestViewCheckoutState;
}

/**
 * POST /api/pull-requests/checkout — the Pull Requests view's REVIEW action:
 * create or update the local worktree that stands on this pull request's head
 * branch, so a session can be opened in it.
 *
 * The same four components as the merge and the check, and for the same reason:
 * everything the checkout needs — the head branch, the remote that carries it,
 * the exact commit, the worktree to update, the base to record — is re-derived
 * from this identity on the server. A branch, SHA, path or worktree id from the
 * client would let a surface a minute stale check out something it never showed.
 */
export interface PullRequestViewCheckoutRequest {
  projectId: string;
  provider: GitHostingProviderKind;
  /** `owner/repo`, lowercased — the same identity the other two carry. */
  repositoryKey: string;
  number: number;
}

/**
 * Which merge-back target the worktree ended up RECORDING, stated rather than
 * assumed.
 *
 * `baseBranch` is not decoration: `worktreeMerge.ts` refuses to merge a
 * worktree back unless the main checkout is on that exact branch, so a
 * remote-tracking ref, a tag or a SHA recorded there produces a checkout that
 * looks ordinary and can never merge back. A review checkout therefore records
 * the pull request's base branch only where it EXISTS locally, and the main
 * checkout's current branch otherwise — and says which of the two happened,
 * because the difference decides where the work would land.
 */
export interface PullRequestCheckoutBase {
  /** The merge-back target the worktree row holds. */
  branch: string;
  /** The branch the pull request itself merges into. */
  pullRequestBase: string;
  /**
   * The recorded base IS the pull request's base branch. False is a statement
   * about this checkout, not a failure: the pull request's base was not a local
   * branch here (create), or the checkout that already existed was recorded
   * against another base and is never re-pointed by this action (update).
   */
  matchesPullRequestBase: boolean;
}

/**
 * Why a review checkout did nothing. Every one of these is DATA on a 200: the
 * action attempted nothing it could not report, and the reason belongs on the
 * pull request rather than in a transport error.
 *
 * Nothing here is ever resolved by guessing. A checkout that is dirty, that has
 * commits the pull request does not, or that tracks something else is reported
 * as itself — this action never resets, forces or re-points a branch it did not
 * create.
 */
export type PullRequestCheckoutRefusalKind =
  /** The head branch is not on this repository's remote — a fork, typically. */
  | "head-unreachable"
  /**
   * The remote branch of that name is NOT at the pull request's head. Either
   * the head lives on a fork whose branch name collides with one here, or it
   * moved between the provider read and the fetch.
   */
  | "head-moved"
  /** The existing checkout has uncommitted changes. */
  | "dirty"
  /** The existing branch carries commits that are not on the pull request head. */
  | "diverged"
  /** The existing branch does not track this pull request's head branch. */
  | "not-tracking"
  /** A local branch of that name exists with no managed worktree on it. */
  | "branch-exists"
  /** Two managed checkouts stand on this head branch; neither is touched. */
  | "ambiguous-checkout"
  /** No local base could be recorded (the main checkout is detached). */
  | "base-unresolvable"
  /**
   * The checkout or its upstream moved between the state this action checked
   * and the moment it took the lock, so the act it was about to perform is no
   * longer the act that was verified. Nothing was changed; asking again reads
   * the new state.
   */
  | "raced"
  /** The update itself refused — a conflicting rebase, say — and restored. */
  | "update-failed";

/**
 * Tasks this CHECKOUT is linked to, as the server's own edges answer it.
 *
 * On the wire because the answer must not depend on how fresh a browser's
 * lists happen to be: an empty array is the authoritative "this checkout has
 * no linked Task", which is what lets a client fall back to the pull request's
 * own Task links without risk of overruling a checkout-owned Task it simply
 * could not see yet.
 */
type PullRequestCheckoutTaskIds = string[];

/**
 * What the review checkout DID. Four outcomes, deliberately distinct: a
 * checkout that already stood at the pull request's head did no git work at
 * all, and reporting that as an update would claim something that did not
 * happen.
 */
export type PullRequestCheckoutOutcome =
  | {
      status: "created";
      worktreeId: string;
      /** The worktree's own branch — the pull request's head branch. */
      branch: string;
      path: string;
      /** The commit the new checkout actually stands at. */
      head: string;
      base: PullRequestCheckoutBase;
      taskIds: PullRequestCheckoutTaskIds;
    }
  | {
      status: "updated";
      worktreeId: string;
      branch: string;
      /** Where the checkout stood before, so the move is verifiable. */
      previousHead: string;
      head: string;
      base: PullRequestCheckoutBase;
      taskIds: PullRequestCheckoutTaskIds;
    }
  | {
      status: "already-current";
      worktreeId: string;
      branch: string;
      head: string;
      base: PullRequestCheckoutBase;
      taskIds: PullRequestCheckoutTaskIds;
    }
  | {
      status: "refused";
      kind: PullRequestCheckoutRefusalKind;
      /** The server's own words, for the surface to render on the object. */
      reason: string;
      /** The existing checkout the refusal is about, where there is one. */
      worktreeId?: string;
    };

/**
 * The review checkout's answer. A 200 means the action ran and reported what it
 * found; `outcome.status === "refused"` is that report, not a failure of the
 * request.
 */
export interface PullRequestViewCheckoutResponse {
  number: number;
  /** The head branch this ran for, as the PROVIDER reported it. */
  headBranch: string;
  outcome: PullRequestCheckoutOutcome;
}

/**
 * GET /api/worktrees/hosting — every active worktree's hosting state in one
 * request, for the Worktrees inbox.
 *
 * A worktree whose PULL-REQUEST lookup failed is simply absent from `statuses`
 * rather than present-and-empty: the inbox reads absence as unknown, and a
 * fabricated empty row would read as "no PR, no CI". A failed CI or review read
 * does NOT remove the row — it leaves only that field absent, which already
 * means unknown here, so an answered pull request survives an unrelated outage.
 */
export interface WorktreeHostingListResponse {
  statuses: WorktreeHostingStatusResponse[];
  /** When this projection was built, for staleness display. */
  fetchedAt: number;
}

/** POST /api/worktrees/:id/create-pr body. */
export interface WorktreeCreatePrRequest {
  title: string;
  body?: string;
}

export interface WorktreeCreatePrResponse {
  worktreeId: string;
  pr: WorktreePullRequestInfo;
}

/**
 * POST /api/worktrees/:id/merge-pr body — the worktree page's merge button.
 * Same server-side projection as the chat card's `merge` action, so the two
 * surfaces cannot drift: one provider call that merges and, unless this body
 * opts out, deletes the remote branch.
 */
export interface WorktreeMergePrRequest {
  method: PullRequestMergeMethod;
  /** Default true; the remote branch is deleted as part of the merge call. */
  deleteBranch?: boolean;
}

export interface WorktreeMergePrResponse {
  worktreeId: string;
  /** The merged pull request, in its post-merge state. */
  pr: WorktreePullRequestInfo;
  method: PullRequestMergeMethod;
  /** The remote branch was deleted along with the merge. */
  branchDeleted: boolean;
}

/**
 * What a worktree diff is computed against. `workingTree` = uncommitted changes
 * vs HEAD. A range diffs `from` → `to`; omitting `to` diffs `from` → the
 * working tree (e.g. "everything since the branch point, committed or not").
 */
export type WorktreeDiffScope =
  { kind: "workingTree" } | { kind: "range"; from: string; to?: string };

export interface WorktreeChangeFile {
  path: string;
  oldPath?: string;
  status: WorktreeChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface WorktreeChangesResponse {
  worktreeId: string;
  branch: string | null;
  head: string | null;
  scope: WorktreeDiffScope;
  files: WorktreeChangeFile[];
  totals: { files: number; additions: number; deletions: number };
  updatedAt: number;
}

/**
 * One file's diff. `diff` carries the raw patch; text-sized full old/new
 * contents are included for renderers that support native context expansion.
 */
export interface WorktreeFileDiffResponse {
  worktreeId: string;
  path: string;
  oldPath?: string;
  status: WorktreeChangeStatus;
  language: string;
  binary: boolean;
  truncated: boolean;
  /** Raw unified `git diff` text. */
  diff: string;
  oldContent: string;
  newContent: string;
  /**
   * Resolved commit oid of the displayed NEW side when the scope range has an
   * explicit `to` (the new side is committed content, not the working tree).
   * Absent when the new side shows current working-tree content. The client
   * uses it to anchor review comments at that commit (`NewWorktreeCommentAnchor.ref`).
   */
  newOid?: string;
  updatedAt: number;
}

export interface WorktreeFileResponse {
  worktreeId: string;
  path: string;
  /** The ref the content was read at; absent = working tree. */
  ref?: string;
  language: string;
  mimeType: string;
  binary: boolean;
  truncated: boolean;
  content: string;
  updatedAt: number;
}

export interface WorktreeCommitLogEntry {
  oid: string;
  shortOid: string;
  subject: string;
  author: string;
  authoredAt: number;
  /** True for commits already on the base branch (context beyond the branch point). */
  onBase?: boolean;
}

export interface WorktreeLogResponse {
  worktreeId: string;
  entries: WorktreeCommitLogEntry[];
}

export interface WorktreeTreeEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number;
}

/** Where a worktree merge-back currently stands. */
/**
 * A merge message is a CARD LINE, not a log. Git failure output can run to the
 * exec buffer's size, and this text reaches both a card's detail line and its
 * memo key — so every path that surfaces one bounds it here, live and persisted
 * alike, rather than each deciding for itself.
 */
export const MERGE_MESSAGE_MAX = 200;

export function boundMergeMessage(
  message: string | undefined | null,
): string | undefined {
  const clean = (message ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > MERGE_MESSAGE_MAX
    ? `${clean.slice(0, MERGE_MESSAGE_MAX - 1)}…`
    : clean;
}

export type WorktreeMergePhase =
  "idle" | "merging" | "conflicts" | "agent_resolving" | "done" | "failed";

/* ------------------------- worktree review comments ------------------------ */

export type WorktreeCommentAuthor =
  | { kind: "user" }
  | {
      kind: "agent";
      sessionId: string;
      /** Snapshots captured when this individual comment was written. */
      model?: string;
      thinkingLevel?: string;
    };

/** Where a new comment is anchored (creation input; the server snapshots context). */
export interface NewWorktreeCommentAnchor {
  path: string;
  /** Which side of a diff the line was on; plain file views use "new". */
  side: "old" | "new";
  /** 1-based line number in the displayed content. */
  line: number;
  /**
   * Exact sub-line selection when creation came from native text selection.
   * When present, `position` is mandatory even though the reusable
   * `SelectorBundle` model makes it optional. Absent for the gutter affordance;
   * the server captures the whole line.
   */
  selectors?: SelectorBundle;
  /**
   * Commit the displayed content came from, for commenting on an OLDER commit's
   * diff (e.g. reviewing one of several commits an agent made). Absent = the
   * current working tree ("new") / HEAD ("old"). The server snapshots the
   * anchor at this commit and the re-anchor pass maps it forward to current
   * content like any other anchor.
   */
  ref?: string;
}

/**
 * How well a comment's anchor still maps onto the current worktree content:
 * `anchored` = at its original position, `moved` = re-anchored to a shifted or
 * fuzzy-matched line, `orphaned` = the anchored content no longer exists.
 */
export type WorktreeCommentAnchorState = "anchored" | "moved" | "orphaned";

/** A review comment thread root or reply (roots carry the anchor). */
export interface WorktreeComment {
  id: string;
  worktreeId: string;
  /** Present on replies; absent on thread roots. */
  parentId?: string;
  author: WorktreeCommentAuthor;
  body: string;
  /** Agent finding metadata; human comments and replies normally omit it. */
  severity?: import("./comments.ts").ReviewSeverity;
  reviewSetId?: string;
  resolvedAt?: number;
  /** "user" or the resolving agent's session id. */
  resolvedBy?: string;
  /** Immutable creation anchor (roots only). */
  anchor?: {
    path: string;
    side: "old" | "new";
    /** Legacy/display coordinate; selector offsets are the identity. */
    line: number;
    commit: string;
    dirty: boolean;
    selectors: SelectorBundle;
  };
  /** Current position after re-anchoring (roots only; absent when orphaned). */
  current?: { path: string; line: number };
  anchorState?: WorktreeCommentAnchorState;
  /** Session the comment batch was attached to, if any. */
  attachedSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionProjectContext {
  id: string;
  known: boolean;
  /** Server-resolved display name when the registry id is known. */
  name?: string;
}

export interface ContextInfo {
  sessionId: string;
  updatedAt: number;
  /** Informational Project context inherited from a Task or selected for a standalone Session. */
  project?: SessionProjectContext;
  messageCounts: {
    user: number;
    assistant: number;
    toolCalls: number;
    toolResults: number;
    total: number;
  };
  /** Cumulative actual usage reported by completed provider responses in this session. */
  tokenUsage: TokenUsage;
  /** Cumulative provider cost reported by pi, if available for the model/provider. */
  cost: number;
  /** Current context estimate for the active branch/model. */
  context?: ContextUsageInfo;
  /** Live estimate while a turn is streaming; actual usage lands after the provider response finishes. */
  currentTurn?: CurrentTurnUsageEstimate;
}

/* ----------------------------- client -> server ---------------------------- */

/**
 * One message the user queued behind a running turn. It is sent as the next
 * turn once the session is idle, ahead of anything agents have queued for it.
 * A queued host slash command (`/compact`) carries `command` and runs then.
 */
export interface QueuedPrompt {
  id: string;
  /** As typed; a queued command keeps its leading `/`. */
  text: string;
  /** Metadata only — the bytes wait in the session attachment store. */
  attachments?: QueuedPromptAttachment[];
  command?: { name: string; rawArgs: string };
  createdAt: number;
  /** Why its last delivery failed. The queue pauses on a failed item. */
  error?: string;
  /** Its send is under way: it can no longer be edited or removed. */
  sending?: true;
}

export type QueuedPromptAttachment = Omit<PromptAttachment, "data">;

/**
 * A session's queue, in send order. `paused` holds it after the user stopped a
 * turn or a delivery failed: nothing is sent until they resume it or send a
 * message themselves.
 */
export interface PromptQueueState {
  items: QueuedPrompt[];
  paused: boolean;
}

export interface PromptAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Raw base64 without a data: URL prefix. */
  data: string;
  /** Special role for non-file attachments (e.g. an attached Task). */
  role?: AttachmentRole;
}

/**
 * A fan-out topic on the single session socket.
 *
 * Chat traffic is already addressed per viewer, but the DOMAIN lists are not:
 * one Task mutation used to push its whole list (~147 KB) to every connected
 * browser, including a phone sitting in a conversation. A connection therefore
 * declares which lists it is currently showing, and the hub broadcasts to those
 * connections only. Subscribing is authoritative-on-subscribe: a warm migrated
 * domain receives a revision digest, while cold and non-migrated domains receive
 * a snapshot, so reconnect and first visit converge through the same request.
 *
 * Not a topic, deliberately:
 * - the session list, which every surface's sidebar shows;
 * - per-worktree status/changes and per-object comment traces, which are
 *   addressed by the object the connection has open, not by topic.
 */
export type BroadcastTopic =
  | "tasks"
  | "projects"
  /** Canonical durable subagent-thread registry summaries. */
  | "subagents"
  /** Canonical durable session-owned background work items. */
  | "background"
  | "worktrees"
  | "knowledge"
  | "calendar"
  | "usage"
  | "workflow"
  /** The user-owned skills library, rescanned on every subscribe. */
  | "skills";

export const BROADCAST_TOPICS: readonly BroadcastTopic[] = [
  "tasks",
  "projects",
  "subagents",
  "background",
  "worktrees",
  "knowledge",
  "calendar",
  "usage",
  "workflow",
  "skills",
];

/** Cumulative finalized provider usage; live estimates never travel here. */
export interface SubagentUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros?: number;
}

export interface SubagentUsageSnapshot {
  totals: SubagentUsageTotals;
  /** Partial means at least one finalized assistant entry had no usage report. */
  completeness: "partial" | "complete";
}

/**
 * Sum the authoritative durable assistant entries of a normalized session.
 * Streaming estimates and context-window occupancy are intentionally ignored.
 * Cost follows the session store's per-entry USD→micros rounding.
 */
export function subagentUsageSnapshotFromEntries(
  entries: readonly SessionEntry[],
): SubagentUsageSnapshot {
  const totals: SubagentUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let assistantEntries = 0;
  let usageEntries = 0;
  let hasCost = false;
  let costMicros = 0;
  const add = (current: number, value: number | undefined, field: string) => {
    const amount = value ?? 0;
    if (!Number.isFinite(amount) || amount < 0)
      throw new RangeError(`${field} must be a non-negative finite number`);
    const next = current + amount;
    if (!Number.isSafeInteger(next))
      throw new RangeError(`${field} total must be a safe integer`);
    return next;
  };

  for (const entry of entries) {
    if (entry.role !== "assistant") continue;
    assistantEntries += 1;
    if (!entry.usage) continue;
    usageEntries += 1;
    totals.inputTokens = add(
      totals.inputTokens,
      entry.usage.inputTokens,
      "inputTokens",
    );
    totals.outputTokens = add(
      totals.outputTokens,
      entry.usage.outputTokens,
      "outputTokens",
    );
    totals.cacheReadTokens = add(
      totals.cacheReadTokens,
      entry.usage.cacheReadTokens,
      "cacheReadTokens",
    );
    totals.cacheWriteTokens = add(
      totals.cacheWriteTokens,
      entry.usage.cacheCreationTokens,
      "cacheWriteTokens",
    );
    if (entry.usage.costUSD !== undefined) {
      if (!Number.isFinite(entry.usage.costUSD) || entry.usage.costUSD < 0)
        throw new RangeError("costUSD must be a non-negative finite number");
      costMicros = add(
        costMicros,
        Math.round(entry.usage.costUSD * 1_000_000),
        "costMicros",
      );
      hasCost = true;
    }
  }
  if (hasCost) totals.costMicros = costMicros;
  return {
    totals,
    completeness: usageEntries === assistantEntries ? "complete" : "partial",
  };
}

/** Facts whose ownership remains with one immediate parent session. */
export interface DelegationObligationProjection {
  activeRunCount: number;
  /** Accepted terminal envelopes not yet durably admitted to the parent transcript. */
  unadmittedResultCount: number;
  /** Managed worktrees not yet explicitly integrated or discarded. */
  ownedManagedWorktreeCount: number;
}

/**
 * One shared refusal for parent settlement and workflow result completion.
 * Priority keeps the reason singular while reporting the earliest obligation.
 */
export function delegationObligationReason(
  projection: DelegationObligationProjection,
): string | undefined {
  if (projection.activeRunCount > 0)
    return "it still has active delegated work.";
  if (projection.unadmittedResultCount > 0)
    return "a delegated result has not been admitted to its transcript.";
  if (projection.ownedManagedWorktreeCount > 0)
    return "it still owns a managed delegated worktree.";
  return undefined;
}

/** Bounded identity/configuration evidence for a subagent thread. */
export interface SubagentThreadConfigSummary {
  roleName: string;
  baseRole: string;
  provider: string;
  modelId: string;
  credentialProfileId: string;
  executionProfileId: string;
  contractId: string;
  contractVersion: number;
  degradedPinReason?: string;
}

/** Relation pointers only; worktree provenance and other large bodies stay keyed. */
export interface SubagentThreadRelationSummary {
  worktreeId?: string;
  cwd?: string;
  taskId?: number;
  projectId?: string;
  worktreeRelation?: string;
}

/** No assignment/result body or transcript blocks belong in this projection. */
export type SubagentRunStatus =
  | "pending"
  | "running"
  | "awaiting-parent"
  | "submitted"
  | "unreported"
  | "failed"
  | "stopped"
  | "lost";

export type SubagentExecutionPhase =
  | "pending-dispatch"
  | "predecessor-wait"
  | "provider-admitted"
  | "nudge-reserved"
  | "nudge-admitted"
  | "result-accepted"
  | "stop-requested"
  | "safe-idle"
  | "watchdog"
  | "awaiting-parent";

export type SubagentWatchdogState =
  "unused" | "reserved" | "admitted" | "completed";

export interface SubagentRunSummary {
  id: string;
  threadId: string;
  sequence: number;
  initiatedBy: "human" | "agent";
  status: SubagentRunStatus;
  activePhase?: SubagentExecutionPhase;
  executionQuiescent: boolean;
  watchdogState: SubagentWatchdogState;
  actualThinking: string;
  usageDelta: SubagentUsageTotals;
  usageState: "current" | "final";
  usageCompleteness: "partial" | "complete";
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
}

/** Canonical registry row. Closure is inherited state, never a thread field. */
export interface SubagentThreadSummary {
  id: string;
  parentSessionId: string;
  sessionId: string;
  peerConversationId: string;
  config: SubagentThreadConfigSummary;
  relation: SubagentThreadRelationSummary;
  usage: SubagentUsageTotals;
  activeRun?: SubagentRunSummary;
  latestRun?: SubagentRunSummary;
  createdAt: number;
  updatedAt: number;
  activityAt: number;
  inheritedArchivedAt?: number;
  inheritedSettledAt?: number;
}

/** Bounded run-detail snapshot; result and assignment bodies are exact keyed reads. */
export interface SubagentThreadRunDetail {
  thread: SubagentThreadSummary;
  runs: SubagentRunSummary[];
  nextBeforeSequence?: number;
}

/**
 * Which runtime executes one background work item.
 *
 * `claude-query` work runs inside a retained Claude query and is addressed
 * through that vendor's task controls; `host-process` work is supervised by PA
 * itself (a process group or an owned socket). The distinction is a FACT about
 * the item, never a second capability model: every consumer addresses work by
 * its PA id whichever backend runs it.
 */
export type BackgroundWorkBackend = "claude-query" | "host-process";

/** How much of a command line the registry row keeps; the rest is cut. */
export const BACKGROUND_WORK_COMMAND_MAX_CHARS = 4_096;

/** What the item does. Both monitor kinds may outlive the provider turn. */
export type BackgroundWorkKind =
  "shell" | "monitor-command" | "monitor-websocket";

/**
 * Whether the owner WAITS on an item (`awaited`, the default: a build, a test
 * run, a readiness wait) or keeps it running beside its work (`service`: a dev
 * server, a watcher). Declared by the owning agent through `background_tasks`,
 * never inferred from the command. A service shows as running but is never
 * read as work in progress.
 */
export type BackgroundWorkIntent = "awaited" | "service";

/**
 * The item's legal lifecycle. `pending-launch` is reserved-but-not-executing:
 * an owner Stop that wins that race terminalizes as `not-started`, which is why
 * it is distinct from `stopped`. `lost` is what an unclean server restart
 * writes — the app never claims continuity across an OS process boundary.
 */
export type BackgroundWorkState =
  | "pending-launch"
  | "running"
  | "completed"
  | "failed"
  | "not-started"
  | "stopped"
  | "lost";

/**
 * Stop is a REQUEST recorded on a still-nonterminal row, so a stop nobody
 * acknowledged never fabricates a terminal outcome. `awaiting-binding` is a
 * Stop issued after execution began but before the provider handle was
 * authoritatively bound; `unconfirmed` is an attempt that went unanswered and
 * may still be resolved by later evidence or a new explicit attempt.
 */
export type BackgroundWorkStopState =
  "none" | "requested" | "awaiting-binding" | "unconfirmed";

/** The optional Claude retained-query epoch that owns `claude-query` items. */
export type BackgroundHostState =
  "creating" | "live" | "draining" | "closed" | "stopped" | "lost";

/**
 * Identity and size facts about retained output — never the output itself, a
 * host path, or the command that produced it. `refusalReason` is how a capture
 * that was declined (binary, untrusted) stays honest instead of silent.
 */
export interface BackgroundWorkEvidenceSummary {
  artifactId?: string;
  originalBytes?: number;
  capturedBytes?: number;
  truncated?: boolean;
  text?: boolean;
  refusalReason?: string;
}

/** The host epoch as it travels beside an item; never a separate collection. */
export interface BackgroundWorkHostSummary {
  id: string;
  state: BackgroundHostState;
  stopAllRequestedAt?: number;
}

/**
 * The canonical registry row: bounded, provider-neutral, and addressable by PA
 * id alone. Vendor task ids, OS process/group ids, credentials, environment,
 * raw paths and output bodies never appear here.
 */
export interface BackgroundWorkItemSummary {
  id: string;
  ownerSessionId: string;
  backend: BackgroundWorkBackend;
  kind: BackgroundWorkKind;
  /**
   * Bounded human title: the agent's description when it gave one, else the
   * first line of the command. Never a host path or an output body.
   */
  label: string;
  /** The agent's own short description of the job, when it gave one. */
  description?: string;
  /**
   * The command line, bounded to {@link BACKGROUND_WORK_COMMAND_MAX_CHARS}.
   * A human sees it on the card without opening the tool view; the transcript
   * shows the same text in the tool call, so nothing new leaves the server. A
   * WebSocket monitor carries its URL here. Never environment, cwd or output.
   */
  command?: string;
  /** True when `command` was cut at the cap. */
  commandTruncated?: boolean;
  state: BackgroundWorkState;
  /** `service` when the owner declared it one; omitted for `awaited`. */
  intent?: BackgroundWorkIntent;
  stopState: BackgroundWorkStopState;
  stopReason?: string;
  stopAttempts?: number;
  /** The retained Claude host epoch, when this item has one. */
  host?: BackgroundWorkHostSummary;
  /** True once a provider handle was authoritatively bound; the id stays internal. */
  providerBound?: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  terminalAt?: number;
  /** Frozen at admission from the settings generation below; never re-read. */
  deadlineAt: number;
  settingsGeneration: number;
  terminalReason?: string;
  exitCode?: number;
  outcomeSummary?: string;
  evidence?: BackgroundWorkEvidenceSummary;
}

/**
 * Background work owned by one session, independent of its provider turn.
 * A session with active background work is NOT streaming: `isStreaming`,
 * `runStartedAt`, unread and `SessionSnapshot.runState` are untouched by it.
 */
export interface SessionBackgroundActivity {
  /** Every nonterminal item this session owns. */
  activeCount: number;
  /**
   * How many of them the owner declared a `service` (dev server, watcher):
   * running, but nothing anyone waits on. Omitted when none.
   */
  serviceCount?: number;
  shellCount: number;
  monitorCommandCount: number;
  monitorWebsocketCount: number;
  /** Items reserved but not yet executing. */
  startingCount: number;
  /** Nonterminal items with an outstanding Stop request. */
  stoppingCount: number;
  /** Earliest start (or reservation, when not started) among active items. */
  oldestStartedAt: number;
  /** True while a retained Claude host epoch is live for this owner. */
  retainedHost?: boolean;
}

/**
 * The background items the owner WAITS on: every active one it did not
 * declare a `service`. What "jobs" counts wherever a fold says how much is
 * still going.
 */
export function awaitedBackgroundCount(
  activity: SessionBackgroundActivity | undefined,
): number {
  if (!activity) return 0;
  return Math.max(0, activity.activeCount - (activity.serviceCount ?? 0));
}

/**
 * Whether background work keeps a session BUSY: an item it waits on, or a
 * retained host with no items left, inside its quiet grace. A host kept alive
 * only by services is not busy — a dev server is no reason to keep waiting.
 */
export function backgroundWorkBusy(
  activity: SessionBackgroundActivity | undefined,
): boolean {
  if (!activity) return false;
  return (
    awaitedBackgroundCount(activity) > 0 ||
    (activity.activeCount <= 0 && Boolean(activity.retainedHost))
  );
}

/**
 * One refusal shared by settlement and destructive deletion, so neither can
 * claim the session is idle while work it owns is still executing. Phrased as a
 * sentence fragment, like {@link settleBlockedReason}'s other reasons.
 *
 * A retained host with no children left still blocks: the epoch outlives its
 * last task by design (it closes after its quiet grace), so "no active items"
 * is not the same as "nothing running", and letting the session settle or be
 * deleted in that window would orphan a live provider query.
 */
export function backgroundWorkBlockedReason(
  activity: SessionBackgroundActivity | undefined,
): string | undefined {
  if (!activity) return undefined;
  if (activity.activeCount <= 0)
    return activity.retainedHost
      ? "it still holds a retained background host."
      : undefined;
  return activity.activeCount === 1
    ? "it still has 1 background process running."
    : `it still has ${activity.activeCount} background processes running.`;
}

/**
 * What the supervisor answered for ONE item a human asked to Stop. It is
 * control feedback, not lifecycle state: the row's authoritative state arrives
 * as a `background` event, and nothing here may be rendered as a terminal row.
 * `unknown` is an id the registry does not hold — the human is not scoped to an
 * owner session, so there is no "not yours" answer to give.
 */
export type BackgroundWorkStopOutcome =
  | "stopped"
  | "already-terminal"
  | "awaiting-binding"
  | "stop-unconfirmed"
  | "unknown";

/**
 * The answer to a human `stopBackgroundWork`/`stopAllBackgroundWork`. It exists
 * to retire the browser's PENDING control state and to explain a wait; every
 * row fact still arrives through the registry's state events.
 */
export interface BackgroundWorkStopAnswer {
  requestId: string;
  /** Set for a Stop-all, so the browser can retire that owner's pending control. */
  ownerSessionId?: string;
  items: { itemId: string; outcome: BackgroundWorkStopOutcome }[];
  /**
   * A retained Claude host epoch that Stop-all reserved but could not close.
   * `protectedTurn` means an ordinary prompted turn is still inside its safe
   * boundary: the close waits for it rather than interrupting the user's own
   * turn, so the UI shows the wait instead of claiming the host closed.
   */
  hostCloseWaiting?: { protectedTurn: boolean };
}

/**
 * The user-editable governance for session-owned background work (the
 * "Background processes" settings card, [Task-467](pa://task/467)).
 *
 * Every value here is read ONCE, at admission, and frozen onto the admitted row
 * (`BackgroundWorkItemSummary.deadlineAt`/`settingsGeneration`). Changing a
 * value therefore governs LATER admissions only: nothing already running is
 * killed, evicted, re-deadlined or re-shaped by an edit.
 */
export interface BackgroundWorkSettings {
  /** Master switch. Off denies every new admission; running work is untouched. */
  enabled: boolean;
  /**
   * How many sessions may OWN background work at once. One slot is shared by
   * all of that session's children, so this is a cap on OWNERS, never on the
   * number of background items one session may start.
   */
  ownerSessionCap: number;
  /** Lifetime frozen onto each admitted item, from which its deadline is derived. */
  taskLifetimeMinutes: number;
  /** How long a retained Claude host epoch stays open with no children left. */
  claudeEmptyHostGraceSeconds: number;
}

/** The shipped defaults for {@link BackgroundWorkSettings}. */
export const DEFAULT_BACKGROUND_WORK_SETTINGS: BackgroundWorkSettings = {
  enabled: true,
  ownerSessionCap: 7,
  taskLifetimeMinutes: 60,
  claudeEmptyHostGraceSeconds: 30,
};

/**
 * The accepted range of each numeric field, shared so the settings UI offers
 * exactly what {@link normalizeBackgroundWorkSettings} accepts.
 */
export const BACKGROUND_WORK_SETTINGS_RANGES = {
  ownerSessionCap: { min: 1, max: 20 },
  taskLifetimeMinutes: { min: 5, max: 1440 },
  claudeEmptyHostGraceSeconds: { min: 0, max: 300 },
} as const;

/**
 * Normalize a stored or client-supplied card to a usable one. A value outside
 * its range is CLAMPED to the nearest bound and anything non-numeric falls back
 * to the default, so a hand-edited settings file or an older client can never
 * produce an unbounded lifetime or a zero-capacity deadlock.
 */
export function normalizeBackgroundWorkSettings(
  settings: Partial<BackgroundWorkSettings> | undefined,
): BackgroundWorkSettings {
  const range = BACKGROUND_WORK_SETTINGS_RANGES;
  return {
    enabled:
      typeof settings?.enabled === "boolean"
        ? settings.enabled
        : DEFAULT_BACKGROUND_WORK_SETTINGS.enabled,
    ownerSessionCap: clampInt(
      settings?.ownerSessionCap,
      range.ownerSessionCap.min,
      range.ownerSessionCap.max,
      DEFAULT_BACKGROUND_WORK_SETTINGS.ownerSessionCap,
    ),
    taskLifetimeMinutes: clampInt(
      settings?.taskLifetimeMinutes,
      range.taskLifetimeMinutes.min,
      range.taskLifetimeMinutes.max,
      DEFAULT_BACKGROUND_WORK_SETTINGS.taskLifetimeMinutes,
    ),
    claudeEmptyHostGraceSeconds: clampInt(
      settings?.claudeEmptyHostGraceSeconds,
      range.claudeEmptyHostGraceSeconds.min,
      range.claudeEmptyHostGraceSeconds.max,
      DEFAULT_BACKGROUND_WORK_SETTINGS.claudeEmptyHostGraceSeconds,
    ),
  };
}

export type ResultDeliveryState =
  | "pending"
  | "delivered"
  | "processing"
  | "processed"
  | "replied"
  | "interrupted"
  | "failed"
  | "unavailable";

/** Why automatic parent processing was suppressed, rather than silently skipped. */
export type ResultDeliverySuppressionReason = "hop-limit";

/**
 * Shared contract for the terminal-delivery projection. Task-475's delivery
 * service produces this from peer admission/processing records; the registry
 * slice only transports bounded run state and does not invent a second source.
 */
export interface ResultDeliveryProjection {
  state: ResultDeliveryState;
  automaticProcessingSuppressionReason?: ResultDeliverySuppressionReason;
}

/** One revision-ordered membership change in a domain's canonical live projection. */
export type StateEvent<Item> =
  | {
      kind: "upsert";
      id: string;
      revision: number;
      item: Item;
    }
  | {
      kind: "delete";
      id: string;
      revision: number;
      item?: never;
    };

/**
 * One atomic, revision-ordered domain batch. `seq` identifies the flush, while
 * each object's revision decides whether its event applies. Revisions live here
 * rather than on `item` so an authoritative echo can reuse an optimistic row.
 */
export interface StateEventsMessage<
  Topic extends BroadcastTopic = BroadcastTopic,
  Item = unknown,
> {
  type: "stateEvents";
  topic: Topic;
  seq: number;
  events: StateEvent<Item>[];
}

/** One row in a domain's compact live-projection revision digest. */
export interface StateDigestEntry {
  id: string;
  revision: number;
}

/** Authoritative resubscribe baseline, diffed against cached objects client-side. */
export interface StateDigestMessage<
  Topic extends BroadcastTopic = BroadcastTopic,
> {
  type: "stateDigest";
  topic: Topic;
  seq: number;
  entries: StateDigestEntry[];
}

/** Targeted authoritative rows requested after a digest diff. */
export interface StateItemsMessage<
  Topic extends BroadcastTopic = BroadcastTopic,
  Item = unknown,
> {
  type: "stateItems";
  topic: Topic;
  requestId: string;
  events: StateEvent<Item>[];
}

/** Cold-start/resync answer for one commentable object. */
export interface CommentsSnapshotMessage {
  type: "commentsSnapshot";
  target: CommentTarget;
  threads: CommentThread[];
  /** Present only for worktree targets. */
  reviewSets?: import("./comments.ts").WorktreeReviewSet[];
  reviewSetRevisions?: StateDigestEntry[];
  revisions: StateDigestEntry[];
  requestId?: string;
  error?: string;
}

/** Revisioned changes for touched threads/sets only; never a whole collection. */
export interface CommentEventsMessage {
  type: "commentEvents";
  target: CommentTarget;
  seq: number;
  events: StateEvent<CommentThread>[];
  /** Revisioned worktree review-set changes; absent for other targets. */
  reviewSetEvents?: StateEvent<import("./comments.ts").WorktreeReviewSet>[];
}

/* ------------------------- workflow run start (wire) ------------------------ */

/**
 * One agent role's session runtime for a Workflow Run, captured by the start
 * sheet and immutable for the run's lifetime. This is a RECIPE-owned shape (the
 * code-delivery recipe's roles), which is why it lives here on the wire and not
 * in the deliberately generic `workflow.ts` core model.
 */
export interface WorkflowRoleConfig extends CredentialProfilePin {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** Optional extra instructions appended to the role's assignment prompt. */
  promptOverride?: string;
}

/** One model candidate the coordinator may choose for a code-delivery role. */
export interface WorkflowRoleCandidate extends WorkflowRoleConfig {
  /** Operator-supplied model family used as selection evidence, never enforcement. */
  family: string;
  /** Short operator evidence rendered into the coordinator's assignment. */
  notes?: string;
}

export type WorkflowCandidateRole =
  "implementer" | "reviewer" | "fixer" | "verdict";

export type WorkflowRoleCandidateSets = Record<
  WorkflowCandidateRole,
  WorkflowRoleCandidate[]
>;

/**
 * The code-delivery recipe's start configuration: constrained coordinator
 * runtime, its authorized per-role model sets, and role prompt overrides.
 * Stored opaquely on the run (`WorkflowRunSummary.config`) so the agent executor
 * can rebuild every role's session after any restart.
 */
export interface CodeDeliveryWorkflowConfig {
  /** Cheap, tool-constrained runtime that judges Task context and evidence. */
  coordinator: WorkflowRoleConfig;
  /** Exact configurations the coordinator may choose within each work role. */
  roles: WorkflowRoleCandidateSets;
  /** Push exact review heads and create the run's draft PR before review. */
  earlyPush?: boolean;
  /** Maximum time to wait for checks after each early push. */
  ciTimeoutMs?: number;
  /** Delay between provider polls while checks are absent or pending. */
  ciPollIntervalMs?: number;
  /** Role-specific instructions applied after the coordinator chooses one. */
  implementerPromptOverride?: string;
  reviewerPromptOverride?: string;
}

export const WORKFLOW_CI_DEFAULTS = {
  enabled: true,
  timeoutMs: 10 * 60_000,
  pollIntervalMs: 5_000,
} as const;

export const WORKFLOW_CI_BOUNDS = {
  timeoutMs: { min: 30_000, max: 30 * 60_000 },
  pollIntervalMs: { min: 1_000, max: 60_000 },
} as const;

/** Per-role prompt-inflation guardrails for candidate sets. */
export const WORKFLOW_ROLE_SET_BOUNDS = {
  implementer: { min: 1, max: 6 },
  reviewer: { min: 1, max: 6 },
  fixer: { min: 0, max: 6 },
  verdict: { min: 0, max: 6 },
} as const;

export const WORKFLOW_ROLE_FAMILY_MAX_CHARS = 40;
export const WORKFLOW_ROLE_NOTES_MAX_CHARS = 240;

/** The code-delivery recipe phase shown on a Workflow Run card. */
export type WorkflowRunPhase =
  | "starting"
  | "plan"
  | "implement"
  | "commit-sync"
  | "commit"
  | "base-sync"
  | "ci"
  | "review"
  | "review-decision"
  | "ceiling-decision"
  | "delivery"
  | "observe"
  | "merge";

/** A coordinator-selected role config safe to show on a run card. */
export type WorkflowRunCardRoleConfig = Pick<
  WorkflowRoleCandidate,
  "provider" | "modelId" | "thinkingLevel" | "family" | "notes"
>;

/**
 * What the run's live `/pr` card says about DELIVERY, joined onto the Workflow
 * card so the Task can merge the pull request and retire the checkout without
 * being sent to the card's session first.
 *
 * Deliberately narrow: whether each of the two controls is offered, what the
 * merge needs to be offered honestly (the methods the repository allows), and
 * what the last attempt came to. CI, hosted review and mergeability stay off
 * it — the run reaches its merge seam only once they are known good, so
 * restating them here would be a second, staler copy of the live card's job.
 *
 * `canMerge` and `canCleanUp` are the SERVER's answer, not a rule a renderer
 * re-derives: the same conditions guard the messages that act on them, so a
 * button this projection does not offer is one the server would refuse.
 */
export interface WorkflowRunDelivery {
  /** The run is at its merge seam and the card may be merged from the Task. */
  canMerge: boolean;
  /** The run is finished and its checkout may be retired from the Task. */
  canCleanUp: boolean;
  /**
   * Merge methods the repository currently allows, in the shared vocabulary's
   * order. Absent = not read yet; an EMPTY array is a real answer, and the
   * merge control then says so rather than offering a method the provider
   * would refuse.
   */
  mergeMethods?: PullRequestMergeMethod[];
  /** Provider/project default, when the repository metadata defines one. */
  defaultMergeMethod?: PullRequestMergeMethod;
  /** The card is already running an action — here, or on another surface. */
  busyAction?: PullRequestCardAction;
  /** The checkout was already retired, here or from the live card. */
  cleanedUp?: boolean;
  /**
   * The checkout is gone but the run is STILL an unacknowledged inbox item —
   * a cleanup whose settlement was refused, or one run from a surface that
   * does not settle (the live card, or one of the run's own role sessions).
   *
   * Derived live from the run's attention cursor on every projection, never
   * stored: the condition stops being true the moment the run is settled, and
   * a remembered sentence about it would outlive the state it describes and go
   * on telling the user to do something already done. The REASON the Settle is
   * refused is not copied here either — the inbox item carries it live, in the
   * one shared wording, on the Settle it disables.
   */
  settleStillNeeded: boolean;
  /** Why the last action on the card failed; the card is the failure's home. */
  error?: string;
}

/** Recipe-owned projection for inspecting or steering one code-delivery run. */
export interface WorkflowRunCard {
  runId: string;
  phase: WorkflowRunPhase;
  /** The open step's state, absent when nothing is open. */
  activity?: "running" | "waiting";
  coordinatorSessionId?: string;
  implementerSessionId?: string;
  fixerSessionId?: string;
  verdictSessionId?: string;
  /**
   * The newest reviewer session of each review pass, ascending. Each pass is
   * its own session, so one id would hide every earlier pass's review.
   */
  reviewerSessions?: { pass: number; sessionId: string }[];
  /** The accepted deterministic plan produced by the coordinator. */
  workPlan?: {
    complexity: "low" | "medium" | "high";
    implementer: WorkflowRunCardRoleConfig;
    /** The FIRST discovery reviewer; later passes are decided as they come. */
    reviewer: WorkflowRunCardRoleConfig;
    rationale: string;
  };
  /**
   * The coordinator's newest post-assessment decision THE RUN CARRIED OUT:
   * whether it delivered, took another review pass, or routed a fix round, and
   * to which runtime. The card is the only surface where that judgement — and
   * what it asked the next agent to do — reaches the user outside the
   * coordinator's own transcript, and a choice the run's bounds refused is
   * never shown as one it made.
   */
  reviewDecision?: {
    decision: "deliver" | "review-again" | "fix";
    /** The pass the decision was taken after. */
    afterPass: number;
    rationale: string;
    /**
     * What the step the decision routed to was asked to concentrate on — the
     * next review pass, or the fix round.
     */
    focus?: string[];
    /** The reviewer runtime the next pass runs on, when the decision named one. */
    reviewer?: WorkflowRunCardRoleConfig;
    /** Who answers the findings, when the decision routed a fix round. */
    assignee?: "fixer" | "implementer";
    /** The fixer runtime that round runs on, when one was named. */
    fixer?: WorkflowRunCardRoleConfig;
    /** The runtime judging the delivered head, when delivery named one. */
    verdict?: WorkflowRunCardRoleConfig;
    /**
     * Either the rationale or the focus list was cut for this list broadcast;
     * the coordinator's session holds the complete decision.
     */
    truncated?: boolean;
  };
  /** Loop iterations consumed (the limit remains on the run summary). */
  iterationsUsed: number;
  /**
   * The newest valid assessment recorded by a review step, INCLUDING what the
   * reviewer said: the card is the only place that evidence surfaces outside
   * the reviewer's own transcript.
   */
  latestAssessment?: {
    verdict: "pass" | "revise" | "fail";
    headCommit: string;
    stale: boolean;
    /** The reviewer's bounded prose summary of the assessment. */
    summary?: string;
    /** Actionable findings; empty for a `pass`, which may not carry any. */
    findings: ReviewFinding[];
    /** Remarks the reviewer explicitly did not want acted on now. */
    observations?: string[];
    /**
     * Either list was cut to keep this list broadcast small — the reviewer's
     * session holds the complete assessment.
     */
    truncated?: boolean;
  };
  /**
   * The newest durable worktree review set that published findings, with the
   * newest fix round's per-finding outcome. Sets carrying no findings (an
   * accepting review, a passing verdict) never take this over, so a finished
   * run still shows what its answered findings came to. Counts are what a
   * completed fix round RECORDED, not a live rollup: the card is projected from
   * step rows, and the worktree's own review surface is where the current state
   * of each thread lives.
   */
  reviewSet?: {
    id: string;
    /** Findings published as anchored threads in this set. */
    findingCount: number;
    resolvedCount: number;
    /** Answered on the thread and deliberately left open. */
    disputedCount: number;
    openCount: number;
  };
  /**
   * Durable identity of the existing live `/pr` card. The Workflow card links
   * to it and the provider; it does not duplicate the card's mutable CI/review
   * state — `delivery` is the ONE exception, and it carries only what the two
   * delivery controls on the Task need (see {@link WorkflowRunDelivery}).
   */
  pullRequest?: {
    cardId: string;
    sessionId: string;
    number: number;
    url: string;
    /**
     * Joined onto the run when the card exists. Absent means the server could
     * not read it, and the Task then offers no delivery control rather than one
     * whose refusal it cannot predict.
     */
    delivery?: WorkflowRunDelivery;
  };
  /**
   * The next automatic action, or the decision required from the user. A
   * PAUSED run makes no move, so this states why it stopped instead — the
   * recipe's pause reason where it has one, otherwise the run's persisted
   * one — and never announces a step the run will not take.
   */
  nextAction: string;
  /** The exact-head PR observation reached the merge-decision seam. */
  mergeDecisionReady: boolean;
  /**
   * The user asked for this run to end and the settlement has not finished —
   * a host operation may hold the run's chain for as long as its own deadline.
   * The card says so and offers no control that contradicts it: Resume is
   * refused while this stands, so it must not be shown.
   */
  cancelRequested?: boolean;
  /**
   * The open gate an exhausted ceiling reached, when the run is waiting at one:
   * what it wanted to do, what it has spent, and whether "deliver as it stands"
   * would ship a head no discovery review passed.
   */
  ceilingDecision?: {
    blocked: "review-passes" | "iterations";
    wanted: string;
    /**
     * What this gate may be answered with. `deliver` needs a head to ship;
     * without one the user gets `re-evaluate` instead — fix the workspace
     * yourself and have the run look again — so a ceiling at its bound never
     * leaves cancel as the only exit: a gate with neither a head to ship nor a
     * delivery gate behind it to re-read still offers `["raise", "cancel"]`,
     * and a raise at the gate has no maximum — the start-form bounds guard a
     * typo, not this explicit decision. Cancelling still preserves the
     * worktree, branch, sessions and any pull request.
     */
    allowedChoices: ("raise" | "deliver" | "re-evaluate" | "cancel")[];
    ceilings: { maxIterations: number; maxReviewPasses: number };
    spent: { iterations: number; reviewPasses: number; sessions: number };
    headCarriesDiscoveryReview: boolean;
    /**
     * How much more this run's own history suggests granting, for the blocked
     * limit ([Task-592](pa://task/592)). A STARTING POINT for the control, not
     * a recommendation the user owes an answer to: every amount the gate would
     * accept is still offered, and the decision is unchanged.
     *
     * It exists because the control started at one every time, and a run that
     * needs more than it was given asks again for each increment. Run 111
     * blocked five separate times over nine hours, and every raise was granted
     * — five decisions that were one decision.
     */
    suggestedRaise: number;
  };
  /** A base conflict may be routed through user-authorized rebase + review. */
  canRebaseAndReview: boolean;
  /** Whether the failed or blocked tail can be retried semantically. */
  canRetry: boolean;
  /**
   * Whether Resume would actually MOVE this run — the recipe has a next step
   * for the current history, and no gate of its own is waiting to be answered.
   *
   * A paused run is not automatically resumable. Some pauses are the recipe's
   * settled conclusion about a history that cannot change by itself: a `fail`
   * verdict, or a stopped tail whose way on is Retry. Resuming those re-derives
   * the identical pause instantly, so offering Resume there is a control that
   * cannot complete — the one thing this card must never render.
   */
  canResume: boolean;
  /**
   * Why a paused run stopped, in the stopped step's OWN words. `nextAction`
   * only names the step and its status, which says nothing a user can act on;
   * this carries the failed or blocked tail's result summary beside it. The
   * summary is bounded for this list broadcast — a cut one ends in an ellipsis
   * and the step's session holds the complete text.
   */
  blockedReason?: {
    /** The stopped step's phase, absent when it carries none. */
    phase?: Exclude<WorkflowRunPhase, "starting">;
    status: "failed" | "blocked";
    summary: string;
    /** Safe, restored rebase conflict with a manual resolve-then-Retry path. */
    rebaseConflict?: {
      files: string[];
      baseBranch: string;
      /** Host-verified abort/reset restored the clean pre-repair branch. */
      restored: boolean;
      truncated?: boolean;
    };
    /**
     * The run already spent its one automatic triage of this failure: an agent
     * read the operation's error and could not clear it, so the summary beside
     * this is the agent's diagnosis rather than the operation's error. Present
     * when the run is stopped on the triage itself or on the re-issued
     * operation that the triage handed back.
     */
    operationTriage?: {
      /** The phase of the host operation the triage was assigned to. */
      phase: Exclude<WorkflowRunPhase, "starting">;
      /**
       * Whether the run stopped ON the triage — so the summary beside this is
       * an agent's diagnosis — or on the operation the triage handed back,
       * which then failed again on its own terms.
       */
      stoppedOn: "triage" | "operation";
      /** Host-verified: the triage left the run branch exactly as it found it. */
      restored: boolean;
    };
  };
  /**
   * How many attempts in a row ended with the paused tail's exact outcome —
   * same step kind, phase, status and summary — present only from the second
   * one on. A semantic retry re-runs the same assignment, so a deterministic
   * step reproduces its predecessor's result within a second and the pause
   * banner then differs by a step number alone: without this the retry is
   * indistinguishable from a button that did nothing. It is also the whole
   * chain collapsed to one number, so a run does not have to show N identical
   * steps for the repetition to be readable.
   */
  repeatedAttempts?: number;
}

/**
 * A prompt override is the user's own instruction text: over the bound it is
 * REJECTED with a readable error rather than silently truncated, because a
 * truncated instruction is a different instruction.
 */
export const WORKFLOW_PROMPT_OVERRIDE_MAX_CHARS = 4_000;

/**
 * Where a `startWorkflowRun` request currently stands. `started` and `failed`
 * are terminal; everything before them narrates worktree provisioning (the
 * submodule clone can take minutes, so the sheet must be able to say so).
 */
export type WorkflowRunStartPhase =
  "naming" | "creating" | "submodules" | "started" | "failed";

/**
 * The mutating commands an optimistic client correlates by `requestId`.
 *
 * The client applies the change locally before the server answers, then records
 * the touched object ids (and a create's local temp id) until that command
 * settles. Correlation must be explicit: these domains also receive UNSOLICITED
 * authoritative broadcasts (an agent editing a Task, another tab saving a
 * project), and a client must recover a rejection by reading those objects
 * authoritatively rather than restoring a pre-change snapshot over a concurrent
 * write. The server answers a `requestId`-carrying command with either an
 * `error` carrying that id or a `mutationSettled`.
 */
export const MUTATION_REQUEST_ID_COMMANDS = [
  "saveTask",
  "assignTaskProjects",
  "archiveTask",
  "deleteTask",
  "reorderTasks",
  "saveProject",
  "updateSettings",
  "renameSession",
  "deleteSession",
  "archiveSession",
  "removeWorktree",
  "pullRequestCardAction",
] as const;

/** The commands that edit a session's prompt queue. */
export type PromptQueueCommand = Extract<
  ClientMessage,
  {
    type:
      | "queuePrompt"
      | "updateQueuedPrompt"
      | "removeQueuedPrompt"
      | "moveQueuedPrompt"
      | "clearPromptQueue"
      | "sendQueuedPromptNow"
      | "resumePromptQueue";
  }
>;

export type ClientMessage =
  | {
      type: "prompt";
      text: string;
      attachments?: PromptAttachment[];
      attachTaskId?: string;
      projectId?: string;
      knowledgeEntryId?: string;
      clientRequestId?: string;
    }
  | { type: "runSlashCommand"; name: string; rawArgs: string }
  /**
   * Queue a message behind the running turn of `sessionId`. `command` marks a
   * host slash command, run when its turn comes; `text` then keeps its `/`.
   */
  | {
      type: "queuePrompt";
      sessionId: string;
      text: string;
      attachments?: PromptAttachment[];
      command?: { name: string; rawArgs: string };
    }
  /** Replace a queued message's text (it went back into the composer to edit). */
  | { type: "updateQueuedPrompt"; sessionId: string; id: string; text: string }
  | { type: "removeQueuedPrompt"; sessionId: string; id: string }
  /** Move one queued message to `toIndex` in send order. */
  | {
      type: "moveQueuedPrompt";
      sessionId: string;
      id: string;
      toIndex: number;
    }
  | { type: "clearPromptQueue"; sessionId: string }
  /**
   * Send one queued message NOW: as a steer into a running turn that takes
   * one, else as the next turn of an idle session (which also resumes it).
   */
  | { type: "sendQueuedPromptNow"; sessionId: string; id: string }
  /** Lift a pause and send the next message if the session is idle. */
  | { type: "resumePromptQueue"; sessionId: string }
  | { type: "acceptCommitDryRun"; entryId: string }
  /**
   * Approve or reject a pending card. `edits` are the user's per-row changes to
   * an editable body (today only `sessionSpawn`); they are applied as part of
   * the approval, and ignored on reject. `forSession` also grants the card's
   * operations for the rest of its session (`approvalGrants.ts`).
   */
  | {
      type: "resolveApproval";
      approvalId: string;
      decision: ApprovalDecision;
      edits?: ApprovalResolutionEdits;
      forSession?: boolean;
    }
  /** Withdraw one session approval grant; later cards wait for a click again. */
  | { type: "revokeApprovalGrant"; sessionId: string; key: string }
  /**
   * Answer a `choosing-task` pull-request card's Task-disambiguation prompt.
   * `taskId: null` means "none of these" (an agent-written title, no linked Task).
   */
  | {
      type: "resolvePullRequestCardTask";
      cardId: string;
      taskId: string | null;
    }
  /**
   * Run one of a live pull-request card's actions. `mergeMethod` is required
   * for `merge` and ignored otherwise — the method is a per-merge decision, so
   * it travels with the click rather than with the card, and so does
   * `deleteBranch` (omitted or true = delete the remote branch, false = keep
   * it).
   */
  | {
      type: "pullRequestCardAction";
      cardId: string;
      action: PullRequestCardAction;
      mergeMethod?: PullRequestMergeMethod;
      deleteBranch?: boolean;
      /** Correlates this modelled mutation with its settle/error outcome. */
      requestId?: string;
    }
  | { type: "respondToQuestion"; response: AgentQuestionResponse }
  | { type: "abort" }
  /** Load the full body for a lazily-projected snapshot block after user expansion. */
  | {
      type: "loadTimelineBlock";
      entryId: string;
      blockIndex: number;
      kind: import("./session/index.ts").LazyBlockKind;
    }
  /**
   * The COMPLETE set of in-flight bodies this viewer is rendering (expanded and
   * near its viewport), replacing the previous set. Newly listed bodies are
   * answered with a `liveBody` snapshot then deltas; bodies no longer listed
   * stop receiving text (their compact lifecycle keeps flowing). Scoped to the
   * viewed session; a set for any other session is ignored.
   */
  | {
      type: "setLiveBodySubscriptions";
      sessionId: string;
      bodies: import("./session/index.ts").LiveBodyKey[];
    }
  /**
   * Load the entries immediately BEFORE `beforeSeq` (the transcript's current
   * first entry) for a windowed transcript, when the reader has exhausted the
   * rows the snapshot carried.
   */
  | {
      type: "loadTimelineRange";
      sessionId: string;
      beforeSeq: number;
      limit?: number;
    }
  | { type: "setModel"; provider: string; id: string }
  | { type: "setThinkingLevel"; level: ThinkingLevel }
  /**
   * Switch the viewed session between Build and Plan. Unlike model/thinking this
   * is accepted at ANY point in a session's life: it is the tool policy the next
   * turn is built with. Harnesses without a mode axis refuse it.
   */
  | { type: "setSessionMode"; mode: SessionMode }
  /**
   * Reload model registry/auth state from disk, force a provider catalog fetch
   * and send the current available list. The `models` reply echoes `requestId`
   * and ALWAYS arrives, refreshed or failed: it is what retires the button's
   * busy state, and an unanswered click would leave a spinner forever.
   */
  | { type: "refreshModels"; requestId: string }
  /**
   * Create a fresh pi session of the given {@link AgentType} (the bootstrap
   * landing). Claude harnesses are NOT created here — they use `harnessSend` on
   * the first prompt. `harness` is advisory routing metadata;
   * `model`/`thinkingLevel`/`mode` seed the fresh pi session.
   */
  | {
      type: "newSession";
      agentType: AgentType;
      harness?: Harness;
      model?: { provider: string; id: string };
      thinkingLevel?: ThinkingLevel;
      mode?: SessionMode;
      worktreeId?: string;
    }
  /** Load (view) a session addressed by OUR session id; the server resolves it via `hub.acquireById(id)`. */
  | { type: "loadSession"; id: string; timelineCache?: TimelineCacheDescriptor }
  | { type: "openPermanentAssistant" }
  /** Load archived session rows on demand, when the archived sidebar section is expanded. */
  | { type: "loadArchivedSessions" }
  /** Resolve compact metadata for generic pa:// object links. */
  | { type: "resolveObjectLinks"; requestId: string; uris: string[] }
  | { type: "deleteSession"; id: string; requestId?: string }
  /** Hide a session from the default list (reversible). `archived=false` restores it. */
  | {
      type: "archiveSession";
      id: string;
      archived?: boolean;
      requestId?: string;
    }
  /**
   * Move a session out of (or back into) the Sessions inbox working set.
   * The server refuses to settle running, queued, approval- or
   * question-blocked work; `settled=false` always succeeds.
   *
   * Settling also settles the peers the session still coordinates
   * ({@link spawnClusterDescendantIds}), server-side and through their
   * current outcome revisions, in the same mutation — the coordinator is the
   * attention owner, its peers are evidence — and a peer the shared predicate
   * blocks refuses the whole command in that peer's wording. Unsettling
   * touches the one session.
   *
   * `throughRevision` is the {@link SessionOutcomeAttention} revision the
   * clicked row carried (0 when it carried none). It bounds what this Settle
   * may acknowledge, so a click on a stale row cannot hide an outcome that
   * arrived after it was rendered.
   *
   * REQUIRED, deliberately: acknowledging "whatever the server holds now" is a
   * privilege only a server-side settlement may take, and an optional field
   * would hand that privilege to any client that simply omits it.
   */
  | {
      type: "settleSession";
      id: string;
      settled?: boolean;
      throughRevision: number;
      requestId?: string;
    }
  /**
   * Acknowledge a formal Workflow Run's latest event and take it out of the
   * Sessions inbox working set ([Task-677](pa://task/677)). The server refuses
   * a run whose current gate is an unresolved user decision
   * ({@link workflowRunSettleBlockedReason}); otherwise it raises the run's
   * `settledRevision` AND settles the role sessions the run's card projection
   * names, through their current outcome revisions, in the same mutation —
   * the run is the attention owner, its roles are evidence.
   *
   * `throughRevision` is the {@link WorkflowRunAttention} revision the clicked
   * item carried (0 when it carried none), REQUIRED for the same reason as on
   * `settleSession`: a click on a stale item must not acknowledge an outcome
   * that arrived after it was rendered.
   */
  | {
      type: "settleWorkflowRun";
      runId: string;
      throughRevision: number;
      requestId?: string;
    }
  | { type: "renameSession"; id: string; title: string; requestId?: string }
  /**
   * Take a spawned peer session over (`taken-over`), or hand it back to the
   * coordinator that spawned it (`coordinator`) — the user's EXPLICIT word on
   * {@link SpawnOwnership}; messaging a peer never moves it. Refused for a
   * session with no spawn edge. Taking over revokes the coordinator's
   * `session_control` over the peer and stands it apart from the
   * coordinator's inbox fold; handing back restores both.
   */
  | {
      type: "setSpawnOwnership";
      id: string;
      ownership: SettableSpawnOwnership;
      requestId?: string;
    }
  /**
   * Acknowledge that this session's worktree is gone and it may run in the app
   * working directory anyway. Clears `worktreeMissing` for exactly the worktree
   * the edge points at now: a session later relinked to another worktree that
   * also disappears asks again.
   */
  | { type: "acknowledgeMissingWorktree"; id: string }
  /**
   * Calendar: ensure the per-day assistant session exists, view it, and either
   * run the day scan (`scan`) or send an initial `text`. When the session is
   * created, `modelProvider`/`modelId`/`thinkingLevel` override the configured
   * Calendar-day model (used by the pre-session composer's model picker).
   */
  | {
      type: "calendarDayActivate";
      date: string;
      scan?: boolean;
      logTime?: boolean;
      text?: string;
      modelProvider?: string;
      modelId?: string;
      thinkingLevel?: ThinkingLevel;
    }
  /**
   * Branch a session at one transcript entry. `entryId` is always OUR log entry
   * id — the only id a client holds — which the server translates into the
   * harness's own native anchor; `position` picks the side ("at" keeps the
   * chosen assistant turn, "before" stops short of the chosen prompt and returns
   * its text to prefill the composer).
   */
  | {
      type: "forkSession";
      id: string;
      entryId: string;
      position: "before" | "at";
    }
  /** Create a fresh pi session of the given agent type and pre-fill the composer with an editable draft without submitting it. */
  | {
      type: "createDraftSession";
      agentType: AgentType;
      draftText: string;
      notice?: string;
    }
  | { type: "listSessions" }
  /** Bounded memory list/search for the management UI. */
  | { type: "memoryList"; requestId: string; filter?: MemoryListFilter }
  /** One memory card plus its supersession lineage. */
  | { type: "memoryGet"; requestId: string; id: string }
  /** Validated memory mutation (edit/correct/pin/unpin/archive/restore). */
  | {
      type: "memoryMutate";
      requestId: string;
      operation: MemoryMutateOperation;
    }
  /** Recent per-session effective-load audit batches for the inspector. */
  | {
      type: "memoryLoads";
      requestId: string;
      sessionId: string;
      limit?: number;
    }
  /** Actionable memory processor configuration status (Task 100). */
  | { type: "memoryStatus"; requestId: string }
  /** Expand the current session's bounded Peer prompts history beyond its default snapshot size. */
  | { type: "requestPeerPromptHistory"; limit?: number }
  /** Where a message the reader asked to jump to lives; see {@link TimelineAnchorTarget}. */
  | {
      type: "resolveTimelineAnchor";
      requestId: string;
      target: TimelineAnchorTarget;
    }
  /** Fetch the full settings object on demand (for the Settings page). */
  | { type: "requestSettings" }
  /** Persist a settings patch; each provided section replaces the stored one. */
  | { type: "updateSettings"; patch: Partial<AppSettings>; requestId?: string }
  /** Persist Jira integration settings. Secret fields are stored server-side and not echoed. */
  | { type: "updateJiraSettings"; patch: JiraSettingsPatch }
  /** Persist Jira integration settings, then test the saved credentials. */
  | { type: "saveAndTestJiraSettings"; patch: JiraSettingsPatch }
  /** Test the saved Jira credentials without exposing secret values. */
  | { type: "testJiraSettings" }
  /** Persist Confluence integration settings (its enable switch). */
  | { type: "updateConfluenceSettings"; patch: ConfluenceSettingsPatch }
  /** Persist Confluence integration settings, then test the shared Atlassian credentials. */
  | { type: "saveAndTestConfluenceSettings"; patch: ConfluenceSettingsPatch }
  /** Test Confluence access with the Atlassian credentials the Jira integration holds. */
  | { type: "testConfluenceSettings" }
  /** Persist Tempo integration preferences (non-secret). OAuth tokens are managed via the HTTP OAuth flow. */
  | { type: "updateTempoSettings"; patch: TempoSettingsPatch }
  /** Persist Tempo preferences, then test the saved OAuth authorization. */
  | { type: "saveAndTestTempoSettings"; patch: TempoSettingsPatch }
  /** Test the saved Tempo OAuth authorization without exposing secret values. */
  | { type: "testTempoSettings" }
  /** Persist Google Workspace OAuth settings. Secret fields are stored server-side and not echoed. */
  | { type: "updateGoogleSettings"; patch: GoogleSettingsPatch }
  /** Persist Google Workspace OAuth settings, then test the saved credentials. */
  | { type: "saveAndTestGoogleSettings"; patch: GoogleSettingsPatch }
  /** Test saved Google Workspace credentials without exposing secret values. */
  | { type: "testGoogleSettings" }
  /** Persist Slack integration settings. Secret fields are stored server-side and not echoed. */
  | { type: "updateSlackSettings"; patch: SlackSettingsPatch }
  /** Persist Slack integration settings, then test the saved credentials. */
  | { type: "saveAndTestSlackSettings"; patch: SlackSettingsPatch }
  /** Test saved Slack credentials without exposing secret values. */
  | { type: "testSlackSettings" }
  /** Persist and independently test the experimental Slack Huddle browser session. */
  | { type: "saveAndTestSlackHuddleSettings"; patch: SlackSettingsPatch }
  /** Test only the experimental Slack Huddle browser session. */
  | { type: "testSlackHuddleSettings" }
  /** Persist OpenAI-compatible provider settings. Secret fields are stored server-side and not echoed. */
  | {
      type: "updateOpenAiCompatibleSettings";
      patch: OpenAiCompatibleSettingsPatch;
    }
  /** Persist OpenAI-compatible provider settings, then discover models and register them. */
  | {
      type: "saveAndTestOpenAiCompatibleSettings";
      patch: OpenAiCompatibleSettingsPatch;
    }
  /** Test saved OpenAI-compatible settings and rediscover models without exposing secret values. */
  | { type: "testOpenAiCompatibleSettings" }
  /** Persist web-search (Brave) settings. The API key is stored server-side and not echoed. */
  | { type: "updateBraveSettings"; patch: BraveSettingsPatch }
  /** Persist web-search (Brave) settings, then verify the API key. */
  | { type: "saveAndTestBraveSettings"; patch: BraveSettingsPatch }
  /** Test saved web-search (Brave) settings without exposing secret values. */
  | { type: "testBraveSettings" }
  /** Persist Context7 settings. The API key is stored server-side and not echoed. */
  | { type: "updateContext7Settings"; patch: Context7SettingsPatch }
  /** Persist Context7 settings, then verify the API key. */
  | { type: "saveAndTestContext7Settings"; patch: Context7SettingsPatch }
  /** Test saved Context7 settings without exposing secret values. */
  | { type: "testContext7Settings" }
  /** Persist GitHub integration settings. The token is stored server-side and not echoed. */
  | { type: "updateGithubSettings"; patch: GithubSettingsPatch }
  /** Persist GitHub integration settings, then verify the token. */
  | { type: "saveAndTestGithubSettings"; patch: GithubSettingsPatch }
  /** Test the saved GitHub token without exposing secret values. */
  | { type: "testGithubSettings" }
  /** Persist Forgejo integration settings. The token is stored server-side and not echoed. */
  | { type: "updateForgejoSettings"; patch: ForgejoSettingsPatch }
  /** Persist Forgejo integration settings, then verify the token. */
  | { type: "saveAndTestForgejoSettings"; patch: ForgejoSettingsPatch }
  /** Test the saved Forgejo token without exposing secret values. */
  | { type: "testForgejoSettings" }
  /**
   * Start receiving a domain list's broadcasts (see {@link BroadcastTopic}).
   * A topic named in `digests` answers with its compact revision digest; other
   * snapshot-backed topics answer with a full snapshot (the cold-start fallback).
   */
  | {
      type: "subscribe";
      topics: BroadcastTopic[];
      digests?: BroadcastTopic[];
    }
  | { type: "unsubscribe"; topics: BroadcastTopic[] }
  /** Hold an authorized thread's bounded run-detail topic. */
  | {
      type: "subscribeSubagentThread";
      threadId: string;
      limit?: number;
      beforeSequence?: number;
      digest?: boolean;
    }
  | { type: "unsubscribeSubagentThread"; threadId: string }
  /**
   * Stop ONE background item under HUMAN authorization. The server resolves the
   * owner from the durable row and calls the supervisor's Stop service directly:
   * the agent-facing `background_tasks` tool is a different caller with a
   * different authorization, and neither is a second lifecycle authority. The
   * row's own state travels as a `background` state event, never in the answer.
   */
  | { type: "stopBackgroundWork"; itemId: string; requestId: string }
  /**
   * Stop every nonterminal item one session owns, and close its retained host.
   * May interrupt a background-origin turn; an ordinary prompted turn is never
   * interrupted, and the answer says the host close is waiting on it instead.
   */
  | { type: "stopAllBackgroundWork"; ownerSessionId: string; requestId: string }
  /** Fetch changed runs for a held thread after a run digest. */
  | {
      type: "getSubagentRunItems";
      threadId: string;
      ids: string[];
      requestId: string;
    }
  /** Batch-fetch rows whose revisions differed in a state digest. */
  | {
      type: "getStateItems";
      topic: "tasks" | "projects";
      ids: string[];
      requestId: string;
    }
  /**
   * Ask the server to revalidate the subscription-usage cache for every enabled
   * account that is no longer fresh. A hint, not a command: the cache enforces
   * its own freshness, min-interval and backoff, so a heartbeat from a visible
   * page costs nothing while the numbers are fresh.
   */
  | { type: "refreshUsage" }
  | { type: "listTasks"; request: TaskListRequest }
  | { type: "saveTask"; request: TaskSaveRequest; requestId?: string }
  | {
      type: "assignTaskProjects";
      updates: TaskProjectAssignmentUpdate[];
      requestId?: string;
    }
  | { type: "listProjects"; request?: ProjectListRequest }
  /** Request one full Project document; answers are correlated per id. */
  | { type: "getProject"; id: string; requestId: string }
  /** Persist editable Project registry fields/properties. */
  | {
      type: "saveProject";
      id: string;
      patch: Partial<ProjectRecord>;
      requestId?: string;
    }
  /**
   * Provision a Project's git repo using ambient git+ssh: `clone` clones
   * `repoUrl` into `settings.projectsRoot/<project id>` and registers it as the
   * project's main checkout; `pull` runs `git pull --rebase` in that checkout.
   * Progress/result surface via an updated `projects` list and `error` on failure.
   */
  | { type: "provisionProjectRepo"; id: string; requestId?: string }
  /**
   * Remove a Project's provisioned checkout: force-remove its spawned worktrees,
   * unregister the managed clone local path (`projectsRoot/<id>`), and, when
   * `deleteFolder` is set, delete that managed folder from disk. Only the managed
   * clone folder is ever deleted; externally registered local paths are left on
   * disk and merely unregistered.
   */
  | { type: "removeProjectRepo"; id: string; requestId?: string }
  /** Set a Project's registry status to archived (hidden from the default list). */
  | { type: "archiveProject"; id: string; requestId?: string }
  /** Permanently remove a Project from the registry. */
  | { type: "deleteProject"; id: string; requestId?: string }
  | {
      type: "reorderProjects";
      orderedIds: string[];
      placements?: ProjectReorderPlacement[];
      requestId?: string;
    }
  /**
   * Hide a Task from the Backlog (reversible). `archived=false` restores it,
   * which is what the archive toast's Undo sends — archiving is offered without
   * a confirmation prompt precisely because it round-trips.
   */
  | { type: "archiveTask"; id: string; archived?: boolean; requestId?: string }
  | { type: "deleteTask"; id: string; requestId?: string }
  /** Fetch the full markdown description for a single task (on-demand from the drawer). */
  | { type: "getTask"; id: string; requestId: string }
  | {
      type: "reorderTasks";
      orderedIds: string[];
      placements?: TaskReorderPlacement[];
      requestId?: string;
    }
  | { type: "cancelPostReloadContinuation" }
  /**
   * Create-on-first-prompt for staged new sessions. The FIRST send creates the
   * session with the chosen `harness` + `agentType`, model/thinking, and any
   * task/project links. Claude-SDK keeps the client-generated `id`; pi uses a
   * server-minted id and ignores the client id after request validation.
   */
  | {
      type: "harnessSend";
      id: string;
      harness: Harness;
      agentType: AgentType;
      text: string;
      attachments?: PromptAttachment[];
      modelProvider?: string;
      modelId?: string;
      thinkingLevel?: ThinkingLevel;
      /** Start the session in this mode (default `build`). */
      mode?: SessionMode;
      credentialProfileId?: string;
      attachTaskId?: string;
      projectId?: string;
      knowledgeEntryId?: string;
      worktreeId?: string;
      /**
       * Create a fresh worktree in this project and run the session in it —
       * the "+ New worktree" staging of the new-session surface. Mutually
       * exclusive with `worktreeId` (which wins if both arrive). Provisioning
       * runs BEFORE the session is created, reports through `worktreeProvision`
       * and, on failure, creates no session and runs no turn.
       */
      createWorktreeInProjectId?: string;
      clientRequestId?: string;
    }
  /** List worktrees (all projects, or one). Response: `worktreeList`. */
  | { type: "listWorktrees"; projectId?: string }
  /**
   * Ask the naming agent for a worktree name suffix proposal (also the branch
   * name). `context` is free text (e.g. task title) the agent names from.
   * Response: `worktreeNameProposal` echoing `requestId`.
   */
  | {
      type: "proposeWorktreeName";
      projectId: string;
      taskId?: string;
      context?: string;
      requestId: string;
    }
  /**
   * Create a worktree from the project's main checkout. `name` (the suffix /
   * branch) is required — propose one first via `proposeWorktreeName` or let the
   * user type one. Optional task/session are linked `in_worktree` on success.
   */
  | {
      type: "createWorktree";
      projectId: string;
      name: string;
      taskId?: string;
      sessionId?: string;
    }
  /**
   * Remove a worktree (`git worktree remove`). Refused while dirty or with
   * unmerged commits unless `force`. `deleteBranch` also deletes the branch
   * (force-delete when `force`).
   */
  | {
      type: "removeWorktree";
      worktreeId: string;
      deleteBranch?: boolean;
      force?: boolean;
      requestId?: string;
    }
  /**
   * Start a code-delivery Workflow Run for a Task: create the run row, then
   * provision its worktree and branch. Starting is the user's authorization for
   * exactly the run's sessions, one new worktree, local commits, and push + PR
   * after review passes — never merge, Task completion, or cleanup
   * (`docs/agent-workflows.md`). Progress and the outcome stream back as
   * `workflowRunStart` messages echoing `requestId`.
   */
  | {
      type: "startWorkflowRun";
      taskId: string;
      config: CodeDeliveryWorkflowConfig;
      /** Optional local branch to fork from; omitted for the main checkout branch. */
      baseBranch?: string;
      /** Omitted to size the starting ceilings from the coordinator's plan. */
      limits?: WorkflowRunLimits;
      requestId: string;
    }
  /**
   * Answer the gate an exhausted ceiling opened: raise it to the stated
   * numbers, take the work as it stands, or cancel the run. `deliver` is the
   * only way work no discovery review passed reaches the delivery gate, so it
   * is a decision the user makes and the run records
   * (`docs/agent-workflows.md`, "Limits, and who raises them").
   */
  | {
      type: "answerWorkflowCeiling";
      runId: string;
      choice: "raise" | "deliver" | "re-evaluate" | "cancel";
      raise?: WorkflowCeilingRaise;
    }
  | { type: "pauseWorkflowRun"; runId: string; reason?: string }
  | { type: "resumeWorkflowRun"; runId: string }
  | { type: "cancelWorkflowRun"; runId: string }
  /** Permanently delete a cancelled run, with explicit optional resource cleanup. */
  | {
      type: "deleteWorkflowRun";
      runId: string;
      deleteWorktree: boolean;
      archiveSessions: boolean;
    }
  | { type: "retryWorkflowRun"; runId: string }
  | { type: "rebaseAndReviewWorkflowRun"; runId: string }
  /**
   * Answer the run's merge seam from its Workflow card: merge the pull request
   * the run published, with the method and remote-branch choice this click
   * made. Refused unless the run's card currently offers it
   * ({@link WorkflowRunDelivery.canMerge}) — the same gate the live `/pr`
   * card's merge runs through, reached without opening its session.
   */
  | {
      type: "mergeWorkflowRun";
      runId: string;
      mergeMethod: PullRequestMergeMethod;
      /** False KEEPS the remote head branch; omitted deletes it. */
      deleteBranch?: boolean;
      /**
       * Correlates the click with its outcome, so the browser can busy the
       * button it pressed before the run list echoes the durable `busyAction`
       * ({@link WorkflowRunDelivery.busyAction}).
       */
      requestId?: string;
    }
  /**
   * Retire a finished run's checkout from its Workflow card: the live card's
   * safe cleanup — refresh the base, verify containment, remove the worktree
   * and its branch, settle every session on it — and then the run's own
   * settlement, so the acknowledged run leaves the Sessions inbox with it.
   */
  | { type: "cleanUpWorkflowRun"; runId: string; requestId?: string }
  /** Start live change watching for a worktree (the client is viewing it). */
  | { type: "watchWorktree"; worktreeId: string }
  | { type: "unwatchWorktree"; worktreeId: string }
  /** Subscribe/resync one object's authoritative comment projection. */
  | { type: "listComments"; target: CommentTarget; requestId?: string }
  | { type: "unwatchComments"; target: CommentTarget }
  | {
      type: "addComment";
      target: CommentTarget;
      body: string;
      selectors?: SelectorBundle;
      requestId?: string;
    }
  | {
      type: "replyComment";
      threadId: string;
      body: string;
      parentId?: string;
      requestId?: string;
    }
  | {
      type: "resolveComment";
      threadId: string;
      resolved: boolean;
      requestId?: string;
    }
  | {
      type: "editComment";
      commentId: string;
      body: string;
      requestId?: string;
    }
  | {
      type: "deleteComment";
      threadId: string;
      /** A reply root for a subtree delete; absent deletes the whole thread. */
      commentId?: string;
      requestId?: string;
    }
  | {
      type: "attachComments";
      threadIds: string[];
      sessionId?: string;
      /** Session creation/prompt options used by the review submit surfaces. */
      session?:
        | { kind: "existing"; sessionId: string; additionalPrompt?: string }
        | {
            kind: "new";
            harness: Harness;
            agentType?: AgentType;
            modelProvider?: string;
            modelId?: string;
            thinkingLevel?: ThinkingLevel;
            /**
             * Build/Plan for the created session (absent = Build). A review
             * draft is staged on the ordinary new-session surface, where the
             * mode is picked like the model — so it has to reach creation, or
             * the session runs a policy the composer said it would not.
             */
            mode?: SessionMode;
            credentialProfileId?: string;
            additionalPrompt?: string;
            attachments?: PromptAttachment[];
          };
      requestId?: string;
    }
  /**
   * Merge the worktree branch back into its base branch (strategy defaults to
   * settings.worktrees.defaultMergeStrategy). Conflicts spawn the configured
   * merger agent; progress arrives as `worktreeMergeUpdate`.
   */
  | {
      type: "mergeWorktree";
      worktreeId: string;
      strategy?: WorktreeMergeStrategy;
    };

/* ----------------------------- server -> client ---------------------------- */

export type ServerMessage =
  /** A session's prompt queue changed; `queue` is its complete new state. */
  | { type: "promptQueue"; sessionId: string; queue: PromptQueueState }
  | StateEventsMessage<"tasks", TaskSummary>
  | StateEventsMessage<"projects", ProjectSummary>
  | StateEventsMessage<"subagents", SubagentThreadSummary>
  | StateEventsMessage<"background", BackgroundWorkItemSummary>
  | CommentsSnapshotMessage
  | CommentEventsMessage
  | {
      /** First production frame, before any session snapshot, for deploy hand-off. */
      type: "webBuild";
      webBuildId: string;
    }
  | {
      type: "ready";
      /**
       * Content id of the currently served web build. A browser remembers the
       * last id it ran and reloads when a reconnect reaches a newer deployment,
       * preventing an old JS protocol client from operating against a new server.
       */
      webBuildId?: string;
      /** The currently viewed session, or null before a client-staged new session's first prompt. */
      state: SessionState | null;
      models: ModelOption[];
      /** Agents available to this client (Workshop only appears in dev mode). */
      agents: AgentInfo[];
      sessions: SessionListItem[];
      /** Number of archived sessions omitted from the initial/default sessions list. */
      archivedSessionCount?: number;
      /** True when `sessions` includes archived rows. */
      archivedSessionsLoaded?: boolean;
      /** Runtime settings needed by the app shell; Settings page requests the full object on demand. */
      settings: Partial<AppSettings>;
      /**
       * Which build of the SERVER answered — the version it declares plus the
       * commit it was packaged from. Independent of the browser bundle's own
       * build (a tab survives a deploy, and the shell is installed by hand), so
       * Settings shows both rather than assuming one.
       */
      serverBuild: BuildInfo;
      /** Whether this instance can transcribe dictation, and why not when it cannot. */
      speechToText: SpeechToTextStatus;
      slashCommands: SlashCommandInfo[];
      contextInfo: ContextInfo | null;
    }
  | { type: "state"; state: SessionState }
  /**
   * The server detached this connection from its viewed session after that
   * session was archived or deleted. The new-session surface stays client-staged:
   * no replacement session exists until its first prompt. A deletion reaches
   * EVERY connection viewing the session, not only the one that asked, so a
   * client whose route still names it moves to the new-session surface.
   */
  | {
      type: "sessionViewCleared";
      sessionId: string;
      reason: "deleted" | "archived";
    }
  /**
   * Atomic per-session load snapshot: the session state + context info, plus the
   * runtime-native {@link ClientSessionSnapshot} (durable timeline + in-flight
   * streams + runState) the client reducer keys its timeline on. Sent when a
   * session is (re)loaded into view; the sole chat-load authority.
   */
  | {
      type: "snapshot";
      state: SessionState;
      snapshot: ClientSessionSnapshot;
      contextInfo: ContextInfo;
    }
  /** One runtime-native delta frame, applied to the client's keyed snapshot. */
  | { type: "event"; sessionId: string; event: ClientRuntimeEvent }
  | { type: "contextInfo"; sessionId: string; info: ContextInfo }
  | {
      type: "timelineBlockLoaded";
      sessionId: string;
      entryId: string;
      blockIndex: number;
      kind: import("./session/index.ts").LazyBlockKind;
      content: unknown;
    }
  /**
   * One `loadTimelineBlock` that could not be answered, named exactly so the
   * client can retire that read: `unavailable` is terminal (the block is not in
   * this timeline any more), `error` is a failed read the client may retry.
   */
  | {
      type: "timelineBlockFailed";
      sessionId: string;
      entryId: string;
      blockIndex: number;
      kind: import("./session/index.ts").LazyBlockKind;
      reason: "unavailable" | "error";
      message: string;
    }
  /**
   * Older timeline entries for a windowed transcript, answering one
   * `loadTimelineRange`. `entries` immediately precede `beforeSeq` (the client's
   * current first entry), so the rendered suffix stays gapless; `turnStatsSeed`
   * is recomputed for the NEW start, which is what keeps the already-rendered
   * turn rows identical after the prepend.
   */
  | {
      type: "timelineRange";
      sessionId: string;
      /** Echo of the request's anchor, so a racing answer can be dropped. */
      beforeSeq: number;
      entries: ClientTimelineEntry[];
      /** Absolute index of `entries[0]`; zero means the session start is reached. */
      timelineStart: number;
      totalEntryCount: number;
      turnStatsSeed?: TurnStatsSeed;
    }
  /** Echoed after settings are successfully persisted; the client applies these. */
  | { type: "settings"; settings: AppSettings }
  /**
   * Where one queued prompt to the permanent Assistant has got to. Sent only to
   * the connection viewing that session.
   *
   * `queued` and `working` are CONDITIONS on the message itself, not events:
   * the client renders them on that prompt's own row (the optimistic echo keyed
   * by `clientRequestId`, which is still on screen until the durable user entry
   * lands) and announces neither. `failed` is the one failure here, so it names
   * the session it belongs to like every other session-scoped failure
   * (`docs/messaging.md`).
   */
  | {
      type: "permanentAssistantQueue";
      sessionId: string;
      clientRequestId: string;
      state: "queued" | "working" | "completed" | "failed";
      error?: string;
    }
  /**
   * Server resolved (creating if needed) the singleton Personal Assistant session
   * and switched its view to it. The client swaps in the session and navigates to
   * it — same shape/handling as {@link forkedSession}, so the router loads the id
   * instead of fighting the previously-addressed session's URL.
   */
  | {
      type: "permanentAssistantOpened";
      state: SessionState;
      sessions: SessionListItem[];
      contextInfo: ContextInfo;
    }
  /**
   * The available model list. `requestId` is present only on the answer to a
   * `refreshModels`, so the client retires exactly the refresh it started and
   * an unrelated `models` send (a settings save, an account change) cannot
   * clear a spinner it knows nothing about.
   */
  | { type: "models"; models: ModelOption[]; requestId?: string }
  /**
   * Recomputed dictation availability, echoed after a settings save. `ready`
   * alone would leave the Settings health line (and the mic button's reason)
   * stale after changing `speechToText.modelId` until the next reconnect.
   */
  | { type: "speechToTextStatus"; status: SpeechToTextStatus }
  | { type: "jiraStatus"; status: JiraConnectionStatus; settings: AppSettings }
  | {
      type: "confluenceStatus";
      status: ConfluenceConnectionStatus;
      settings: AppSettings;
    }
  | {
      type: "tempoStatus";
      status: TempoConnectionStatus;
      settings: AppSettings;
    }
  | {
      type: "googleStatus";
      status: GoogleConnectionStatus;
      settings: AppSettings;
    }
  | {
      type: "slackStatus";
      status: SlackConnectionStatus;
      settings: AppSettings;
    }
  | {
      type: "slackHuddleStatus";
      status: SlackHuddleConnectionStatus;
      settings: AppSettings;
    }
  | {
      type: "openAiCompatibleStatus";
      status: OpenAiCompatibleConnectionStatus;
      settings: AppSettings;
      models: ModelOption[];
    }
  | {
      type: "braveStatus";
      status: BraveConnectionStatus;
      settings: AppSettings;
    }
  | {
      type: "context7Status";
      status: Context7ConnectionStatus;
      settings: AppSettings;
    }
  | {
      type: "githubStatus";
      status: GithubConnectionStatus;
      settings: AppSettings;
    }
  | {
      type: "forgejoStatus";
      status: ForgejoConnectionStatus;
      settings: AppSettings;
    }
  | {
      type: "sessions";
      sessions: SessionListItem[];
      archivedSessionCount?: number;
      archivedSessionsLoaded?: boolean;
    }
  /** One session's metadata changed (for example unread/read state); avoids resending the whole list. */
  | { type: "sessionUpdated"; session: SessionListItem }
  | {
      type: "objectLinksResolved";
      requestId: string;
      links: PaObjectLinkResolution[];
    }
  | { type: "calendarDayScanProgress"; progress: CalendarDayScanProgress }
  | { type: "memoryListResult"; requestId: string; result: MemoryListResult }
  | { type: "memoryGetResult"; requestId: string; lineage: MemoryLineage }
  | {
      type: "memoryMutateResult";
      requestId: string;
      result: MemoryMutateResult;
    }
  | {
      type: "memoryLoadsResult";
      requestId: string;
      sessionId: string;
      batches: MemoryLoadBatch[];
    }
  | {
      type: "memoryStatusResult";
      requestId: string;
      processor: { configured: boolean; message?: string };
    }
  /** Targeted invalidation so open memory panels refetch authoritative rows. */
  | { type: "memoryInvalidated"; ids: string[] }
  /** Targeted invalidation of a session's effective-load audit. */
  | { type: "memoryLoadInvalidated"; sessionId: string }
  /**
   * A full Task-list snapshot: the cold-start/digest-failure fallback and the
   * explicit read used for mutation recovery. Task MUTATIONS never travel this
   * way — they are `stateEvents` batches (`docs/state-sync.md`). The sidecar
   * `revisions` seeds later digest resubscribe without polluting wire objects.
   */
  | {
      type: "taskList";
      list: TaskListResponse;
      seq: number;
      revisions: StateDigestEntry[];
    }
  /** Compact authoritative resubscribe baseline for the live Task projection. */
  | StateDigestMessage<"tasks">
  /** Rows batch-fetched after the client diffs a Task digest. */
  | StateItemsMessage<"tasks", TaskSummary>
  | StateDigestMessage<"projects">
  | StateItemsMessage<"projects", ProjectSummary>
  /** Cold/resync registry snapshot; run history is deliberately absent. */
  | {
      type: "subagentThreadList";
      threads: SubagentThreadSummary[];
      seq: number;
      revisions: StateDigestEntry[];
    }
  /**
   * Cold/resync snapshot of the canonical background-work projection. Mutations
   * never travel this way — they are `stateEvents` batches — and the sidecar
   * `revisions` seeds the client's next resubscribe.
   *
   * The registry keeps its terminal history, so this is a BOUNDED window over
   * it — active work first, then the newest rows — not the whole member set
   * ([Task-656](pa://task/656)). A row left out arrives as an ordinary upsert
   * the moment it changes; what no client has is older, SETTLED history, and
   * `truncated` is how a surface says that instead of presenting its window as
   * the complete registry.
   */
  | {
      type: "backgroundWorkList";
      items: BackgroundWorkItemSummary[];
      seq: number;
      revisions: StateDigestEntry[];
      /** Member rows exist beyond the window this answer carried. */
      truncated?: boolean;
    }
  /** Control feedback for a human Stop; the rows themselves travel as events. */
  | ({ type: "backgroundWorkStopAnswer" } & BackgroundWorkStopAnswer)
  /** Bounded snapshot for one authorized, held thread's run-detail topic. */
  | {
      type: "subagentThreadRunSnapshot";
      threadId: string;
      detail: SubagentThreadRunDetail;
      seq: number;
      revisions: StateDigestEntry[];
    }
  /** Run-detail digest and targeted catch-up reuse the revision sidecar model. */
  | {
      type: "subagentRunDigest";
      threadId: string;
      seq: number;
      entries: StateDigestEntry[];
    }
  | {
      type: "subagentRunItems";
      threadId: string;
      requestId: string;
      events: StateEvent<SubagentRunSummary>[];
    }
  | {
      type: "subagentRunEvents";
      threadId: string;
      seq: number;
      events: StateEvent<SubagentRunSummary>[];
    }
  /**
   * The whole `usage` topic snapshot: one narrow indicator per enabled account
   * (`docs/usage.md`). Sent on subscribe and re-sent whenever the server-side
   * cache changes, so no surface polls for it.
   */
  | { type: "usageIndicators"; indicators: UsageIndicator[] }
  /** The project assignment landed; the rows themselves arrive as `stateEvents`. */
  | { type: "taskProjectsAssigned" }
  | {
      type: "projectList";
      list: ProjectListResponse;
      seq: number;
      revisions: StateDigestEntry[];
    }
  | {
      type: "projectDetail";
      id: string;
      item: ProjectRecord | null;
      revision?: number;
      requestId: string;
      error?: string;
    }
  | {
      type: "projectSaved";
      item: ProjectRecord;
      revision: number;
      requestId?: string;
    }
  /**
   * The mutator's direct reply to `saveTask`: the authoritative FULL Task, which
   * is how a detail view adopts the stored body and how a create settles its
   * browser-local temp row (matched through `requestId`). It carries no list —
   * the list rows travel as `stateEvents`.
   */
  | { type: "taskSaved"; item: TaskItem; requestId?: string }
  /**
   * Response to a `getTask` request. `item: null` without `error` is an
   * authoritative not-found answer; `error` is a failed read. Correlation lets
   * the client drop a superseded read for the same id.
   */
  | {
      type: "taskDetail";
      id: string;
      item: TaskItem | null;
      requestId?: string;
      error?: string;
    }
  | {
      type: "forkedSession";
      state: SessionState;
      sessions: SessionListItem[];
      contextInfo: ContextInfo;
      selectedText?: string;
    }
  | {
      type: "draftSession";
      state: SessionState;
      sessions: SessionListItem[];
      contextInfo: ContextInfo;
      draftText: string;
      notice?: string;
    }
  /**
   * The durable user message — an engine→adapter envelope (the runtime ingests it
   * and re-emits the authoritative `entryAppended`). `clientRequestId` echoes the
   * value the client sent with its `prompt`/`harnessSend`.
   */
  | {
      type: "userMessage";
      sessionId: string;
      message: DisplayMessage;
      clientRequestId?: string;
    }
  | { type: "assistantStart"; sessionId: string; id: string }
  | { type: "textDelta"; sessionId: string; id: string; delta: string }
  | { type: "thinkingDelta"; sessionId: string; id: string; delta: string }
  | {
      type: "commitResult";
      sessionId: string;
      id: string;
      commit: CommitDisplay;
    }
  | { type: "pushResult"; sessionId: string; id: string; push: PushDisplay }
  | {
      type: "compactionResult";
      sessionId: string;
      id: string;
      compaction: CompactionDisplay;
    }
  | {
      type: "contextClearResult";
      sessionId: string;
      id: string;
      contextClear: ContextClearDisplay;
    }
  /** The genesis card of a session started with "+ New worktree" staged. */
  | {
      type: "worktreeProvisionResult";
      sessionId: string;
      id: string;
      provision: WorktreeProvisionDisplay;
    }
  | {
      type: "toolStart";
      sessionId: string;
      id: string;
      toolId: string;
      name: string;
      args: unknown;
    }
  | {
      type: "toolUpdate";
      sessionId: string;
      id: string;
      toolId: string;
      output: string;
    }
  | {
      type: "toolEnd";
      sessionId: string;
      id: string;
      toolId: string;
      output: string;
      isError: boolean;
      /** Provider display diff with real file line numbers (see DisplayBlock `resultDiff`). */
      resultDiff?: string;
    }
  | {
      type: "assistantEnd";
      sessionId: string;
      id: string;
      error?: string;
      errorInfo?: ProviderErrorInfo;
      aborted?: boolean;
    }
  /**
   * Non-turn diagnostics surfaced to the user without changing chat history.
   * `target` names the object it is about, so the client can put it there
   * (`docs/messaging.md`); without one it can only be said in passing.
   */
  | {
      type: "notice";
      severity: NoticeSeverity;
      message: string;
      target?: MessageTarget;
    }
  /**
   * The same alert the server delivers as a Declarative Web Push, offered to
   * clients that are connected RIGHT NOW.
   *
   * It exists for runtimes with no push service at all: the native shell is a
   * WKWebView, which implements neither `Notification` nor `PushManager`, so a
   * subscription there can never be created and the push path silently reaches
   * nobody. A live socket is the one channel such a client does have. Browsers
   * ignore it — they already subscribed, and acting on both would notify twice.
   *
   * Advisory, not state: it is broadcast, never replayed, and a client that was
   * offline for it has missed it. `navigatePath` is app-relative.
   */
  | {
      type: "appNotification";
      title: string;
      body: string;
      navigatePath: string;
    }
  /**
   * Dev-only: the server is about to reload to apply a server/shared code edit.
   * `pending` = globally queued and waiting for all active runs plus a short
   * cleanup delay; `reloading` = exiting now (the client should expect a brief
   * disconnect + auto-reconnect).
   */
  | { type: "devReload"; phase: "pending" | "reloading"; runningCount?: number }
  /**
   * `requestId` is present when this error answers a client command that
   * carried one, which is what lets an optimistic client recover exactly the
   * objects that mutation touched (see {@link MUTATION_REQUEST_ID_COMMANDS}).
   */
  | {
      type: "error";
      message: string;
      requestId?: string;
      /** The object that failed, so the client can report it there. */
      target?: MessageTarget;
      /**
       * Set with a `session` target when that session cannot be OPENED at all
       * (its stored record exists but is unreadable): no view will arrive for
       * it, so a client waiting to show it stops waiting and says so.
       */
      sessionUnavailable?: true;
      /**
       * Set when this error is a PROMPT SEND that never ran, and carries the
       * `clientRequestId` that send arrived with — the same value the optimistic
       * echo is keyed by (`entryAppended` reconciles it by that key too). It
       * lets the client retire exactly the echo whose prompt failed, instead of
       * recognising the sentence and guessing at the rest of its pending sends.
       *
       * Unset when the send carried no `clientRequestId`: such a send has no
       * echo to retire, since the echo only exists because the client minted
       * one. Distinct from `requestId`, which belongs to mutation correlation.
       */
      failedPromptClientRequestId?: string;
    }
  /**
   * A client command carrying a `requestId` finished without an error. It says
   * nothing about the resulting data — the authoritative list/broadcast does
   * that — only that the optimistic state may stop expecting a rollback.
   */
  | { type: "mutationSettled"; requestId: string }
  /** An approval card was created or updated; the client upserts it by id. */
  | { type: "approvalUpdate"; sessionId: string; approval: ApprovalCard }
  /** The session's complete set of approval grants, replacing the last one. */
  | { type: "approvalGrants"; sessionId: string; grants: ApprovalGrant[] }
  /** A pull-request card (stage 2 `/pr`) was created or updated; upsert by id. */
  | { type: "pullRequestCardUpdate"; sessionId: string; card: PullRequestCard }
  /**
   * A durable peer-prompt transition. The client overlays this onto any
   * rendered card (sender tool card or recipient transcript block) sharing the
   * same `messageKey`, so lifecycle changes update the existing card in place.
   */
  | {
      type: "peerPromptCardUpdate";
      sessionId: string;
      messageKey: string;
      state: PeerPromptState;
      failureReason?: string;
    }
  /** Response to `requestPeerPromptHistory`: an expanded (still bounded) projection replacing the default one for display. */
  | {
      type: "peerPromptHistoryExpanded";
      sessionId: string;
      projection: PeerPromptThreadsProjection;
    }
  /**
   * Response to `resolveTimelineAnchor`. `anchor` is absent when the target no
   * longer exists (its session was deleted, or a fork cut the entry away) —
   * the jump then stops rather than sending the reader somewhere arbitrary.
   */
  | {
      type: "timelineAnchor";
      requestId: string;
      anchor?: TimelineAnchor;
      error?: string;
    }
  /** Full worktree list (broadcast after create/remove and on request). */
  | { type: "worktreeList"; worktrees: WorktreeRecord[]; updatedAt: number }
  /**
   * Every Workflow Run plus a recipe-owned card for each run whose recipe the
   * server can project — terminal runs included, so a finished run's role
   * membership stays structurally known while its outcome is still
   * unacknowledged: the `workflow` topic's authoritative snapshot and change
   * broadcast.
   */
  | {
      type: "workflowRunList";
      runs: WorkflowRunSummary[];
      cards: Record<string, WorkflowRunCard>;
      updatedAt: number;
    }
  /**
   * The `skills` topic's ONE list shape: a fresh working-tree scan of the
   * user-owned library, answering a subscribe and carrying every later change.
   *
   * Exactly one of `list`/`error` is set. A scan that could not run at all is
   * an `error` rather than an empty library, because "no skills" is a claim
   * about authored content and a failed read is not entitled to make it; a
   * client keeps whatever it already had beside that message. Per-folder
   * failures are NOT this error — they travel inside `list.diagnostics`, which
   * is how a malformed folder stays visible with its reason.
   */
  | { type: "skillList"; list: SkillLibraryList; error?: never }
  | { type: "skillList"; list?: never; error: string }
  /**
   * Progress and outcome of a `startWorkflowRun` request, keyed to it by
   * `requestId`. `runId` is present from the first message on — the run row is
   * created before provisioning, so a crash mid-provision leaves a durable run
   * that pauses with the reason rather than vanishing. `failed` after that
   * still names the run; `failed` without a `runId` means starting was refused
   * outright (unknown Task, no git-backed Project) and nothing was created.
   */
  | {
      type: "workflowRunStart";
      requestId: string;
      phase: WorkflowRunStartPhase;
      runId?: string;
      branch?: string;
      error?: string;
    }
  /** Naming-agent proposal for `proposeWorktreeName`; echoes the requestId. */
  | { type: "worktreeNameProposal"; requestId: string; name: string }
  /**
   * First-send worktree provisioning progress, echoing the send's
   * `clientRequestId` so the browser can key the live card to its own send.
   * `created` is followed by the ordinary session creation; `failed` is the end
   * of the line — no session, no turn, and the prompt goes back to the composer.
   */
  | {
      type: "worktreeProvision";
      clientRequestId: string;
      provision: WorktreeProvisionDisplay;
    }
  /** Live git state of one worktree (on demand and pushed by the watcher). */
  | { type: "worktreeStatus"; status: WorktreeGitStatus }
  /** Fresh working-tree change list, pushed by the watcher while clients view the worktree. */
  | { type: "worktreeChanges"; changes: WorktreeChangesResponse }
  /** A committed KB mutation invalidated entry/inspector HTTP projections. */
  | { type: "knowledgeChanged"; entryIds: string[]; changedAt: number }
  /** Merge-back progress: phase transitions, conflicts, and the merger-agent session. */
  | {
      type: "worktreeMergeUpdate";
      worktreeId: string;
      phase: WorktreeMergePhase;
      message?: string;
      conflictPaths?: string[];
      agentSessionId?: string;
    };

/* ============================================================================
 * Calendar view (read-only Google Calendar + per-day meeting-minutes scanner)
 *
 * These DTOs are exchanged over the REST surface under /api/calendar/* (not the
 * WebSocket protocol) but live here so the web client and server share one
 * source of truth. The calendar view shows the primary Google Calendar; the
 * per-day meeting-minutes scan is run by the normal assistant agent (so it is
 * observable in the chat). The day read-model surfaces what that scan produced:
 * processed meeting-minutes sources (ledger), linked project Tasks, and
 * the persistent executive-summary markdown in the `daily-summaries` knowledge
 * skill.
 * ========================================================================== */

/** A detected video-conference link on an event (clickable to join). */
export interface CalendarConferenceLink {
  provider: "google-meet" | "zoom" | "teams" | "other";
  label: string;
  uri: string;
}

/** One attendee, compacted for the detail pane. */
export interface CalendarAttendeeDto {
  name: string | null;
  email: string | null;
  self: boolean;
  optional: boolean;
  organizer: boolean;
  /** accepted / declined / tentative / needsAction. */
  response: string | null;
}

/** One calendar event normalized for UI rendering (grids + detail pane). */
export interface CalendarEventDto {
  id: string;
  title: string;
  /** Raw RFC3339 start (or YYYY-MM-DD for all-day). */
  start: string | null;
  /** Raw RFC3339 end (or YYYY-MM-DD for all-day). */
  end: string | null;
  allDay: boolean;
  status: string | null;
  htmlLink: string | null;
  location: string | null;
  description: string | null;
  /** First detected video-conference link (Meet/Zoom/Teams), if any. */
  meetingUrl: string | null;
  /** All detected, de-duplicated conference links. */
  conferenceLinks: CalendarConferenceLink[];
  organizer: string | null;
  /** The configured user's response status (accepted/declined/tentative/needsAction). */
  selfResponse: string | null;
  attendees: CalendarAttendeeDto[];
  attendeeCount: number;
  /** True when the event has an attachment that looks like meeting minutes/notes. */
  hasMinutesAttachment: boolean;
  /** "busy"/"free" transparency, mirrors Google's `transparency`. */
  transparency: string | null;
}

export interface CalendarEventsResponse {
  from: string;
  to: string;
  calendarId: string;
  calendarSummary: string | null;
  timeZone: string | null;
  events: CalendarEventDto[];
}

/** One logged Tempo worklog projected for the calendar overlay (own worklogs only). */
export interface CalendarWorklogDto {
  id: string;
  /** Jira issue key when Jira enrichment is available, else null (raw id only). */
  issueKey: string | null;
  issueUrl: string | null;
  description: string;
  /** User-local start date `YYYY-MM-DD`. */
  startDate: string;
  /** User-local `HH:MM` start, when Tempo recorded one. */
  startTime: string | null;
  /** Logged duration in seconds. */
  seconds: number;
}

export interface CalendarWorklogsResponse {
  from: string;
  to: string;
  /** False when Tempo is not enabled/authorized (the overlay simply shows nothing). */
  enabled: boolean;
  /** True when issue keys were enriched via Jira. */
  jiraEnriched: boolean;
  worklogs: CalendarWorklogDto[];
}

export type CalendarScanOutcome =
  "actions_found" | "no_actions" | "unclear" | "error";

/** A meeting-minutes source the scanner has already processed for a day (ledger). */
export interface CalendarScanSource {
  title: string;
  sourceLink: string;
  outcome: CalendarScanOutcome;
  scannedAt: string | null;
  error?: string;
  /** CL Tasks generated from this source (the tree's child nodes). */
  tasks: CalendarDayTaskRef[];
}

/** A CL Task linked to one of a day's meeting-minutes sources. */
export interface CalendarDayTaskRef {
  id: string;
  title: string;
  status: TaskStatus;
}

/** The persistent executive summary for a day, a first-class KB entry. */
export interface CalendarDaySummary {
  /** Stable KB entry id, e.g. daily-summary-2026-06-29. */
  entryId: string;
  /** KB entry index.md path, e.g. daily-summaries/2026-06-29/index.md. */
  path: string;
  markdown: string;
  updatedAt: string | null;
}

/** Read-model for a single day: what the (agent-run) scan produced. */
/** Disposition of one source in a day-scan run: was it even attempted? */
export type CalendarDaySourceDisposition = "attempted" | "skipped";
/** Result of one attempted source: did it meet its completeness criteria? */
export type CalendarDaySourceResult = "complete" | "partial" | "failed";

/** Per-source health row projected from the last collection run's manifest. */
export interface CalendarDaySourceHealth {
  key: string;
  label: string;
  disposition: CalendarDaySourceDisposition;
  /** Skip reason when disposition is "skipped" (disabled/unconfigured/intentionally-skipped/deferred). */
  skipReason?: string;
  result?: CalendarDaySourceResult;
  factCount?: number;
  added?: number;
  changed?: number;
  error?: string;
}

/** Metered minutes-curation substage counts, projected from the run manifest. */
export interface CalendarDayMinutesSummary {
  discovered: number;
  processed: number;
  /** Skipped via a composite-cache-key hit (unchanged content + versions). */
  cached: number;
  /** Deferred past the per-run cap; a later run resumes without reprocessing. */
  deferred: number;
  failed: number;
  tasksCreated: number;
}

/** Compact health header for the calendar day view, from the last run manifest. */
export interface CalendarDayRunHealth {
  runId: string;
  /** ISO timestamp the run finished collecting. */
  asOf: string;
  schemaVersion: number;
  sources: CalendarDaySourceHealth[];
  /** Total added+changed across sources — the changes-since-last-scan badge. */
  changesSinceLastRun: number;
  /** Minutes-curation substage summary, absent when no minutes docs were discovered. */
  minutes?: CalendarDayMinutesSummary;
}

/** A derived/pending Tempo worklog proposal row for the day (state machine in the server). */
export interface CalendarDayTempoRow {
  id: string;
  issueKey: string;
  startTime: string | null;
  durationSeconds: number;
  activityKey: string | null;
  description: string | null;
  status:
    | "proposed"
    | "user-edited"
    | "dropped"
    | "pending-approval"
    | "executing"
    | "executed"
    | "partial"
    | "failed"
    | "cancelled"
    | "declined";
  resultWorklogId: string | null;
}

export interface CalendarDayState {
  date: string;
  /** True when Google Workspace is configured (so the UI can prompt to connect). */
  googleConfigured: boolean;
  /** Id of the assistant session bound to this day, if one has been created. */
  daySessionId: string | null;
  /** Processed meeting-minutes sources for the day, from the scan ledger. */
  sources: CalendarScanSource[];
  /** CL Tasks linked to the day's meeting-minutes sources. */
  tasks: CalendarDayTaskRef[];
  /** The persisted executive summary, if one has been written. */
  summary: CalendarDaySummary | null;
  /** Health of the last deterministic collection run, if one has happened. */
  run: CalendarDayRunHealth | null;
  /** Tempo logging proposals for the day (excludes dropped/cancelled rows). */
  tempo: CalendarDayTempoRow[];
}

export type CalendarScanStepStatus = "pending" | "running" | "done" | "failed";

/** One step of the deterministic day scan, surfaced live in the day panel. */
export interface CalendarScanStep {
  key: string;
  label: string;
  status: CalendarScanStepStatus;
  /** Short live detail, e.g. "7/10 sources" or an error message. */
  detail?: string;
}

/**
 * Live progress of a day scan (collect → minutes → synthesize). Broadcast to all
 * clients as the server-side deterministic pipeline advances, so the day panel
 * can show the workflow while scanning. `active` is false once the run settles.
 */
export interface CalendarDayScanProgress {
  date: string;
  active: boolean;
  steps: CalendarScanStep[];
  /** epoch ms when the scan started. */
  startedAt: number;
  /** The day session bound to this scan, once created. */
  sessionId: string | null;
  /** Set when the whole run failed outright. */
  error?: string;
}
