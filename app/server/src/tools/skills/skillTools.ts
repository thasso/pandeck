/**
 * Harness-neutral authoring and history tools for the central skills library
 * ([Task-633](pa://task/633), `docs/skills.md`).
 *
 * The library stays hand-authorable and its working tree stays authoritative;
 * these tools are the second, validated way in. Every mutation runs against a
 * completely clean repository, is validated by the same scanner rule the
 * browser sees, and becomes exactly one commit with provenance for the session
 * that made it.
 */
import {
  defineAgentTool,
  type AgentTool,
  type ToolCallContext,
  type ToolResult,
} from "../../mcp/tool.ts";
import {
  readSessionAttachmentUpTo,
  resolveSessionAttachment,
} from "../../sessionAttachments.ts";
import {
  createSkill,
  deleteSkill,
  editSkillSource,
  manageSkillFiles,
  MAX_SKILL_FILE_OPERATIONS,
  MAX_SKILL_IMPORT_BYTES,
  MAX_SKILL_SOURCE_BYTES,
  MAX_SKILL_TEXT_FILE_BYTES,
  normalizeLibraryPath,
  readSkillLibraryOverview,
  readSkillSource,
  renameSkill,
  type SkillFileOperation,
  type SkillMutationOutcome,
} from "../../skills/skillAuthoring.ts";
import {
  DEFAULT_SKILL_TEXT_WINDOW_LINES,
  MAX_SKILL_TEXT_WINDOW_LINES,
  readSkillTextWindow,
} from "../../skills/skillFiles.ts";
import { SkillValidationError } from "../../skills/skillManifest.ts";
import {
  skillLibraryStore,
  MAX_COMMIT_REASON_CHARS,
  MAX_COMMIT_TASK_ID_CHARS,
  type SkillHistoryEntry,
  type SkillLibraryStore,
} from "../../skills/skillLibraryStore.ts";
import { scanSkillLibrary } from "../../skills/skillLibraryScanner.ts";
import type { SkillFileTree, SkillFileTreeEntry } from "@assistant/shared";

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;
const DEFAULT_DIFF_CHARS = 12_000;
const MAX_DIFF_CHARS = 120_000;
const MAX_TREE_ROWS = 200;

let libraryFactory = (): SkillLibraryStore => skillLibraryStore;

/** Test-only seam so tool tests run against an isolated temp library. */
export function setSkillToolLibraryForTests(
  factory: (() => SkillLibraryStore) | null,
): void {
  libraryFactory = factory ?? (() => skillLibraryStore);
}

function library(): SkillLibraryStore {
  return libraryFactory();
}

function compactJsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

/**
 * One caller-supplied provenance value. A commit trailer block is line
 * structured, so a value carrying a newline would forge or truncate the
 * `Skill-*` trailers around it, and an unbounded one defeats the bounded-input
 * contract every other field here honours. Both are refused rather than
 * silently repaired: the model can restate a reason, and a Task id with a
 * newline in it is not a Task id.
 */
function assertSingleLine(
  value: string,
  field: string,
  maxChars: number,
): string {
  const trimmed = value.trim();
  // A forged trailer line is made of exactly these characters, so the pattern
  // has to contain them.
  // oxlint-disable-next-line no-control-regex -- see above: a forged trailer is made of these characters.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new SkillValidationError(
      `${field} must be a single line without control characters.`,
    );
  }
  if (trimmed.length > maxChars) {
    throw new SkillValidationError(
      `${field} must be at most ${maxChars} characters (got ${trimmed.length}).`,
    );
  }
  return trimmed;
}

