import { randomUUID } from "node:crypto";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import { createTask } from "../tasks.ts";
import { DAY_SCAN_TASK_MARKER } from "./collectors/pa.ts";
import {
  buildDaySynthesisDigest,
  renderSynthesisPrompt,
  type DaySynthesisDigest,
} from "./digest.ts";
import { validateSynthesisResult } from "./synthesisSchema.ts";
import { applySynthesis, type SynthesisApplyResult } from "./synthesisApply.ts";
import type { MinutesCandidate } from "./minutes.ts";

/**
 * The DaySynthesisRunner seam (plan § synthesis). The runner reasons over the
 * bounded digest with a READ-ONLY tool surface and MUST return the structured
 * result; the server validates it (schema/caps/link allowlist) and applies it
 * through the journaled protocol. Malformed output is rejected and retryable —
 * nothing is applied. The live model call is injected (`setDaySynthesizer`) so
 * the deterministic orchestration is testable and the SDK stays out of the
 * dayScan core.
 */
export type DaySynthesizer = (input: {
  prompt: string;
  digest: DaySynthesisDigest;
}) => Promise<unknown>;

let synthesizer: DaySynthesizer | null = null;

/** Install the live synthesizer (read-only-allowlisted one-shot agent). Wired once at startup. */
export function setDaySynthesizer(fn: DaySynthesizer | null): void {
  synthesizer = fn;
}

export interface RunDaySynthesisOptions {
  store?: KnowledgeBaseStore;
  synthesizer?: DaySynthesizer;
  createTaskForCandidate?: (input: {
    candidateId: string;
    title: string;
    entryPath: string;
    candidate: MinutesCandidate;
  }) => string;
  runId?: string;
}

export type DaySynthesisRunResult =
  ({ ok: true } & SynthesisApplyResult) | { ok: false; errors: string[] };

/** Default Task creator for accepted minutes candidates (origin-tagged for self-exclusion). */
function defaultCreateTaskForCandidate(input: {
  candidateId: string;
  title: string;
  candidate: MinutesCandidate;
}): string {
  const { candidate } = input;
  const task = createTask({
    title: input.title || candidate.title,
    description: [candidate.action, candidate.context]
      .filter(Boolean)
      .join("\n\n"),
    ...(candidate.dueDate != null ? { dueDate: candidate.dueDate } : {}),
    externalLinks: [
      {
        url: `${DAY_SCAN_TASK_MARKER}/${input.candidateId}`,
        type: "source",
        source: "unknown",
        title: "Day scan",
      },
    ],
    source: { createdBy: "agent" },
  });
  return task.id;
}

/**
 * Run one synthesis pass for a day: build digest → run the synthesizer →
 * validate → apply through the journaled protocol. Independently retryable
 * from collection; a fresh call reconciles (resume-not-duplicate) via the
 * application journal.
 */
export async function runDaySynthesis(
  date: string,
  opts: RunDaySynthesisOptions = {},
): Promise<DaySynthesisRunResult> {
  const store = opts.store ?? new KnowledgeBaseStore();
  const synth = opts.synthesizer ?? synthesizer;
  if (!synth) throw new Error("No day synthesizer is configured.");

  const digest = await buildDaySynthesisDigest(store, date);
  const raw = await synth({ prompt: renderSynthesisPrompt(digest), digest });
  const validation = validateSynthesisResult(raw);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const runId = opts.runId ?? `${date}-synth-${randomUUID().slice(0, 8)}`;
  const applied = await applySynthesis({
    store,
    runId,
    date,
    result: validation.result,
    createTaskForCandidate:
      opts.createTaskForCandidate ?? defaultCreateTaskForCandidate,
  });
  return { ok: true, ...applied };
}
