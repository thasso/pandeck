import {
  KnowledgeBaseStore,
  type KbFileChange,
} from "../knowledgeBaseStore.ts";
import {
  beginRun,
  ensureCandidateTask,
  getRun,
  listUnterminatedRuns,
  setRunState,
} from "../db/daySynthesisStore.ts";
import { DAY_SYNTHESIS_ACTOR_NAME } from "./types.ts";
import { dailySummaryEntryId, dailySummaryEntryPath } from "./dayState.ts";
import { applyNarrativeRegion } from "./appendix.ts";
import { renderNarrative, type SynthesisResult } from "./synthesisSchema.ts";
import {
  applyThreadProposals,
  parseThreadsDoc,
  renderThreadsEntry,
  THREADS_ASSET_PATH,
  THREADS_ENTRY_PATH,
} from "./threads.ts";
import { readMinutesIndex } from "./minutesRun.ts";
import type { MinutesCandidate } from "./minutes.ts";

/**
 * Synthesis application protocol (plan Decision #2). Applying validated
 * structured output touches KB Git + SQLite + (later) the session log, which
 * cannot be one transaction, so application is JOURNALED and IDEMPOTENT:
 *
 *   0. PREFLIGHT every revision-sensitive proposal (candidate state, thread
 *      revision) BEFORE any irreversible effect. Individually stale proposals
 *      are skipped as rejected/stale — never the whole run; a fully stale run
 *      creates nothing.
 *   1. journal `applying`.
 *   2. surviving Task proposals apply idempotently (unique candidate→Task map).
 *   3. ALL synthesis KB changes land in ONE run-id-tagged KB commit (narrative,
 *      threads store + projection, candidate statuses).
 *   4. journal `applied` (with the commit id).
 *
 * Re-applying a partially completed run RESUMES rather than duplicating:
 * already-created Tasks are found by candidate mapping; an already-landed KB
 * commit is found by its run-id subject.
 */

export interface SynthesisApplyDeps {
  store: KnowledgeBaseStore;
  runId: string;
  date: string;
  result: SynthesisResult;
  /** Creates a Task for an accepted candidate; invoked at most once per candidate. */
  createTaskForCandidate(input: {
    candidateId: string;
    title: string;
    entryPath: string;
    candidate: MinutesCandidate;
  }): string;
  now?: string;
}

export interface SynthesisApplyResult {
  runId: string;
  kbCommit: string | null;
  tasksCreated: number;
  tasksReused: number;
  staleTaskProposals: string[];
  threadsApplied: string[];
  threadsRejectedStale: number;
  resumed: boolean;
}

function runSubject(runId: string): string {
  return `day-synthesis apply ${runId}`;
}

async function findRunCommit(
  store: KnowledgeBaseStore,
  runId: string,
): Promise<string | null> {
  const subject = runSubject(runId);
  const history = await store.history({ limit: 50 });
  return history.find((h) => h.subject === subject)?.commit ?? null;
}

async function readTextIfPresent(
  store: KnowledgeBaseStore,
  path: string,
): Promise<string | null> {
  try {
    return await store.readEntryFile(path);
  } catch {
    return null;
  }
}

/**
 * Write a ready-made Markdown briefing into a day entry's narrative region as
 * the `day-synthesis` actor (Task 162). Used by the interactive scan, where the
 * day chat session IS the synthesizer: its visible turn's Markdown becomes the
 * durable day report. Bypasses the day-scan path guard (system actor) and
 * touches ONLY the narrative region (data region + `## Notes` untouched). A
 * no-op when the entry or region is missing or the content is unchanged.
 */
