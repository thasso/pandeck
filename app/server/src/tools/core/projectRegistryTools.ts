import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import {
  addAlias,
  addJiraLink,
  addLocalPath,
  archiveProject,
  deleteProject,
  getProject,
  listProjects,
  lookupProjects,
  readProjectRegistry,
  removeAlias,
  removeJiraLink,
  removeLocalPath,
  updateProject,
  upsertProject,
  validateProjectRegistry,
  type JiraLinkRole,
  type LocalPathKind,
  type LocalPathMatch,
  type ProjectJiraLink,
  type ProjectLocalPath,
  type ProjectRecord,
  type ProjectStatus,
} from "../../projectRegistry.ts";
import { broadcastWorktreeList } from "../../worktrees/worktrees.ts";
import { invalidateMainRepo } from "../../worktrees/worktreeResolve.ts";
import {
  cloneAndRegisterProjectRepo,
  projectRepoDir,
} from "../../projectProvision.ts";

const projectRegistryReadSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: {
      type: "string",
      enum: ["list", "lookup", "get", "validate"],
      description:
        "Read mode: list projects, lookup by evidence, get one project by id, or validate the registry.",
    },
    id: {
      type: "string",
      description:
        "Project id for mode=get, or one lookup signal for mode=lookup.",
    },
    query: {
      type: "string",
      description:
        "Free-text query matched against names, aliases, tags, description, local paths, and Jira links.",
    },
    path: {
      type: "string",
      description:
        "Local filesystem path/cwd/git root to resolve against project local path mappings.",
    },
    branch: {
      type: "string",
      description:
        "Git branch name to resolve against embedded Jira issue keys.",
    },
    jiraKey: {
      type: "string",
      description: "Jira project key or issue key, for example APP or APP-7.",
    },
    tag: {
      type: "string",
      description: "Tag filter for list, or lookup signal for lookup.",
    },
    status: {
      type: "string",
      enum: ["active", "archived"],
      description: "Optional project status filter for list.",
    },
    includeArchived: {
      type: "boolean",
      description:
        "Include archived projects in list/lookup results. Defaults to false.",
    },
    maxResults: {
      type: "number",
      description:
        "Maximum number of projects/matches to return. Defaults to 20 for list, 10 for lookup.",
    },
  },
} as const;

const localPathPayloadSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    kind: { type: "string", enum: ["repo", "workspace", "folder"] },
    match: { type: "string", enum: ["exact", "prefix"] },
    notes: { type: "string" },
  },
} as const;

const jiraLinkPayloadSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectKey: { type: "string" },
    issueKey: { type: "string" },
    role: {
      type: "string",
      enum: ["primary", "related", "fallback", "customer", "historical"],
    },
    notes: { type: "string" },
  },
} as const;

const projectPayloadSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      description:
        "Stable lowercase project id/slug, e.g. acme. If omitted, derived from name.",
    },
    name: {
      type: "string",
      description: "Human project name. Required when creating a new project.",
    },
    key: {
      type: "string",
      description:
        "Required short display key for the project, e.g. CL. This is separate from Jira links.",
    },
    description: {
      type: "string",
      description: "Durable project description/context.",
    },
    context: {
      type: "string",
      description:
        "Alias for description; accepted because agents often call project notes context.",
    },
    notes: {
      type: "string",
      description: "Additional notes; folded into description.",
    },
    color: {
      type: "string",
      description: "Optional CSS color such as #CC7D33.",
    },
    status: { type: "string", enum: ["active", "archived"] },
    tags: { type: "array", items: { type: "string" } },
    localPaths: { type: "array", items: localPathPayloadSchema },
    jira: {
      type: "array",
      items: jiraLinkPayloadSchema,
      description:
        "Jira links. Use projectKey for a Jira project, issueKey for a specific issue.",
    },
    jiraLinks: {
      type: "array",
      items: jiraLinkPayloadSchema,
      description: "Alias for jira; accepted for agent ergonomics.",
    },
    aliases: { type: "array", items: { type: "string" } },
    parentId: {
      type: "string",
      description: "Parent project id for the project tree.",
    },
    sortOrder: { type: "number" },
    repoUrl: {
      type: "string",
      description:
        "Git URL to clone/provision this project's repo from (ambient git+ssh). The clone becomes the main checkout and is what cloneRepo and the UI Repository section read.",
    },
    worktreeRoot: {
      type: "string",
      description:
        "Per-project override for where new worktrees are created (falls back to settings.worktrees.root).",
    },
  },
} as const;

const projectRegistryWriteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation"],
  properties: {
    operation: {
      type: "string",
      enum: [
        "upsertProject",
        "updateProject",
        "addLocalPath",
        "removeLocalPath",
        "addJiraLink",
        "removeJiraLink",
        "addAlias",
        "removeAlias",
        "archiveProject",
        "deleteProject",
        "cloneRepo",
      ],
      description:
        "Mutation to apply to an EXISTING project in the local project registry; a new project is proposed with project_create. Use cloneRepo to clone the project's configured repository URL into its managed checkout on disk; it is idempotent, so an existing checkout is reused rather than overwritten.",
    },
    reason: {
      type: "string",
      description:
        "Optional audit/context note accepted for consistency with other write tools; not persisted.",
    },
    id: {
      type: "string",
      description:
        "Project id for update/add/remove/archive/delete operations. For upsertProject, project.id is preferred but id can be used.",
    },
    project: {
      ...projectPayloadSchema,
      description:
        "Full or partial project record for upsertProject/updateProject.",
    },
    localPath: {
      ...localPathPayloadSchema,
      description: "Local path mapping for addLocalPath.",
    },
    path: {
      type: "string",
      description: "Local path string for removeLocalPath.",
    },
    jiraLink: {
      ...jiraLinkPayloadSchema,
      description:
        "Jira link for addJiraLink. Use projectKey for related Jira projects, issueKey for specific issues.",
    },
    jiraKey: {
      type: "string",
      description: "Jira project key or issue key for removeJiraLink.",
    },
    alias: {
      type: "string",
      description: "Alias string for addAlias/removeAlias.",
    },
    confirmDelete: {
      type: "boolean",
      description:
        "Required true for deleteProject. Prefer archiveProject unless the user explicitly asks to delete.",
    },
    confirm: {
      type: "boolean",
      description:
        "Required true for cloneRepo. Without it the tool returns the exact target path and repository URL so you can confirm with the user before cloning to disk.",
    },
  },
} as const;

type ReadParams = {
  mode: "list" | "lookup" | "get" | "validate";
  id?: string;
  query?: string;
  path?: string;
  branch?: string;
  jiraKey?: string;
  tag?: string;
  status?: ProjectStatus;
  includeArchived?: boolean;
  maxResults?: number;
};

type WriteParams = {
  operation:
    | "upsertProject"
    | "updateProject"
    | "addLocalPath"
    | "removeLocalPath"
    | "addJiraLink"
    | "removeJiraLink"
    | "addAlias"
    | "removeAlias"
    | "archiveProject"
    | "deleteProject"
    | "cloneRepo";
  reason?: string;
  id?: string;
  project?: Partial<ProjectRecord>;
  localPath?: ProjectLocalPath;
  path?: string;
  jiraLink?: ProjectJiraLink;
  jiraKey?: string;
  alias?: string;
  confirmDelete?: boolean;
  confirm?: boolean;
};

export const projectRegistryReadTool = defineAgentTool<ReadParams>({
  name: "project_registry_read",
  label: "Project Registry: Read",
  description:
    "Read the local project registry for project context, local folder/repo mappings, and Jira links. Use before assuming project mappings: list to browse all projects, lookup by path/branch/jiraKey/tag/query for discovery, get to read one project by id, validate to audit the registry. Important: explicit user instructions and current tool evidence beat registry fallback hints. Active session Project context is candidate evidence for Jira keys/issues, local repos, docs — but stronger current tool evidence wins. Explain match reason when it affects recommendations. Pay attention to matchedBy, confidence, and warnings in results; if no registry match exists, say that instead of inventing one.",
  parameters: projectRegistryReadSchema,
  async execute(params) {
    if (params.mode === "list") {
      const maxResults = clamp(params.maxResults ?? 20, 1, 100);
      const projects = listProjects(params).slice(0, maxResults);
      return jsonResult({
        mode: "list",
        count: projects.length,
        projects,
        presentationGuidance:
          "Use registry records as local project context alongside explicit user instructions and stronger current tool evidence.",
      });
    }

    if (params.mode === "lookup") {
      const matches = lookupProjects(params);
      return jsonResult({
        mode: "lookup",
        input: cleanObject(params),
        count: matches.length,
        matches,
        presentationGuidance:
          "Explain which project matched and why when the match affects a recommendation, ticket choice, or time-tracking interpretation.",
      });
    }

    if (params.mode === "get") {
      if (!params.id) throw new Error("id is required when mode=get.");
      const project = getProject(params.id);
      if (!project) throw new Error(`Project not found: ${params.id}`);
      return jsonResult({ mode: "get", project });
    }

    if (params.mode === "validate") {
      const registry = readProjectRegistry();
      const validation = validateProjectRegistry(registry);
      return jsonResult({
        mode: "validate",
        projectCount: registry.projects.length,
        ...validation,
      });
    }

    throw new Error(
      `Unsupported project_registry_read mode: ${(params as { mode?: string }).mode ?? "(missing)"}`,
    );
  },
});

