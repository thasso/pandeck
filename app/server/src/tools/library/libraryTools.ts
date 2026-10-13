/**
 * Harness-neutral authoring and history tools for a Git-backed library
 * ([Task-633](pa://task/633), `docs/skills.md`,
 * `docs/agent-definitions.md#shared-library-core`).
 *
 * The library stays hand-authorable and its working tree stays authoritative;
 * these tools are the second, validated way in. Every mutation runs against a
 * completely clean repository, is validated by the same scanner rule the
 * browser sees, and becomes exactly one commit with provenance for the session
 * that made it.
 *
 * One factory builds every kind's group, so `skill_*` and any later library's
 * tools are the same code: a kind supplies its names, its create fields, and
 * the consequences of a rename or delete, and nothing else.
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
  deleteEntry,
  editEntrySource,
  manageEntryFiles,
  MAX_ENTRY_FILE_OPERATIONS,
  MAX_ENTRY_IMPORT_BYTES,
  MAX_ENTRY_TEXT_FILE_BYTES,
  normalizeLibraryPath,
  readLibraryOverview,
  readEntrySource,
  renameEntry,
  type EntryFileOperation,
  type LibraryMutationOptions,
  type LibraryMutationOutcome,
} from "../../library/libraryAuthoring.ts";
import {
  DEFAULT_ENTRY_TEXT_WINDOW_LINES,
  MAX_ENTRY_TEXT_WINDOW_LINES,
  readEntryTextWindow,
} from "../../library/entryFiles.ts";
import { EntryValidationError } from "../../library/entryManifest.ts";
import { capitalize, withArticle } from "../../library/libraryKind.ts";
import { scanLibrary } from "../../library/libraryScanner.ts";
import {
  MAX_COMMIT_REASON_CHARS,
  MAX_COMMIT_TASK_ID_CHARS,
  type LibraryCommitMeta,
  type LibraryHistoryEntry,
  type LibraryStore,
} from "../../library/libraryStore.ts";
import type { EntryFileTree, EntryFileTreeEntry } from "@assistant/shared";

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;
const DEFAULT_DIFF_CHARS = 12_000;
const MAX_DIFF_CHARS = 120_000;
const MAX_TREE_ROWS = 200;

/** How many entries and diagnostics one `<prefix>_list` result carries. */
const MAX_LISTED_ENTRIES = 200;
const MAX_LISTED_DIAGNOSTICS = 50;

/** What one kind contributes to its tool group. */
export interface LibraryToolSpec {
  /** Tool-name prefix: `skill` gives `skill_list`, `skill_get`, … */
  prefix: string;
  /** Label group: `Skills` gives `Skills: List`. */
  labelGroup: string;
  /** Example entry name used in the commit-reason hint. */
  exampleName: string;
  /** The store the tools act on, read per call so tests can swap it. */
  library: () => LibraryStore;
  /** `<prefix>_create`: the kind's own fields, and how they become an entry. */
  create: {
    description: string;
    /** Properties BEFORE the shared `reason`/`taskId`, in schema order. */
    properties: Record<string, unknown>;
    required: string[];
    run(
      params: Record<string, unknown>,
      meta: LibraryCommitMeta,
      library: LibraryStore,
      options: LibraryMutationOptions,
    ): Promise<LibraryMutationOutcome>;
  };
  rename: {
    description: string;
    consequences(previousName: string, newName: string): string[];
  };
  delete: {
    description: string;
    consequences(name: string): string[];
  };
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
 * `<Kind>-*` trailers around it, and an unbounded one defeats the bounded-input
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
    throw new EntryValidationError(
      `${field} must be a single line without control characters.`,
    );
  }
  if (trimmed.length > maxChars) {
    throw new EntryValidationError(
      `${field} must be at most ${maxChars} characters (got ${trimmed.length}).`,
    );
  }
  return trimmed;
}

