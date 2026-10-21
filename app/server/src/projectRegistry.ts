import { existsSync } from "node:fs";
import { isAbsolute, normalize, sep } from "node:path";
import { incoming } from "./db/links.ts";
import type {
  ProjectSummary,
  StateDigestEntry,
  StateEvent,
} from "@assistant/shared";
import { projectSummaryOf } from "@assistant/shared";
import { notifyTaskChange } from "./tasks.ts";
import {
  projectNode,
  projectStore,
  type Project,
  type ProjectJiraLink,
  type ProjectJiraLinkRole,
  type ProjectLocalPath,
  type ProjectLocalPathKind,
  type ProjectLocalPathMatch,
  type ProjectStatus,
} from "./db/projectStore.ts";

/**
 * Domain layer over {@link ./db/projectStore.ts}: normalization, validation, and
 * the read-only lookup/scoring engine. Persistence (SQLite rows, child tables,
 * and graph edges) lives entirely in the store; this module owns none of it.
 */

export type { ProjectStatus, ProjectLocalPath, ProjectJiraLink };

/** Legacy type aliases kept for existing call sites. */
export type LocalPathKind = ProjectLocalPathKind;
export type LocalPathMatch = ProjectLocalPathMatch;
export type JiraLinkRole = ProjectJiraLinkRole;

/** A project record is the fully assembled store shape without sync metadata. */
export type ProjectRecord = Omit<Project, "revision">;

export interface ProjectRegistryFile {
  version: 1;
  projects: ProjectRecord[];
}

type ProjectMatchConfidence = "strong" | "medium" | "weak";

export interface ProjectMatch {
  project: ProjectRecord;
  confidence: ProjectMatchConfidence;
  score: number;
  matchedBy: string[];
  warnings: string[];
}

export interface ProjectLookupInput {
  id?: string;
  query?: string;
  path?: string;
  branch?: string;
  jiraKey?: string;
  tag?: string;
  status?: ProjectStatus;
  includeArchived?: boolean;
  maxResults?: number;
}

const ISSUE_KEY_RE = /^([A-Z][A-Z0-9]+)-(\d+)$/;
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]+$/;
const DISPLAY_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/* --------------------------------- reads --------------------------------- */

function recordOf(project: Project): ProjectRecord {
  const { revision: _revision, ...record } = project;
  return record;
}

/** Adapter that presents the store contents in the legacy registry shape. */
export function readProjectRegistry(): ProjectRegistryFile {
  return {
    version: 1,
    projects: projectStore.list({ includeArchived: true }).map(recordOf),
  };
}