export const projectRegistryWriteTool = defineAgentTool<WriteParams>({
  name: "project_registry_write",
  label: "Project Registry: Write",
  description:
    "Update records of existing projects in the local project registry, or clone a project's repository onto disk. Creating a project goes through project_create's approval card. Use only when explicitly asked to remember/update/correct/remove project context, mappings, aliases, or Jira links, or to clone a repo. Never silently guess — if uncertain, ask or record uncertainty explicitly in description/notes instead. Prefer additive updates and archiveProject over deleteProject. A registry project is not necessarily a Jira project: add projectKey for Jira projects, issueKey for specific issues. tempo.defaultIssue is fallback-only and must not override explicit instructions, stronger current evidence, calendar titles, or meeting notes. After a write, summarize what changed and mention any returned warnings.",
  parameters: projectRegistryWriteSchema,
  async execute(params) {
    const before = readProjectRegistry();
    const beforeProjectIds = new Set(
      before.projects.map((project) => project.id),
    );

    let result: Record<string, unknown>;
    if (params.operation === "upsertProject") {
      const project = requireProjectPayload(params);
      const id = params.id ?? project.id ?? project.name ?? "";
      if (!getProject(id))
        throw new Error(
          `Project ${id || "(unnamed)"} does not exist. A new project needs the user's approval: propose it with project_create.`,
        );
      const upsert = upsertProject({
        ...project,
        ...(params.id ? { id: params.id } : {}),
      });
      invalidateMainRepo(upsert.project.id); // localPaths may have changed
      result = {
        operation: params.operation,
        created: upsert.created,
        project: upsert.project,
        warnings: upsert.warnings,
      };
    } else if (params.operation === "updateProject") {
      const id = requireId(params);
      const project = requireProjectPayload(params);
      const update = updateProject(id, project);
      invalidateMainRepo(update.project.id);
      result = {
        operation: params.operation,
        project: update.project,
        warnings: update.warnings,
      };
    } else if (params.operation === "addLocalPath") {
      const update = addLocalPath(requireId(params), requireLocalPath(params));
      invalidateMainRepo(update.project.id);
      result = {
        operation: params.operation,
        project: update.project,
        warnings: update.warnings,
      };
    } else if (params.operation === "removeLocalPath") {
      if (!params.path)
        throw new Error("path is required for removeLocalPath.");
      const update = removeLocalPath(requireId(params), params.path);
      invalidateMainRepo(update.project.id);
      result = {
        operation: params.operation,
        project: update.project,
        warnings: update.warnings,
      };
    } else if (params.operation === "addJiraLink") {
      const update = addJiraLink(requireId(params), requireJiraLink(params));
      result = {
        operation: params.operation,
        project: update.project,
        warnings: update.warnings,
      };
    } else if (params.operation === "removeJiraLink") {
      if (!params.jiraKey)
        throw new Error("jiraKey is required for removeJiraLink.");
      const update = removeJiraLink(requireId(params), params.jiraKey);
      result = {
        operation: params.operation,
        project: update.project,
        warnings: update.warnings,
      };
    } else if (params.operation === "addAlias") {
      if (!params.alias) throw new Error("alias is required for addAlias.");
      const update = addAlias(requireId(params), params.alias);
      result = {
        operation: params.operation,
        project: update.project,
        warnings: update.warnings,
      };
    } else if (params.operation === "removeAlias") {
      if (!params.alias) throw new Error("alias is required for removeAlias.");
      const update = removeAlias(requireId(params), params.alias);
      result = {
        operation: params.operation,
        project: update.project,
        warnings: update.warnings,
      };
    } else if (params.operation === "archiveProject") {
      const update = archiveProject(requireId(params));
      result = {
        operation: params.operation,
        project: update.project,
        warnings: update.warnings,
      };
    } else if (params.operation === "deleteProject") {
      if (params.confirmDelete !== true)
        throw new Error(
          "deleteProject requires confirmDelete=true. Prefer archiveProject unless the user explicitly asked to delete.",
        );
      const id = requireId(params);
      const deleted = deleteProject(id);
      invalidateMainRepo(id);
      result = {
        operation: params.operation,
        deleted: deleted.deleted,
        warnings: [],
      };
    } else if (params.operation === "cloneRepo") {
      const id = requireId(params);
      const project = getProject(id);
      if (!project) throw new Error(`Project not found: ${id}`);
      const repoUrl = project.repoUrl?.trim();
      if (!repoUrl)
        throw new Error(
          "This project has no repository URL configured. Set repoUrl on the project first (upsertProject/updateProject).",
        );
      const targetDir = projectRepoDir(id);
      // Confirmation: surface the exact URL + target path and require confirm=true
      // before writing to disk, mirroring deleteProject's confirmDelete gate.
      if (params.confirm !== true) {
        throw new Error(
          `cloneRepo requires confirm=true. This will clone ${repoUrl} into ${targetDir}. Confirm the target path with the user, then retry with confirm=true.`,
        );
      }
      const clone = await cloneAndRegisterProjectRepo(id);
      invalidateMainRepo(id);
      void broadcastWorktreeList();
      result = {
        operation: params.operation,
        project: getProject(id),
        cloned: clone.cloned,
        alreadyPresent: !clone.cloned,
        registeredLocalPath: clone.registeredLocalPath,
        repoUrl: clone.repoUrl,
        dir: clone.dir,
        warnings: [],
      };
    } else {
      throw new Error(
        `Unsupported project_registry_write operation: ${(params as { operation?: string }).operation ?? "(missing)"}`,
      );
    }

    const after = readProjectRegistry();
    const validation = validateProjectRegistry(after);
    return jsonResult({
      ...result,
      summary: summarizeRegistryChange(before, after, beforeProjectIds),
      validation,
    });
  },
});