export async function writeDayBriefingNarrative(
  store: KnowledgeBaseStore,
  date: string,
  markdown: string,
): Promise<string | null> {
  const dayEntryPath = `${dailySummaryEntryPath(date)}/index.md`;
  const dayEntry = await readTextIfPresent(store, dayEntryPath);
  if (dayEntry === null) return null;
  const next = applyNarrativeRegion(dayEntry, markdown.trim());
  if (next === dayEntry) return null;
  const commit = await store.commitChanges(
    [{ op: "write", path: dayEntryPath, content: next }],
    {
      actor: { kind: "system", name: DAY_SYNTHESIS_ACTOR_NAME },
      reason: `day-synthesis briefing ${date}`,
      body: `Day-Scan-Date: ${date}`,
      entryIds: [dailySummaryEntryId(date)],
    },
  );
  return commit.commit;
}

/** candidateId → { entryPath, candidate } across the committed meeting entries (via the ledger index). */
async function loadCandidateContext(
  store: KnowledgeBaseStore,
): Promise<Map<string, { entryPath: string; candidate: MinutesCandidate }>> {
  const map = new Map<
    string,
    { entryPath: string; candidate: MinutesCandidate }
  >();
  for (const record of readMinutesIndex()) {
    const raw = await readTextIfPresent(
      store,
      `${record.entryPath}/assets/candidates.json`,
    );
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { candidates?: MinutesCandidate[] };
      for (const candidate of parsed.candidates ?? [])
        map.set(candidate.id, { entryPath: record.entryPath, candidate });
    } catch {
      /* skip malformed */
    }
  }
  return map;
}