function commitMeta(
  ctx: ToolCallContext,
  params: { reason: string; taskId?: string },
) {
  const reason = assertSingleLine(
    params.reason ?? "",
    "reason",
    MAX_COMMIT_REASON_CHARS,
  );
  if (!reason)
    throw new SkillValidationError(
      "reason is required: it becomes the commit subject.",
    );
  const taskId = params.taskId
    ? assertSingleLine(params.taskId, "taskId", MAX_COMMIT_TASK_ID_CHARS)
    : "";
  return {
    actor: {
      id: `${ctx.session.harness}:${ctx.session.agentType}:${ctx.session.sessionId}`,
      // The session title is outside data too; the store sanitizes it into one
      // bounded line rather than refusing a session because of its name.
      name: ctx.session.title?.trim() || `${ctx.session.agentType} agent`,
    },
    reason,
    sessionId: ctx.session.sessionId,
    ...(taskId ? { taskId } : {}),
  };
}

function mutationPayload(action: string, outcome: SkillMutationOutcome) {
  return {
    action,
    ...(outcome.skill ? { skill: outcome.skill } : {}),
    folder: outcome.folder,
    commit: {
      commit: outcome.commit.shortCommit,
      fullCommit: outcome.commit.commit,
      changedPaths: outcome.commit.changedPaths,
    },
    repository: repositoryPayload(outcome.status),
  };
}

function repositoryPayload(status: {
  clean: boolean;
  changeCount: number;
  changes: { status: string; path: string }[];
  branch?: string;
  head?: { shortCommit: string; subject: string };
}) {
  return {
    clean: status.clean,
    ...(status.branch ? { branch: status.branch } : {}),
    ...(status.head
      ? { head: `${status.head.shortCommit} ${status.head.subject}` }
      : {}),
    ...(status.clean
      ? {}
      : {
          uncommittedChanges: status.changeCount,
          changes: status.changes.map(
            (change) => `${change.status.trim() || "??"} ${change.path}`,
          ),
        }),
  };
}

const reasonProperty = {
  type: "string",
  maxLength: MAX_COMMIT_REASON_CHARS,
  description: `Concise imperative commit subject for this change, e.g. 'Add release-notes skill'. One line, at most ${MAX_COMMIT_REASON_CHARS} characters.`,
} as const;

const taskIdProperty = {
  type: "string",
  maxLength: MAX_COMMIT_TASK_ID_CHARS,
  description: `Optional related Task id recorded as commit provenance. One line, at most ${MAX_COMMIT_TASK_ID_CHARS} characters.`,
} as const;

/** How many skills and diagnostics one `skill_list` result carries. */
const MAX_LISTED_SKILLS = 200;
const MAX_LISTED_DIAGNOSTICS = 50;

const skillListTool = defineAgentTool<Record<string, never>>({
  name: "skill_list",
  label: "Skills: List",
  description:
    "List the user's central skills library: its valid skills (declared name, description, source path), the scan diagnostics explaining folders that cannot be used, the library path, and the library repository's cleanliness and HEAD. Both lists are bounded; `skillCount`/`diagnosticCount` are the true totals and `truncated` says when a list was cut. Start here before any other skill tool. A skill is addressed by its DECLARED name, never by a filesystem path. The library is a Git repository the user also edits by hand, so authoring tools refuse to run while it holds uncommitted changes; this tool reports that state.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async execute() {
    const overview = await readSkillLibraryOverview(library());
    // A tool result is a model's context, so the library's SIZE may not decide
    // how big it gets: a directly authored library of thousands of folders
    // would otherwise be emitted whole. Both lists are bounded and both say how
    // much they left out, and the totals stay exact.
    const skills = overview.skills.slice(0, MAX_LISTED_SKILLS);
    const diagnostics = overview.diagnostics.slice(0, MAX_LISTED_DIAGNOSTICS);
    return compactJsonResult({
      capability: "skill_list",
      libraryPath: overview.libraryPath,
      repository: repositoryPayload(overview.repository),
      skillCount: overview.skills.length,
      diagnosticCount: overview.diagnostics.length,
      ...(skills.length < overview.skills.length ||
      diagnostics.length < overview.diagnostics.length
        ? { truncated: true }
        : {}),
      skills,
      diagnostics: diagnostics.map((diagnostic) => ({
        folder: diagnostic.folder,
        path: diagnostic.path,
        code: diagnostic.code,
        error: diagnostic.error,
      })),
    });
  },
});

