/**
 * The `projects` store (see docs/projects design; mirrors {@link ./taskStore.ts}).
 *
 * A project's own attributes live in the `projects` row plus the matcher-critical
 * `project_paths` child table; simple arrays (`aliases`, `tags`)
 * are JSON on the row. Relationships to other nodes are edges in the generic
 * {@link ./links.ts} graph:
 *   - `project —parent→ project`   hierarchy (sibling order is the `sort_order` column)
 *   - `project —jira→ jira`        Jira links (role/notes in edge metadata)
 *   - `session —in_project→ project` standalone session→project mapping
 *
 * The id is a stable human slug (referenced by task `in_project` edges, session
 * mappings, and `knowledge/projects/<id>/` folders), so it is TEXT — not a
 * per-type integer sequence. This store is pure persistence: normalization,
 * validation, and the lookup/scoring engine stay in `projectRegistry.ts`.
 *
 * Writes are synchronous (node:sqlite + WAL), durable at call time.
 */
import { getDb } from "./index.ts";
import { nextId } from "./sequences.ts";
import {
  outgoing,
  memoizedOnLinks,
  outgoingByType,
  removeAllFor,
  removeLink,
  setOutgoing,
  type NodeRef,
} from "./links.ts";

export type ProjectStatus = "active" | "archived";
export type ProjectLocalPathKind = "repo" | "workspace" | "folder";
export type ProjectLocalPathMatch = "exact" | "prefix";
export type ProjectJiraLinkRole =
  "primary" | "related" | "fallback" | "customer" | "historical";

export interface ProjectLocalPath {
  path: string;
  kind?: ProjectLocalPathKind;
  match?: ProjectLocalPathMatch;
  notes?: string;
}

export interface ProjectJiraLink {
  projectKey?: string;
  issueKey?: string;
  role?: ProjectJiraLinkRole;
  notes?: string;
}

/** Fully assembled project record (row + child tables + edges). */
export interface Project {
  id: string;
  name: string;
  key: string;
  color?: string;
  description: string;
  status: ProjectStatus;
  tags?: string[];
  aliases?: string[];
  localPaths?: ProjectLocalPath[];
  jira?: ProjectJiraLink[];
  parentId?: string | null;
  sortOrder?: number;
  /** Per-project override for where new worktrees are created. */
  worktreeRoot?: string;
  /** Git URL to clone/provision the project's repo from. */
  repoUrl?: string;
  /** ISO-8601, derived from the stored millisecond timestamps. */
  createdAt: string;
  updatedAt: string;
  /** Persisted state-event revision; internal to persistence/domain sync. */
  revision?: number;
}

/** The graph node for a project. */
export function projectNode(id: string): NodeRef {
  return { type: "project", id };
}

/* --------------------------------- reads --------------------------------- */

function get(id: string): Project | undefined {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE id = ? AND deleted_at_ms IS NULL")
    .get(id) as DbProjectRow | undefined;
  return row ? assemble(row) : undefined;
}

function list(opts: { includeArchived?: boolean } = {}): Project[] {
  const clauses = ["deleted_at_ms IS NULL"];
  if (!opts.includeArchived) clauses.push("status != 'archived'");
  const rows = getDb()
    .prepare(`SELECT * FROM projects WHERE ${clauses.join(" AND ")}`)
    .all() as unknown as DbProjectRow[];
  return rows.map(assemble).sort((a, b) => a.name.localeCompare(b.name));
}

/* -------------------------------- writes --------------------------------- */

/**
 * Upsert a fully-normalized project: writes the row, replaces both child tables,
 * and replaces the `parent` and `jira` edges. `createdAt`/`updatedAt` are supplied
 * by the caller (domain layer) as ISO strings.
 */