export const assistantProjectRegistryTools = [
  projectRegistryReadTool,
  projectRegistryWriteTool,
];

function requireId(params: WriteParams): string {
  if (!params.id)
    throw new Error("id is required for this project registry operation.");
  return params.id;
}

function requireProjectPayload(params: WriteParams): Partial<ProjectRecord> {
  if (!params.project || typeof params.project !== "object")
    throw new Error("project object is required for this operation.");
  return normalizeProjectPayload(params.project as Record<string, unknown>);
}

function requireLocalPath(params: WriteParams): ProjectLocalPath {
  if (!params.localPath || typeof params.localPath !== "object")
    throw new Error("localPath object is required for addLocalPath.");
  return normalizeLocalPathPayload(
    params.localPath as unknown as Record<string, unknown>,
  );
}

function requireJiraLink(params: WriteParams): ProjectJiraLink {
  if (!params.jiraLink || typeof params.jiraLink !== "object")
    throw new Error("jiraLink object is required for addJiraLink.");
  return normalizeJiraLinkPayload(params.jiraLink as Record<string, unknown>);
}

export function normalizeProjectPayload(
  raw: Record<string, unknown>,
): Partial<ProjectRecord> {
  const jira = [...arrayValue(raw.jira), ...arrayValue(raw.jiraLinks)].map(
    (item) => normalizeJiraLinkPayload(item),
  );
  const idValue = stringValue(raw.id);
  const nameValue = stringValue(raw.name);
  const keyValue = inferProjectKey(raw, jira);
  const colorValue = stringValue(raw.color);
  const descriptionValue = normalizeDescriptionPayload(raw);
  const statusValue = enumValue<ProjectStatus>(raw.status, [
    "active",
    "archived",
  ]);
  const tagsValue = stringArray(raw.tags);
  const aliasesValue = stringArray(raw.aliases);
  const parentIdValue =
    raw.parentId === null ? null : stringValue(raw.parentId);
  const worktreeRootValue = stringValue(raw.worktreeRoot);
  const repoUrlValue = stringValue(raw.repoUrl);
  return cleanObject({
    ...(idValue !== undefined ? { id: idValue } : {}),
    ...(nameValue !== undefined ? { name: nameValue } : {}),
    ...(keyValue !== undefined ? { key: keyValue } : {}),
    ...(descriptionValue !== undefined
      ? { description: descriptionValue }
      : {}),
    ...(colorValue !== undefined ? { color: colorValue } : {}),
    ...(statusValue !== undefined ? { status: statusValue } : {}),
    ...(tagsValue !== undefined ? { tags: tagsValue } : {}),
    localPaths: arrayValue(raw.localPaths).map((item) =>
      normalizeLocalPathPayload(item),
    ),
    jira,
    ...(aliasesValue !== undefined ? { aliases: aliasesValue } : {}),
    ...(parentIdValue !== undefined ? { parentId: parentIdValue } : {}),
    ...(typeof raw.sortOrder === "number" && Number.isFinite(raw.sortOrder)
      ? { sortOrder: raw.sortOrder }
      : {}),
    ...(repoUrlValue !== undefined ? { repoUrl: repoUrlValue } : {}),
    ...(worktreeRootValue !== undefined
      ? { worktreeRoot: worktreeRootValue }
      : {}),
  });
}