export function listProjects(input: ProjectLookupInput = {}): ProjectRecord[] {
  const query = normalizeSearchText(input.query);
  const tag = input.tag?.trim().toLowerCase();
  return projectStore
    .list({
      ...(input.includeArchived !== undefined
        ? { includeArchived: input.includeArchived }
        : {}),
    })
    .map(recordOf)
    .filter((project) => !input.status || project.status === input.status)
    .filter(
      (project) =>
        !tag ||
        (project.tags ?? []).some((value) => value.toLowerCase() === tag),
    )
    .filter(
      (project) => !query || projectSearchHaystack(project).includes(query),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getProject(id: string): ProjectRecord | null {
  const project = projectStore.get(normalizeId(id));
  return project ? recordOf(project) : null;
}

export function lookupProjects(input: ProjectLookupInput): ProjectMatch[] {
  const maxResults = clamp(input.maxResults ?? 10, 1, 50);
  const matches = new Map<string, ProjectMatch>();
  const candidates = projectStore
    .list({
      ...(input.includeArchived !== undefined
        ? { includeArchived: input.includeArchived }
        : {}),
    })
    .map(recordOf);

  for (const project of candidates) {
    const matchedBy: string[] = [];
    const warnings = projectWarnings(project);
    let score = 0;

    if (input.id && project.id === normalizeId(input.id)) {
      score += 100;
      matchedBy.push("id");
    }
    if (input.path) {
      const pathMatch = matchProjectPath(project, input.path);
      if (pathMatch) {
        score += pathMatch.score;
        matchedBy.push(pathMatch.reason);
      }
    }
    if (input.branch) {
      const branchMatch = matchBranch(project, input.branch);
      if (branchMatch) {
        score += branchMatch.score;
        matchedBy.push(branchMatch.reason);
      }
    }
    if (input.jiraKey) {
      const jiraMatch = matchJiraKey(project, input.jiraKey);
      if (jiraMatch) {
        score += jiraMatch.score;
        matchedBy.push(jiraMatch.reason);
      }
    }
    if (
      input.tag &&
      (project.tags ?? []).some(
        (tag) => tag.toLowerCase() === input.tag?.toLowerCase(),
      )
    ) {
      score += 35;
      matchedBy.push("tag");
    }
    if (input.query) {
      const queryMatch = matchQuery(project, input.query);
      if (queryMatch) {
        score += queryMatch.score;
        matchedBy.push(queryMatch.reason);
      }
    }

    if (score > 0) {
      matches.set(project.id, {
        project,
        confidence: confidenceForScore(score),
        score,
        matchedBy: unique(matchedBy),
        warnings,
      });
    }
  }

  return [...matches.values()]
    .sort(
      (a, b) =>
        b.score - a.score || a.project.name.localeCompare(b.project.name),
    )
    .slice(0, maxResults);
}

/* --------------------------- state-change sync --------------------------- */

export type ProjectChangeListener = (ids: readonly string[]) => void;
const projectChangeListeners = new Set<ProjectChangeListener>();

export function subscribeProjectChanges(
  listener: ProjectChangeListener,
): () => void {
  projectChangeListeners.add(listener);
  return () => projectChangeListeners.delete(listener);
}

/** Notify-with-ids is the sole Project revision bump. */
export function notifyProjectChange(ids: Iterable<string>): void {
  const touched = [...new Set(ids)];
  if (!touched.length) return;
  projectStore.stampRevisions(touched);
  for (const listener of projectChangeListeners) {
    try {
      listener(touched);
    } catch {
      // A listener cannot make an already durable write fail.
    }
  }
}

export function projectRevisionIndex(): Map<
  string,
  { revision: number; live: boolean }
> {
  return new Map(
    projectStore
      .revisions()
      .map((row) => [row.id, { revision: row.revision, live: row.live }]),
  );
}

export function projectRevisionDigest(): StateDigestEntry[] {
  return projectStore
    .revisions()
    .filter((row) => row.live)
    .map(({ id, revision }) => ({ id, revision }));
}

export function projectSummaryFor(id: string): ProjectSummary | null {
  const project = getProject(id);
  return project ? projectSummaryOf(project) : null;
}

export function projectStateItems(
  ids: readonly string[],
): StateEvent<ProjectSummary>[] {
  const index = projectRevisionIndex();
  const events: StateEvent<ProjectSummary>[] = [];
  for (const id of new Set(ids)) {
    const entry = index.get(id);
    if (!entry) continue;
    const item = entry.live ? projectSummaryFor(id) : null;
    events.push(
      item
        ? { kind: "upsert", id, revision: entry.revision, item }
        : { kind: "delete", id, revision: entry.revision },
    );
  }
  return events;
}

export function projectRevision(id: string): number {
  return projectRevisionIndex().get(normalizeId(id))?.revision ?? 0;
}

/* -------------------------------- writes --------------------------------- */

/**
 * The record {@link upsertProject} would CREATE from `rawProject`, validated but
 * not persisted. Throws when the id is taken, so a proposal can be checked
 * before anyone approves it and re-checked when they do.
 */
export function draftNewProject(
  rawProject: Partial<ProjectRecord>,
): ProjectRecord {
  const id = normalizeId(rawProject.id || rawProject.name || "");
  if (!id) throw new Error("Project id or name is required.");
  if (projectStore.get(id)) throw new Error(`Project ${id} already exists.`);
  const now = new Date().toISOString();
  const project = normalizeProject({
    ...rawProject,
    id,
    createdAt: now,
    updatedAt: now,
  });
  assertProjectValid(project, id);
  return project;
}

export function upsertProject(rawProject: Partial<ProjectRecord>): {
  registry: ProjectRegistryFile;
  project: ProjectRecord;
  created: boolean;
  warnings: string[];
} {
  const now = new Date().toISOString();
  const id = normalizeId(rawProject.id || rawProject.name || "");
  if (!id) throw new Error("Project id or name is required.");
  const previous = projectStore.get(id);
  const created = !previous;
  const project = normalizeProject({
    ...(previous ?? {}),
    ...rawProject,
    id,
    createdAt: previous?.createdAt ?? rawProject.createdAt ?? now,
    updatedAt: now,
  });
  assertProjectValid(project, id);
  projectStore.put(project);
  notifyProjectChange([id]);
  const persisted = getProject(id)!;
  return {
    registry: readProjectRegistry(),
    project: persisted,
    created,
    warnings: projectWarnings(persisted),
  };
}

export function updateProject(
  id: string,
  patch: Partial<ProjectRecord>,
): {
  registry: ProjectRegistryFile;
  project: ProjectRecord;
  warnings: string[];
} {
  const normalizedId = normalizeId(id);
  const previous = projectStore.get(normalizedId);
  if (!previous) throw new Error(`Project not found: ${id}`);
  const project = normalizeProject({
    ...previous,
    ...patch,
    id: previous.id,
    createdAt: previous.createdAt,
    updatedAt: new Date().toISOString(),
  });
  assertProjectValid(project, normalizedId);
  projectStore.put(project);
  notifyProjectChange([normalizedId]);
  const persisted = getProject(normalizedId)!;
  return {
    registry: readProjectRegistry(),
    project: persisted,
    warnings: projectWarnings(persisted),
  };
}

export function addLocalPath(
  id: string,
  rawPath: ProjectLocalPath,
): {
  registry: ProjectRegistryFile;
  project: ProjectRecord;
  warnings: string[];
} {
  const project = requireProject(id);
  const localPath = normalizeLocalPath(rawPath);
  const existing = project.localPaths ?? [];
  if (
    existing.some(
      (item) =>
        item.path === localPath.path &&
        (item.match ?? "prefix") === (localPath.match ?? "prefix"),
    )
  ) {
    throw new Error(
      `Local path is already registered on ${project.id}: ${localPath.path}`,
    );
  }
  return updateProject(project.id, { localPaths: [...existing, localPath] });
}

export function removeLocalPath(
  id: string,
  path: string,
): {
  registry: ProjectRegistryFile;
  project: ProjectRecord;
  warnings: string[];
} {
  const project = requireProject(id);
  const normalizedPath = normalizeFsPath(path);
  const next = (project.localPaths ?? []).filter(
    (item) => normalizeFsPath(item.path) !== normalizedPath,
  );
  if (next.length === (project.localPaths ?? []).length)
    throw new Error(`Local path not found on ${project.id}: ${path}`);
  return updateProject(project.id, { localPaths: next });
}

export function addJiraLink(
  id: string,
  rawLink: ProjectJiraLink,
): {
  registry: ProjectRegistryFile;
  project: ProjectRecord;
  warnings: string[];
} {
  const project = requireProject(id);
  const link = normalizeJiraLink(rawLink);
  const existing = project.jira ?? [];
  if (existing.some((item) => sameJiraLink(item, link)))
    throw new Error(`Jira link is already registered on ${project.id}.`);
  return updateProject(project.id, { jira: [...existing, link] });
}

export function removeJiraLink(
  id: string,
  jiraKey: string,
): {
  registry: ProjectRegistryFile;
  project: ProjectRecord;
  warnings: string[];
} {
  const project = requireProject(id);
  const normalized = normalizeJiraKey(jiraKey);
  const next = (project.jira ?? []).filter(
    (item) => item.issueKey !== normalized && item.projectKey !== normalized,
  );
  if (next.length === (project.jira ?? []).length)
    throw new Error(`Jira link not found on ${project.id}: ${jiraKey}`);
  return updateProject(project.id, { jira: next });
}

export function addAlias(
  id: string,
  alias: string,
): {
  registry: ProjectRegistryFile;
  project: ProjectRecord;
  warnings: string[];
} {
  const project = requireProject(id);
  const cleaned = alias.trim();
  if (!cleaned) throw new Error("Alias cannot be empty.");
  const aliases = unique([...(project.aliases ?? []), cleaned]);
  return updateProject(project.id, { aliases });
}

export function removeAlias(
  id: string,
  alias: string,
): {
  registry: ProjectRegistryFile;
  project: ProjectRecord;
  warnings: string[];
} {
  const project = requireProject(id);
  const lower = alias.trim().toLowerCase();
  const aliases = (project.aliases ?? []).filter(
    (item) => item.toLowerCase() !== lower,
  );
  if (aliases.length === (project.aliases ?? []).length)
    throw new Error(`Alias not found on ${project.id}: ${alias}`);
  return updateProject(project.id, { aliases });
}

export function archiveProject(id: string): {
  registry: ProjectRegistryFile;
  project: ProjectRecord;
  warnings: string[];
} {
  return updateProject(id, { status: "archived" });
}

export function deleteProject(id: string): {
  registry: ProjectRegistryFile;
  deleted: ProjectRecord;
} {
  const normalizedId = normalizeId(id);
  const deleted = projectStore.get(normalizedId);
  if (!deleted) throw new Error(`Project not found: ${id}`);
  // `remove` sweeps every edge touching the project, including the
  // `in_project` edges of its Tasks — so those Task rows change here, and read
  // AFTER the sweep nothing records that they ever belonged to it. Report them
  // through the Task domain's one change seam: a Task list showing a project
  // that no longer exists has nothing left to repair it, now that a mutation
  // broadcasts only the rows it touched.
  const orphaned = incoming(projectNode(normalizedId), "in_project")
    .filter((edge) => edge.fromType === "task")
    .map((edge) => edge.fromId);
  projectStore.remove(normalizedId);
  notifyProjectChange([normalizedId]);
  if (orphaned.length) notifyTaskChange(orphaned);
  return { registry: readProjectRegistry(), deleted };
}

export function reorderProjects(
  orderedIds: string[],
  placements: Array<{ id: string; parentId?: string | null }> = [],
): ProjectRegistryFile {
  const byId = new Map(
    projectStore
      .list({ includeArchived: true })
      .map((project) => [project.id, project]),
  );
  const normalizedOrderedIds = orderedIds.map((id) => normalizeId(id));
  const placementById = new Map(
    placements.map((placement) => [
      normalizeId(placement.id),
      placement.parentId == null ? null : normalizeId(placement.parentId),
    ]),
  );
  const parentById = new Map<string, string | null>();
  const sortOrderById = new Map<string, number>();
  const siblingIndex = new Map<string, number>();

  for (const id of normalizedOrderedIds) {
    const project = byId.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const parentId = placementById.has(id)
      ? placementById.get(id)!
      : (project.parentId ?? null);
    if (parentId && !byId.has(parentId))
      throw new Error(`Parent Project not found: ${parentId}`);
    if (parentId === id)
      throw new Error(`Project cannot be its own parent: ${id}`);
    const key = parentId ?? "";
    const sortOrder = siblingIndex.get(key) ?? 0;
    siblingIndex.set(key, sortOrder + 1);
    parentById.set(id, parentId);
    sortOrderById.set(id, sortOrder);
  }

  // Validate the resulting hierarchy before persisting anything.
  const projected = [...byId.values()].map((project) =>
    sortOrderById.has(project.id)
      ? {
          ...project,
          parentId: parentById.get(project.id) ?? null,
          sortOrder: sortOrderById.get(project.id)!,
        }
      : project,
  );
  const validation = validateProjectRegistry({
    version: 1,
    projects: projected,
  });
  if (validation.errors.length) throw new Error(validation.errors.join("; "));

  for (const id of sortOrderById.keys()) {
    projectStore.setParent(id, parentById.get(id) ?? null);
    projectStore.setSortOrder(id, sortOrderById.get(id)!);
  }
  notifyProjectChange(sortOrderById.keys());
  return readProjectRegistry();
}

/* ------------------------------ validation ------------------------------- */

export function validateProjectRegistry(registry: ProjectRegistryFile): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const [index, project] of registry.projects.entries()) {
    if (!project.id) errors.push(`projects[${index}].id is required`);
    else if (!ID_RE.test(project.id))
      errors.push(
        `projects[${index}].id must be a lowercase slug: ${project.id}`,
      );
    else if (ids.has(project.id))
      errors.push(`Duplicate project id: ${project.id}`);
    ids.add(project.id);
    if (!project.name) errors.push(`projects[${index}].name is required`);
    if (!project.key) errors.push(`projects[${index}].key is required`);
    else if (!DISPLAY_KEY_RE.test(project.key))
      errors.push(
        `projects[${index}].key must be 2-10 uppercase letters/numbers: ${project.key}`,
      );
    else if (keys.has(project.key))
      errors.push(`Duplicate project key: ${project.key}`);
    if (project.key) keys.add(project.key);
    if (project.parentId && project.parentId === project.id)
      errors.push(
        `projects[${index}].parentId cannot reference itself: ${project.id}`,
      );
    warnings.push(
      ...projectWarnings(project).map(
        (warning) => `${project.id || `projects[${index}]`}: ${warning}`,
      ),
    );
  }
  errors.push(...projectHierarchyErrors(registry.projects));
  return { errors, warnings };
}