const skillGetTool = defineAgentTool<{ name: string }>({
  name: "skill_get",
  label: "Skills: Get",
  description:
    "Read one valid skill by DECLARED name: its metadata, complete bounded SKILL.md source including the YAML frontmatter, and a bounded supporting-file tree. Read a skill this way BEFORE editing it — skill_edit replaces exact text that must match the current source. Takes no filesystem path; a name the library does not currently declare as valid is reported by skill_list with its diagnostic instead.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: {
        type: "string",
        description: "Declared skill name, as listed by skill_list.",
      },
    },
  },
  async execute(params) {
    const skill = await readSkillSource(params.name, library());
    if (!skill) {
      throw new SkillValidationError(
        `No valid skill declares the name "${params.name}". Use skill_list to see declared names and the diagnostics for folders that are not usable.`,
      );
    }
    return compactJsonResult({
      capability: "skill_get",
      name: skill.name,
      description: skill.description,
      folder: skill.folder,
      path: skill.path,
      source: skill.source,
      bytes: skill.bytes,
      truncated: skill.truncated,
      files: compactTree(skill.files),
    });
  },
});

const skillReadFileTool = defineAgentTool<{
  name: string;
  path: string;
  offset?: number;
  limit?: number;
}>({
  name: "skill_read_file",
  label: "Skills: Read File",
  description:
    "Read one of a skill's supporting files as text: the references, templates and scripts a SKILL.md points at, which skill_get's tree lists as metadata only. The answer is one window of LINES, so a long reference is paged rather than emitted whole; `lineCount` is what the window is taken from and `truncated` says more of the file follows. Read a file this way BEFORE editing it: skill_manage_files' edit operation replaces exact text that must match what is there now, and this text is served verbatim. A binary file is refused rather than decoded, and only a file's first 256 KiB is reachable. SKILL.md may be read this way too, but skill_edit is what changes it.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "path"],
    properties: {
      name: {
        type: "string",
        description: "Declared skill name that owns the file.",
      },
      path: {
        type: "string",
        description:
          "Skill-relative path, e.g. references/api.md, exactly as skill_get's tree lists it.",
      },
      offset: {
        type: "number",
        minimum: 1,
        description: "1-based first line. Defaults to the start of the file.",
      },
      limit: {
        type: "number",
        minimum: 1,
        description: `Maximum lines. Defaults to ${DEFAULT_SKILL_TEXT_WINDOW_LINES}, capped at ${MAX_SKILL_TEXT_WINDOW_LINES}.`,
      },
    },
  },
  async execute(params) {
    const window = await readSkillTextWindow(
      params.name,
      params.path,
      {
        ...(params.offset === undefined ? {} : { offset: params.offset }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      },
      library(),
    );
    if (!window) {
      throw new SkillValidationError(
        `No valid skill declares the name "${params.name}". Use skill_list to see declared names and the diagnostics for folders that are not usable.`,
      );
    }
    return compactJsonResult({
      capability: "skill_read_file",
      name: params.name,
      path: window.path,
      mimeType: window.mimeType,
      bytes: window.bytes,
      firstLine: window.firstLine,
      lastLine: window.lastLine,
      lineCount: window.lineCount,
      truncated: window.truncated,
      text: window.text,
    });
  },
});