function commitMeta(
  ctx: ToolCallContext,
  params: { reason: string; taskId?: string },
): LibraryCommitMeta {
  const reason = assertSingleLine(
    params.reason ?? "",
    "reason",
    MAX_COMMIT_REASON_CHARS,
  );
  if (!reason)
    throw new EntryValidationError(
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

const taskIdProperty = {
  type: "string",
  maxLength: MAX_COMMIT_TASK_ID_CHARS,
  description: `Optional related Task id recorded as commit provenance. One line, at most ${MAX_COMMIT_TASK_ID_CHARS} characters.`,
} as const;

/** Build one kind's whole deferred tool group. */
export function libraryTools(spec: LibraryToolSpec): AgentTool[] {
  const { kind } = spec.library();
  const { noun, plural, manifestFile } = kind;
  const library = (): LibraryStore => spec.library();
  const tool = (suffix: string): string => `${spec.prefix}_${suffix}`;
  const label = (action: string): string => `${spec.labelGroup}: ${action}`;
  const anEntry = withArticle(noun);
  const notDeclared = (name: string): string =>
    `No valid ${noun} declares the name "${name}". Use ${tool("list")} to see declared names and the diagnostics for folders that are not usable.`;

  const reasonProperty = {
    type: "string",
    maxLength: MAX_COMMIT_REASON_CHARS,
    description: `Concise imperative commit subject for this change, e.g. 'Add ${spec.exampleName} ${noun}'. One line, at most ${MAX_COMMIT_REASON_CHARS} characters.`,
  } as const;

  const mutationPayload = (
    action: string,
    outcome: LibraryMutationOutcome,
  ) => ({
    action,
    ...(outcome.entry ? { [noun]: outcome.entry } : {}),
    folder: outcome.folder,
    commit: {
      commit: outcome.commit.shortCommit,
      fullCommit: outcome.commit.commit,
      changedPaths: outcome.commit.changedPaths,
    },
    repository: repositoryPayload(outcome.status),
  });

  const listTool = defineAgentTool<Record<string, never>>({
    name: tool("list"),
    label: label("List"),
    description: `List the user's central ${plural} library: its valid ${plural} (declared name, description, source path), the scan diagnostics explaining folders that cannot be used, the library path, and the library repository's cleanliness and HEAD. Both lists are bounded; \`${noun}Count\`/\`diagnosticCount\` are the true totals and \`truncated\` says when a list was cut. Start here before any other ${noun} tool. ${capitalize(anEntry)} is addressed by its DECLARED name, never by a filesystem path. The library is a Git repository the user also edits by hand, so authoring tools refuse to run while it holds uncommitted changes; this tool reports that state.`,
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      const overview = await readLibraryOverview(library());
      // A tool result is a model's context, so the library's SIZE may not
      // decide how big it gets: a directly authored library of thousands of
      // folders would otherwise be emitted whole. Both lists are bounded and
      // both say how much they left out, and the totals stay exact.
      const entries = overview.entries.slice(0, MAX_LISTED_ENTRIES);
      const diagnostics = overview.diagnostics.slice(0, MAX_LISTED_DIAGNOSTICS);
      return compactJsonResult({
        capability: tool("list"),
        libraryPath: overview.libraryPath,
        repository: repositoryPayload(overview.repository),
        [`${noun}Count`]: overview.entries.length,
        diagnosticCount: overview.diagnostics.length,
        ...(entries.length < overview.entries.length ||
        diagnostics.length < overview.diagnostics.length
          ? { truncated: true }
          : {}),
        [plural]: entries,
        diagnostics: diagnostics.map((diagnostic) => ({
          folder: diagnostic.folder,
          path: diagnostic.path,
          code: diagnostic.code,
          error: diagnostic.error,
        })),
      });
    },
  });

  const getTool = defineAgentTool<{ name: string }>({
    name: tool("get"),
    label: label("Get"),
    description: `Read one valid ${noun} by DECLARED name: its metadata, complete bounded ${manifestFile} source including the YAML frontmatter, and a bounded supporting-file tree. Read ${anEntry} this way BEFORE editing it — ${tool("edit")} replaces exact text that must match the current source. Takes no filesystem path; a name the library does not currently declare as valid is reported by ${tool("list")} with its diagnostic instead.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: `Declared ${noun} name, as listed by ${tool("list")}.`,
        },
      },
    },
    async execute(params) {
      const entry = await readEntrySource(params.name, library());
      if (!entry) throw new EntryValidationError(notDeclared(params.name));
      return compactJsonResult({
        capability: tool("get"),
        name: entry.name,
        description: entry.description,
        folder: entry.folder,
        path: entry.path,
        source: entry.source,
        bytes: entry.bytes,
        truncated: entry.truncated,
        files: compactTree(entry.files),
      });
    },
  });

  const readFileTool = defineAgentTool<{
    name: string;
    path: string;
    offset?: number;
    limit?: number;
  }>({
    name: tool("read_file"),
    label: label("Read File"),
    description: `Read one of ${anEntry}'s supporting files as text: the references, templates and scripts ${withArticle(manifestFile)} points at, which ${tool("get")}'s tree lists as metadata only. The answer is one window of LINES, so a long reference is paged rather than emitted whole; \`lineCount\` is what the window is taken from and \`truncated\` says more of the file follows. Read a file this way BEFORE editing it: ${tool("manage_files")}' edit operation replaces exact text that must match what is there now, and this text is served verbatim. A binary file is refused rather than decoded, and only a file's first 256 KiB is reachable. ${manifestFile} may be read this way too, but ${tool("edit")} is what changes it.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "path"],
      properties: {
        name: {
          type: "string",
          description: `Declared ${noun} name that owns the file.`,
        },
        path: {
          type: "string",
          description: `${capitalize(noun)}-relative path, e.g. references/api.md, exactly as ${tool("get")}'s tree lists it.`,
        },
        offset: {
          type: "number",
          minimum: 1,
          description: "1-based first line. Defaults to the start of the file.",
        },
        limit: {
          type: "number",
          minimum: 1,
          description: `Maximum lines. Defaults to ${DEFAULT_ENTRY_TEXT_WINDOW_LINES}, capped at ${MAX_ENTRY_TEXT_WINDOW_LINES}.`,
        },
      },
    },
    async execute(params) {
      const window = await readEntryTextWindow(
        params.name,
        params.path,
        {
          ...(params.offset === undefined ? {} : { offset: params.offset }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        },
        library(),
      );
      if (!window) throw new EntryValidationError(notDeclared(params.name));
      return compactJsonResult({
        capability: tool("read_file"),
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

  const createTool = defineAgentTool<
    Record<string, unknown> & { reason: string; taskId?: string }
  >({
    name: tool("create"),
    label: label("Create"),
    description: spec.create.description,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [...spec.create.required, "reason"],
      properties: {
        ...spec.create.properties,
        reason: reasonProperty,
        taskId: taskIdProperty,
      },
    },
    async execute(params, ctx) {
      const outcome = await spec.create.run(
        params,
        commitMeta(ctx, params),
        library(),
        ctx.signal ? { signal: ctx.signal } : {},
      );
      return compactJsonResult({
        capability: tool("create"),
        ...mutationPayload("create", outcome),
      });
    },
  });

  const editTool = defineAgentTool<{
    name: string;
    edits: { oldText: string; newText: string }[];
    reason: string;
    taskId?: string;
  }>({
    name: tool("edit"),
    label: label("Edit"),
    description: `Edit one ${noun}'s ${manifestFile} with exact, unique text replacements and commit the result. Read the ${noun} with ${tool("get")} first and copy text from the source it returned, frontmatter included; a fragment that is missing, ambiguous, or leaves the file unchanged is refused before anything is written. The complete result is validated as ${anEntry}, and an edit may NOT change the declared name — use ${tool("rename")}, which also moves the source folder. Requires a completely clean library repository. Never write secrets or credentials into ${anEntry}.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "edits", "reason"],
      properties: {
        name: { type: "string", description: `Declared ${noun} name to edit.` },
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
                description: `Exact text that occurs once in the current ${manifestFile} source.`,
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
      const outcome = await editEntrySource(
        { name: params.name, edits: params.edits },
        commitMeta(ctx, params),
        library(),
        ctx.signal ? { signal: ctx.signal } : {},
      );
      return compactJsonResult({
        capability: tool("edit"),
        ...mutationPayload("edit", outcome),
        replacements: outcome.replacements,
      });
    },
  });

  const manageFilesTool = defineAgentTool<{
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
    name: tool("manage_files"),
    label: label("Manage Files"),
    description: `Write, edit, import, and delete supporting files beneath ONE ${noun} folder as a single commit. Use it for references, templates, and scripts ${anEntry} points at. Text content is written inline; edit changes an existing text file in place through exact replacements, so a long reference is patched rather than resent whole; a file the user attached to this session is copied server-side by attachment id, so its raw bytes never pass through your context — the attachment must belong to THIS session. Paths are relative to the ${noun} folder; absolute paths, traversal, backslashes, and ${manifestFile} itself are refused, and an existing symlink is never written through. One path appears at most once per batch. The whole batch applies or none of it does, and it requires a completely clean library repository. Never store secrets or credentials.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "operations", "reason"],
      properties: {
        name: {
          type: "string",
          description: `Declared ${noun} name that owns these files.`,
        },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: MAX_ENTRY_FILE_OPERATIONS,
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
                description: `${capitalize(noun)}-relative path, e.g. references/api.md. A write creates missing parent folders; an edit and a delete address a file that already exists.`,
              },
              content: {
                type: "string",
                description: `UTF-8 text for a write, bounded at ${MAX_ENTRY_TEXT_FILE_BYTES} bytes.`,
              },
              edits: {
                type: "array",
                minItems: 1,
                description: `Replacements for an edit, applied together. Read the file with ${tool("read_file")} first and copy the text from what it returned.`,
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
                description: `Session attachment id for import_attachment (from list_attachments), bounded at ${MAX_ENTRY_IMPORT_BYTES} bytes.`,
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
      const outcome = await manageEntryFiles(
        { name: params.name, operations },
        commitMeta(ctx, params),
        library(),
        ctx.signal ? { signal: ctx.signal } : {},
      );
      return compactJsonResult({
        capability: tool("manage_files"),
        ...mutationPayload("manage_files", outcome),
        applied: outcome.applied,
      });
    },
  });

  const renameTool = defineAgentTool<{
    name: string;
    newName: string;
    reason: string;
    taskId?: string;
  }>({
    name: tool("rename"),
    label: label("Rename"),
    description: spec.rename.description,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "newName", "reason"],
      properties: {
        name: { type: "string", description: `Current declared ${noun} name.` },
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
      const outcome = await renameEntry(
        { name: params.name, newName: params.newName },
        commitMeta(ctx, params),
        library(),
        ctx.signal ? { signal: ctx.signal } : {},
      );
      return compactJsonResult({
        capability: tool("rename"),
        ...mutationPayload("rename", outcome),
        previousName: outcome.previousName,
        consequences: spec.rename.consequences(
          outcome.previousName,
          params.newName,
        ),
      });
    },
  });

  const deleteTool = defineAgentTool<{
    name: string;
    reason: string;
    taskId?: string;
  }>({
    name: tool("delete"),
    label: label("Delete"),
    description: spec.delete.description,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "reason"],
      properties: {
        name: {
          type: "string",
          description: `Declared ${noun} name whose whole folder is removed.`,
        },
        reason: reasonProperty,
        taskId: taskIdProperty,
      },
    },
    async execute(params, ctx) {
      const outcome = await deleteEntry(
        { name: params.name },
        commitMeta(ctx, params),
        library(),
        ctx.signal ? { signal: ctx.signal } : {},
      );
      return compactJsonResult({
        capability: tool("delete"),
        ...mutationPayload("delete", outcome),
        deletedName: params.name,
        consequences: spec.delete.consequences(params.name),
      });
    },
  });

  const historyTool = defineAgentTool<{
    name?: string;
    path?: string;
    limit?: number;
  }>({
    name: tool("history"),
    label: label("History"),
    description: `Compact Git history for the whole ${plural} library, or scoped to one currently valid ${noun} or one library-relative source path. Read-only. A path scope still works for a folder that was deleted, which is how a removed ${noun} stays inspectable.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          description: `Optional declared ${noun} name; resolved to its current source folder.`,
        },
        path: {
          type: "string",
          description: `Optional library-relative path scope (with name, it is relative to that ${noun}'s folder).`,
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
        capability: tool("history"),
        scope: scope ?? null,
        history: history.entries.map((entry) => historyRow(store, entry)),
        // Older commits than these exist: the bounded stream stopped early.
        truncated: history.truncated,
      });
    },
  });

  const diffTool = defineAgentTool<{
    from: string;
    to?: string;
    name?: string;
    path?: string;
    maxChars?: number;
  }>({
    name: tool("diff"),
    label: label("Diff"),
    description: `Bounded unified diff of the ${plural} library between two revisions (default target: the current working tree), optionally scoped to one ${noun} or library-relative path. Read-only. Revisions are commit ids or refs from ${tool("history")}; an option-shaped value is refused.`,
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
          description: `Optional declared ${noun} name to scope the diff.`,
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
      // abandoned call must be able to end the Git process rather than pay for
      // it.
      const diff = await store.diff({
        from: params.from,
        ...(params.to !== undefined ? { to: params.to } : {}),
        ...(scope !== undefined ? { path: scope } : {}),
        maxChars: boundedChars(params.maxChars),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return compactJsonResult({
        capability: tool("diff"),
        from: params.from,
        to: params.to ?? null,
        scope: scope ?? null,
        ...diff,
      });
    },
  });

  return [
    listTool,
    getTool,
    readFileTool,
    createTool,
    editTool,
    manageFilesTool,
    renameTool,
    deleteTool,
    historyTool,
    diffTool,
  ];
}

