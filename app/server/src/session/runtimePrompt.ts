/**
 * App-level prompt facade for runtime-backed sessions.
 *
 * Application code should drive pi/Claude-SDK sessions through this module, not
 * through raw engine prompt methods or adapters. The facade ensures the session
 * is attached to the normalized runtime before prompting, so run-state and the
 * durable app-owned log are updated for viewed and background runs alike.
 */
import type {
  AgentType,
  ContextInfo,
  Harness,
  PromptAttachment,
  SessionMode,
  ThinkingLevel,
} from "@assistant/shared";
import { WORKTREE_MISSING_BLOCKED_REASON } from "@assistant/shared";
import {
  checkSessionCheckoutRefused,
  sessionWorktreeRetired,
} from "../worktrees/sessionCwd.ts";
import {
  assertTurnAllowed,
  spendHumanResume,
  type HumanResumeToken,
} from "../automaticTurnHold.ts";
import type { PromptOrigin, SessionSnapshot } from "@assistant/shared/session";
import type { PromptableAdapter } from "./adapters/contract.ts";
import type { RuntimePromptOptions } from "./runtime/liveSession.ts";
import { PromptDeliveryReceipt } from "./runtime/promptDelivery.ts";
import { SessionRuntime } from "./runtime/runtime.ts";
import { sessionRuntime } from "./runtimeInstance.ts";
import {
  commitMemoryDelivery,
  decideMemoryDeliveryForPrompt,
  recordMemoryDeliveryFailure,
} from "../memory/memoryRuntime.ts";
import { memoryScheduler } from "../memory/memoryScheduler.ts";
import { beginPromptRun } from "./sessionRunLease.ts";
import { planTurnHintFor } from "./planHint.ts";
import { sessionSkills, skillUserInvocable } from "../sessionSkills.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { credentialProfileById } from "../credentialProfiles.ts";
import {
  installAccountRecovery,
  moveOffDisabledAccount,
  prepareAccountRecoveryTurn,
} from "../sessionAccountSwitch.ts";
import {
  assertAccountRecoveryAdmission,
  type AccountRecoveryTicket,
} from "./runtime/accountRecoveryAdmission.ts";

export interface RuntimePromptDriver {
  readonly id: string;
  readonly key: string;
  readonly sessionId: string;
  readonly harness: Harness;
  readonly credentialProfileId?: string | undefined;
  readonly agentType: AgentType;
  readonly sessionFile: string | undefined;
  readonly isRunning: boolean;
  readonly canSteer: boolean;
  /**
   * Build/Plan for the NEXT turn. Absent means the harness has no mode axis
   * yet, which behaves exactly as `build` (see `planHint.ts`).
   */
  readonly sessionMode?: SessionMode;
  /**
   * True once this instance was disposed — its store released it for being
   * idle, or it was removed (`HarnessDriver.released`, which every harness
   * answers). A released driver is refused before a runtime session is bound
   * to it or anything is appended; each caller surfaces or retries that
   * failure its own way (a peer send retries, a queued prompt holds its row
   * with the error), and a new send acquires the live session.
   */
  readonly released?: boolean;
  modelSelection?(): {
    model?: { provider: string; id: string } | undefined;
    thinkingLevel?: ThinkingLevel | undefined;
  };
  /** `allowWithoutHistory`: the turn has not started, so no history is lost. */
  switchAccount?(
    profileId: string,
    admit: () => void,
    allowWithoutHistory?: boolean,
  ): Promise<void>;
  dropEncryptedReasoning?(admit: () => void): Promise<boolean>;
  contextInfo(): ContextInfo;
  broadcastState(): void;
  createRuntimeAdapter(): PromptableAdapter;
}