const skillCreateTool = defineAgentTool<{
  name: string;
  description: string;
  body: string;
  reason: string;
  taskId?: string;
}>({
  name: "skill_create",
  label: "Skills: Create",
  description:
    "Create a new skill as <name>/SKILL.md in the user's library and commit it. The source folder is the declared name; frontmatter is written deterministically from name and description, and the body is your Markdown instructions. Requires a completely clean library repository (tracked, staged and untracked): a mutation never absorbs the user's manual edits, and a dirty tree is refused with what to resolve. The result is rejected before any commit if the scanner would not report the new skill as valid or if the name is already declared. Never put secrets, credentials, or tokens in a skill: this library is shared by every session that enables it.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "description", "body", "reason"],
    properties: {
      name: {
        type: "string",
        description:
          "Declared skill name and source folder: 1-64 characters, lowercase letters, digits and single hyphens.",
      },
      description: {
        type: "string",
        description:
          "One-line trigger description (max 1024 characters) telling an agent when this skill applies.",
      },
      body: {
        type: "string",
        description: `Markdown instructions below the frontmatter. Bounded at ${MAX_SKILL_SOURCE_BYTES} bytes for the whole file; put long reference material in supporting files via skill_manage_files.`,
      },
      reason: reasonProperty,
      taskId: taskIdProperty,
    },
  },
  async execute(params, ctx) {
    const outcome = await createSkill(
      {
        name: params.name,
        description: params.description,
        body: params.body,
      },
      commitMeta(ctx, params),
      library(),
      ctx.signal ? { signal: ctx.signal } : {},
    );
    return compactJsonResult({
      capability: "skill_create",
      ...mutationPayload("create", outcome),
    });
  },
});

const skillEditTool = defineAgentTool<{
  name: string;
  edits: { oldText: string; newText: string }[];
  reason: string;
  taskId?: string;
}>({
  name: "skill_edit",
  label: "Skills: Edit",
  description:
    "Edit one skill's SKILL.md with exact, unique text replacements and commit the result. Read the skill with skill_get first and copy text from the source it returned, frontmatter included; a fragment that is missing, ambiguous, or leaves the file unchanged is refused before anything is written. The complete result is validated as a skill, and an edit may NOT change the declared name — use skill_rename, which also moves the source folder. Requires a completely clean library repository. Never write secrets or credentials into a skill.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "edits", "reason"],
    properties: {
      name: { type: "string", description: "Declared skill name to edit." },
      edits: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["oldText", "newText"],
          properties: {
            oldText: {
              type: "string",
              description:
                "Exact text that occurs once in the current SKILL.md source.",
            },
            newText: { type: "string", description: "Replacement text." },
          },
        },
      },
      reason: reasonProperty,
      taskId: taskIdProperty,
    },
  },
  async execute(params, ctx) {
    const outcome = await editSkillSource(
      { name: params.name, edits: params.edits },
      commitMeta(ctx, params),
      library(),
      ctx.signal ? { signal: ctx.signal } : {},
    );
    return compactJsonResult({
      capability: "skill_edit",
      ...mutationPayload("edit", outcome),
      replacements: outcome.replacements,
    });
  },
});

