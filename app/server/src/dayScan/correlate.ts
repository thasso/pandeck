import type { DayScanIdentities } from "@assistant/shared";
import type { DaySourceFact, DaySourceKey } from "./types.ts";

/** Layer-2 output: one fact enriched with cross-source joins and own-identity resolution. */
export interface CorrelatedFact {
  source: DaySourceKey;
  fact: DaySourceFact;
  /** Jira issue keys referenced by this fact (native field or extracted from text/refs). */
  issueKeys: string[];
  /** Jira project key prefixes derived from `issueKeys` + native projectKey fields. */
  projectKeys: string[];
  /** GitHub `owner/repo` when the fact carries one. */
  repo: string | null;
  /** Resolved against the configured identity mappings (or collector-tagged "own"). */
  own: boolean;
}

const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;

/** Extract Jira issue keys from free text (titles, branch refs). */
export function extractIssueKeys(text: string | null | undefined): string[] {
  if (!text) return [];
  const keys = new Set<string>();
  for (const match of text.matchAll(ISSUE_KEY_RE))
    keys.add(`${match[1]}-${match[2]}`);
  return [...keys];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Correlation/enrichment layer: joins GitHub references and Tempo worklogs to
 * Jira issues via issue keys, and resolves "me" via the identity mappings.
 * Pure over collected facts — no fetching.
 */
export function correlateFacts(
  snapshots: Array<{ source: DaySourceKey; facts: DaySourceFact[] }>,
  identities: DayScanIdentities,
): CorrelatedFact[] {
  const out: CorrelatedFact[] = [];
  for (const { source, facts } of snapshots) {
    for (const fact of facts) {
      const data = fact.data ?? {};
      const issueKeys = new Set<string>();
      const nativeIssueKey = str(data.issueKey);
      if (nativeIssueKey) issueKeys.add(nativeIssueKey);
      if (source === "jira" && fact.id.startsWith("jira:")) {
        const key = fact.id.split(":")[1];
        if (key && /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(key)) issueKeys.add(key);
      }
      // Text-extracted references (branch refs, titles) join GitHub → Jira.
      for (const key of extractIssueKeys(str(data.ref))) issueKeys.add(key);
      for (const key of extractIssueKeys(fact.title)) issueKeys.add(key);

      const projectKeys = new Set<string>();
      const nativeProject = str(data.projectKey);
      if (nativeProject) projectKeys.add(nativeProject);
      for (const key of issueKeys) projectKeys.add(key.split("-")[0]!);

      const repo = str(data.repo);
      const own =
        (fact.tags ?? []).includes("own") ||
        Boolean(
          identities.githubLogin && fact.actor === identities.githubLogin,
        ) ||
        Boolean(
          identities.googleEmail && fact.actor === identities.googleEmail,
        );

      out.push({
        source,
        fact,
        issueKeys: [...issueKeys],
        projectKeys: [...projectKeys],
        repo,
        own,
      });
    }
  }
  return out;
}

/** Issue keys that appear in more than one source (cross-source corroboration). */
export function corroboratedIssueKeys(facts: CorrelatedFact[]): Set<string> {
  const seenBySource = new Map<string, Set<DaySourceKey>>();
  for (const item of facts) {
    for (const key of item.issueKeys) {
      const sources = seenBySource.get(key) ?? new Set();
      sources.add(item.source);
      seenBySource.set(key, sources);
    }
  }
  return new Set(
    [...seenBySource.entries()]
      .filter(([, sources]) => sources.size > 1)
      .map(([key]) => key),
  );
}