function inferProjectKey(
  raw: Record<string, unknown>,
  jira: ProjectJiraLink[],
): string | undefined {
  const explicit = stringValue(raw.key)?.toUpperCase();
  if (explicit) return explicit;

  const projectKey = stringValue(raw.projectKey)?.toUpperCase();
  if (projectKey) return projectKey;

  const jiraProjectKey = jira.find((link) => link.projectKey)?.projectKey;
  if (jiraProjectKey) return jiraProjectKey;

  const aliasKey = stringArray(raw.aliases)?.find((alias) =>
    /^[A-Z][A-Z0-9]{1,9}$/.test(alias.trim().toUpperCase()),
  );
  return aliasKey?.toUpperCase();
}

function normalizeDescriptionPayload(
  raw: Record<string, unknown>,
): string | undefined {
  const parts: string[] = [];
  const description = stringValue(raw.description);
  if (description) parts.push(description);
  const context = stringValue(raw.context);
  if (context) parts.push(description ? `## Context\n\n${context}` : context);
  const notes = stringValue(raw.notes);
  if (notes) parts.push(`## Notes\n\n${notes}`);
  return parts.length ? parts.join("\n\n") : undefined;
}

function normalizeLocalPathPayload(
  raw: Record<string, unknown>,
): ProjectLocalPath {
  const kindValue = enumValue<LocalPathKind>(raw.kind, [
    "repo",
    "workspace",
    "folder",
  ]);
  const matchValue = enumValue<LocalPathMatch>(raw.match, ["exact", "prefix"]);
  const notesValue = stringValue(raw.notes);
  return cleanObject({
    path: stringValue(raw.path) ?? "",
    ...(kindValue !== undefined ? { kind: kindValue } : {}),
    ...(matchValue !== undefined ? { match: matchValue } : {}),
    ...(notesValue !== undefined ? { notes: notesValue } : {}),
  });
}

function normalizeJiraLinkPayload(
  raw: Record<string, unknown>,
): ProjectJiraLink {
  const projectKeyValue = stringValue(raw.projectKey);
  const issueKeyValue = stringValue(raw.issueKey);
  const roleValue = enumValue<JiraLinkRole>(raw.role, [
    "primary",
    "related",
    "fallback",
    "customer",
    "historical",
  ]);
  const notesValue = stringValue(raw.notes);
  return cleanObject({
    ...(projectKeyValue !== undefined ? { projectKey: projectKeyValue } : {}),
    ...(issueKeyValue !== undefined ? { issueKey: issueKeyValue } : {}),
    ...(roleValue !== undefined ? { role: roleValue } : {}),
    ...(notesValue !== undefined ? { notes: notesValue } : {}),
  });
}

function summarizeRegistryChange(
  before: { projects: ProjectRecord[] },
  after: { projects: ProjectRecord[] },
  beforeProjectIds: Set<string>,
) {
  const afterProjectIds = new Set(after.projects.map((project) => project.id));
  const added = [...afterProjectIds].filter((id) => !beforeProjectIds.has(id));
  const removed = [...beforeProjectIds].filter(
    (id) => !afterProjectIds.has(id),
  );
  const changed = after.projects
    .filter((project) => beforeProjectIds.has(project.id))
    .filter(
      (project) =>
        JSON.stringify(
          before.projects.find((item) => item.id === project.id),
        ) !== JSON.stringify(project),
    )
    .map((project) => project.id);
  return {
    projectCountBefore: before.projects.length,
    projectCountAfter: after.projects.length,
    added,
    changed,
    removed,
  };
}

function cleanObject<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (
      item === undefined ||
      item === "" ||
      (Array.isArray(item) && item.length === 0)
    )
      delete value[key];
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  return out.length ? out : undefined;
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}
