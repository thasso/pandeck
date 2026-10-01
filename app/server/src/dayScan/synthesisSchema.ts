/**
 * The structured synthesis result contract (plan § "Synthesis — the
 * DaySynthesisRunner seam", Decision #1). The runner MUST return this shape;
 * the server validates it (section-id whitelist, length/count caps) and applies
 * it — free-form entry edits are never trusted. Malformed output is rejected and
 * retryable; nothing is applied. Links are NOT host-restricted: the collectors
 * and digest hand the runner trusted canonical URLs (Jira/GitHub/Google
 * Calendar/Slack/…) and the day report is meant to link them freely.
 */

/** Presentation-hierarchy section ids (plan § Presentation). `## Notes` is user-owned — never synthesized. */
export const SYNTHESIS_SECTION_IDS = [
  "needs-attention",
  "my-day",
  "projects",
  "decisions",
  "evidence",
] as const;
type SynthesisSectionId = (typeof SYNTHESIS_SECTION_IDS)[number];

const SECTION_TITLES: Record<SynthesisSectionId, string> = {
  "needs-attention": "Needs your attention",
  "my-day": "My day",
  projects: "Projects",
  decisions: "Decisions & actions",
  evidence: "Data health & evidence",
};

const MAX_SECTION_CHARS = 6000;
const MAX_SECTIONS = SYNTHESIS_SECTION_IDS.length;
const MAX_TASK_PROPOSALS = 40;
const MAX_THREAD_PROPOSALS = 40;
const MAX_TITLE_CHARS = 200;
const MAX_LINKS_PER_SECTION = 60;

export interface SynthesisSection {
  id: SynthesisSectionId;
  markdown: string;
}

/** Accept a minutes candidate as a Task (references the stable candidate id, never a URL). */
interface SynthesisTaskProposal {
  candidateId: string;
  title: string;
  accept: boolean;
}

/** A validated thread-store proposal; `baseRevision` is the revision it was computed against. */
export interface SynthesisThreadProposal {
  threadId: string | null;
  title: string;
  state: "active" | "waning" | "closed" | "archived";
  issueKeys: string[];
  summary: string;
  baseRevision: number;
}

export interface SynthesisResult {
  sections: SynthesisSection[];
  taskProposals: SynthesisTaskProposal[];
  threadProposals: SynthesisThreadProposal[];
}

export type ValidationResult =
  { ok: true; result: SynthesisResult } | { ok: false; errors: string[] };

const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Validate a raw runner result. Rejects unknown/duplicate section ids and
 * over-cap lengths/counts. Returns a normalized, trimmed `SynthesisResult` on
 * success. Links are not host-restricted (see the file header).
 */
export function validateSynthesisResult(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const root = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;

  const sections: SynthesisSection[] = [];
  const seenSections = new Set<string>();
  const rawSections = Array.isArray(root.sections) ? root.sections : [];
  if (rawSections.length > MAX_SECTIONS)
    errors.push(`Too many sections (${rawSections.length} > ${MAX_SECTIONS}).`);
  for (const item of rawSections) {
    const obj = (item && typeof item === "object" ? item : {}) as Record<
      string,
      unknown
    >;
    const id = str(obj.id);
    if (!SYNTHESIS_SECTION_IDS.includes(id as SynthesisSectionId)) {
      errors.push(
        `Unknown section id "${id}". Allowed: ${SYNTHESIS_SECTION_IDS.join(", ")}.`,
      );
      continue;
    }
    if (seenSections.has(id)) {
      errors.push(`Duplicate section id "${id}".`);
      continue;
    }
    seenSections.add(id);
    const markdown = str(obj.markdown);
    if (markdown.length > MAX_SECTION_CHARS)
      errors.push(`Section "${id}" exceeds ${MAX_SECTION_CHARS} chars.`);
    const linkCount = [...markdown.matchAll(LINK_RE)].length;
    if (linkCount > MAX_LINKS_PER_SECTION)
      errors.push(`Section "${id}" has too many links.`);
    sections.push({
      id: id as SynthesisSectionId,
      markdown: markdown.slice(0, MAX_SECTION_CHARS),
    });
  }

  const taskProposals: SynthesisTaskProposal[] = [];
  const rawTasks = Array.isArray(root.taskProposals) ? root.taskProposals : [];
  if (rawTasks.length > MAX_TASK_PROPOSALS)
    errors.push(
      `Too many task proposals (${rawTasks.length} > ${MAX_TASK_PROPOSALS}).`,
    );
  for (const item of rawTasks.slice(0, MAX_TASK_PROPOSALS)) {
    const obj = (item && typeof item === "object" ? item : {}) as Record<
      string,
      unknown
    >;
    const candidateId = str(obj.candidateId).trim();
    if (!candidateId) {
      errors.push("A task proposal is missing candidateId.");
      continue;
    }
    taskProposals.push({
      candidateId,
      title: str(obj.title).slice(0, MAX_TITLE_CHARS),
      accept: obj.accept === true,
    });
  }

  const threadProposals: SynthesisThreadProposal[] = [];
  const rawThreads = Array.isArray(root.threadProposals)
    ? root.threadProposals
    : [];
  if (rawThreads.length > MAX_THREAD_PROPOSALS)
    errors.push(
      `Too many thread proposals (${rawThreads.length} > ${MAX_THREAD_PROPOSALS}).`,
    );
  for (const item of rawThreads.slice(0, MAX_THREAD_PROPOSALS)) {
    const obj = (item && typeof item === "object" ? item : {}) as Record<
      string,
      unknown
    >;
    const state = str(obj.state);
    if (!["active", "waning", "closed", "archived"].includes(state)) {
      errors.push(`Thread proposal has an invalid state "${state}".`);
      continue;
    }
    const baseRevision =
      typeof obj.baseRevision === "number" && Number.isInteger(obj.baseRevision)
        ? obj.baseRevision
        : null;
    if (baseRevision === null) {
      errors.push("A thread proposal is missing an integer baseRevision.");
      continue;
    }
    threadProposals.push({
      threadId: str(obj.threadId).trim() || null,
      title: str(obj.title).slice(0, MAX_TITLE_CHARS),
      state: state as SynthesisThreadProposal["state"],
      issueKeys: Array.isArray(obj.issueKeys)
        ? obj.issueKeys
            .map((k) => str(k).trim())
            .filter(Boolean)
            .slice(0, 40)
        : [],
      summary: str(obj.summary).slice(0, 1000),
      baseRevision,
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, result: { sections, taskProposals, threadProposals } };
}

/** Render validated sections into the day entry's narrative region (server-owned template). */
export function renderNarrative(sections: SynthesisSection[]): string {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const lines: string[] = [];
  for (const id of SYNTHESIS_SECTION_IDS) {
    const section = byId.get(id);
    if (!section || !section.markdown.trim()) continue;
    lines.push(`## ${SECTION_TITLES[id]}`, "", section.markdown.trim(), "");
  }
  return lines.join("\n").trim();
}