const skillManageFilesTool = defineAgentTool<{
  name: string;
  operations: {
    op: "write" | "edit" | "import_attachment" | "delete";
    path: string;
    content?: string;
    edits?: { oldText: string; newText: string }[];
    attachmentId?: string;
  }[];
  reason: string;
  taskId?: string;
}>({
  name: "skill_manage_files",
  label: "Skills: Manage Files",
  description:
    "Write, edit, import, and delete supporting files beneath ONE skill folder as a single commit. Use it for references, templates, and scripts a skill points at. Text content is written inline; edit changes an existing text file in place through exact replacements, so a long reference is patched rather than resent whole; a file the user attached to this session is copied server-side by attachment id, so its raw bytes never pass through your context — the attachment must belong to THIS session. Paths are relative to the skill folder; absolute paths, traversal, backslashes, and SKILL.md itself are refused, and an existing symlink is never written through. One path appears at most once per batch. The whole batch applies or none of it does, and it requires a completely clean library repository. Never store secrets or credentials.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "operations", "reason"],
    properties: {
      name: {
        type: "string",
        description: "Declared skill name that owns these files.",
      },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: MAX_SKILL_FILE_OPERATIONS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["op", "path"],
          properties: {
            op: {
              type: "string",
              enum: ["write", "edit", "import_attachment", "delete"],
              description:
                "write = inline UTF-8 text, creating or replacing the file; edit = exact text replacements in an existing UTF-8 text file; import_attachment = copy a session attachment's bytes; delete = remove one existing regular file.",
            },
            path: {
              type: "string",
              description:
                "Skill-relative path, e.g. references/api.md. A write creates missing parent folders; an edit and a delete address a file that already exists.",
            },
            content: {
              type: "string",
              description: `UTF-8 text for a write, bounded at ${MAX_SKILL_TEXT_FILE_BYTES} bytes.`,
            },
            edits: {
              type: "array",
              minItems: 1,
              description:
                "Replacements for an edit, applied together. Read the file with skill_read_file first and copy the text from what it returned.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["oldText", "newText"],
                properties: {
                  oldText: {
                    type: "string",
                    description:
                      "Exact text that occurs exactly once in the file as it is now.",
                  },
                  newText: {
                    type: "string",
                    description: "Replacement text.",
                  },
                },
              },
            },
            attachmentId: {
              type: "string",
              description: `Session attachment id for import_attachment (from list_attachments), bounded at ${MAX_SKILL_IMPORT_BYTES} bytes.`,
            },
          },
        },
      },
      reason: reasonProperty,
      taskId: taskIdProperty,
    },
  },
  async execute(params, ctx) {
    const operations = params.operations.map((operation) =>
      resolveFileOperation(operation, ctx),
    );
    const outcome = await manageSkillFiles(
      { name: params.name, operations },
      commitMeta(ctx, params),
      library(),
      ctx.signal ? { signal: ctx.signal } : {},
    );
    return compactJsonResult({
      capability: "skill_manage_files",
      ...mutationPayload("manage_files", outcome),
      applied: outcome.applied,
    });
  },
});

const skillRenameTool = defineAgentTool<{
  name: string;
  newName: string;
  reason: string;
  taskId?: string;
}>({
  name: "skill_rename",
  label: "Skills: Rename",
  description:
    "Rename a skill: move its source folder to the new name and rewrite the declared frontmatter name in one commit. Refused when the new name is already declared or the destination folder exists. Consequences to report to the user: sessions that already froze the OLD name keep it and can no longer materialize it, the old name's global on/off setting stays as the user's historical decision, and the NEW name starts disabled until the user enables it in Settings → Skills. Requires a completely clean library repository.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "newName", "reason"],
    properties: {
      name: { type: "string", description: "Current declared skill name." },
      newName: {
        type: "string",
        description:
          "New declared name and source folder: 1-64 characters, lowercase letters, digits and single hyphens.",
      },
      reason: reasonProperty,
      taskId: taskIdProperty,
    },
  },
  async execute(params, ctx) {
    const outcome = await renameSkill(
      { name: params.name, newName: params.newName },
      commitMeta(ctx, params),
      library(),
      ctx.signal ? { signal: ctx.signal } : {},
    );
    return compactJsonResult({
      capability: "skill_rename",
      ...mutationPayload("rename", outcome),
      previousName: outcome.previousName,
      consequences: [
        `Sessions that froze "${outcome.previousName}" keep that name and can no longer materialize it.`,
        `The stored on/off entry for "${outcome.previousName}" is kept as the user's decision; "${params.newName}" defaults to off until the user enables it.`,
      ],
    });
  },
});

const skillDeleteTool = defineAgentTool<{
  name: string;
  reason: string;
  taskId?: string;
}>({
  name: "skill_delete",
  label: "Skills: Delete",
  description:
    "Delete one whole skill folder — SKILL.md and every supporting file — resolved from its current declared name, as one commit. Git history is the only recovery path: no tool restores a deleted skill. Frozen sessions and stored on/off settings are NOT rewritten, so a session that already froze this name can no longer materialize it. Confirm with the user before deleting a skill they did not just ask you to remove. Requires a completely clean library repository.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "reason"],
    properties: {
      name: {
        type: "string",
        description: "Declared skill name whose whole folder is removed.",
      },
      reason: reasonProperty,
      taskId: taskIdProperty,
    },
  },
  async execute(params, ctx) {
    const outcome = await deleteSkill(
      { name: params.name },
      commitMeta(ctx, params),
      library(),
      ctx.signal ? { signal: ctx.signal } : {},
    );
    return compactJsonResult({
      capability: "skill_delete",
      ...mutationPayload("delete", outcome),
      deletedName: params.name,
      consequences: [
        "The folder is recoverable only from the library's Git history.",
        `Frozen sessions and the stored on/off entry for "${params.name}" are not rewritten.`,
      ],
    });
  },
});