function put(project: Project): void {
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare(
      `
      INSERT INTO projects (id, name, key, color, description, status, aliases_json, tags_json, sort_order, worktree_root, repo_url, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        key = excluded.key,
        color = excluded.color,
        description = excluded.description,
        status = excluded.status,
        aliases_json = excluded.aliases_json,
        tags_json = excluded.tags_json,
        sort_order = excluded.sort_order,
        worktree_root = excluded.worktree_root,
        repo_url = excluded.repo_url,
        updated_at_ms = excluded.updated_at_ms,
        deleted_at_ms = NULL
    `,
    ).run(
      project.id,
      project.name,
      project.key,
      project.color ?? null,
      project.description ?? "",
      project.status,
      jsonArrayOrNull(project.aliases),
      jsonArrayOrNull(project.tags),
      project.sortOrder ?? null,
      project.worktreeRoot ?? null,
      project.repoUrl ?? null,
      isoToMs(project.createdAt),
      isoToMs(project.updatedAt),
    );

    db.prepare("DELETE FROM project_paths WHERE project_id = ?").run(
      project.id,
    );
    const insertPath = db.prepare(
      "INSERT INTO project_paths (project_id, path, kind, match, notes) VALUES (?, ?, ?, ?, ?)",
    );
    for (const p of project.localPaths ?? []) {
      insertPath.run(
        project.id,
        p.path,
        p.kind ?? null,
        p.match ?? "prefix",
        p.notes ?? null,
      );
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Edges live in their own transactions inside setOutgoing/removeLink.
  setParent(project.id, project.parentId ?? null);
  setJira(project.id, project.jira ?? []);
}

/** Tombstone a project, drop its child rows, and sweep every edge touching it. */
function remove(id: string): void {
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE projects SET deleted_at_ms = ?, updated_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL",
    ).run(Date.now(), Date.now(), id);
    db.prepare("DELETE FROM project_paths WHERE project_id = ?").run(id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  // Sweeps parent/jira edges AND any task/session —…→ this project edges.
  removeAllFor(projectNode(id));
}

/** Persist the manual order + parent placement for a set of projects. */
function setSortOrder(id: string, sortOrder: number | null): void {
  getDb()
    .prepare(
      "UPDATE projects SET sort_order = ?, updated_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL",
    )
    .run(sortOrder, Date.now(), id);
}

function stampRevisions(ids: readonly string[]): number {
  const revision = nextId("project_revision");
  const update = getDb().prepare(
    "UPDATE projects SET revision = ? WHERE id = ?",
  );
  for (const id of ids) update.run(revision, id);
  return revision;
}

function revisions(): Array<{
  id: string;
  revision: number;
  live: boolean;
}> {
  return getDb()
    .prepare("SELECT id, revision, deleted_at_ms FROM projects")
    .all()
    .map((row) => {
      const value = row as {
        id: string;
        revision: number;
        deleted_at_ms: number | null;
      };
      return {
        id: value.id,
        revision: value.revision,
        live: value.deleted_at_ms === null,
      };
    });
}

/* ------------------------------- hierarchy ------------------------------- */

/** The parent project id of a child, if any. */
function parentOf(childId: string): string | undefined {
  return outgoing(projectNode(childId), "parent")[0]?.toId;
}

/** Set (or clear, with `parentId === null`) a project's parent. */
function setParent(childId: string, parentId: string | null): void {
  if (parentId === null || parentId === "") {
    setOutgoing(projectNode(childId), "parent", []);
    return;
  }
  setOutgoing(projectNode(childId), "parent", [{ to: projectNode(parentId) }]);
}

/* ------------------------------- jira links ------------------------------ */

function jiraFor(id: string): ProjectJiraLink[] {
  return outgoing(projectNode(id), "jira").map(
    (e) => (e.metadata as ProjectJiraLink | undefined) ?? { issueKey: e.toId },
  );
}

/** Replace a project's Jira links. `to_id` is the issue key when present, else the project key. */
function setJira(id: string, links: ProjectJiraLink[]): void {
  setOutgoing(
    projectNode(id),
    "jira",
    links
      .map((link) => ({ link, key: link.issueKey || link.projectKey }))
      .filter((x): x is { link: ProjectJiraLink; key: string } =>
        Boolean(x.key),
      )
      .map(({ link, key }) => ({
        to: { type: "jira" as const, id: key },
        metadata: link,
      })),
  );
}

/* --------------------- standalone session → project ---------------------- */

/** The project a standalone session is mapped to, if any. */
function sessionProjectOf(sessionId: string): string | undefined {
  return outgoing({ type: "session", id: sessionId }, "in_project")[0]?.toId;
}

/**
 * Every session→project mapping in one query, for the session list; rebuilt
 * only after a session edge changes ({@link memoizedOnLinks}).
 */
const sessionProjectIndex: () => ReadonlyMap<string, string> = memoizedOnLinks(
  "session",
  () => {
    const index = new Map<string, string>();
    for (const [sessionId, links] of outgoingByType("session", "in_project")) {
      const projectId = links[0]?.toId;
      if (projectId) index.set(sessionId, projectId);
    }
    return index;
  },
);

function setSessionProject(sessionId: string, projectId: string): void {
  setOutgoing({ type: "session", id: sessionId }, "in_project", [
    { to: projectNode(projectId), metadata: { source: "standalone" } },
  ]);
}

function forgetSessionProject(sessionId: string): void {
  const current = sessionProjectOf(sessionId);
  if (current)
    removeLink(
      { type: "session", id: sessionId },
      "in_project",
      projectNode(current),
    );
}

/* ------------------------------- assembly -------------------------------- */

interface DbProjectRow {
  id: string;
  name: string;
  key: string;
  color: string | null;
  description: string;
  status: ProjectStatus;
  aliases_json: string | null;
  tags_json: string | null;
  sort_order: number | null;
  worktree_root: string | null;
  repo_url: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  deleted_at_ms: number | null;
  revision: number;
}

function assemble(row: DbProjectRow): Project {
  const paths = getDb()
    .prepare("SELECT * FROM project_paths WHERE project_id = ?")
    .all(row.id) as unknown as DbPathRow[];
  const jira = jiraFor(row.id);
  const parentId = parentOf(row.id);
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    ...(row.color ? { color: row.color } : {}),
    description: row.description ?? "",
    status: row.status,
    ...(row.worktree_root ? { worktreeRoot: row.worktree_root } : {}),
    ...(row.repo_url ? { repoUrl: row.repo_url } : {}),
    ...(parseJsonArray(row.tags_json).length
      ? { tags: parseJsonArray(row.tags_json) }
      : {}),
    ...(parseJsonArray(row.aliases_json).length
      ? { aliases: parseJsonArray(row.aliases_json) }
      : {}),
    ...(paths.length ? { localPaths: paths.map(pathFromRow) } : {}),
    ...(jira.length ? { jira } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(row.sort_order !== null ? { sortOrder: row.sort_order } : {}),
    createdAt: msToIso(row.created_at_ms),
    updatedAt: msToIso(row.updated_at_ms),
    revision: row.revision,
  };
}

interface DbPathRow {
  project_id: string;
  path: string;
  kind: ProjectLocalPathKind | null;
  match: ProjectLocalPathMatch;
  notes: string | null;
}

function pathFromRow(row: DbPathRow): ProjectLocalPath {
  return {
    path: row.path,
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.match ? { match: row.match } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
  };
}

/* -------------------------------- helpers -------------------------------- */

function jsonArrayOrNull(value: string[] | undefined): string | null {
  return value && value.length ? JSON.stringify(value) : null;
}

function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoToMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Date.now();
}

export const projectStore = {
  get,
  list,
  put,
  remove,
  setSortOrder,
  stampRevisions,
  revisions,
  // hierarchy
  parentOf,
  setParent,
  // jira
  jiraFor,
  setJira,
  // standalone session mapping
  sessionProjectOf,
  sessionProjectIndex,
  setSessionProject,
  forgetSessionProject,
  // helpers
  projectNode,
};
