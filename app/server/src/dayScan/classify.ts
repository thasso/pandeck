import { createHash } from "node:crypto";
import type { ProjectRecord } from "@assistant/shared";
import { listProjects } from "../projectRegistry.ts";
import { parseRemoteUrl } from "../gitHosting.ts";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import type { CorrelatedFact } from "./correlate.ts";

type ClassificationSource =
  | "override"
  | "registry-jira"
  | "registry-git"
  | "registry-jira-weak"
  | "heuristic"
  | "unmapped";
type ClassificationConfidence = "high" | "medium" | "low" | "none";

export interface FactClassification {
  /** Registry project id when mapped; null in heuristic/unmapped buckets. */
  projectId: string | null;
  /** Bucket key the rollup groups by: a project id, `jira:<KEY>`, `repo:<name>`, or `unmapped`. */
  bucket: string;
  label: string;
  confidence: ClassificationConfidence;
  source: ClassificationSource;
  /** Secondary theme/customer/support dimensions (KB overlay). */
  secondary: string[];
}

/** Optional KB overlay: adds themes/many-to-one overrides, never duplicates registry facts. */
interface MappingOverride {
  jiraProject?: string;
  repo?: string;
  projectId?: string;
  bucket?: string;
  label?: string;
  secondary?: string[];
}

export const MAPPING_OVERLAY_ASSET =
  "references/day-scan-project-mapping/assets/mapping.json";

interface MappingIndex {
  version: string;
  overridesByJira: Map<string, MappingOverride>;
  overridesByRepo: Map<string, MappingOverride>;
  jiraStrong: Map<string, ProjectRecord>;
  jiraWeak: Map<string, ProjectRecord>;
  repos: Map<string, ProjectRecord>;
  labels: Map<string, string>;
}

/**
 * Deterministic mapping precedence (plan § Project classification): KB
 * overrides → registry primary Jira links → registry repoUrl →
 * registry related/fallback links → heuristic bucket → Unmapped. The mapping
 * version (hash of all inputs) lands in the run manifest; historical
 * summaries are never rewritten when it changes.
 */
export async function buildMappingIndex(
  opts: { store?: KnowledgeBaseStore; projects?: ProjectRecord[] } = {},
): Promise<MappingIndex> {
  const projects = opts.projects ?? listProjects();
  const index: MappingIndex = {
    version: "",
    overridesByJira: new Map(),
    overridesByRepo: new Map(),
    jiraStrong: new Map(),
    jiraWeak: new Map(),
    repos: new Map(),
    labels: new Map(),
  };
  for (const project of projects) {
    index.labels.set(project.id, project.name);
    for (const link of project.jira ?? []) {
      const key =
        link.projectKey?.toUpperCase() ??
        (link.issueKey
          ? link.issueKey.split("-")[0]?.toUpperCase()
          : undefined);
      if (!key) continue;
      const role = link.role ?? "related";
      // Primary/related map strongly; fallback/historical/customer are weak hints.
      const strong = role === "primary" || role === "related";
      const target = strong ? index.jiraStrong : index.jiraWeak;
      if (!target.has(key) || role === "primary") target.set(key, project);
    }
    const remotes = [project.repoUrl].filter((r): r is string => Boolean(r));
    for (const remote of remotes) {
      const parsed = parseRemoteUrl(remote);
      if (parsed)
        index.repos.set(
          `${parsed.owner}/${parsed.repo}`.toLowerCase(),
          project,
        );
    }
  }

  // KB overlay (optional; absence is normal).
  let overlayRaw = "";
  try {
    const store = opts.store ?? new KnowledgeBaseStore();
    overlayRaw = await store.readEntryFile(MAPPING_OVERLAY_ASSET);
    const overlay = JSON.parse(overlayRaw) as { overrides?: MappingOverride[] };
    for (const override of overlay.overrides ?? []) {
      if (override.jiraProject)
        index.overridesByJira.set(override.jiraProject.toUpperCase(), override);
      if (override.repo)
        index.overridesByRepo.set(override.repo.toLowerCase(), override);
    }
  } catch {
    /* no overlay entry */
  }

  index.version = createHash("sha1")
    .update(
      JSON.stringify(
        projects.map((p) => ({
          id: p.id,
          jira: p.jira ?? [],
          repoUrl: p.repoUrl ?? null,
        })),
      ),
    )
    .update(overlayRaw)
    .digest("hex")
    .slice(0, 12);
  return index;
}

function fromOverride(
  override: MappingOverride,
  index: MappingIndex,
): FactClassification {
  const projectId = override.projectId ?? null;
  const bucket = override.bucket ?? projectId ?? "unmapped";
  return {
    projectId,
    bucket,
    label:
      override.label ??
      (projectId ? (index.labels.get(projectId) ?? projectId) : bucket),
    confidence: "high",
    source: "override",
    secondary: override.secondary ?? [],
  };
}

function fromProject(
  project: ProjectRecord,
  source: ClassificationSource,
  confidence: ClassificationConfidence,
): FactClassification {
  return {
    projectId: project.id,
    bucket: project.id,
    label: project.name,
    confidence,
    source,
    secondary: [],
  };
}

/** Classify one correlated fact: ONE primary bucket plus secondary dimensions. */
export function classifyFact(
  item: CorrelatedFact,
  index: MappingIndex,
): FactClassification {
  for (const key of item.projectKeys) {
    const override = index.overridesByJira.get(key.toUpperCase());
    if (override) return fromOverride(override, index);
  }
  if (item.repo) {
    const override = index.overridesByRepo.get(item.repo.toLowerCase());
    if (override) return fromOverride(override, index);
  }
  for (const key of item.projectKeys) {
    const project = index.jiraStrong.get(key.toUpperCase());
    if (project) return fromProject(project, "registry-jira", "high");
  }
  if (item.repo) {
    const project = index.repos.get(item.repo.toLowerCase());
    if (project) return fromProject(project, "registry-git", "high");
  }
  for (const key of item.projectKeys) {
    const project = index.jiraWeak.get(key.toUpperCase());
    if (project) return fromProject(project, "registry-jira-weak", "low");
  }
  // Heuristic buckets keep unmapped activity visible without inventing projects.
  const jiraKey = item.projectKeys[0];
  if (jiraKey)
    return {
      projectId: null,
      bucket: `jira:${jiraKey}`,
      label: `Jira ${jiraKey}`,
      confidence: "low",
      source: "heuristic",
      secondary: [],
    };
  if (item.repo)
    return {
      projectId: null,
      bucket: `repo:${item.repo}`,
      label: item.repo,
      confidence: "low",
      source: "heuristic",
      secondary: [],
    };
  return {
    projectId: null,
    bucket: "unmapped",
    label: "Unmapped",
    confidence: "none",
    source: "unmapped",
    secondary: [],
  };
}
