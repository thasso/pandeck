import type {
  AgentType,
  SessionMode,
  WorktreeProvisionDisplay,
} from "@assistant/shared";
import type { HostCommandResult } from "./sessionKit/hostCommandTurn.ts";
import { parseCommitArgs, parsePrArgs } from "./slashCommands.ts";
import {
  type CommitWorkflowResult,
  runCommitWorkflow,
  toCommitDisplay,
} from "./commitWorkflow.ts";
import {
  parsePushArgs,
  runPushWorkflow,
  toPushDisplay,
} from "./pushWorkflow.ts";
import { resetMemorySessionContext } from "./memory/memoryRuntime.ts";
import { memoryScheduler } from "./memory/memoryScheduler.ts";
import { runPrWorkflow, type PrWorkflowPhase } from "./prWorkflow.ts";

/**
 * What a harness reports back from a manual compaction. `skipped` is a normal,
 * non-error outcome — a harness may legitimately refuse (the Claude CLI answers
 * "Not enough messages to compact." on a short conversation) — and renders as
 * plain tool output instead of a compaction card.
 */
export type HostCompactionOutcome =
  | {
      kind: "compacted";
      summary: string;
      /** Context tokens replaced by the summary. */
      tokensBefore: number;
      /** Context tokens after compaction, when the harness measures it. */
      tokensAfter?: number;
      /** First entry retained in context, when the harness exposes one. */
      firstKeptEntryId?: string;
    }
  | { kind: "skipped"; reason: string };

/**
 * What a harness reports back from a context clear. `skipped` is a normal
 * outcome — a session that never sent a turn has no context to drop — and
 * renders as plain tool output instead of a boundary card.
 */
export type HostClearOutcome =
  | {
      kind: "cleared";
      /** Context tokens dropped, when the harness measured a context size. */
      tokensBefore?: number;
    }
  | { kind: "skipped"; reason: string };

/**
 * The uniform surface every harness session exposes so the host (us, not the
 * model) can run a "tool call" — a slash command like `/commit` — and render its
 * result, identical across pi / claude-sdk. A commit is just a tool call WE make,
 * with special rendering for the result; this interface is the one seam each
 * harness implements so the dispatch + workflow live in ONE place
 * ({@link runCommitForHost}) instead of being special-cased per harness.
 *
 * Implemented by `PiLiveSession` and `ClaudeSdkSession`.
 * {@link import("./hub.ts").HarnessDriver} extends this, so any viewed session is
 * usable as a host.
 */
export interface SyntheticToolHost {
  readonly kind: AgentType;
  readonly sessionId: string;
  /**
   * Build/Plan for the session, when the harness has the mode axis. Plan is the
   * user's declared intent for the session, so the git-writing host commands
   * (`/commit`, `/push`, `/pr`) refuse under it — they are user-invoked, but
   * running them against a session the user has parked in Plan is exactly the
   * "wrote anyway" surprise Plan exists to prevent.
   */
  readonly sessionMode?: SessionMode;
  /** Open a host-driven assistant turn carrying a single in-progress tool block. */
  beginSyntheticTool(
    name: string,
    args: unknown,
  ): { assistantId: string; toolId: string };
  /** Stream progress text into the in-flight synthetic tool block. */
  updateSyntheticTool(output: string): void;
  /** Finish the synthetic turn with plain tool output. */
  finishSyntheticTool(toolId: string, output: string, isError?: boolean): void;
  /** Drop a normal skipped phase without persisting its wrapper tool turn. */
  discardSyntheticTool(): void;
  /**
   * Finish the synthetic turn with a rich host-command card (commit, push,
   * compaction, context clear, worktree provisioning), which replaces its tool
   * block and is the turn's durable entry.
   */
  finishSyntheticCard(result: HostCommandResult): void;
  /**
   * Compact this session's context, keeping recent history — the one genuinely
   * harness-specific step of `/compact`. pi calls its `AgentSession.compact`;
   * the Claude harness sends the CLI's own `/compact` command. Called INSIDE the
   * synthetic turn opened by {@link runCompactForHost}, so an implementation may
   * stream progress through `updateSyntheticTool`.
   */
  compactContext(customInstructions?: string): Promise<HostCompactionOutcome>;
  /**
   * Drop this session's model context entirely, keeping the app's transcript —
   * the one genuinely harness-specific step of `/clear`. pi resets its session
   * leaf so the next turn starts a new branch; the Claude harness forgets the
   * CLI resume id so the next turn opens a fresh provider session. Called
   * INSIDE the synthetic turn opened by {@link runClearForHost}.
   */
  clearContext(): Promise<HostClearOutcome>;
  /**
   * The minimal session context host slash commands need. `sessionManager` is
   * used by the commit workflow (getBranch + appendCustomEntry); pi returns its
   * real `AgentSession.sessionManager` (so the commit persists into pi's jsonl),
   * Claude sessions return a snapshot-backed duck (no pi persistence). `cwd` is
   * the session's git working directory, used by both `/commit` and `/push`.
   */
  commitWorkflowContext(): { sessionManager: unknown; cwd?: string };
}