export type RuntimePromptFacadeOptions = RuntimePromptOptions & {
  attachments?: PromptAttachment[];
  /** Server-only authority for the automatic continuation owning a switch. */
  accountRecovery?: AccountRecoveryTicket;
  /**
   * The user's authority, captured when they acted, to run this turn on a
   * session a Stop holds and to lift that hold once it is appended
   * (`automaticTurnHold.ts`). Only a message the user is sending right now
   * carries one; queued, scheduled and automatic work never does.
   */
  resumeHold?: HumanResumeToken;
  /**
   * A last synchronous check after every await, right before the turn is
   * appended: throwing refuses the turn and nothing reaches the session. For a
   * prompt whose CONTENT depends on state that may change while it waits — a
   * failure notice whose delegation the user may end meanwhile.
   */
  admit?: () => void;
};

/**
 * Notified when a session that was live only for RENDERING gets the harness
 * that will actually run it (`session/adapters/detached.ts`). Whoever opened
 * that harness is irrelevant — a reader's first prompt, a queued peer message,
 * a workflow step — so the signal is taken at the one place all of them pass:
 * the runtime attachment below. Connections showing the session listen so they
 * can re-attach their view to the real driver and stop reporting the
 * placeholder's `canSteer: false`.
 */
const harnessOpenedListeners = new Set<(sessionId: string) => void>();
export function subscribeHarnessOpened(
  listener: (sessionId: string) => void,
): () => void {
  harnessOpenedListeners.add(listener);
  return () => harnessOpenedListeners.delete(listener);
}

export function ensureRuntimeSessionWithRuntime(
  runtime: SessionRuntime,
  driver: RuntimePromptDriver,
): ReturnType<SessionRuntime["createSession"]> {
  // Binding a released instance would leave the runtime session wrapping a
  // disposed harness, and every later prompt would reuse it.
  if (driver.released)
    throw new Error(
      `Session ${driver.id} was released from memory; send it again.`,
    );
  const existing = runtime.get(driver.id);
  const attachRecovery = (
    live: ReturnType<SessionRuntime["createSession"]>,
  ) => {
    installAccountRecovery(
      live,
      driver,
      () => {
        assertSessionWorktreePresent(driver.sessionId);
        assertTurnAllowed(driver.sessionId, undefined);
      },
      () => {
        const releaseRun = beginPromptRun(driver.sessionId);
        try {
          const releaseAdmission = runtime.admitPrompt(driver.sessionId);
          return () => {
            releaseAdmission();
            releaseRun();
          };
        } catch (error) {
          releaseRun();
          throw error;
        }
      },
      (ticket, admit) =>
        promptRuntimeSessionWithRuntime(runtime, driver, "", {
          hidden: true,
          continuation: true,
          accountRecovery: ticket,
          admit,
          origin: { kind: "system", source: "account-switch" },
          contextBlock:
            "Continue the interrupted turn from the existing conversation. Do not repeat completed actions.",
        }),
    );
    return live;
  };
  if (!existing)
    return attachRecovery(
      runtime.createSession(driver.id, driver.createRuntimeAdapter()),
    );
  // A session brought live for viewing has no harness behind it yet. This is
  // where it gets one: the detached adapter is swapped for the driver's own,
  // which is why a prompt through this facade works on a session the reader
  // merely opened.
  if (!existing.isDetached) return attachRecovery(existing);
  existing.rebindAdapter(driver.createRuntimeAdapter());
  for (const listener of harnessOpenedListeners) {
    try {
      listener(driver.id);
    } catch {
      /* best-effort: one bad listener must not fail the prompt */
    }
  }
  return attachRecovery(existing);
}

/**
 * Refuse to run a session whose `in_worktree` worktree is GONE and unacknowledged
 * ([Task-321](pa://task/321)).
 *
 * This lives at the run boundary rather than at the client entry points because
 * "resume" has many mouths: the web `prompt`/slash commands, queued peer
 * delivery and `session_send_prompt`, review handoffs into an existing session,
 * day activation and scans, the post-reload continuation, approval outcomes and
 * question answers. Any of them can revive a session whose checkout was cleaned
 * up under it, and `resolveSessionCwd` would then silently point the agent at
 * the app's OWN repository. One check before the runtime session is ensured and
 * before anything is appended, so no path can forget it.
 *
 * Two halves. This synchronous one refuses on a DB verdict (a removed row, an
 * unknown project, the main checkout's cached "no repository") before the run
 * lease is taken. {@link decideSessionCheckout} then decides presence from the
 * run's own Worker check, after the lease and admission, so a folder deleted
 * or restored since the last cached answer is decided exactly.
 *
 * It THROWS: every caller here is a background or fire-and-forget driver that
 * already reports a failed send (the peer store retries then fails the message
 * permanently, the connection handlers surface `errorText`). `connection.ts`
 * additionally checks up front on the interactive paths, so the user gets the
 * refusal before any side effect rather than as a failed turn.
 */
