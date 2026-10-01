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
  AgentKind,
  ContextInfo,
  DisplayMessage,
  Harness,
  ModelOption,
  SessionMode,
  SessionState,
  ThinkingLevel,
} from "@assistant/shared";
import { isCodingAgentType } from "@assistant/shared";
import type { AgentType } from "./agentTypes.ts";
import { sessionStore, type SessionMeta } from "./db/sessionStore.ts";
import { worktreeIdForSession } from "./db/worktreeStore.ts";
import type { HarnessDriver, Viewer } from "./harness.ts";
import { existsSync } from "node:fs";
import type {
  HostClearOutcome,
  HostCompactionOutcome,
} from "./hostSlashCommands.ts";
import { listSessionArtifacts } from "./mcp/toolGroups/packRuntime.ts";
import {
  claudeSdkModelOption,
  knownClaudeSdkModelAlias,
} from "./claudeSdk/modelSettings.ts";
import { findModel, toModelOption } from "./piSdk/models.ts";
import { toolExposureForSession } from "./piSdk/toolActivation.ts";
import { peerPromptThreadsFor } from "./peerPrompt.ts";
import { promptQueueField } from "./promptQueue.ts";
import { canonicalPiSessionPath } from "./sessionStorage.ts";
import { DetachedSessionError } from "./session/adapters/detached.ts";
import { sessionRuntime } from "./session/runtimeInstance.ts";
import { activeSkillsForSession } from "./sessionSkills.ts";
import {
  findOriginTask,
  listRelatedGlobalTasks,
  listSessionTasks,
} from "./tasks.ts";
import {
  getAnsweredAgentQuestions,
  getPendingAgentQuestion,
} from "./tools/core/questionTool.ts";
import { hasPendingApproval } from "./pendingApprovals.ts";
import { hasChoosingTaskCard } from "./pullRequestCards.ts";
import { getPendingPostReloadContinuation } from "./mcp/toolGroups/registry.ts";
import { sessionWorktreeMissing } from "./worktrees/sessionCwd.ts";

/** Persona for a stored session, defaulting the way the pi store's reopen does. */
function kindOf(meta: SessionMeta): AgentKind {
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
  readonly kind: AgentKind;
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
    const native = canonicalPiSessionPath(meta.id);
    this.sessionFile =
      meta.harness === "pi" && existsSync(native) ? native : undefined;
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
    const idleReasonValue = getPendingAgentQuestion(this.id)
      ? "awaiting_question"
      : hasPendingApproval(this.id)
        ? "awaiting_approval"
        : hasChoosingTaskCard(this.id)
          ? "awaiting_task_choice"
          : undefined;
    const pendingQuestionValue = getPendingAgentQuestion(this.id);
    const pendingPostReloadContinuationValue = getPendingPostReloadContinuation(
      this.id,
    );
    const activeSkillsValue = activeSkillsForSession(this.id, this.kind);
    const worktreeIdValue = this.safeWorktreeId();
    const modelValue = this.modelOption();
    const originTaskValue = this.originTask();
    const toolExposureValue = toolExposureForSession(this.id);
    const coding = isCodingAgentType(this.kind);
    return {
      sessionId: this.id,
      ...(this.sessionFile !== undefined
        ? { sessionFile: this.sessionFile }
        : {}),
      harness: this.harness,
      agentType: this.agentType,
      ...(this.meta.forkOrigin !== undefined
        ? { forkOrigin: this.meta.forkOrigin }
        : {}),
      ...(modelValue !== undefined ? { model: modelValue } : {}),
      thinkingLevel: (this.meta.thinkingLevel ?? "off") as ThinkingLevel,
      ...(this.meta.mode !== undefined ? { mode: this.meta.mode } : {}),
      // Steering needs a running turn, which a detached session cannot have.
      canSteer: false,
      ...(idleReasonValue !== undefined ? { idleReason: idleReasonValue } : {}),
      ...(pendingQuestionValue !== undefined
        ? { pendingQuestion: pendingQuestionValue }
        : {}),
      answeredQuestions: getAnsweredAgentQuestions(this.id),
      tasks: this.safe(() => listSessionTasks(this.kind, this.id), []),
      relatedGlobalTasks: this.safe(
        () => listRelatedGlobalTasks(this.kind, this.id),
        [],
      ),
      ...(originTaskValue !== undefined ? { originTask: originTaskValue } : {}),
      ...(toolExposureValue !== undefined
        ? { toolExposure: toolExposureValue }
        : {}),
      ...(activeSkillsValue !== undefined
        ? { activeSkills: activeSkillsValue }
        : {}),
      ...(coding ? { artifacts: listSessionArtifacts(this.id) } : {}),
      ...(this.kind === "workshop" &&
      pendingPostReloadContinuationValue !== undefined
        ? { pendingPostReloadContinuation: pendingPostReloadContinuationValue }
        : {}),
      peerPrompts: peerPromptThreadsFor(this.id),
      ...promptQueueField(this.id),
      ...(worktreeIdValue !== undefined ? { worktreeId: worktreeIdValue } : {}),
      ...(this.safeWorktreeMissing() ? { worktreeMissing: true } : {}),
    };
  }

  /** Stats for the stored transcript, computed by the runtime from the log. */
  contextInfo(): ContextInfo {
    return sessionRuntime.openForView(this.id).contextInfo();
  }

  /**
   * The model this session last ran on, resolved from the registry the way the
   * picker lists them. An id no catalog offers any more resolves to nothing
   * rather than to a fabricated option: the upgrade's `state` carries whatever
   * the harness itself reports.
   *
   * A Claude SDK row is resolved by its model alias alone: its `provider`
   * column is the credential kind (`claude`), not the picker's provider id.
   */
  private modelOption(): ModelOption | undefined {
    const { provider, model } = this.meta;
    if (!model) return undefined;
    if (this.harness === "claude-sdk") {
      const alias = knownClaudeSdkModelAlias(model);
      return alias ? claudeSdkModelOption(alias) : undefined;
    }
    if (!provider) return undefined;
    const pi = findModel(provider, model);
    return pi ? toModelOption(pi) : undefined;
  }

  private originTask(): ReturnType<typeof findOriginTask> {
    return this.safe(() => findOriginTask(this.id), undefined);
  }

  private safeWorktreeId(): string | undefined {
    return this.safe(() => worktreeIdForSession(this.id), undefined);
  }

  private safeWorktreeMissing(): boolean {
    return this.safe(() => sessionWorktreeMissing(this.id), false);
  }

  /** A store hiccup must degrade one field, never fail the whole view. */
  private safe<T>(read: () => T, fallback: T): T {
    try {
      return read();
    } catch (err) {
      console.warn(
        "Detached session state read failed:",
        err instanceof Error ? err.message : String(err),
      );
      return fallback;
    }
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
  finishSyntheticCommit(): never {
    this.refuse();
  }
  finishSyntheticPush(): never {
    this.refuse();
  }
  finishSyntheticCompaction(): never {
    this.refuse();
  }
  finishSyntheticContextClear(): never {
    this.refuse();
  }
  finishSyntheticWorktreeProvision(): never {
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