/**
 * Refuse a git-writing host command while the session is in Plan, as a finished
 * error tool turn so the refusal is legible in the transcript. Deliberately
 * neutral wording: v1 Plan is a convention (the shell stays), so the message
 * says what did not run and how to proceed — never that Plan is read-only or
 * enforced.
 */
function refusedInPlan(
  host: SyntheticToolHost,
  name: string,
  commandText: string,
  rawArgs: string,
): boolean {
  if (host.sessionMode !== "plan") return false;
  const { toolId } = host.beginSyntheticTool(name, {
    command: commandText,
    rawArgs,
  });
  host.finishSyntheticTool(
    toolId,
    `This session is in Plan, so ${name} did not run. Switch the session to Build first.`,
    true,
  );
  return true;
}

/**
 * Run `/commit` against any harness, uniformly: open a synthetic tool turn, run
 * the shared commit workflow (streaming progress into the tool block), then
 * render the rich commit card (or an error). The host implementation owns the
 * turn lifecycle, persistence and workspace refresh in its finish* methods.
 */
export async function runCommitForHost(
  host: SyntheticToolHost,
  rawArgs: string,
): Promise<void> {
  const args = parseCommitArgs(rawArgs);
  const commandText = `/commit${rawArgs.trim() ? ` ${rawArgs.trim()}` : ""}`;
  if (refusedInPlan(host, "/commit", commandText, rawArgs)) return;
  const { toolId } = host.beginSyntheticTool("/commit", {
    command: commandText,
    rawArgs,
  });
  try {
    const { sessionManager, cwd } = host.commitWorkflowContext();
    const result: CommitWorkflowResult = await runCommitWorkflow({
      source: "slash",
      // The workflow only touches `session.sessionManager`.
      session: { sessionManager } as never,
      sessionKind: host.kind,
      sessionId: host.sessionId,
      ...(cwd !== undefined ? { cwd } : {}),
      dryRun: args.dryRun,
      force: args.force,
      additionalContext: args.additionalContext,
      commandText,
      onProgress: (message) => host.updateSyntheticTool(message),
    });
    host.finishSyntheticCard({
      kind: "commit",
      commit: toCommitDisplay(result),
    });
  } catch (err) {
    host.finishSyntheticTool(
      toolId,
      err instanceof Error ? err.message : String(err),
      true,
    );
  }
}

/**
 * Run `/push` against any harness, uniformly (same synthetic-tool surface as
 * `/commit`): open a synthetic tool turn, run the app-side push workflow
 * (streaming progress into the tool block), then render plain tool output. See
 * {@link import("./pushWorkflow.ts").runPushWorkflow} for why native push is unavailable.
 */
export async function runPushForHost(
  host: SyntheticToolHost,
  rawArgs: string,
): Promise<void> {
  const args = parsePushArgs(rawArgs);
  const commandText = `/push${rawArgs.trim() ? ` ${rawArgs.trim()}` : ""}`;
  if (refusedInPlan(host, "/push", commandText, rawArgs)) return;
  const { toolId } = host.beginSyntheticTool("/push", {
    command: commandText,
    rawArgs,
  });
  try {
    const { cwd } = host.commitWorkflowContext();
    const result = await runPushWorkflow({
      ...(cwd !== undefined ? { cwd } : {}),
      force: args.force,
      ...(args.remote !== undefined ? { remote: args.remote } : {}),
      ...(args.branch !== undefined ? { branch: args.branch } : {}),
      onProgress: (message) => host.updateSyntheticTool(message),
    });
    host.finishSyntheticCard({ kind: "push", push: toPushDisplay(result) });
  } catch (err) {
    host.finishSyntheticTool(
      toolId,
      err instanceof Error ? err.message : String(err),
      true,
    );
  }
}