function assertSessionWorktreePresent(sessionId: string): void {
  let missing = false;
  try {
    missing = sessionWorktreeRetired(sessionId);
  } catch (err) {
    // A store failure must not block every prompt: fail OPEN, the same way
    // memory selection does; the own check below still decides presence.
    warnCheckFailed(err);
    return;
  }
  if (missing) throw new Error(WORKTREE_MISSING_BLOCKED_REASON);
}

function warnCheckFailed(err: unknown): void {
  console.warn(
    "Failed to check session worktree before prompting:",
    err instanceof Error ? err.message : String(err),
  );
}

/**
 * The run's own decision on its session's checkout: a Worker check requested
 * now, refused with {@link WORKTREE_MISSING_BLOCKED_REASON} when it finds the
 * checkout gone and unacknowledged. A non-coding persona is decided before any
 * Worker contact; a session with no edge, or a DB verdict, needs none. A
 * Worker failure rejects: never absence, never the app CWD. It starts no
 * engine and reads no cwd, so it compares no edge; the run lease taken before
 * it keeps the worktree's removal out. A store error fails open, as the
 * synchronous half does.
 */
async function decideSessionCheckout(sessionId: string): Promise<void> {
  if (await checkSessionCheckoutRefused(sessionId, warnCheckFailed))
    throw new Error(WORKTREE_MISSING_BLOCKED_REASON);
}

/** Current account metadata is checked at admission, never inside an admitted run. */
export function assertSessionEnterpriseAccount(
  driver: Pick<RuntimePromptDriver, "sessionId" | "credentialProfileId">,
): void {
  const source = sessionStore.getIncludingDeleted(driver.sessionId);
  if (!source?.requiresEnterprise) return;
  const profileId = driver.credentialProfileId ?? source.credentialProfileId;
  const profile = profileId ? credentialProfileById(profileId) : undefined;
  if (!profile?.enterprise)
    throw new Error(
      "This session requires an enterprise account, but its bound account is missing or no longer marked as enterprise.",
    );
}

export function promptRuntimeSession(
  driver: RuntimePromptDriver,
  text: string,
  options: RuntimePromptFacadeOptions = {},
): PromptDeliveryReceipt {
  return promptRuntimeSessionWithRuntime(sessionRuntime, driver, text, options);
}

/**
 * Admit a provider-initiated turn that has no app prompt to append. It still
 * passes the same worktree, run-lease, skill and runtime attachment boundary as
 * prompted work. The returned release owns that boundary until the provider's
 * result arrives.
 */
export async function beginRuntimeProviderTurn(
  driver: RuntimePromptDriver,
  origin: PromptOrigin,
): Promise<() => void> {
  assertAccountRecoveryAdmission(driver.sessionId);
  assertSessionWorktreePresent(driver.sessionId);
  assertTurnAllowed(driver.sessionId, undefined);
  const releaseRun = beginPromptRun(driver.sessionId);
  const releaseAdmission = sessionRuntime.admitPrompt(driver.sessionId);
  try {
    await decideSessionCheckout(driver.sessionId);
    await sessionSkills(driver.sessionId, driver.agentType);
    assertTurnAllowed(driver.sessionId, undefined);
    assertAccountRecoveryAdmission(driver.sessionId);
    assertSessionEnterpriseAccount(driver);
    const live = ensureRuntimeSessionWithRuntime(sessionRuntime, driver);
    // The provider supplied no user message. Stamp its provenance on the next
    // durable assistant entry instead of fabricating a user row.
    const clearOrigin = live.markNextAssistantOrigin(origin);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      clearOrigin();
      releaseAdmission();
      releaseRun();
    };
  } catch (error) {
    releaseAdmission();
    releaseRun();
    throw error;
  }
}

