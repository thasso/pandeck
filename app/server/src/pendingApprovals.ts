/**
 * Unified, harness-neutral approval subsystem (Task 108).
 *
 * ONE durable, store-driven flow behind every agent-proposed mutation
 * (GitHub/Forgejo PR writes, Jira/Tempo edits, commit dry-runs). It mirrors the
 * question flow's six
 * properties so approvals behave the same on pi AND claude-sdk:
 *
 *  - persistent: records live in SQLite (`db/approvalStore.ts`) and survive reload;
 *  - attention: a pending approval marks the session `awaitingInput` (sidebar icon);
 *  - interactive + decision-recorded: the card runs pending → executing → executed
 *    | failed | rejected, and the decision/result are stored on the card;
 *  - card delivery: injected into both harnesses' snapshots and re-emitted to a
 *    viewer on attach, so it survives reload/navigation;
 *  - agent-informed: resolving resumes the idle session with a hidden outcome
 *    prompt (the connection drives the runtime facade, like a question answer);
 *  - harness-neutral: Approve/Reject is a connection command against THIS store,
 *    not a pi-only accept method.
 *
 * Each mutation family registers an {@link ApprovalExecutor} (server-side action)
 * and creates cards via {@link createApproval}; execution happens ONLY on approve.
 *
 * "Approve for session" also records the card's operations as session GRANTS
 * (`@assistant/shared` `approvalGrants.ts`), stored beside the cards. A later
 * card whose operations are all granted is still created and shown, but it is
 * approved by the server instead of blocking the session, and its outcome
 * reaches the agent through the same handoff as a clicked decision.
 */
import { randomUUID } from "node:crypto";
import { notifySessionBlocked } from "./webPush.ts";
import { applyPatch, approvalGrantKeys } from "@assistant/shared";
import {
  approvalMessageId,
  formatPaObjectLink,
} from "@assistant/shared/objectLinks";
import type {
  ApprovalBody,
  ApprovalCard,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalKind,
  ApprovalResolutionEdits,
  DisplayMessage,
  Patch,
} from "@assistant/shared";
import { inDbTransaction } from "./db/index.ts";
import { approvalStore, type StoredApproval } from "./db/approvalStore.ts";

/** Hidden-prompt lead line handed to the agent when an approval resolves. */
const APPROVAL_OUTCOME_MARKER = "[approval decision]";

/** Durable record: the client-facing card plus server-only execution context. */
interface ApprovalRecord {
  card: ApprovalCard;
  /** Kind-specific execution context, never sent to the client (e.g. a cwd, config hints). */
  context: Record<string, unknown>;
}

/** A mutation family's server-side executor. `execute` throws on failure. */
export interface ApprovalExecutor {
  /**
   * Settle what will actually execute, returning the body to execute. Runs —
   * and is persisted — BEFORE the card leaves `pending`, so a refusal leaves a
   * card the user can fix and approve again. Only kinds whose card is editable
   * implement it.
   *
   * It runs on EVERY approval, with or without `edits`: a card can sit pending
   * while the world moves under it, so the untouched rows need revalidating
   * just as much as the edited ones.
   */
  prepare?(
    card: ApprovalCard,
    edits: ApprovalResolutionEdits | undefined,
  ): Promise<ApprovalBody>;
  /**
   * Perform the approved action. May mutate `card.body` items with per-item
   * results for display. Returns a short human outcome (+ optional result URL).
   */
  execute(
    card: ApprovalCard,
    context: Record<string, unknown>,
  ): Promise<{ resultSummary: string; resultUrl?: string }>;
}

const executors = new Map<ApprovalKind, ApprovalExecutor>();

/** Register the executor for an approval kind (called once at module load by each family). */
export function registerApprovalExecutor(
  kind: ApprovalKind,
  executor: ApprovalExecutor,
): void {
  executors.set(kind, executor);
}

/* ------------------------------- store access ------------------------------ */

/**
 * A stored record as the domain reads it: reconciled on every read, as the file
 * store did, so a card written with the legacy shape still reads repaired.
 */
const asRecord = (stored: StoredApproval): ApprovalRecord => ({
  card: reconcileLegacyPartialApprovalCard(stored.card),
  context: stored.context,
});