function assertProjectValid(project: ProjectRecord, id: string): void {
  const others = projectStore
    .list({ includeArchived: true })
    .filter((p) => p.id !== id);
  const validation = validateProjectRegistry({
    version: 1,
    projects: [...others, project],
  });
  if (validation.errors.length)
    throw new Error(`Invalid project: ${validation.errors.join("; ")}`);
}

function requireProject(id: string): ProjectRecord {
  const project = getProject(id);
  if (!project) throw new Error(`Project not found: ${id}`);
  return project;
}

/* ----------------------------- normalization ----------------------------- */

function normalizeProject(
  raw: Partial<ProjectRecord> & { id: string },
): ProjectRecord {
  const name = (raw.name ?? "").trim();
  const now = new Date().toISOString();
  return dropUndefined({
    id: normalizeId(raw.id || name),
    name,
    key: normalizeProjectKey(raw.key),
    color: normalizeColor(raw.color),
    description: raw.description?.trim() ?? "",
    status: normalizeStatus(raw.status),
    tags: normalizeStringArray(raw.tags).map((tag) => tag.toLowerCase()),
    aliases: normalizeStringArray(raw.aliases),
    localPaths: normalizeArray(raw.localPaths, normalizeLocalPath),
    jira: normalizeArray(raw.jira, normalizeJiraLink),
    parentId: normalizeParentId(raw.parentId),
    sortOrder: optionalNumber(raw.sortOrder),
    worktreeRoot: optionalString(raw.worktreeRoot),
    repoUrl: optionalString(raw.repoUrl),
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
  }) as ProjectRecord;
}