export function promptRuntimeSessionWithRuntime(
  runtime: SessionRuntime,
  driver: RuntimePromptDriver,
  text: string,
  facadeOptions: RuntimePromptFacadeOptions = {},
): PromptDeliveryReceipt {
  return new PromptDeliveryReceipt((receipt) =>
    deliverWithRuntime(runtime, driver, text, facadeOptions, receipt),
  );
}

async function deliverWithRuntime(
  runtime: SessionRuntime,
  driver: RuntimePromptDriver,
  text: string,
  facadeOptions: RuntimePromptFacadeOptions,
  receipt: PromptDeliveryReceipt,
): Promise<void> {
  const { admit, accountRecovery, ...options } = facadeOptions;
  const assertRecoveryAdmission = () => {
    // Keep the idle edge reserved without blocking a genuine steer into the
    // admitted continuation. Both owners must still consider that run live.
    if (
      options.steer &&
      driver.isRunning &&
      runtime.get(driver.sessionId)?.isRunning
    )
      return;
    assertAccountRecoveryAdmission(driver.sessionId, accountRecovery);
  };
  assertRecoveryAdmission();
  const memorySource = sessionStore.getIncludingDeleted(driver.sessionId);
  const excludedFromMemoryCapture =
    !memorySource || memorySource.requiresEnterprise === true;
  // BEFORE the runtime session is ensured and before any append: a refused turn
  // must leave no trace of itself in the session.
  assertSessionWorktreePresent(driver.sessionId);
  // A Stop holds every turn the user did not just ask for
  // (`automaticTurnHold.ts`). Checked here and again after the last await
  // below, so neither a caller that sampled the session before the Stop nor a
  // resume the user authorized before a newer Stop can start a turn after it.
  assertTurnAllowed(driver.sessionId, options.resumeHold);
  // A session whose WORKTREE is being removed right now must not start a run —
  // and a run that starts here must block that removal until it is done. The
  // session's worktree is resolved HERE, at admission, so a session linked to a
  // held worktree after the hold was taken is covered too. The check and the
  // hold are synchronous, so the two decisions cannot interleave; sampling "is
  // it running" from the removal side never could (see `sessionRunLease.ts`).
  // This is the ONE place every prompt path goes through, which is why the
  // lease lives here and not at each caller.
  const releaseRun = beginPromptRun(driver.sessionId);
  // Until the run settles, no idle release may take this session's harness.
  const releaseAdmission = runtime.admitPrompt(driver.sessionId);
  try {
    // Presence from this run's own Worker check, under the lease: a refusal
    // still precedes the runtime session and every append.
    await decideSessionCheckout(driver.sessionId);
    // The lifecycle backstop for every prompt mouth. Creation paths freeze
    // eagerly where they know a session is new; this covers reopen/resume and
    // the first post-upgrade start of a legacy coding session. It happens before
    // the runtime session exists or any user entry can be appended.
    const frozenSkills = await sessionSkills(
      driver.sessionId,
      driver.agentType,
    );
    if (options.skillInvocation)
      await assertSkillInvocation(options, frozenSkills);
    assertTurnAllowed(driver.sessionId, options.resumeHold);
    assertRecoveryAdmission();
    // An account recovery continuation has already chosen its account, and a
    // steer-only message starts no turn.
    const accountMove =
      accountRecovery || options.steerOnly
        ? undefined
        : await moveOffDisabledAccount(driver, () => {
            assertTurnAllowed(driver.sessionId, options.resumeHold);
            assertRecoveryAdmission();
          });
    assertTurnAllowed(driver.sessionId, options.resumeHold);
    assertRecoveryAdmission();
    // Nothing below awaits before the append. The enterprise check runs before
    // `admit`, which must stay the last check: a peer admission reserves its
    // delivery, and a refusal after that reservation could strand the prompt.
    accountMove?.usable();
    assertSessionEnterpriseAccount(driver);
    admit?.();
    const live = ensureRuntimeSessionWithRuntime(runtime, driver);
    if (accountMove) live.appendNotice(accountMove.notice);
    prepareAccountRecoveryTurn(live, accountRecovery);
    return await runPromptWithRuntime(
      runtime,
      driver,
      text,
      withHumanResume(options, receipt),
      excludedFromMemoryCapture,
      receipt,
    );
  } finally {
    releaseAdmission();
    releaseRun();
  }
}

