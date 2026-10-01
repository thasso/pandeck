import { createHash } from "node:crypto";

/**
 * Minutes curation core (plan § "Minutes extraction & curation"). Pure over
 * inputs — no fetching, no agent runs, no KB writes — so cache-key gating,
 * candidate identity/reconciliation, and meeting-entry rendering are all
 * deterministic and testable. The orchestrator (`minutesRun.ts`) wires the
 * metered extractor and the atomic KB/ledger commit around these functions.
 */

/** Bump to invalidate every cached extraction even on unchanged documents. */
const MINUTES_EXTRACTOR_VERSION = "1";
/** Bump when curation (reconciliation/rendering) changes so caches re-run. */
const MINUTES_CURATOR_VERSION = "1";

type MinutesConfidence = "high" | "medium" | "low";

/**
 * Candidate lifecycle. `superseded` marks an action that vanished from a later
 * extraction of the same document; its id and any Task link are preserved so a
 * reappearance reconciles back rather than duplicating.
 */
type MinutesCandidateStatus =
  "proposed" | "accepted" | "task-created" | "rejected" | "superseded";

/** One extracted action before it is reconciled against prior curation state. */
export interface FreshCandidate {
  title: string;
  action: string;
  context: string;
  ownerReason: string;
  confidence: MinutesConfidence;
  dueDate: string | null;
  snippet: string;
}

/**
 * A persisted candidate. `id` is stable across document edits (source id +
 * canonical action key), so unrelated edits keep the id, Task link, and status.
 * The content hash is version metadata only — never part of the identity.
 */
export interface MinutesCandidate {
  id: string;
  sourceId: string;
  /** Normalized action identity used to match across re-extractions. */
  actionKey: string;
  title: string;
  action: string;
  context: string;
  ownerReason: string;
  confidence: MinutesConfidence;
  dueDate: string | null;
  snippet: string;
  status: MinutesCandidateStatus;
  /** Linked Task id once a Task is created/accepted for this candidate. */
  taskId: string | null;
  firstObservedHash: string;
  lastObservedHash: string;
  firstObservedAt: string;
  lastObservedAt: string;
}

/**
 * The composite cache key: reprocessing is skipped ONLY when content AND all
 * implementation versions match. Bumping any version re-runs extraction on
 * unchanged documents (extractor fixes, curator changes, mapping corrections).
 */
export interface MinutesCacheKey {
  contentHash: string;
  extractorVersion: string;
  curatorVersion: string;
  mappingVersion: string;
}

export function buildCacheKey(
  contentHash: string,
  mappingVersion: string,
): MinutesCacheKey {
  return {
    contentHash,
    extractorVersion: MINUTES_EXTRACTOR_VERSION,
    curatorVersion: MINUTES_CURATOR_VERSION,
    mappingVersion,
  };
}

/** True when a persisted key exactly matches a freshly computed one (all four dimensions). */
export function cacheKeyMatches(
  a: MinutesCacheKey | undefined,
  b: MinutesCacheKey,
): boolean {
  return Boolean(
    a &&
    a.contentHash === b.contentHash &&
    a.extractorVersion === b.extractorVersion &&
    a.curatorVersion === b.curatorVersion &&
    a.mappingVersion === b.mappingVersion,
  );
}

/** Normalized action identity: lowercased, punctuation-stripped, whitespace-collapsed title. */
export function canonicalActionKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function candidateId(sourceId: string, actionKey: string): string {
  return `mc_${createHash("sha1").update(`${sourceId}\u0000${actionKey}`).digest("hex").slice(0, 12)}`;
}

/**
 * Reconcile a fresh extraction against prior candidates for the SAME source:
 * matched actions keep their id, Task link, and status (only content refreshes);
 * actions absent from the fresh set are marked `superseded` (id/Task preserved);
 * genuinely new actions get new ids as `proposed`. Candidate-level, not URL-level.
 */