/** Run `/pr` as sequential commit, push, and pull-request synthetic turns. */
export async function runPrForHost(
  host: SyntheticToolHost,
  rawArgs: string,
): Promise<void> {
  const args = parsePrArgs(rawArgs);
  const commandText = `/pr${rawArgs.trim() ? ` ${rawArgs.trim()}` : ""}`;
  // /pr is commit + push phases, so it takes the same Plan refusal.
  if (refusedInPlan(host, "/pr", commandText, rawArgs)) return;
  let activeToolId: string | undefined;

  const phaseName = (phase: PrWorkflowPhase): string =>
    phase === "commit" ? "/commit" : phase === "push" ? "/push" : "/pr";

  try {
    const { sessionManager, cwd } = host.commitWorkflowContext();
    await runPrWorkflow({
      sessionManager,
      ...(cwd !== undefined ? { cwd } : {}),
      sessionKind: host.kind,
      sessionId: host.sessionId,
      args,
      commandText,
      presenter: {
        begin(phase, phaseArgs) {
          activeToolId = host.beginSyntheticTool(
            phaseName(phase),
            phaseArgs,
          ).toolId;
          return activeToolId;
        },
        progress(message) {
          host.updateSyntheticTool(message);
        },
        discard() {
          host.discardSyntheticTool();
          activeToolId = undefined;
        },
        finishCommit(result) {
          host.finishSyntheticCard({
            kind: "commit",
            commit: toCommitDisplay(result),
          });
          activeToolId = undefined;
        },
        finishPush(result) {
          host.finishSyntheticCard({
            kind: "push",
            push: toPushDisplay(result),
          });
          activeToolId = undefined;
        },
        // The rich pull-request card lives in the store (`pullRequestCards.ts`),
        // injected like an approval; this turn just finishes with plain text.
        finishPullRequestTool(message, isError) {
          if (activeToolId)
            host.finishSyntheticTool(activeToolId, message, isError);
          activeToolId = undefined;
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (activeToolId) {
      host.finishSyntheticTool(activeToolId, message, true);
      return;
    }
    try {
      const fallback = host.beginSyntheticTool("/pr", {
        command: commandText,
        rawArgs,
      });
      host.finishSyntheticTool(fallback.toolId, message, true);
    } catch {
      // Another run claimed the idle gap between phases. Preserve the original
      // workflow failure for Connection's outer error handler.
      throw err;
    }
  }
}

/** Return the harness-independent server runner for a host slash command. */
/**
 * Host slash commands that touch nothing but the session's OWN context, so the
 * missing-worktree guard does not apply to them: they resolve no cwd, and the
 * app-CWD fallback that guard exists to prevent cannot happen. Refusing one
 * would only strand a session whose checkout vanished — clearing its context is
 * exactly the kind of recovery still worth allowing.
 *
 * Everything else stays guarded by default, which is why this lists the EXEMPT
 * commands rather than the cwd-dependent ones: `/commit`, `/push` and `/pr` act
 * on the checkout, and `/compact` spawns a provider query in the session's cwd.
 */
export const CONTEXT_ONLY_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  "clear",
]);

export function hostSlashCommandRunner(
  name: string,
): ((host: SyntheticToolHost, rawArgs: string) => Promise<void>) | undefined {
  if (name === "commit") return runCommitForHost;
  if (name === "push") return runPushForHost;
  if (name === "pr") return runPrForHost;
  if (name === "compact") return runCompactForHost;
  if (name === "clear") return runClearForHost;
  return undefined;
}

/**
 * Run `/compact` against any harness, uniformly (same synthetic-tool surface as
 * `/commit`): flush pending memory observations BEFORE context is replaced, let
 * the harness compact, then reset the delivered memory snapshot so the next turn
 * re-injects it (Task 96/99) and render the compaction card.
 *
 * A harness that declines to compact reports `skipped`, which is plain tool
 * output and leaves the memory snapshot alone — nothing was replaced.
 */
export async function runCompactForHost(
  host: SyntheticToolHost,
  rawArgs: string,
): Promise<void> {
  const customInstructions = rawArgs.trim() || undefined;
  const commandText = `/compact${customInstructions ? ` ${customInstructions}` : ""}`;
  const { toolId } = host.beginSyntheticTool("/compact", {
    command: commandText,
    rawArgs,
  });
  try {
    host.updateSyntheticTool("Compacting session context…");
    // Flush pending observations BEFORE compaction so they are learned from the
    // real conversation rather than the summary; single-flight, so a redundant
    // trigger (e.g. an automatic compaction racing this one) is harmless.
    await memoryScheduler.flushBeforeReset(host.sessionId);
    const result = await host.compactContext(customInstructions);
    if (result.kind === "skipped") {
      host.finishSyntheticTool(toolId, result.reason, false);
      return;
    }
    resetMemorySessionContext(host.sessionId);
    host.finishSyntheticCard({
      kind: "compaction",
      compaction: {
        summary: result.summary,
        tokensBefore: result.tokensBefore,
        ...(result.tokensAfter !== undefined
          ? { tokensAfter: result.tokensAfter }
          : {}),
        ...(result.firstKeptEntryId
          ? { firstKeptEntryId: result.firstKeptEntryId }
          : {}),
      },
    });
  } catch (err) {
    host.finishSyntheticTool(
      toolId,
      err instanceof Error ? err.message : String(err),
      true,
    );
  }
}

/**
 * Run `/clear` against any harness, uniformly (same synthetic-tool surface as
 * `/compact`): flush pending memory observations BEFORE context goes away, let
 * the harness drop it, then reset the delivered memory snapshot so the next turn
 * re-injects it and render the boundary card.
 *
 * `/clear` takes no arguments and is allowed in Plan — it writes nothing outside
 * the session. The mid-turn refusal (a running turn owns the very context this
 * would pull away) is `beginSyntheticTool`'s own, thrown before any turn exists
 * and surfaced by the dispatcher, exactly as for `/compact`: a running-state
 * check AFTER that call would always fire, since opening the synthetic turn is
 * itself what sets the session running.
 */
export async function runClearForHost(host: SyntheticToolHost): Promise<void> {
  const { toolId } = host.beginSyntheticTool("/clear", { command: "/clear" });
  try {
    host.updateSyntheticTool("Clearing session context…");
    // Same ordering as /compact: observations are learned from the real
    // conversation, which only exists until the clear lands.
    await memoryScheduler.flushBeforeReset(host.sessionId);
    const result = await host.clearContext();
    if (result.kind === "skipped") {
      host.finishSyntheticTool(toolId, result.reason, false);
      return;
    }
    resetMemorySessionContext(host.sessionId);
    host.finishSyntheticCard({
      kind: "contextClear",
      contextClear:
        result.tokensBefore !== undefined
          ? { tokensBefore: result.tokensBefore }
          : {},
    });
  } catch (err) {
    host.finishSyntheticTool(
      toolId,
      err instanceof Error ? err.message : String(err),
      true,
    );
  }
}

/**
 * Record an ALREADY-COMPLETED worktree provision as this session's genesis card,
 * through the same synthetic-turn surface the slash commands use.
 *
 * Unlike `/commit` and friends, the work does not happen inside the turn: the
 * checkout has to exist before the session does (a session's cwd is fixed at
 * construction in both harnesses), so the first send provisions first and calls
 * this once the session is live. The card is therefore always terminal, and the
 * whole thing is decoration — a harness that refuses to open a synthetic turn
 * (a queued dev reload, say) must not take the user's turn down with it.
 */
export function recordWorktreeProvisionForHost(
  host: SyntheticToolHost,
  provision: WorktreeProvisionDisplay,
): void {
  try {
    host.beginSyntheticTool("worktree", {
      command: "new worktree",
      branch: provision.branch,
      baseBranch: provision.baseBranch,
    });
    host.finishSyntheticCard({ kind: "worktreeProvision", provision });
  } catch {
    // The worktree exists and the session runs in it; a missing card is cosmetic.
  }
}