/**
 * A `/<skill>` invocation starts a turn of its own with one of the session's
 * frozen skills, and nothing else: refused before anything is appended. The
 * adapter's synchronous dispatch check follows inside the runtime.
 */
async function assertSkillInvocation(
  options: RuntimePromptFacadeOptions,
  frozenSkills: readonly string[],
): Promise<void> {
  const name = options.skillInvocation!.name;
  if (!frozenSkills.includes(name))
    throw new Error(`/${name} is not one of this session's skills.`);
  if (options.steer || options.steerOnly)
    throw new Error(
      `/${name} starts a new turn; send it when the current one finishes.`,
    );
  if (options.hidden || options.continuation)
    throw new Error(`/${name} can only be sent as a visible prompt.`);
  if (options.attachments?.length)
    throw new Error("Skill commands do not support attachments.");
  if (!(await skillUserInvocable(name)))
    throw new Error(`/${name} can only be loaded by the agent.`);
}

/**
 * A message the user is sending right now lifts the Stop it was sent under
 * once it is APPENDED as a turn of its own: a refused send resumed nothing. A
 * steer does not count — a held session runs only the turn being stopped, and
 * a message aimed at that turn is not a resume. The token leaves the options
 * here, so it never reaches the runtime or the adapter.
 */
function withHumanResume(
  options: RuntimePromptFacadeOptions,
  receipt: PromptDeliveryReceipt,
): RuntimePromptFacadeOptions {
  const { resumeHold, ...rest } = options;
  if (!resumeHold || options.steer) return rest;
  receipt.observe((event) => {
    if (event.type !== "appended") return;
    try {
      spendHumanResume(resumeHold);
    } catch (err) {
      console.warn("[stop-hold] could not lift a hold:", err);
    }
  }, true);
  return rest;
}

/**
 * Background-work facts that did not warrant a turn of their own
 * (`deliveryPolicy.ts`), already CLAIMED for the prompt about to carry them.
 * The claim is what makes them this prompt's: no other prompt can carry them
 * meanwhile, and the outbox knows an attempt may expose them.
 */
export interface DeferredBackgroundContext {
  block: string;
  /** Observe runtime evidence before the carrying prompt can append. */
  observe(receipt: PromptDeliveryReceipt, before?: boolean): void;
  /** The carrying prompt is over: what it threw, undefined when it resolved. */
  finished(thrown: unknown): void;
}

/**
 * Supplies and claims deferred background context for a turn about to start.
 * A seam rather than an import so the session layer keeps knowing nothing about
 * the background-work service; `index.ts` registers the real provider at boot.
 * Called synchronously, after the facade's last await and right before the
 * runtime appends: undefined when nothing is waiting or the claim was refused.
 */
let deferredBackgroundContext:
  ((sessionId: string) => DeferredBackgroundContext | undefined) | undefined;
export function setDeferredBackgroundContextProvider(
  fn:
    ((sessionId: string) => DeferredBackgroundContext | undefined) | undefined,
): void {
  deferredBackgroundContext = fn;
}

