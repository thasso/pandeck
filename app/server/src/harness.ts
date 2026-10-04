/**
 * Harness-neutral driver contracts: the read/view surface a connection needs
 * from any backing engine ("harness"), plus the promptable extension for
 * runtime-controlled sessions. Leaf module — must not import `hub.ts`.
 */
import type {
  AgentType,
  BroadcastTopic,
  ContextInfo,
  DisplayMessage,
  Harness,
  ServerMessage,
  SessionState,
  ThinkingLevel,
} from "@assistant/shared";
import type { SyntheticToolHost } from "./hostSlashCommands.ts";

/**
 * How long a resident harness that nobody views and nothing drives stays in
 * memory before its store releases it. One clock for both harnesses: the next
 * command reopens it from disk (`docs/session-loading.md#letting-go`).
 */
export const HARNESS_IDLE_EVICT_MS = 5 * 60_000;

/** Anything that can receive server messages — implemented by `Connection`. */
export interface Viewer {
  send(message: ServerMessage): void;
  /** Whether this viewer has explicitly requested archived session rows. */
  wantsArchivedSessions?(): boolean;
  /**
   * The session this viewer is showing right now, if any. Automatic retention
   * (`sessionRetention.ts`) never archives a session someone is looking at.
   */
  viewingSessionId?(): string | undefined;
  /**
   * Whether this viewer is currently showing a domain list (`BroadcastTopic`).
   * A viewer that does not implement it receives no list traffic, which is
   * correct: subscribing is what delivers the snapshot in the first place.
   */
  wantsTopic?(topic: BroadcastTopic): boolean;
  /** Whether this viewer holds an authorized subagent thread detail topic. */
  wantsSubagentThread?(threadId: string): boolean;
  /** Whether this viewer subscribed to this exact object's comment stream. */
  wantsComments?(target: import("@assistant/shared").CommentTarget): boolean;
  /** Whether this viewer is live-watching this worktree (`watchWorktree`). */
  wantsWorktree?(worktreeId: string): boolean;
  /** Settings were written (by any client or agent); send this viewer its fresh copy. */
  settingsChanged?(change: import("./settingsService.ts").SettingsChange): void;
  /**
   * The session is being deleted: detach from it if it is on show, and let no
   * load of it still in flight attach. Called for every viewer BEFORE the
   * shared driver is disposed (`hub.clearSessionViews`).
   */
  sessionRemoved?(sessionId: string): void;
  /**
   * A session this viewer may be showing DETACHED (rendered from storage, no
   * harness open — see `viewSession.ts`) now has a real driver. A viewer on
   * that session re-attaches to it; every other viewer ignores the call.
   */
  sessionHarnessOpened?(driver: HarnessDriver): void;
}

/**
 * The read/view surface a `Connection` needs from whatever session it is
 * displaying — the common contract every backing engine ("harness") satisfies.
 * Implemented by the pi-backed `PiLiveSession` and the in-process
 * `ClaudeSdkSession`. Engine-specific mutations (prompt/abort/setModel/…) are
 * NOT part of this read surface — prompts go through the normalized runtime
 * facade, while other mutations narrow to the runtime-capable concrete driver as
 * needed.
 *
 * `kind` and `agentType` both carry the session's persona ({@link AgentType});
 * every driver also exposes its {@link Harness} and our session `id` (=
 * {@link sessionId}; for pi this is the pi session id — we do NOT mint a
 * distinct uuid for pi sessions).
 */
export interface HarnessDriver extends SyntheticToolHost {
  readonly kind: AgentType;
  /** Which engine runs this session (pi / claude-sdk). */
  readonly harness: Harness;
  /** Which persona/toolset this session emulates (independent of harness). */
  readonly agentType: AgentType;
  /** Our session id (equals {@link sessionId}; for pi this is the pi id). */
  readonly id: string;
  readonly key: string;
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  /** Engine-local running flag for sidebar/watch metadata; viewed chat run-state comes from the runtime. */
  readonly isRunning: boolean;
  /**
   * True once this instance was disposed: its store released it for being idle
   * ({@link HARNESS_IDLE_EVICT_MS}) or it was removed. Nothing may drive it
   * again; the prompt door refuses it (`runtimePrompt.ts`).
   */
  readonly released: boolean;
  addViewer(v: Viewer): void;
  removeViewer(v: Viewer): void;
  broadcastState(): void;
  state(): SessionState;
  snapshot(): DisplayMessage[];
  contextInfo(): ContextInfo;
}

/**
 * A {@link HarnessDriver} that also owns an active conversation and can be
 * controlled by the normalized runtime. App code must not prompt these drivers
 * directly; use the runtime prompt facade so run-state and durable logs stay
 * authoritative.
 */
export interface PromptableDriver extends HarnessDriver {
  abort(): void | Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
}