export async function applySynthesis(
  deps: SynthesisApplyDeps,
): Promise<SynthesisApplyResult> {
  const { store, runId, date, result } = deps;
  const now = deps.now ?? new Date().toISOString();
  const zero: SynthesisApplyResult = {
    runId,
    kbCommit: null,
    tasksCreated: 0,
    tasksReused: 0,
    staleTaskProposals: [],
    threadsApplied: [],
    threadsRejectedStale: 0,
    resumed: false,
  };

  const run = beginRun(runId, date);
  if (run.state === "applied")
    return { ...zero, kbCommit: run.kbCommit, resumed: true };

  // Resume: the run's KB commit already landed in a prior crashed attempt.
  const existingCommit = await findRunCommit(store, runId);
  if (existingCommit) {
    setRunState(runId, "applied", existingCommit);
    return { ...zero, kbCommit: existingCommit, resumed: true };
  }

  // ---- (0) PREFLIGHT: partition revision-sensitive proposals before any effect.
  const candidateCtx = await loadCandidateContext(store);
  const survivingTasks: Array<{
    candidateId: string;
    title: string;
    entryPath: string;
    candidate: MinutesCandidate;
  }> = [];
  const staleTaskProposals: string[] = [];
  for (const proposal of result.taskProposals) {
    if (!proposal.accept) continue;
    const found = candidateCtx.get(proposal.candidateId);
    // Stale if the candidate no longer exists or already reached a terminal state.
    if (
      !found ||
      found.candidate.status === "rejected" ||
      found.candidate.status === "superseded" ||
      found.candidate.status === "task-created"
    ) {
      staleTaskProposals.push(proposal.candidateId);
      continue;
    }
    // Confidence policy: only LOW requires explicit user acceptance, so the
    // model's accept flag can never auto-create a Task for a low candidate
    // (high/medium are auto-created by the minutes substage / here).
    if (found.candidate.confidence === "low") continue;
    survivingTasks.push({
      candidateId: proposal.candidateId,
      title: proposal.title || found.candidate.title,
      entryPath: found.entryPath,
      candidate: found.candidate,
    });
  }

  const threadsDoc = parseThreadsDoc(
    await readTextIfPresent(store, THREADS_ASSET_PATH),
  );
  const threadResult = applyThreadProposals(
    threadsDoc,
    result.threadProposals,
    now,
  );

  // ---- (1) journal applying.
  setRunState(runId, "applying");

  // ---- (2) surviving Task proposals apply idempotently (unique candidate→Task map).
  let tasksCreated = 0;
  let tasksReused = 0;
  const updatedEntries = new Map<string, MinutesCandidate[]>();
  for (const task of survivingTasks) {
    const { taskId, created } = ensureCandidateTask(
      task.candidateId,
      runId,
      () =>
        deps.createTaskForCandidate({
          candidateId: task.candidateId,
          title: task.title,
          entryPath: task.entryPath,
          candidate: task.candidate,
        }),
    );
    if (created) tasksCreated += 1;
    else tasksReused += 1;
    // Reflect the link in the candidate source of truth (candidates.json).
    let list = updatedEntries.get(task.entryPath);
    if (!list) {
      const raw = await readTextIfPresent(
        store,
        `${task.entryPath}/assets/candidates.json`,
      );
      list = raw
        ? ((JSON.parse(raw) as { candidates?: MinutesCandidate[] })
            .candidates ?? [])
        : [];
      updatedEntries.set(task.entryPath, list);
    }
    const target = list.find((c) => c.id === task.candidateId);
    if (target) {
      target.taskId = taskId;
      target.status = "task-created";
    }
  }

  // ---- (3) build the ONE run-id-tagged KB commit.
  const changes: KbFileChange[] = [];
  const entryIds = [dailySummaryEntryId(date)];

  const dayEntryPath = `${dailySummaryEntryPath(date)}/index.md`;
  const dayEntry = await readTextIfPresent(store, dayEntryPath);
  if (dayEntry !== null) {
    const next = applyNarrativeRegion(
      dayEntry,
      renderNarrative(result.sections),
    );
    if (next !== dayEntry)
      changes.push({ op: "write", path: dayEntryPath, content: next });
  }

  if (threadResult.changed) {
    changes.push({
      op: "write",
      path: THREADS_ASSET_PATH,
      content: JSON.stringify(threadResult.next, null, 2),
    });
    changes.push({
      op: "write",
      path: `${THREADS_ENTRY_PATH}/index.md`,
      content: renderThreadsEntry(threadResult.next),
    });
    entryIds.push("ongoing-threads");
  }

  for (const [entryPath, candidates] of updatedEntries) {
    const path = `${entryPath}/assets/candidates.json`;
    const raw = await readTextIfPresent(store, path);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const content = JSON.stringify({ ...parsed, candidates }, null, 2);
    if (content !== raw) changes.push({ op: "write", path, content });
  }

  let kbCommit: string | null = null;
  if (changes.length > 0) {
    const commit = await store.commitChanges(changes, {
      actor: { kind: "system", name: DAY_SYNTHESIS_ACTOR_NAME },
      reason: runSubject(runId),
      body: `Day-Synthesis-Run: ${runId}\nDay-Scan-Date: ${date}`,
      entryIds,
    });
    kbCommit = commit.commit;
  }

  // ---- (4) journal applied.
  setRunState(runId, "applied", kbCommit);

  return {
    runId,
    kbCommit,
    tasksCreated,
    tasksReused,
    staleTaskProposals,
    threadsApplied: threadResult.applied,
    threadsRejectedStale: threadResult.rejectedStale.length,
    resumed: false,
  };
}

/**
 * Startup reconciliation (plan Decision #2). Any run left non-terminal is a
 * crash marker: if its run-id-tagged KB commit already exists, close the
 * journal (`applied`); otherwise leave it for a fresh apply/retry (Tasks
 * already created are safe — the candidate→Task mapping is unique, so a re-run
 * reuses them). Returns the run ids it closed.
 */
export async function reconcileDaySynthesisOnStartup(
  store: KnowledgeBaseStore,
): Promise<string[]> {
  const closed: string[] = [];
  for (const run of listUnterminatedRuns()) {
    const commit = await findRunCommit(store, run.runId);
    if (commit) {
      setRunState(run.runId, "applied", commit);
      closed.push(run.runId);
    }
  }
  return closed;
}

export { getRun as getDaySynthesisRun };