/**
 * Older executors lost their mutated item body when a post-create link failed,
 * leaving a real Jira issue represented as a total failure. The generated error
 * still contains the created subject key (`KEY↔target`), so recover that one
 * deterministic legacy shape without guessing from arbitrary failures.
 */
export function reconcileLegacyPartialApprovalCard(
  card: ApprovalCard,
): ApprovalCard {
  if (
    card.status !== "failed" ||
    card.decision !== "approved" ||
    card.body.kind !== "jiraIssue" ||
    // A legacy record can lack them; there is nothing to recover then.
    !Array.isArray(card.body.items) ||
    typeof card.error !== "string"
  )
    return card;
  const creates = card.body.items.filter(
    (item) => item.operation === "create" && !item.resultIssueKey,
  );
  if (creates.length !== 1) return card;
  const match = card.error.match(
    /\b(?:add|remove) link \S+ ([A-Z][A-Z0-9]+-\d+)↔/,
  );
  if (!match?.[1]) return card;
  const key = match[1];
  const host = card.body.jiraHost?.match(/^https?:\/\//i)
    ? card.body.jiraHost
    : card.body.jiraHost
      ? `https://${card.body.jiraHost}`
      : undefined;
  const resultUrl = host
    ? `${host.replace(/\/$/, "")}/browse/${encodeURIComponent(key)}`
    : undefined;
  const warning = card.error.replace(
    /^All \d+ Jira change\(s\) failed:\s*/,
    "Issue created, but ",
  );
  const items = card.body.items.map((item) =>
    item === creates[0]
      ? applyPatch(item, {
          issueKey: key,
          resultIssueKey: key,
          ...(resultUrl ? { resultIssueUrl: resultUrl } : {}),
          warning,
          error: undefined,
        })
      : item,
  );
  return {
    ...applyPatch(card, {
      status: "executed",
      // Cleared, not omitted: a re-executed card must lose its old error.
      error: undefined,
      resultSummary: `Created ${key} with warnings`,
      ...(resultUrl ? { resultUrl } : {}),
    }),
    body: { ...card.body, items },
  };
}

function getRecord(approvalId: string): ApprovalRecord | undefined {
  const stored = approvalStore.get(approvalId);
  return stored ? asRecord(stored) : undefined;
}

/** Current authoritative card for reconnect/error reconciliation. */
export function approvalForId(approvalId: string): ApprovalCard | undefined {
  return getRecord(approvalId)?.card;
}

/* ----------------------------- attention seam ----------------------------- */

type ChangeListener = (sessionId: string) => void;
const listeners = new Set<ChangeListener>();

/** Subscribe to pending-approval changes for a session (harness attention refresh). */
export function subscribePendingApprovalChanges(
  listener: ChangeListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitChange(sessionId: string): void {
  for (const listener of listeners) listener(sessionId);
}

/** True while the session has an approval awaiting the user's decision. */
export function hasPendingApproval(sessionId: string): boolean {
  return approvalStore.sessionAwaits(sessionId);
}

/**
 * Every session currently blocked on an approval, in ONE query over the pending
 * rows. The session-list projection needs this per row; asking
 * `hasPendingApproval` once per session would be a query per row of every
 * broadcast.
 */
export function pendingApprovalSessionIds(): Set<string> {
  return approvalStore.awaitingSessionIds();
}

/* ----------------------------- read projections --------------------------- */

/** All approval cards for a session, oldest first (re-emitted to a viewer on attach). */
export function approvalsForSession(sessionId: string): ApprovalCard[] {
  return approvalStore
    .forSession(sessionId)
    .map((stored) => asRecord(stored).card);
}

/** Project approval display blocks for a session, oldest first. */
function approvalBlocksForSession(sessionId: string): DisplayMessage[] {
  return approvalsForSession(sessionId).map((approval) => ({
    id: approvalMessageId(approval.id),
    role: "assistant" as const,
    blocks: [{ kind: "approval" as const, approval }],
    createdAt: new Date(approval.createdAt).toISOString(),
  }));
}

/** Interleave approvals into a legacy DisplayMessage snapshot at their issuing tool/time. */
export function withApprovalBlocks(
  messages: DisplayMessage[],
  sessionId: string,
): DisplayMessage[] {
  const result = [...messages];
  for (const message of approvalBlocksForSession(sessionId)) {
    const approval = approvalCardFromMessage(message);
    let insertAt = -1;
    if (approval?.sourceToolCallId) {
      const anchor = result.findIndex((candidate) =>
        candidate.blocks.some(
          (block) =>
            block.kind === "tool" && block.toolId === approval.sourceToolCallId,
        ),
      );
      if (anchor >= 0) {
        insertAt = anchor + 1;
        while (
          insertAt < result.length &&
          approvalCardFromMessage(result[insertAt]!)?.sourceToolCallId ===
            approval.sourceToolCallId
        )
          insertAt += 1;
      }
    }
    if (insertAt < 0) {
      const createdAt = approval?.createdAt ?? 0;
      insertAt = result.findIndex(
        (candidate) =>
          candidate.createdAt && Date.parse(candidate.createdAt) > createdAt,
      );
      if (insertAt < 0) {
        let lastDated = -1;
        for (let index = 0; index < result.length; index += 1)
          if (result[index]!.createdAt) lastDated = index;
        insertAt = lastDated >= 0 ? lastDated + 1 : result.length;
      }
    }
    result.splice(insertAt, 0, message);
  }
  return result;
}

function approvalCardFromMessage(
  message: DisplayMessage,
): ApprovalCard | undefined {
  return message.blocks.find(
    (
      block,
    ): block is Extract<
      (typeof message.blocks)[number],
      { kind: "approval" }
    > => block.kind === "approval",
  )?.approval;
}

/* ----------------------------- creation ---------------------------------- */

export interface CreateApprovalInput {
  sessionId: string;
  kind: ApprovalKind;
  title: string;
  summary?: string;
  /** Calling tool id used to restore the card's transcript position. */
  sourceToolCallId?: string;
  body: ApprovalBody;
  /** Server-only execution context (cwd, etc.). */
  context?: Record<string, unknown>;
  /**
   * Whether this card replaces an earlier one: a still-pending card of the
   * same session that matches is marked `superseded`, so a re-proposal leaves
   * ONE decision instead of two.
   */
  supersedes?: (earlier: ApprovalCard) => boolean;
}

/**
 * The sentence a proposing tool's result ends with: the card's `pa://` link,
 * so the agent can point the user AT the card instead of describing where it
 * is. The link opens the card in the transcript, wherever it has scrolled to.
 */
export function approvalCardReference(card: ApprovalCard): string {
  const uri = formatPaObjectLink({ objectType: "approval", id: card.id });
  const label = card.title.replace(/[[\]\\]/g, "\\$&");
  return `When you ask the user to decide, link the card: [${label}](${uri}).`;
}

/**
 * Persist a PENDING approval and return its card. Broadcasts the new card +
 * attention — unless the session's grants already cover every operation it
 * performs: that card blocks nobody and is approved on the session's next idle
 * edge ({@link runAutoApprovals}). Earlier pending cards the input
 * `supersedes` are retired in the same store write.
 *
 * A card with a decision in flight is never superseded: the decision has
 * already read it as pending and may be executing it.
 */
export function createApproval(input: CreateApprovalInput): ApprovalCard {
  const now = Date.now();
  const autoApproved = coveredByGrants(input.sessionId, input.body);
  const card: ApprovalCard = {
    renderKind: "approval",
    id: `appr_${now}_${randomUUID().slice(0, 8)}`,
    sessionId: input.sessionId,
    kind: input.kind,
    status: "pending",
    title: input.title,
    ...(input.summary ? { summary: input.summary } : {}),
    createdAt: now,
    ...(input.sourceToolCallId
      ? { sourceToolCallId: input.sourceToolCallId }
      : {}),
    ...(autoApproved ? { autoApproved: true } : {}),
    body: input.body,
  };
  const superseded = inDbTransaction(() => {
    const retired: ApprovalCard[] = [];
    for (const rec of approvalStore
      .pendingForSession(input.sessionId)
      .map(asRecord)) {
      if (decisionLocks.has(rec.card.id) || !input.supersedes?.(rec.card))
        continue;
      const old = applyPatch(rec.card, {
        status: "superseded",
        resolvedAt: now,
        supersededBy: card.id,
        error: undefined,
      });
      approvalStore.update({ card: old, context: rec.context });
      retired.push(old);
    }
    approvalStore.insert({ card, context: input.context ?? {} });
    return retired;
  });
  for (const old of superseded) void broadcast(input.sessionId, old);
  void broadcast(input.sessionId, card);
  if (autoApproved) {
    if (superseded.length > 0) emitChange(input.sessionId);
    return card;
  }
  emitChange(input.sessionId);
  // The agent has stopped until this is answered, so it is one of the two
  // cases push exists for (`docs/messaging.md`). Raised HERE, at creation,
  // rather than on every `approvalUpdate`: a resolution or an execution step is
  // not a new block. Best-effort — a failed alert never fails the proposal.
  void notifySessionBlocked(input.sessionId, "approval", card.title).catch(
    () => {},
  );
  return card;
}

/* ----------------------------- resolution -------------------------------- */

/** Patch one card and return the stored record; a patch that changes nothing writes nothing. */
function patchCard(
  approvalId: string,
  patch: Patch<ApprovalCard>,
): ApprovalRecord | undefined {
  return inDbTransaction(() => {
    const stored = approvalStore.get(approvalId);
    if (!stored) return undefined;
    const rec = asRecord(stored);
    const card = applyPatch(rec.card, patch);
    // Against the row, not `rec`: a card reconciled on read is worth storing.
    if (JSON.stringify(card) === JSON.stringify(stored.card)) return rec;
    const updated = { card, context: rec.context };
    approvalStore.update(updated);
    return updated;
  });
}

/**
 * One in-flight decision per approval; concurrent decisions queue behind it.
 *
 * The card's own `pending` status is NOT a claim: a decision reads it, then
 * awaits `prepare` and the executor, and nothing holds the row across those
 * awaits. Without this, two browsers could both pass the pending check
 * and run the batch twice, and — worse — an approve awaiting a model lookup
 * could resume after a reject completed and execute what the user just refused.
 * Serializing means the loser re-reads a resolved card and is told so, while a
 * `prepare` that throws still leaves the card pending for a real second attempt.
 * (`peerPrompt.ts`'s `drainLocks` is the same in-process pattern.)
 */
const decisionLocks = new Map<string, Promise<void>>();

async function withDecisionLock<T>(
  approvalId: string,
  run: () => Promise<T>,
): Promise<T> {
  const prior = decisionLocks.get(approvalId) ?? Promise.resolve();
  // Both arms: a failed predecessor must not cancel the queued decision.
  const next = prior.then(run, run);
  const tail = next.then(
    () => {},
    () => {},
  );
  decisionLocks.set(approvalId, tail);
  void tail.then(() => {
    if (decisionLocks.get(approvalId) === tail)
      decisionLocks.delete(approvalId);
  });
  return next;
}

/**
 * Resolve an approval by the user's decision. On approve, applies any per-row
 * `edits` and executes the action (pending → executing → executed | failed); on
 * reject, records the rejection. Returns the final card plus the hidden outcome
 * prompt the caller feeds the agent. Throws if the approval is missing, already
 * resolved, or carries an edit the executor refuses — the last leaving the card
 * PENDING so the user can correct it.
 *
 * Decisions for one approval are serialized end to end (see
 * {@link decisionLocks}); a second decision resolves against the card the first
 * one left behind.
 */
export async function resolveApproval(
  approvalId: string,
  decision: ApprovalDecision,
  edits?: ApprovalResolutionEdits,
  options: { forSession?: boolean } = {},
): Promise<{ card: ApprovalCard; outcomePrompt: string }> {
  return withDecisionLock(approvalId, () =>
    resolveApprovalExclusive(approvalId, decision, edits, options),
  );
}

async function resolveApprovalExclusive(
  approvalId: string,
  decision: ApprovalDecision,
  edits: ApprovalResolutionEdits | undefined,
  /**
   * `underGrant`: approved by a session grant, which must still stand.
   * `onSettled`: called synchronously right after the terminal state is
   * written, before anything is awaited — see {@link autoApprove}.
   */
  options: {
    forSession?: boolean;
    underGrant?: boolean;
    onSettled?: (card: ApprovalCard, outcomePrompt: string) => void;
  },
): Promise<{ card: ApprovalCard; outcomePrompt: string }> {
  const rec = getRecord(approvalId);
  if (!rec) throw new Error("Approval not found or already resolved.");
  if (rec.card.status !== "pending")
    throw new Error(`This approval is already ${rec.card.status}.`);
  const sessionId = rec.card.sessionId;

  if (decision === "rejected") {
    const updated = patchCard(approvalId, {
      status: "rejected",
      decision: "rejected",
      resolvedAt: Date.now(),
      error: undefined,
    });
    emitChange(sessionId);
    if (updated) await broadcast(sessionId, updated.card);
    return {
      card: (updated ?? rec).card,
      outcomePrompt: outcomePromptFor((updated ?? rec).card),
    };
  }

  // What will execute is settled — and persisted — while the card is still
  // pending: a refusal here must leave a card the user can adjust and approve
  // again, not a half-executed one. Called even with no edits, since a pending
  // card's world can change under it.
  if (options.underGrant) requireGrant(rec.card);
  const preparer = executors.get(rec.card.kind)?.prepare;
  if (preparer) {
    const matching = edits?.kind === rec.card.body.kind ? edits : undefined;
    patchCard(approvalId, { body: await preparer(rec.card, matching) });
  }
  // Again after `prepare`: it can await a network or model lookup, and a
  // revoke that landed meanwhile must still stop what has not started.
  if (options.underGrant) requireGrant(getRecord(approvalId)!.card);

  // Granted once the decision is settled, before execution: the grant is
  // permission for the operation, not a verdict on how this run turns out.
  if (options.forSession) grantOperations(getRecord(approvalId)!.card);
  const executing = patchCard(approvalId, {
    status: "executing",
    decision: "approved",
    error: undefined,
    ...(options.forSession ? { grantedForSession: true } : {}),
  });
  emitChange(sessionId); // no longer pending → clears the attention indicator
  if (executing) await broadcast(sessionId, executing.card);

  const executor = executors.get(rec.card.kind);
  // Executors annotate the live body with per-item results. Keep this exact
  // object through both success and failure so a thrown partial execution does
  // not lose created ids, link outcomes, or item diagnostics by re-reading the
  // older persisted body.
  const live = getRecord(approvalId)!;
  try {
    if (!executor)
      throw new Error(
        `No executor registered for approval kind "${rec.card.kind}".`,
      );
    const outcome = await executor.execute(live.card, live.context);
    const done = patchCard(approvalId, {
      status: "executed",
      resolvedAt: Date.now(),
      resultSummary: outcome.resultSummary,
      ...(outcome.resultUrl ? { resultUrl: outcome.resultUrl } : {}),
      body: live.card.body,
    });
    const card = (done ?? live).card;
    const outcomePrompt = outcomePromptFor(card);
    settled(options, card, outcomePrompt);
    if (done) await broadcast(sessionId, done.card);
    return { card, outcomePrompt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = patchCard(approvalId, {
      status: "failed",
      resolvedAt: Date.now(),
      error: message,
      body: live.card.body,
    });
    const card = (failed ?? rec).card;
    const outcomePrompt = outcomePromptFor(card);
    settled(options, card, outcomePrompt);
    if (failed) await broadcast(sessionId, failed.card);
    return { card, outcomePrompt };
  }
}

/** Run `onSettled`; it reports its own failure and never fails the decision. */
function settled(
  options: {
    onSettled?: (card: ApprovalCard, outcomePrompt: string) => void;
  },
  card: ApprovalCard,
  outcomePrompt: string,
): void {
  try {
    options.onSettled?.(card, outcomePrompt);
  } catch (err) {
    console.warn(
      `[approvals] could not queue the outcome of ${card.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** The hidden prompt that tells the agent what the user decided and what happened. */
function outcomePromptFor(card: ApprovalCard): string {
  const lines = [APPROVAL_OUTCOME_MARKER];
  if (card.decision === "rejected") {
    lines.push(
      `The user REJECTED your proposed action: "${card.title}". Do not perform it. Continue without it unless the user explicitly asks again.`,
    );
  } else if (card.status === "executed") {
    lines.push(
      card.autoApproved
        ? `Your proposed action "${card.title}" was APPROVED automatically — the user approved this operation for the rest of the session — and it executed successfully.`
        : `The user APPROVED your proposed action: "${card.title}", and it executed successfully.`,
    );
    if (card.resultSummary) lines.push(`Result: ${card.resultSummary}`);
    if (card.resultUrl) lines.push(`URL: ${card.resultUrl}`);
  } else {
    lines.push(
      card.autoApproved
        ? `Your proposed action "${card.title}" was APPROVED automatically under a session grant, but it FAILED to execute.`
        : `The user APPROVED your proposed action: "${card.title}", but it FAILED to execute.`,
    );
    if (card.error) lines.push(`Error: ${card.error}`);
  }
  return lines.join("\n");
}

/* ----------------------------- session grants ---------------------------- */

/** True when `body` performs at least one operation and every one is granted. */
function coveredByGrants(sessionId: string, body: ApprovalBody): boolean {
  const keys = approvalGrantKeys(body);
  if (keys.length === 0) return false;
  const held = new Set(
    approvalStore.grantsForSession(sessionId).map((g) => g.key),
  );
  return keys.every((key) => held.has(key));
}

/** The session's grants, oldest first. */
export function approvalGrantsForSession(sessionId: string): ApprovalGrant[] {
  return approvalStore.grantsForSession(sessionId);
}

/** Grant every operation `card` performs for the rest of its session. */
function grantOperations(card: ApprovalCard): void {
  const now = Date.now();
  inDbTransaction(() => {
    // A key the session already holds keeps its original grant.
    for (const key of approvalGrantKeys(card.body))
      approvalStore.insertGrant(card.sessionId, {
        key,
        grantedAt: now,
        sourceApprovalId: card.id,
      });
  });
  void broadcastGrants(card.sessionId);
}

/**
 * Withdraw one grant. A card already approved under it keeps running; one still
 * waiting to start is handed back to the user by {@link autoApprove}.
 */
export function revokeApprovalGrant(sessionId: string, key: string): void {
  approvalStore.deleteGrant(sessionId, key);
  void broadcastGrants(sessionId);
}

/** The session grant an auto-approval relied on is gone. */
class GrantWithdrawnError extends Error {}

function requireGrant(card: ApprovalCard): void {
  if (!coveredByGrants(card.sessionId, card.body))
    throw new GrantWithdrawnError("The session grant was revoked.");
}

/**
 * Approve a card the session's grants cover and durably queue its outcome for
 * the agent — without delivering it (see {@link runAutoApprovals}). Returns
 * whether an outcome was queued. The grant is re-checked under the decision
 * lock, before and after `prepare`, so a revoke that landed first wins; that,
 * or a `prepare` refusal, turns the card into an ordinary pending approval for
 * the user.
 */
async function autoApprove(approvalId: string): Promise<boolean> {
  // Loaded BEFORE the decision, so queuing the outcome needs no await after
  // the terminal state is written. The module is imported lazily for the
  // same reason `hub.ts` is: it pulls in the runtime, which reads this store.
  const { enqueueAgentHandoff } = await import("./agentHandoffs.ts");
  let queued = false;
  try {
    await withDecisionLock(approvalId, async () => {
      const rec = getRecord(approvalId);
      if (!rec || rec.card.status !== "pending" || !rec.card.autoApproved)
        return;
      await resolveApprovalExclusive(approvalId, "approved", undefined, {
        underGrant: true,
        // The card is terminal from here on, so boot recovery would never
        // find it again: its outcome is queued in the same synchronous step
        // that recorded it, with no await in between.
        onSettled: (card, outcomePrompt) => {
          try {
            enqueueAgentHandoff({
              sessionId: card.sessionId,
              text: outcomePrompt,
              origin: { kind: "system", source: "approval-decision" },
            });
            queued = true;
          } catch (err) {
            // No browser asked for this decision, so the card is the only
            // place the failure can surface. The action's own outcome stands:
            // an executed card stays executed.
            const reason = err instanceof Error ? err.message : String(err);
            const note = `The agent could not be told the outcome: ${reason}`;
            patchCard(card.id, {
              error: card.error ? `${card.error} — ${note}` : note,
            });
          }
        },
      });
    });
    // Re-sent after the lock: an undeliverable outcome was noted on the card
    // after its terminal state had already been broadcast.
    const current = getRecord(approvalId)?.card;
    if (current && !queued && current.status !== "pending")
      await broadcast(current.sessionId, current);
  } catch (err) {
    const rec = getRecord(approvalId);
    if (rec?.card.status === "pending")
      handBackToUser(
        rec.card,
        err instanceof GrantWithdrawnError
          ? undefined
          : err instanceof Error
            ? err.message
            : String(err),
      );
    return false;
  }
  return queued;
}

/** An auto-approval that cannot run becomes the pending card it would have been. */
function handBackToUser(card: ApprovalCard, error?: string): void {
  const updated = patchCard(card.id, {
    autoApproved: undefined,
    ...(error ? { error } : {}),
  });
  emitChange(card.sessionId);
  if (updated) void broadcast(card.sessionId, updated.card);
  void notifySessionBlocked(card.sessionId, "approval", card.title).catch(
    () => {},
  );
}

/**
 * Run a session's auto-approved cards, oldest first, then start delivering
 * their outcomes, which each card queued in the same order. Called on the
 * session's idle edge, never from the proposing tool: the card is created
 * mid-turn, and an executor can need what that turn still holds (a merge
 * reserves the very worktree the turn is running in). A clicked approval
 * always comes after the turn ends too, so this is the same moment, just
 * without the wait.
 *
 * Delivery starts only once EVERY card has executed: delivering an outcome
 * starts the agent's next turn, and a later card in the batch would then run
 * beside it — a merge would find its worktree busy.
 */
export async function runAutoApprovals(sessionId: string): Promise<void> {
  let queued = false;
  for (const id of approvalStore.autoApprovalIds(sessionId))
    if (await autoApprove(id)) queued = true;
  if (queued) await drainOutcomes(sessionId);
}

/**
 * Resume auto-approvals a restart left in `pending`, one batch per session:
 * nothing is running at boot. One that was already executing is not retried —
 * its action may have happened.
 */
export function recoverAutoApprovalsOnBoot(): void {
  for (const sessionId of approvalStore.autoApprovalSessionIds())
    void runAutoApprovals(sessionId).catch((err: unknown) =>
      console.warn(
        `[approvals] auto-approval recovery for ${sessionId} failed:`,
        err instanceof Error ? err.message : String(err),
      ),
    );
}

type OutcomeDrain = (sessionId: string) => Promise<void>;
let drainOutcomesImpl: OutcomeDrain | null = null;

/** Test seam: replace the handoff drain that ends an auto-approval batch. */
export function setAutoApprovalDrainForTests(fn: OutcomeDrain | null): void {
  drainOutcomesImpl = fn;
}

async function drainOutcomes(sessionId: string): Promise<void> {
  if (drainOutcomesImpl) return drainOutcomesImpl(sessionId);
  const { drainAgentHandoffs } = await import("./agentHandoffs.ts");
  await drainAgentHandoffs(sessionId);
}

/* ----------------------------- broadcast --------------------------------- */

type BroadcastFn = (sessionId: string, approval: ApprovalCard) => void;
let broadcastImpl: BroadcastFn | null = null;
type GrantsBroadcastFn = (sessionId: string, grants: ApprovalGrant[]) => void;
let broadcastGrantsImpl: GrantsBroadcastFn | null = null;

/** Test seam: replace the hub broadcast. */
export function setApprovalBroadcastForTests(
  fn: BroadcastFn | null,
  grantsFn: GrantsBroadcastFn | null = null,
): void {
  broadcastImpl = fn;
  broadcastGrantsImpl = grantsFn;
}

async function broadcastGrants(sessionId: string): Promise<void> {
  const grants = approvalGrantsForSession(sessionId);
  if (broadcastImpl) {
    broadcastGrantsImpl?.(sessionId, grants);
    return;
  }
  try {
    const { hub } = await import("./hub.ts");
    hub.broadcastApprovalGrants(sessionId, grants);
  } catch {
    // best-effort; the list is re-sent whenever the session is viewed.
  }
}

async function broadcast(
  sessionId: string,
  approval: ApprovalCard,
): Promise<void> {
  if (broadcastImpl) {
    broadcastImpl(sessionId, approval);
    return;
  }
  try {
    const { hub } = await import("./hub.ts");
    hub.broadcastApprovalUpdate(sessionId, approval);
    void hub.broadcastSessions();
  } catch {
    // best-effort; the card still resolves from the store on the next snapshot.
  }
}