function normalizeLocalPath(raw: unknown): ProjectLocalPath {
  const value = isRecord(raw) ? raw : {};
  const p = stringValue(value.path);
  if (!p.trim()) throw new Error("Local path cannot be empty.");
  const kindValue = enumValue<ProjectLocalPathKind>(value.kind, [
    "repo",
    "workspace",
    "folder",
  ]);
  const notesValue = optionalString(value.notes);
  return dropUndefined({
    path: normalizeFsPath(p),
    ...(kindValue !== undefined ? { kind: kindValue } : {}),
    match:
      enumValue<ProjectLocalPathMatch>(value.match, ["exact", "prefix"]) ??
      "prefix",
    ...(notesValue !== undefined ? { notes: notesValue } : {}),
  });
}

function normalizeJiraLink(raw: unknown): ProjectJiraLink {
  const value = isRecord(raw) ? raw : {};
  const issueKey = optionalString(value.issueKey)
    ? normalizeJiraKey(stringValue(value.issueKey))
    : undefined;
  const projectKey = optionalString(value.projectKey)
    ? normalizeJiraProjectKey(stringValue(value.projectKey))
    : issueKey
      ? jiraProjectFromKey(issueKey)
      : undefined;
  if (!issueKey && !projectKey)
    throw new Error("Jira link needs projectKey or issueKey.");
  const notesValue = optionalString(value.notes);
  return dropUndefined({
    ...(projectKey !== undefined ? { projectKey } : {}),
    ...(issueKey !== undefined ? { issueKey } : {}),
    role:
      enumValue<ProjectJiraLinkRole>(value.role, [
        "primary",
        "related",
        "fallback",
        "customer",
        "historical",
      ]) ?? "related",
    ...(notesValue !== undefined ? { notes: notesValue } : {}),
  });
}