/**
 * Fold any deferred background-work context into the model-only block of a turn
 * that is happening anyway.
 *
 * This is the cheap half of background delivery: the fact costs no turn of its
 * own, and the session learns it before it acts again. It rides AFTER whatever
 * context the caller supplied and before the Plan hint, and — like both — never
 * reaches the durable log, so the visible transcript still shows only what the
 * user wrote.
 *
 * EVERY prompt that reaches the model carries it, hidden and steering ones
 * included. An earlier revision excluded those as "not turns the agent reasons
 * in", which is wrong: `connection.ts` resumes approval decisions, pull-request
 * outcomes and answered questions as hidden prompts — real turns where the agent
 * acts — and each becomes a steer when the session is already running. Skipping
 * them let a session act without a fact that had been deferred precisely so it
 * would arrive before the next action.
 *
 * Neither the append nor the prompt resolving HANDLES the facts: a Stop
 * resolves a prompt like a finished turn. The append binds them to the run it
 * belongs to, and only that run's clean end retires them (`index.ts` settles
 * from `RunOutcome`); a prompt refused before its append gives them back.
 */
function withDeferredBackgroundContext(
  driver: RuntimePromptDriver,
  options: RuntimePromptFacadeOptions,
  receipt: PromptDeliveryReceipt,
): {
  options: RuntimePromptFacadeOptions;
  finished: (thrown: unknown) => void;
} {
  if (options.continuation) return { options, finished: () => {} };
  const pending = deferredBackgroundContext?.(driver.sessionId);
  if (!pending) return { options, finished: () => {} };
  const contextBlock = options.contextBlock
    ? `${options.contextBlock}\n\n${pending.block}`
    : pending.block;
  pending.observe(receipt, true);
  return {
    options: { ...options, contextBlock },
    finished: (thrown) => pending.finished(thrown),
  };
}

/**
 * Prepend the turn's Plan-mode block (if any) to the model-only context block,
 * keeping any structured context the caller already supplied. The commit rides
 * the receipt's append, so only an ACCEPTED turn advances the Plan bookkeeping.
 */
function withPlanTurnHint(
  driver: RuntimePromptDriver,
  options: RuntimePromptFacadeOptions,
  receipt: PromptDeliveryReceipt,
): RuntimePromptFacadeOptions {
  if (options.continuation) return options;
  const hint = planTurnHintFor(driver);
  if (!hint) return options;
  const contextBlock = options.contextBlock
    ? `${options.contextBlock}\n\n${hint.block}`
    : hint.block;
  receipt.observe((event) => {
    if (event.type === "appended") hint.commit();
  }, true);
  return { ...options, contextBlock };
}