const skillHistoryTool = defineAgentTool<{
  name?: string;
  path?: string;
  limit?: number;
}>({
  name: "skill_history",
  label: "Skills: History",
  description:
    "Compact Git history for the whole skills library, or scoped to one currently valid skill or one library-relative source path. Read-only. A path scope still works for a folder that was deleted, which is how a removed skill stays inspectable.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: {
        type: "string",
        description:
          "Optional declared skill name; resolved to its current source folder.",
      },
      path: {
        type: "string",
        description:
          "Optional library-relative path scope (with name, it is relative to that skill's folder).",
      },
      limit: {
        type: "number",
        description: `Maximum commits. Defaults to ${DEFAULT_HISTORY_LIMIT}, capped at ${MAX_HISTORY_LIMIT}.`,
      },
    },
  },
  async execute(params, ctx) {
    const store = library();
    const scope = await resolveScope(store, params.name, params.path);
    const limit = clampLimit(params.limit);
    const history = await store.history({
      ...(scope !== undefined ? { path: scope } : {}),
      limit,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return compactJsonResult({
      capability: "skill_history",
      scope: scope ?? null,
      history: history.entries.map(historyRow),
      // Older commits than these exist: the bounded stream stopped early.
      truncated: history.truncated,
    });
  },
});

const skillDiffTool = defineAgentTool<{
  from: string;
  to?: string;
  name?: string;
  path?: string;
  maxChars?: number;
}>({
  name: "skill_diff",
  label: "Skills: Diff",
  description:
    "Bounded unified diff of the skills library between two revisions (default target: the current working tree), optionally scoped to one skill or library-relative path. Read-only. Revisions are commit ids or refs from skill_history; an option-shaped value is refused.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["from"],
    properties: {
      from: { type: "string", description: "Base commit or ref." },
      to: {
        type: "string",
        description:
          "Optional target commit or ref; defaults to the working tree.",
      },
      name: {
        type: "string",
        description: "Optional declared skill name to scope the diff.",
      },
      path: {
        type: "string",
        description: "Optional library-relative path scope.",
      },
      maxChars: {
        type: "number",
        description: `Maximum patch characters. Defaults to ${DEFAULT_DIFF_CHARS}, capped at ${MAX_DIFF_CHARS}.`,
      },
    },
  },
  async execute(params, ctx) {
    const store = library();
    const scope = await resolveScope(store, params.name, params.path);
    // A diff streams the whole revision range to report exact totals, so an
    // abandoned call must be able to end the Git process rather than pay for it.
    const diff = await store.diff({
      from: params.from,
      ...(params.to !== undefined ? { to: params.to } : {}),
      ...(scope !== undefined ? { path: scope } : {}),
      maxChars: boundedChars(params.maxChars),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return compactJsonResult({
      capability: "skill_diff",
      from: params.from,
      to: params.to ?? null,
      scope: scope ?? null,
      ...diff,
    });
  },
});

/** The one deferred group registered in `tools/catalog.ts`. */
export const skillLibraryTools: AgentTool[] = [
  skillListTool,
  skillGetTool,
  skillReadFileTool,
  skillCreateTool,
  skillEditTool,
  skillManageFilesTool,
  skillRenameTool,
  skillDeleteTool,
  skillHistoryTool,
  skillDiffTool,
];

function resolveFileOperation(
  operation: {
    op: "write" | "edit" | "import_attachment" | "delete";
    path: string;
    content?: string;
    edits?: { oldText: string; newText: string }[];
    attachmentId?: string;
  },
  ctx: ToolCallContext,
): SkillFileOperation {
  if (operation.op === "delete") return { op: "delete", path: operation.path };
  if (operation.op === "write") {
    if (typeof operation.content !== "string")
      throw new SkillValidationError(
        `Operation "write" on "${operation.path}" needs content.`,
      );
    return { op: "write", path: operation.path, content: operation.content };
  }
  if (operation.op === "edit") {
    if (!Array.isArray(operation.edits) || operation.edits.length === 0)
      throw new SkillValidationError(
        `Operation "edit" on "${operation.path}" needs at least one edit.`,
      );
    return { op: "edit", path: operation.path, edits: operation.edits };
  }
  const attachmentId = operation.attachmentId?.trim();
  if (!attachmentId)
    throw new SkillValidationError(
      `Operation "import_attachment" on "${operation.path}" needs an attachmentId.`,
    );
  // Metadata only. The batch's per-file and total budgets are spent on the
  // recorded size first, and the bytes are read one operation at a time and
  // bounded, so a refusal costs no allocation at all.
  const record = resolveSessionAttachment(ctx.session.sessionId, attachmentId);
  if (!record)
    throw new SkillValidationError(
      `No attachment "${attachmentId}" belongs to this session. Use list_attachments; an attachment from another session cannot be imported.`,
    );
  return {
    op: "import",
    path: operation.path,
    size: record.size,
    read: (limit) => readSessionAttachmentUpTo(record, limit),
    attachmentId,
  };
}

/** Resolve an optional skill/path scope to one library-relative path. */
async function resolveScope(
  store: SkillLibraryStore,
  name: string | undefined,
  path: string | undefined,
): Promise<string | undefined> {
  if (name === undefined) {
    return path === undefined ? undefined : normalizeLibraryPath(path);
  }
  await store.ensureInitialized();
  const scan = await scanSkillLibrary(store.root);
  const summary = scan.skills.find((skill) => skill.name === name);
  if (!summary) {
    throw new SkillValidationError(
      `No valid skill declares the name "${name}". Scope by path instead to inspect a folder the library no longer declares.`,
    );
  }
  const folder = summary.path.split("/")[0]!;
  return path === undefined
    ? folder
    : `${folder}/${normalizeLibraryPath(path)}`;
}

function historyRow(entry: SkillHistoryEntry) {
  return {
    commit: entry.shortCommit,
    fullCommit: entry.commit,
    date: entry.date,
    author: entry.author,
    subject: entry.subject,
    ...(entry.trailers["Skill-Names"]
      ? { skills: entry.trailers["Skill-Names"] }
      : {}),
    ...(entry.trailers["Skill-Paths"]
      ? { paths: entry.trailers["Skill-Paths"] }
      : {}),
    ...(entry.trailers["Skill-Task"]
      ? { taskId: entry.trailers["Skill-Task"] }
      : {}),
  };
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT;
  if (!Number.isFinite(value) || value < 1)
    throw new SkillValidationError("limit must be a positive number.");
  return Math.min(Math.floor(value), MAX_HISTORY_LIMIT);
}

function boundedChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DIFF_CHARS;
  if (!Number.isFinite(value) || value < 1)
    throw new SkillValidationError("maxChars must be a positive number.");
  return Math.min(Math.floor(value), MAX_DIFF_CHARS);
}

/** Flatten a bounded tree into compact rows; the tool result stays small. */
function compactTree(tree: SkillFileTree) {
  const rows: { path: string; type: string; bytes?: number }[] = [];
  const visit = (entries: SkillFileTreeEntry[]): void => {
    for (const entry of entries) {
      if (rows.length >= MAX_TREE_ROWS) return;
      rows.push({
        path: entry.path,
        type: entry.type,
        ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
      });
      if (entry.children) visit(entry.children);
    }
  };
  visit(tree.entries);
  return {
    entries: rows,
    entryCount: tree.entryCount,
    truncated: tree.truncated || rows.length < tree.entryCount,
    ...(tree.diagnostics.length > 0 ? { diagnostics: tree.diagnostics } : {}),
  };
}