export function reconcileCandidates(
  prior: MinutesCandidate[],
  fresh: FreshCandidate[],
  opts: { sourceId: string; contentHash: string; observedAt: string },
): MinutesCandidate[] {
  const priorById = new Map(prior.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out: MinutesCandidate[] = [];

  for (const item of fresh) {
    const actionKey = canonicalActionKey(item.title);
    const id = candidateId(opts.sourceId, actionKey);
    if (seen.has(id)) continue; // de-dup within one extraction
    seen.add(id);
    const existing = priorById.get(id);
    if (existing) {
      out.push({
        ...existing,
        // Content refreshes; identity, Task link, and acceptance state persist.
        title: item.title,
        action: item.action,
        context: item.context,
        ownerReason: item.ownerReason,
        confidence: item.confidence,
        dueDate: item.dueDate,
        snippet: item.snippet,
        // A previously superseded action that reappears returns to proposed.
        status: existing.status === "superseded" ? "proposed" : existing.status,
        lastObservedHash: opts.contentHash,
        lastObservedAt: opts.observedAt,
      });
    } else {
      out.push({
        id,
        sourceId: opts.sourceId,
        actionKey,
        title: item.title,
        action: item.action,
        context: item.context,
        ownerReason: item.ownerReason,
        confidence: item.confidence,
        dueDate: item.dueDate,
        snippet: item.snippet,
        status: "proposed",
        taskId: null,
        firstObservedHash: opts.contentHash,
        lastObservedHash: opts.contentHash,
        firstObservedAt: opts.observedAt,
        lastObservedAt: opts.observedAt,
      });
    }
  }

  // Prior candidates no longer extracted: superseded, id + Task link preserved.
  for (const existing of prior) {
    if (seen.has(existing.id)) continue;
    out.push(
      existing.status === "superseded"
        ? existing
        : { ...existing, status: "superseded" },
    );
  }
  return out;
}

/**
 * Task proposal policy: under `auto`, HIGH and MEDIUM candidates auto-create
 * Tasks; only LOW confidence requires explicit user acceptance. Under `review`,
 * everything requires acceptance. A candidate that already has a Task, is
 * rejected, or is superseded never auto-creates.
 */
export function shouldAutoCreateTask(
  candidate: MinutesCandidate,
  policy: "auto" | "review",
): boolean {
  if (
    candidate.taskId ||
    candidate.status === "rejected" ||
    candidate.status === "superseded" ||
    candidate.status === "task-created"
  )
    return false;
  return policy === "auto" && candidate.confidence !== "low";
}

// ---------------------------------------------------------------------------
// Meeting entry identity + rendering
// ---------------------------------------------------------------------------

const GENERATED_START = "<!-- day-scan:minutes:start -->";
const GENERATED_END = "<!-- day-scan:minutes:end -->";
const MINUTES_NOTES_HEADING = "## Notes";

export {
  GENERATED_START as MINUTES_REGION_START,
  GENERATED_END as MINUTES_REGION_END,
};

/** URL/path-safe slug from a meeting title, bounded and collision-tolerant. */
function meetingSlug(title: string): string {
  const slug = canonicalActionKey(title)
    .replace(/\s+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  return slug || "meeting";
}

/** Short stable suffix from the source id keeps same-title meetings distinct. */
function meetingSourceSuffix(sourceId: string): string {
  return createHash("sha1").update(sourceId).digest("hex").slice(0, 8);
}

/**
 * Collision-safe per-meeting entry path anchored to the MEETING day (not the
 * observation day): `meetings/<date>-<slug>-<source-suffix>`.
 */
export function meetingEntryPath(
  meetingDate: string,
  title: string,
  sourceId: string,
): string {
  return `meetings/${meetingDate}-${meetingSlug(title)}-${meetingSourceSuffix(sourceId)}`;
}

/** Stable kb.id derived from the source id (survives title/slug changes). */
export function meetingEntryId(sourceId: string): string {
  return `meeting-${meetingSourceSuffix(sourceId)}`;
}

export interface MeetingEntryInput {
  meetingDate: string;
  title: string;
  sourceId: string;
  sourceLink: string;
  meetingSummary: string | null;
  candidates: MinutesCandidate[];
  observedLate: boolean;
  /** True when the full minutes/transcript is stored at the entry-local `assets/minutes.md`. */
  fullMinutes?: boolean;
}

/** Entry-local asset holding the full (bounded) minutes/transcript for a meeting entry. */
export const MEETING_FULL_MINUTES_ASSET = "assets/minutes.md";

function renderGeneratedRegion(input: MeetingEntryInput): string {
  const lines: string[] = [GENERATED_START, ""];
  if (input.meetingSummary) lines.push(input.meetingSummary.trim(), "");
  if (input.observedLate)
    lines.push(
      `> Late-arriving minutes anchored to the meeting day ${input.meetingDate}.`,
      "",
    );
  lines.push(
    `Source: [minutes](${input.sourceLink})${input.fullMinutes ? ` · [full minutes & transcript](${MEETING_FULL_MINUTES_ASSET})` : ""}`,
    "",
  );
  const active = input.candidates.filter(
    (c) => c.status !== "superseded" && c.status !== "rejected",
  );
  if (active.length > 0) {
    lines.push("### Action candidates", "");
    for (const c of active) {
      const bits = [`**${c.title}**`, `_(${c.confidence}`];
      bits[1] += c.taskId ? `, task ${c.taskId})_` : `)_`;
      lines.push(`- ${bits.join(" ")}: ${c.action.trim()}`);
    }
    lines.push("");
  }
  lines.push(GENERATED_END);
  return lines.join("\n");
}

/** A brand-new meeting entry: frontmatter, generated region, user-owned Notes. */
export function renderMeetingEntry(input: MeetingEntryInput): string {
  const now = new Date().toISOString();
  return [
    "---",
    "kb:",
    "  schema: 1",
    `  id: ${meetingEntryId(input.sourceId)}`,
    "  type: note",
    `  title: "${input.title.replace(/"/g, "'")} — ${input.meetingDate}"`,
    "  status: active",
    `  createdAt: "${now}"`,
    `  updatedAt: "${now}"`,
    "  tags:",
    "    - meeting-minutes",
    `    - "${input.meetingDate}"`,
    "---",
    `# ${input.title} — ${input.meetingDate}`,
    "",
    renderGeneratedRegion(input),
    "",
    MINUTES_NOTES_HEADING,
    "",
    "<!-- User-owned notes. Re-curation never touches this section. -->",
    "",
  ].join("\n");
}

/** Rewrite ONLY the generated region of an existing meeting entry; Notes/frontmatter untouched. */
export function applyMeetingRegion(
  document: string,
  input: MeetingEntryInput,
): string {
  const region = renderGeneratedRegion(input);
  const start = document.indexOf(GENERATED_START);
  const end = document.indexOf(GENERATED_END);
  if (start !== -1 && end !== -1 && end > start) {
    return (
      document.slice(0, start) +
      region +
      document.slice(end + GENERATED_END.length)
    );
  }
  const notesIdx = document.indexOf(`\n${MINUTES_NOTES_HEADING}`);
  if (notesIdx !== -1)
    return `${document.slice(0, notesIdx)}\n${region}\n${document.slice(notesIdx)}`;
  return `${document.trimEnd()}\n\n${region}\n`;
}
