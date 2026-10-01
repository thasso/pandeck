import { createHash } from "node:crypto";
import type { SynthesisThreadProposal } from "./synthesisSchema.ts";

/**
 * Ongoing-threads structured store (plan § "Ongoing threads"). The threads
 * entry's Markdown is a PROJECTION; this JSON asset is the source of truth:
 * stable thread ids, lifecycle states, merge/dedup by referenced issue keys,
 * and a monotonically increasing revision. Validated proposals are applied
 * AUTOMATICALLY under the application protocol; each proposal references the
 * revision it was computed against, and a stale revision rejects it (the
 * synthesis run re-proposes it next time rather than clobbering a newer state).
 */

type ThreadState = "active" | "waning" | "closed" | "archived";

interface ThreadRecord {
  id: string;
  title: string;
  state: ThreadState;
  issueKeys: string[];
  summary: string;
  updatedAt: string;
}

export interface ThreadsDoc {
  revision: number;
  threads: ThreadRecord[];
}

export const THREADS_ENTRY_PATH = "references/ongoing-threads";
export const THREADS_ASSET_PATH = `${THREADS_ENTRY_PATH}/assets/threads.json`;

export function emptyThreadsDoc(): ThreadsDoc {
  return { revision: 0, threads: [] };
}

export function parseThreadsDoc(raw: string | null): ThreadsDoc {
  if (!raw) return emptyThreadsDoc();
  try {
    const parsed = JSON.parse(raw) as Partial<ThreadsDoc>;
    return {
      revision: typeof parsed.revision === "number" ? parsed.revision : 0,
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
    };
  } catch {
    return emptyThreadsDoc();
  }
}

function threadId(title: string, issueKeys: string[]): string {
  const seed =
    issueKeys.length > 0
      ? [...issueKeys].sort().join(",")
      : title.toLowerCase().trim();
  return `th_${createHash("sha1").update(seed).digest("hex").slice(0, 10)}`;
}

/** Find an existing thread a new proposal should merge into (by id, then by shared issue key). */
function findMergeTarget(
  doc: ThreadsDoc,
  proposal: SynthesisThreadProposal,
): ThreadRecord | undefined {
  if (proposal.threadId)
    return doc.threads.find((t) => t.id === proposal.threadId);
  if (proposal.issueKeys.length === 0) return undefined;
  const keys = new Set(proposal.issueKeys);
  return doc.threads.find((t) => t.issueKeys.some((k) => keys.has(k)));
}

export interface ThreadApplyResult {
  next: ThreadsDoc;
  applied: string[];
  /** Proposal identities rejected because their `baseRevision` was stale. */
  rejectedStale: SynthesisThreadProposal[];
  changed: boolean;
}

/**
 * Apply validated thread proposals idempotently against the current doc. Each
 * proposal must carry the current `revision` as its `baseRevision`; a mismatch
 * rejects it as stale (re-proposed next run). Applying any proposal bumps the
 * revision exactly once, so re-running the SAME proposals against the bumped
 * doc rejects them (idempotency: no double-apply).
 */
export function applyThreadProposals(
  current: ThreadsDoc,
  proposals: SynthesisThreadProposal[],
  now: string,
): ThreadApplyResult {
  const next: ThreadsDoc = {
    revision: current.revision,
    threads: current.threads.map((t) => ({ ...t })),
  };
  const applied: string[] = [];
  const rejectedStale: SynthesisThreadProposal[] = [];

  for (const proposal of proposals) {
    if (proposal.baseRevision !== current.revision) {
      rejectedStale.push(proposal);
      continue;
    }
    const target = findMergeTarget(next, proposal);
    if (target) {
      target.title = proposal.title || target.title;
      target.state = proposal.state;
      target.summary = proposal.summary;
      target.issueKeys = [
        ...new Set([...target.issueKeys, ...proposal.issueKeys]),
      ];
      target.updatedAt = now;
      applied.push(target.id);
    } else {
      const id =
        proposal.threadId ?? threadId(proposal.title, proposal.issueKeys);
      if (next.threads.some((t) => t.id === id)) {
        // A same-id thread exists but did not match merge (e.g. explicit id to a
        // closed thread); treat as an update to keep ids stable.
        const existing = next.threads.find((t) => t.id === id)!;
        existing.title = proposal.title || existing.title;
        existing.state = proposal.state;
        existing.summary = proposal.summary;
        existing.issueKeys = [
          ...new Set([...existing.issueKeys, ...proposal.issueKeys]),
        ];
        existing.updatedAt = now;
        applied.push(id);
      } else {
        next.threads.push({
          id,
          title: proposal.title,
          state: proposal.state,
          issueKeys: proposal.issueKeys,
          summary: proposal.summary,
          updatedAt: now,
        });
        applied.push(id);
      }
    }
  }

  const changed = applied.length > 0;
  if (changed) next.revision = current.revision + 1;
  return { next, applied, rejectedStale, changed };
}

/** Server-owned Markdown projection of the threads store (the entry body is generated). */
export function renderThreadsEntry(doc: ThreadsDoc): string {
  const now = new Date().toISOString();
  const order: ThreadState[] = ["active", "waning", "closed", "archived"];
  const lines: string[] = [
    "---",
    "kb:",
    "  schema: 1",
    "  id: ongoing-threads",
    "  type: reference",
    '  title: "Ongoing threads"',
    "  status: active",
    `  createdAt: "${now}"`,
    `  updatedAt: "${now}"`,
    "  tags:",
    "    - day-scan",
    "    - ongoing-threads",
    "---",
    "# Ongoing threads",
    "",
    `<!-- Generated projection of the threads store (revision ${doc.revision}). -->`,
    "",
  ];
  const active = doc.threads.filter((t) => t.state !== "archived");
  if (active.length === 0) lines.push("No active threads.");
  for (const state of order) {
    const inState = doc.threads.filter((t) => t.state === state);
    if (inState.length === 0) continue;
    lines.push(`## ${state[0]!.toUpperCase()}${state.slice(1)}`, "");
    for (const thread of inState) {
      const keys = thread.issueKeys.length
        ? ` (${thread.issueKeys.join(", ")})`
        : "";
      lines.push(`- **${thread.title}**${keys}: ${thread.summary}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}
