/**
 * A session rendered from STORAGE ALONE — the metadata row plus the app-owned
 * log — with no harness open behind it.
 *
 * Opening the provider's transcript is what makes loading a session slow, and
 * it buys the reader nothing: on this machine pi's `SessionManager.open` cost
 * 1.7s on a 51 MB native file and the Claude SDK record is one 31 MB JSON
 * document, while the transcript the browser paints comes entirely from the
 * app-owned log. So a session nobody has opened is viewed through this driver
 * and the runtime's DETACHED adapter (`session/adapters/detached.ts`); the
 * first thing that actually needs the provider — a prompt, an abort, a model
 * change, a host slash command — opens the harness through
 * `Connection.ensureViewingDriver` and the view is re-attached to it.
 *
 * It is therefore a READ surface only. Everything that would drive the session
 * throws {@link DetachedSessionError}: reaching one of those means a caller
 * skipped that upgrade, and silently doing nothing would lose a prompt.
 *
 * What it cannot answer from storage it OMITS rather than guesses — a detached
 * `state()` carries no `skillInvocations` or `browserRuntimes`, both of which
 * are read off a live harness — and the upgrade's `state` broadcast fills them
 * in. It never reports a stale RUN: a running session is resident by
 * construction, so nothing reaches this path while it runs.
 */
import type {
  AgentType,
  ContextInfo,
  DisplayMessage,
  Harness,
  SessionMode,
  SessionState,
  ThinkingLevel,
} from "@assistant/shared";
import { sessionStore, type SessionMeta } from "./db/sessionStore.ts";
import type { HarnessDriver, Viewer } from "./harness.ts";
import type {
  HostClearOutcome,
  HostCompactionOutcome,
} from "./hostSlashCommands.ts";
import { storedSessionModelOption } from "./harnesses/models.ts";
import { engineTranscript } from "./harnesses/storage.ts";
import { DetachedSessionError } from "./session/adapters/detached.ts";
import { sessionRuntime } from "./session/runtimeInstance.ts";
import { buildSessionState } from "./sessionState.ts";

/** Persona for a stored session, defaulting the way the pi store's reopen does. */
function kindOf(meta: SessionMeta): AgentType {
  switch (meta.agentType) {
    case "workshop":
    case "developer":
    case "personal-assistant":
    case "workflow-coordinator":
      return meta.agentType;
    default:
      return "assistant";
  }
}

export class ViewSession implements HarnessDriver {
  readonly live = false;
  readonly kind: AgentType;
  readonly harness: Harness;
  readonly agentType: AgentType;
  readonly id: string;
  readonly key: string;
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  private readonly viewers = new Set<Viewer>();

  constructor(private readonly meta: SessionMeta) {
    this.id = meta.id;
    this.key = meta.id;
    this.sessionId = meta.id;
    this.harness = meta.harness;
    this.kind = kindOf(meta);
    this.agentType = meta.agentType as AgentType;
    this.sessionFile = engineTranscript(meta.harness, meta.id);
  }

  /** A session that is not resident is not running; see the module comment. */
  get isRunning(): boolean {
    return false;
  }

  /** Holds nothing to release: every drive call already refuses. */
  get released(): boolean {
    return false;
  }

  get sessionMode(): SessionMode {
    return this.meta.mode ?? "build";
  }

  addViewer(v: Viewer): void {
    this.viewers.add(v);
  }

  removeViewer(v: Viewer): void {
    this.viewers.delete(v);
  }

  broadcastState(): void {
    const state = this.state();
    for (const viewer of this.viewers) viewer.send({ type: "state", state });
  }

  /**
   * Empty: the legacy `DisplayMessage[]` projection is read only off a live
   * harness (permanent-assistant reply capture, the debug API). The transcript
   * a viewer renders comes from the runtime timeline, not from here.
   */
  snapshot(): DisplayMessage[] {
    return [];
  }

  state(): SessionState {
    return buildSessionState(this.id, {
      harness: this.harness,
      agentType: this.agentType,
      kind: this.kind,
      sessionFile: this.sessionFile,
      forkOrigin: this.meta.forkOrigin,
      model: storedSessionModelOption(
        this.harness,
        this.meta.provider,
        this.meta.model,
      ),
      thinkingLevel: (this.meta.thinkingLevel ?? "off") as ThinkingLevel,
      mode: this.meta.mode,
    });
  }

  /** Stats for the stored transcript, computed by the runtime from the log. */
  contextInfo(): ContextInfo {
    return sessionRuntime.openForView(this.id).contextInfo();
  }

  /* --------------------------- synthetic tool host -------------------------- */
  // Host slash commands drive a turn, so they run only against an open harness.
  // Every entry point upgrades first (`Connection.ensureViewingDriver`); these
  // exist to satisfy the contract and to fail loudly if one ever does not.

  private refuse(): never {
    throw new DetachedSessionError(this.id);
  }

  beginSyntheticTool(): never {
    this.refuse();
  }
  updateSyntheticTool(): never {
    this.refuse();
  }
  finishSyntheticTool(): never {
    this.refuse();
  }
  discardSyntheticTool(): never {
    this.refuse();
  }
  finishSyntheticCard(): never {
    this.refuse();
  }
  compactContext(): Promise<HostCompactionOutcome> {
    this.refuse();
  }
  clearContext(): Promise<HostClearOutcome> {
    this.refuse();
  }
  commitWorkflowContext(): { sessionManager: unknown; cwd?: string } {
    this.refuse();
  }
}

/**
 * The read-only view of a stored session, or undefined when no (undeleted)
 * metadata row names it. Callers that need to DRIVE the session must acquire
 * its harness instead (`hub.acquireById`).
 */
export function viewSessionById(id: string): ViewSession | undefined {
  const meta = sessionStore.get(id);
  return meta ? new ViewSession(meta) : undefined;
}
