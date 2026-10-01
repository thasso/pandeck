import type {
  StateDigestEntry,
  StateEvent,
  SubagentRunSummary,
  SubagentThreadSummary,
} from "@assistant/shared";
import {
  subagentStore,
  type SubagentRun,
  type SubagentThread,
} from "./db/subagentStore.ts";

/** The sole narrowing boundary for registry rows; revisions remain event sidecars. */
function subagentRunSummaryOf(run: SubagentRun): SubagentRunSummary {
  return {
    id: run.id,
    threadId: run.threadId,
    sequence: run.sequence,
    initiatedBy: run.initiatedBy,
    status: run.status,
    ...(run.activePhase ? { activePhase: run.activePhase } : {}),
    executionQuiescent: run.executionQuiescent,
    watchdogState: run.watchdogState,
    actualThinking: run.actualThinking,
    usageDelta: run.usageDelta,
    usageState: run.usageState,
    usageCompleteness: run.usageCompleteness,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.terminalAt !== undefined ? { terminalAt: run.terminalAt } : {}),
  };
}

/** The sole narrowing boundary for canonical thread registry rows. */
function subagentThreadSummaryOf(
  thread: SubagentThread,
): SubagentThreadSummary {
  // These keyed reads keep a cold registry snapshot O(threads), independent
  // of how many historical runs each thread retains.
  const latest = subagentStore.latestRun(thread.id);
  const active = subagentStore.activeRun(thread.id);
  return {
    id: thread.id,
    parentSessionId: thread.parentSessionId,
    sessionId: thread.sessionId,
    peerConversationId: thread.peerConversationId,
    config: {
      roleName: thread.profile.roleName,
      baseRole: thread.profile.baseRole,
      provider: thread.profile.provider,
      modelId: thread.profile.modelId,
      credentialProfileId: thread.profile.credentialProfileId,
      executionProfileId: thread.profile.executionProfileId,
      contractId: thread.profile.contractId,
      contractVersion: thread.profile.contractVersion,
      ...(thread.profile.degradedPinReason
        ? { degradedPinReason: thread.profile.degradedPinReason }
        : {}),
    },
    relation: {
      ...(thread.linkage.worktreeId
        ? { worktreeId: thread.linkage.worktreeId }
        : {}),
      ...(thread.linkage.cwd ? { cwd: thread.linkage.cwd } : {}),
      ...(thread.linkage.taskId !== undefined
        ? { taskId: thread.linkage.taskId }
        : {}),
      ...(thread.linkage.projectId
        ? { projectId: thread.linkage.projectId }
        : {}),
      ...(thread.linkage.worktreeRelation
        ? { worktreeRelation: thread.linkage.worktreeRelation }
        : {}),
    },
    usage: thread.usage,
    ...(active ? { activeRun: subagentRunSummaryOf(active) } : {}),
    ...(latest ? { latestRun: subagentRunSummaryOf(latest) } : {}),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    activityAt: thread.activityAt,
    ...(thread.inheritedArchivedAt !== undefined
      ? { inheritedArchivedAt: thread.inheritedArchivedAt }
      : {}),
    ...(thread.inheritedSettledAt !== undefined
      ? { inheritedSettledAt: thread.inheritedSettledAt }
      : {}),
  };
}

export function subagentThreadRevisionIndex(): Map<
  string,
  { revision: number; live: boolean }
> {
  return new Map(
    subagentStore
      .threadRevisions()
      .map((row) => [row.id, { revision: row.revision, live: row.member }]),
  );
}

export function subagentThreadRevisionDigest(): StateDigestEntry[] {
  return [...subagentThreadRevisionIndex()]
    .filter(([, entry]) => entry.live)
    .map(([id, entry]) => ({ id, revision: entry.revision }));
}

export function subagentThreadStateItems(
  ids: readonly string[],
  index: Map<
    string,
    { revision: number; live: boolean }
  > = subagentThreadRevisionIndex(),
): StateEvent<SubagentThreadSummary>[] {
  const events: StateEvent<SubagentThreadSummary>[] = [];
  for (const id of new Set(ids)) {
    const entry = index.get(id);
    if (!entry) continue;
    if (!entry.live) {
      events.push({ kind: "delete", id, revision: entry.revision });
      continue;
    }
    const thread = subagentStore.getThread(id);
    if (thread)
      events.push({
        kind: "upsert",
        id,
        revision: entry.revision,
        item: subagentThreadSummaryOf(thread),
      });
  }
  return events;
}

export function subagentRunThreadId(id: string): string | undefined {
  return subagentStore.getRun(id, true)?.threadId;
}

export function subagentRunStateItems(
  ids: readonly string[],
): StateEvent<SubagentRunSummary>[] {
  const events: StateEvent<SubagentRunSummary>[] = [];
  for (const id of new Set(ids)) {
    const run = subagentStore.getRun(id, true);
    if (!run) continue;
    if (!subagentStore.getRun(id)) {
      events.push({ kind: "delete", id, revision: run.revision });
    } else {
      events.push({
        kind: "upsert",
        id,
        revision: run.revision,
        item: subagentRunSummaryOf(run),
      });
    }
  }
  return events;
}

export function subagentThreadRunDetail(
  threadId: string,
  options: { limit?: number; beforeSequence?: number } = {},
):
  | {
      thread: SubagentThreadSummary;
      runs: SubagentRunSummary[];
      nextBeforeSequence?: number;
    }
  | undefined {
  const thread = subagentStore.getThread(threadId);
  if (!thread) return undefined;
  const runs = subagentStore
    .listRuns(threadId, options)
    .map(subagentRunSummaryOf);
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  return {
    thread: subagentThreadSummaryOf(thread),
    runs,
    ...(runs.length === limit
      ? { nextBeforeSequence: runs[runs.length - 1]!.sequence }
      : {}),
  };
}

export function subagentRunRevisionDigest(
  threadId: string,
): StateDigestEntry[] {
  return subagentStore
    .runRevisions(threadId)
    .filter((row) => row.member)
    .map(({ id, revision }) => ({ id, revision }));
}