function resolveFileOperation(
  operation: {
    op: "write" | "edit" | "import_attachment" | "delete";
    path: string;
    content?: string;
    edits?: { oldText: string; newText: string }[];
    attachmentId?: string;
  },
  ctx: ToolCallContext,
): EntryFileOperation {
  if (operation.op === "delete") return { op: "delete", path: operation.path };
  if (operation.op === "write") {
    if (typeof operation.content !== "string")
      throw new EntryValidationError(
        `Operation "write" on "${operation.path}" needs content.`,
      );
    return { op: "write", path: operation.path, content: operation.content };
  }
  if (operation.op === "edit") {
    if (!Array.isArray(operation.edits) || operation.edits.length === 0)
      throw new EntryValidationError(
        `Operation "edit" on "${operation.path}" needs at least one edit.`,
      );
    return { op: "edit", path: operation.path, edits: operation.edits };
  }
  const attachmentId = operation.attachmentId?.trim();
  if (!attachmentId)
    throw new EntryValidationError(
      `Operation "import_attachment" on "${operation.path}" needs an attachmentId.`,
    );
  // Metadata only. The batch's per-file and total budgets are spent on the
  // recorded size first, and the bytes are read one operation at a time and
  // bounded, so a refusal costs no allocation at all.
  const record = resolveSessionAttachment(ctx.session.sessionId, attachmentId);
  if (!record)
    throw new EntryValidationError(
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

/** Resolve an optional entry/path scope to one library-relative path. */
async function resolveScope(
  store: LibraryStore,
  name: string | undefined,
  path: string | undefined,
): Promise<string | undefined> {
  if (name === undefined) {
    return path === undefined ? undefined : normalizeLibraryPath(path);
  }
  await store.ensureInitialized();
  const scan = await scanLibrary(store.kind, store.root);
  const summary = scan.entries.find((entry) => entry.name === name);
  if (!summary) {
    throw new EntryValidationError(
      `No valid ${store.kind.noun} declares the name "${name}". Scope by path instead to inspect a folder the library no longer declares.`,
    );
  }
  const folder = summary.path.split("/")[0]!;
  return path === undefined
    ? folder
    : `${folder}/${normalizeLibraryPath(path)}`;
}

function historyRow(store: LibraryStore, entry: LibraryHistoryEntry) {
  const { plural, trailerPrefix } = store.kind;
  const trailer = (name: string): string | undefined =>
    entry.trailers[`${trailerPrefix}-${name}`];
  const names = trailer("Names");
  const paths = trailer("Paths");
  const taskId = trailer("Task");
  return {
    commit: entry.shortCommit,
    fullCommit: entry.commit,
    date: entry.date,
    author: entry.author,
    subject: entry.subject,
    ...(names ? { [plural]: names } : {}),
    ...(paths ? { paths } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT;
  if (!Number.isFinite(value) || value < 1)
    throw new EntryValidationError("limit must be a positive number.");
  return Math.min(Math.floor(value), MAX_HISTORY_LIMIT);
}

function boundedChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DIFF_CHARS;
  if (!Number.isFinite(value) || value < 1)
    throw new EntryValidationError("maxChars must be a positive number.");
  return Math.min(Math.floor(value), MAX_DIFF_CHARS);
}

/** Flatten a bounded tree into compact rows; the tool result stays small. */
function compactTree(tree: EntryFileTree) {
  const rows: { path: string; type: string; bytes?: number }[] = [];
  const visit = (entries: EntryFileTreeEntry[]): void => {
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