async function runPromptWithRuntime(
  runtime: SessionRuntime,
  driver: RuntimePromptDriver,
  text: string,
  rawOptions: RuntimePromptFacadeOptions,
  excludedFromMemoryCapture: boolean,
  receipt: PromptDeliveryReceipt,
): Promise<void> {
  ensureRuntimeSessionWithRuntime(runtime, driver);

  // Plan mode (Task 330) rides EVERY turn — hidden, steering and agent-origin
  // ones included, since they all reach the model — on the model-only context
  // seam, so it stays out of the durable log and the client projection. It is
  // applied before the memory branch below so both paths carry it.
  const deferred = withDeferredBackgroundContext(driver, rawOptions, receipt);
  let options: RuntimePromptFacadeOptions;
  try {
    options = withPlanTurnHint(driver, deferred.options, receipt);
  } catch (error) {
    deferred.finished(error);
    throw error;
  }

  // Every return path below goes through `runPrompt`, so a deferred block is
  // told how its carrying prompt ended exactly once, refusals included.
  const runPrompt = async (
    prompt: RuntimePromptFacadeOptions,
  ): Promise<void> => {
    try {
      await runtime.deliverPrompt(driver.id, text, prompt, receipt);
    } catch (error) {
      deferred.finished(error);
      throw error;
    }
    deferred.finished(undefined);
  };

  // Memory enrichment (Task 96): only top-level human turns are eligible. Hidden
  // resume/system prompts AND mid-turn steering follow-ups carry no memory snapshot
  // and record no effective load. Selection/delivery failures fail OPEN — the turn
  // proceeds with no memory and the delivered-fingerprint is not advanced.
  const eligible =
    !options.hidden &&
    !options.steer &&
    (options.origin?.kind ?? "human") === "human";
  if (!eligible) {
    return runPrompt(options);
  }

  let decision: ReturnType<typeof decideMemoryDeliveryForPrompt> | undefined;
  let selectionFailed = false;
  try {
    decision = decideMemoryDeliveryForPrompt(driver, text);
  } catch {
    decision = undefined;
    selectionFailed = true;
  }

  let capturedTurnId: string | undefined;
  // Capture the source timestamp at APPEND time (when the durable user entry is
  // created), not after a potentially long model turn.
  let capturedAtMs: number | undefined;
  const enriched: RuntimePromptFacadeOptions = {
    ...options,
    ...(decision?.memoryBlock ? { memoryBlock: decision.memoryBlock } : {}),
  };
  receipt.observe((event) => {
    if (event.type !== "appended") return;
    capturedTurnId = event.append.entryId;
    capturedAtMs = Date.now();
  }, true);

  await runPrompt(enriched);

  // Nothing accepted (e.g. a duplicate clientRequestId returned before appending):
  // record neither an effective load nor an observation.
  if (!capturedTurnId) return;

  // Commit the effective-load audit + advance the snapshot only when a delivery
  // decision was computed; a SELECTION failure must not also disable learning.
  if (decision) {
    try {
      commitMemoryDelivery(driver, capturedTurnId, decision);
    } catch {
      // The decision was computed but persisting it failed: still record an
      // explicit failure batch so the inspector doesn't show a stale prior turn.
      recordMemoryDeliveryFailure(driver, capturedTurnId);
    }
  } else if (selectionFailed) {
    // Selection itself threw: record an explicit failure batch for this turn.
    recordMemoryDeliveryFailure(driver, capturedTurnId);
  }

  // Enterprise sessions do not enter automatic memory capture. Check before
  // acquiring their transcript, including a source tombstoned during the run.
  const currentMemorySource = sessionStore.getIncludingDeleted(
    driver.sessionId,
  );
  if (
    excludedFromMemoryCapture ||
    !currentMemorySource ||
    currentMemorySource.requiresEnterprise
  )
    return;

  // Capture the completed clean assistant response (text blocks only — tool
  // call/result bodies are separate entries and excluded) for observation context.
  let assistantText: string | undefined;
  try {
    const snapshot = runtime.get(driver.id)?.getSnapshot();
    if (snapshot)
      assistantText = assistantTextAfter(snapshot.entries, capturedTurnId);
  } catch {
    assistantText = undefined;
  }

  // Post-turn observation (Task 99) runs INDEPENDENTLY of memory selection, shares
  // the same accepted user-turn id, uses the clean human text (never the model-only
  // snapshot), and stamps the append-time source timestamp.
  memoryScheduler.observeTurn({
    sessionId: driver.sessionId,
    userTurnId: capturedTurnId,
    persona: driver.agentType,
    humanText: text,
    ...(assistantText ? { assistantText } : {}),
    ...(capturedAtMs !== undefined ? { sourceTimestampMs: capturedAtMs } : {}),
  });
}

/**
 * Concatenate the clean text of assistant entries that follow the accepted user
 * turn `afterId`, stopping at the next user turn. Only `text` blocks are included
 * — tool-call/result bodies (separate entries) are never captured. `maxChars`
 * caps the result (memory observation uses a small cap; capture callers pass a
 * larger one).
 */
function assistantTextAfter(
  entries: SessionSnapshot["entries"],
  afterId: string,
  maxChars = 4_000,
): string | undefined {
  const start = entries.findIndex((e) => e.id === afterId);
  if (start < 0) return undefined;
  const parts: string[] = [];
  for (let i = start + 1; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.role === "user") break;
    if (entry.role !== "assistant") continue;
    for (const block of entry.content) {
      if (block.type === "text" && block.text.trim())
        parts.push(block.text.trim());
    }
  }
  const text = parts.join("\n").trim();
  return text ? text.slice(0, maxChars) : undefined;
}
