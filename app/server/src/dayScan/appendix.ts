import type { DayRollup } from "./salience.ts";
import type { DayRunManifest, DaySourceDelta } from "./types.ts";

export const DATA_REGION_START = "<!-- day-scan:data:start -->";
export const DATA_REGION_END = "<!-- day-scan:data:end -->";
export const NARRATIVE_REGION_START = "<!-- day-scan:narrative:start -->";
export const NARRATIVE_REGION_END = "<!-- day-scan:narrative:end -->";
const NOTES_HEADING = "## Notes";

/**
 * The machine appendix is SLIM: coverage, counts, and compact evidence
 * indexes — never a duplicate of all snapshot rows (those live in the
 * committed source assets, readable via kb_read_asset).
 */
export function renderMachineAppendix(
  manifest: DayRunManifest,
  rollup: DayRollup,
  deltas: DaySourceDelta[],
): string {
  const lines: string[] = [
    DATA_REGION_START,
    "",
    "## Data",
    "",
    `As of ${manifest.asOf} — run \`${manifest.runId}\` (mapping \`${rollup.mappingVersion}\`).`,
    "",
  ];

  // Compact lists (not wide tables) so the appendix stays readable on mobile.
  lines.push("### Source health", "");
  for (const source of manifest.sources) {
    if (source.disposition === "skipped") {
      lines.push(
        `- **${source.label}** — skipped (${source.skipReason ?? "?"})`,
      );
      continue;
    }
    const parts = [source.result ?? "—"];
    if (source.factCount !== undefined) parts.push(`${source.factCount} facts`);
    if (source.added !== undefined)
      parts.push(`+${source.added}/~${source.changed ?? 0}`);
    if (source.error) parts.push(`error: ${source.error}`);
    lines.push(`- **${source.label}** — ${parts.join(" · ")}`);
  }

  const changed = deltas.filter(
    (d) => d.added.length + d.changed.length + d.noLongerObserved.length > 0,
  );
  if (changed.length > 0) {
    lines.push("", "### Changes since last run", "");
    for (const delta of changed) {
      const parts = [
        delta.added.length ? `${delta.added.length} added` : null,
        delta.changed.length ? `${delta.changed.length} changed` : null,
        delta.noLongerObserved.length
          ? `${delta.noLongerObserved.length} no longer observed`
          : null,
        delta.suppressedNegative ? "absence conclusions suppressed" : null,
      ].filter(Boolean);
      lines.push(`- **${delta.source}**: ${parts.join(", ")}.`);
    }
  }

  if (rollup.buckets.length > 0) {
    lines.push("", "### Activity by project", "");
    for (const bucket of rollup.buckets.slice(0, 15)) {
      const stats = [`${bucket.stats.facts} facts`];
      if (bucket.stats.transitions)
        stats.push(`${bucket.stats.transitions} transitions`);
      if (bucket.stats.own) stats.push(`${bucket.stats.own} own`);
      lines.push(
        `- **${oneLine(bucket.label)}**${bucket.unmapped ? " _(unmapped)_" : ""} — ${stats.join(" · ")}`,
      );
      // Top evidence as short nested links (the URL stays hidden behind the
      // headline text, so it reads cleanly on a narrow screen).
      for (const item of bucket.items.slice(0, 3)) {
        lines.push(
          `  - ${item.links[0] ? `[${oneLine(item.headline)}](${item.links[0]})` : oneLine(item.headline)}`,
        );
      }
    }
    if (rollup.suppressed.bots + rollup.suppressed.routine > 0) {
      lines.push(
        "",
        `Suppressed: ${rollup.suppressed.bots} bot facts, ${rollup.suppressed.routine} routine-churn facts.`,
      );
    }
  }

  lines.push("", DATA_REGION_END);
  return lines.join("\n");
}

function oneLine(text: string): string {
  return text.replaceAll("\n", " ").trim();
}

/** A brand-new day entry: valid frontmatter, empty narrative, machine region, user-owned Notes. */
export function skeletonEntry(date: string, appendix: string): string {
  const now = new Date().toISOString();
  return [
    "---",
    "kb:",
    "  schema: 1",
    `  id: daily-summary-${date}`,
    "  type: daily-summary",
    `  title: "Daily summary ${date}"`,
    "  status: active",
    `  createdAt: "${now}"`,
    `  updatedAt: "${now}"`,
    "  tags:",
    "    - daily-summary",
    `    - "${date}"`,
    "---",
    `# Daily summary ${date}`,
    "",
    NARRATIVE_REGION_START,
    "",
    "<!-- Narrative sections are written by the day synthesis run. -->",
    "",
    NARRATIVE_REGION_END,
    "",
    appendix,
    "",
    NOTES_HEADING,
    "",
    "<!-- User-owned notes. The day scanner and synthesis never touch this section. -->",
    "",
  ].join("\n");
}

/**
 * Rewrite ONLY the synthesis narrative region of a day entry (server-owned;
 * written by the DaySynthesisRunner apply step). The data region, frontmatter,
 * and user-owned `## Notes` are never touched. A document without narrative
 * markers is returned unchanged (the collection skeleton always adds them).
 */
export function applyNarrativeRegion(
  document: string,
  narrative: string,
): string {
  const start = document.indexOf(NARRATIVE_REGION_START);
  const end = document.indexOf(NARRATIVE_REGION_END);
  if (start === -1 || end === -1 || end < start) return document;
  const block = `${NARRATIVE_REGION_START}\n\n${narrative.trim()}\n\n${NARRATIVE_REGION_END}`;
  return (
    document.slice(0, start) +
    block +
    document.slice(end + NARRATIVE_REGION_END.length)
  );
}

/**
 * Rewrite ONLY the machine data region of an existing entry document. User
 * content, narrative sections, frontmatter, and `## Notes` stay untouched.
 * A document without markers gets the region appended before `## Notes`
 * (or at the end).
 */
export function applyMachineRegion(document: string, appendix: string): string {
  const start = document.indexOf(DATA_REGION_START);
  const end = document.indexOf(DATA_REGION_END);
  if (start !== -1 && end !== -1 && end > start) {
    return (
      document.slice(0, start) +
      appendix +
      document.slice(end + DATA_REGION_END.length)
    );
  }
  const notesIdx = document.indexOf(`\n${NOTES_HEADING}`);
  if (notesIdx !== -1) {
    return `${document.slice(0, notesIdx)}\n${appendix}\n${document.slice(notesIdx)}`;
  }
  return `${document.trimEnd()}\n\n${appendix}\n`;
}