function normalizeStatus(value: unknown): ProjectStatus {
  return enumValue<ProjectStatus>(value, ["active", "archived"]) ?? "active";
}

function normalizeParentId(value: unknown): string | null | undefined {
  if (value === null) return null;
  const id = optionalString(value);
  return id ? normalizeId(id) : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeProjectKey(value: unknown): string {
  return optionalString(value)?.toUpperCase() ?? "";
}

function normalizeColor(value: unknown): string | undefined {
  const color = optionalString(value)?.trim();
  if (!color) return undefined;
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : color;
}

/* -------------------------------- matching ------------------------------- */

function matchProjectPath(
  project: ProjectRecord,
  rawPath: string,
): { score: number; reason: string } | null {
  const target = normalizeFsPath(rawPath);
  let best: { score: number; reason: string } | null = null;
  for (const [index, localPath] of (project.localPaths ?? []).entries()) {
    const base = normalizeFsPath(localPath.path);
    const match = localPath.match ?? "prefix";
    const ok =
      match === "exact" ? target === base : pathStartsWith(target, base);
    if (!ok) continue;
    const specificity = Math.min(base.length, 200) / 4;
    const score = (match === "exact" ? 100 : 80) + specificity;
    const candidate = { score, reason: `localPaths[${index}].${match}` };
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

function matchBranch(
  project: ProjectRecord,
  branch: string,
): { score: number; reason: string } | null {
  const cleaned = branch.trim();
  if (!cleaned) return null;
  const tickets = extractJiraKeys(cleaned);
  for (const ticket of tickets) {
    const jiraMatch = matchJiraKey(project, ticket);
    if (jiraMatch)
      return {
        score: Math.max(45, jiraMatch.score - 25),
        reason: `branch:${jiraMatch.reason}`,
      };
  }
  return null;
}

function matchJiraKey(
  project: ProjectRecord,
  rawKey: string,
): { score: number; reason: string } | null {
  const key = normalizeJiraKey(rawKey);
  const issueProject = jiraProjectFromKey(key);
  for (const [index, link] of (project.jira ?? []).entries()) {
    if (link.issueKey && link.issueKey === key)
      return { score: 95, reason: `jira[${index}].issueKey` };
    if (
      link.projectKey &&
      (link.projectKey === key || link.projectKey === issueProject)
    )
      return { score: 65, reason: `jira[${index}].projectKey` };
  }
  return null;
}

function matchQuery(
  project: ProjectRecord,
  query: string,
): { score: number; reason: string } | null {
  const cleaned = normalizeSearchText(query);
  if (!cleaned) return null;
  if (project.id === normalizeId(query)) return { score: 100, reason: "id" };
  if (project.key === query.trim().toUpperCase())
    return { score: 85, reason: "key" };
  if (project.name.toLowerCase() === query.trim().toLowerCase())
    return { score: 80, reason: "name" };
  if (
    (project.aliases ?? []).some(
      (alias) => alias.toLowerCase() === query.trim().toLowerCase(),
    )
  )
    return { score: 75, reason: "alias" };
  if (projectSearchHaystack(project).includes(cleaned))
    return { score: 30, reason: "text" };
  return null;
}

/* -------------------------------- helpers -------------------------------- */

function projectHierarchyErrors(projects: ProjectRecord[]): string[] {
  const errors: string[] = [];
  const ids = new Set(projects.map((project) => project.id));
  for (const project of projects) {
    if (project.parentId && !ids.has(project.parentId))
      errors.push(`${project.id}: parentId not found: ${project.parentId}`);
  }
  for (const project of projects) {
    const seen = new Set<string>();
    let cursor: string | null | undefined = project.parentId;
    while (cursor) {
      if (cursor === project.id || seen.has(cursor)) {
        errors.push(`${project.id}: parentId cycle detected`);
        break;
      }
      seen.add(cursor);
      cursor = projects.find((candidate) => candidate.id === cursor)?.parentId;
    }
  }
  return errors;
}

function projectWarnings(project: ProjectRecord): string[] {
  const warnings: string[] = [];
  for (const [index, localPath] of (project.localPaths ?? []).entries()) {
    if (!isAbsolute(localPath.path))
      warnings.push(`localPaths[${index}] is not absolute: ${localPath.path}`);
    else if (!existsSync(localPath.path))
      warnings.push(
        `localPaths[${index}] does not exist on disk: ${localPath.path}`,
      );
  }
  return warnings;
}

function projectSearchHaystack(project: ProjectRecord): string {
  return normalizeSearchText(
    [
      project.id,
      project.name,
      project.key,
      project.description,
      ...(project.tags ?? []),
      ...(project.aliases ?? []),
      ...(project.localPaths ?? []).flatMap((item) => [
        item.path,
        item.kind,
        item.notes,
      ]),
      ...(project.jira ?? []).flatMap((item) => [
        item.projectKey,
        item.issueKey,
        item.role,
        item.notes,
      ]),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function confidenceForScore(score: number): ProjectMatchConfidence {
  if (score >= 70) return "strong";
  if (score >= 40) return "medium";
  return "weak";
}

function normalizeFsPath(value: string): string {
  return normalize(value.trim());
}

function pathStartsWith(target: string, base: string): boolean {
  if (target === base) return true;
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  return target.startsWith(prefix);
}

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeJiraKey(value: string): string {
  const key = value.trim().toUpperCase();
  if (!PROJECT_KEY_RE.test(key) && !ISSUE_KEY_RE.test(key))
    throw new Error(`Invalid Jira key: ${value}`);
  return key;
}

function normalizeJiraProjectKey(value: string): string {
  const key = value.trim().toUpperCase();
  if (!PROJECT_KEY_RE.test(key))
    throw new Error(`Invalid Jira project key: ${value}`);
  return key;
}

function jiraProjectFromKey(value: string): string | undefined {
  const match = value.match(ISSUE_KEY_RE);
  return match?.[1] ?? (PROJECT_KEY_RE.test(value) ? value : undefined);
}

function extractJiraKeys(value: string): string[] {
  return unique(
    (value.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []).map(normalizeJiraKey),
  );
}

function normalizeSearchText(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(
    value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean),
  );
}

function normalizeArray<T>(
  value: unknown,
  normalizeItem: (item: unknown) => T,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map(normalizeItem);
  return out.length ? out : undefined;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJiraLink(a: ProjectJiraLink, b: ProjectJiraLink): boolean {
  return (
    (a.issueKey ?? "") === (b.issueKey ?? "") &&
    (a.projectKey ?? "") === (b.projectKey ?? "")
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
