/**
 * Git-backed Knowledge Base storage core (KB 03).
 *
 * Owns the filesystem/Git layer for the first-class KB documented in
 * docs/knowledge-base.md: `DATA_DIR/knowledge` is a dedicated Git repo whose
 * source of truth is Markdown entries, entry-local assets, and versioned
 * comment logs. This module deliberately stays free of UI, agent-tool, and
 * frontmatter-schema concerns — it validates paths and Git integrity only.
 * Frontmatter schema/formatting enforcement (KB 04) layers on top of this.
 *
 * All mutations serialize on the KB repo's mutation lock (via {@link gitExec})
 * and validate every input path before touching the filesystem, so a bad batch
 * leaves the repo untouched rather than half-written.
 */
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DATA_DIR } from "./config.ts";
import { git, gitOptional, withRepoLock } from "./gitExec.ts";
import {
  classifyKnowledgePath,
  KB_GENERATED_DIR,
  KB_REPO_DIR_NAME,
  normalizeKnowledgeRelativePath,
  type KbPathKind,
} from "./knowledgeBaseContract.ts";

/** Default source-of-truth KB repo root: `DATA_DIR/knowledge`. */
const KB_STORE_ROOT = join(DATA_DIR, KB_REPO_DIR_NAME);

const KB_GITIGNORE = `${KB_GENERATED_DIR}/\n`;
const HISTORY_LIMIT_DEFAULT = 50;
// Unit/record separators keep git log parsing robust against arbitrary text.
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
// %B (raw body) is parsed for the trailing trailer block ourselves — more
// robust than git's %(trailers) heuristics for our fixed KB-* trailer keys.
const LOG_FORMAT =
  ["%H", "%an", "%ae", "%aI", "%B"].join(FIELD_SEP) + RECORD_SEP;

/** Actor attributed to a KB mutation; drives commit author + `KB-Actor` trailer. */
export interface KbActor {
  kind: "user" | "agent" | "system";
  id?: string;
  name: string;
}

/** Structured provenance recorded on every KB commit. */
export interface KbCommitMeta {
  actor: KbActor;
  /** Short imperative reason; becomes the commit subject line. */
  reason: string;
  /** Optional extended description placed in the commit body. */
  body?: string;
  sessionId?: string;
  taskId?: string;
  entryIds?: string[];
}

/** A single source-of-truth file change applied within one commit. */
export type KbFileChange =
  | { op: "write"; path: string; content: string | Uint8Array }
  | { op: "delete"; path: string };

export interface KbCommitResult {
  /** Full commit hash. */
  commit: string;
  /** Abbreviated (12-char) commit hash for compact display. */
  shortCommit: string;
  /** Normalized relative paths touched by the commit. */
  changedPaths: string[];
}

export interface KbCommitOptions {
  /** Optional domain validation hook executed under the KB repo lock before writes. */
  beforeApply?: () => Promise<void> | void;
}

export interface KbTreeNode {
  path: string;
  type: "file" | "dir";
  kind: KbPathKind;
}

export interface KbSourceStat {
  path: string;
  type: "file" | "dir";
  sizeBytes: number;
  mtimeMs: number;
}

export interface KbBoundedBytes {
  path: string;
  content: Buffer;
  sizeBytes: number;
  truncated: boolean;
}

export interface KbBoundedText {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
}

export interface KbHistoryEntry {
  commit: string;
  shortCommit: string;
  author: string;
  authorEmail: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
  trailers: Record<string, string>;
}

/** One source file a commit changed, with its normalized change status. */
export interface KbCommitFileChange {
  status: "added" | "modified" | "deleted" | "renamed";
  /** Repo-relative path on the new side (old side for deletes). */
  path: string;
  /** Previous path when the file was renamed. */
  oldPath?: string;
}

/** Storage-core error. Thrown for invalid paths, empty commits, and git faults. */
export class KnowledgeBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeBaseError";
  }
}

/**
 * Validate a caller-supplied Git revision before it reaches `git diff/show`
 * (etc.) as a positional argument. Rejects empty values and anything that could
 * be parsed as an option (a leading `-`), so read-only diff/show/history APIs
 * cannot smuggle option-shaped revisions such as `--output=<file>`. Callers must
 * ALSO pass `--end-of-options` before the revision for defense in depth.
 */
function assertGitRevision(value: string, label: string): string {
  const rev = value.trim();
  if (!rev) throw new KnowledgeBaseError(`A ${label} revision is required.`);
  if (rev.startsWith("-"))
    throw new KnowledgeBaseError(`Invalid ${label} revision: "${value}".`);
  return rev;
}

/**
 * Git-backed KB repository storage core. Construct with the repo root (defaults
 * to {@link KB_STORE_ROOT}); tests pass a temp directory. Initialization is
 * lazy and idempotent — the first mutating or reading call ensures the repo.
 */
export class KnowledgeBaseStore {
  readonly root: string;
  private initialized: Promise<void> | undefined;

  constructor(root: string = KB_STORE_ROOT) {
    this.root = root;
  }

  /** Ensure the root exists and is a Git repo with the KB `.gitignore`. */
  async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.doInitialize().catch((err) => {
        // Reset so a transient failure can be retried on the next call.
        this.initialized = undefined;
        throw err;
      });
    }
    return this.initialized;
  }

  private async doInitialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    // Init runs under the same per-repo lock as mutations, and re-checks state
    // inside the lock, so concurrent stores over one root never race on
    // `git init`/`git config`/the initial `.gitignore` commit.
    await withRepoLock(this.lockKey(), async () => {
      if (!existsSync(join(this.root, ".git"))) {
        await git(["init", "-b", "main"], this.root);
      }
      // Repo-local identity so commits work without global git config (tests).
      await git(["config", "user.name", "Knowledge Base"], this.root);
      await git(["config", "user.email", "kb@local"], this.root);
      await git(["config", "commit.gpgsign", "false"], this.root);
      // Git may otherwise detach automatic GC from `git commit`. A background
      // maintenance process would outlive this mutation lock and race the next
      // commit (or test cleanup), occasionally leaving the repository with
      // missing objects. Keep auto-GC synchronous so it remains inside the lock.
      await git(["config", "gc.autoDetach", "false"], this.root);
      // Ensure the KB gitignore is present, correct, and committed. This must
      // handle a fresh repo, a pre-existing/untracked `.gitignore`, and a retry
      // after a crash between writing and committing it — any of which could
      // otherwise leave a repo with no HEAD.
      const hasHead =
        (await gitOptional(["rev-parse", "--verify", "HEAD"], this.root))
          .code === 0;
      const gitignorePath = join(this.root, ".gitignore");
      const currentIgnore = existsSync(gitignorePath)
        ? await readFile(gitignorePath, "utf8")
        : null;
      if (currentIgnore !== KB_GITIGNORE) {
        await writeFile(gitignorePath, KB_GITIGNORE, "utf8");
      }
      await git(["add", ".gitignore"], this.root);
      const staged = (
        await git(["diff", "--cached", "--name-only"], this.root)
      ).stdout.trim();
      if (!hasHead || staged) {
        await this.commitStaged({
          actor: { kind: "system", name: "Knowledge Base" },
          reason: hasHead
            ? "Update knowledge base gitignore"
            : "Initialize knowledge base",
        });
      }
    });
  }

  /**
   * Stable mutation-lock key for this KB repo. The KB is a dedicated repo with a
   * single working tree (no linked worktrees), so the resolved root path is a
   * stable 1:1 key — unlike git-common-dir, it is identical before and after
   * `git init`, which lets init and mutations share one lock.
   */
  private lockKey(): string {
    try {
      return `kb:${realpathSync(this.root)}`;
    } catch {
      return `kb:${resolve(this.root)}`;
    }
  }

  private resolveSourcePath(input: string): string {
    const rel = normalizeKnowledgeRelativePath(input);
    if (!rel) throw new KnowledgeBaseError("Knowledge path is required.");
    const kind = classifyKnowledgePath(rel);
    if (kind === "reserved" || kind === "generated") {
      throw new KnowledgeBaseError(
        `Refusing to commit reserved/generated path "${rel}"; use generated-file helpers for rebuildable artifacts.`,
      );
    }
    return rel;
  }

  /**
   * Apply a batch of source-file writes/deletes as one atomic commit.
   *
   * Every path is validated before any filesystem write, so an invalid batch
   * leaves the repo unchanged. The whole apply+commit runs under the KB repo
   * lock so concurrent callers serialize instead of racing git's index.
   */
  async commitChanges(
    changes: KbFileChange[],
    meta: KbCommitMeta,
    options: KbCommitOptions = {},
  ): Promise<KbCommitResult> {
    await this.ensureInitialized();
    if (changes.length === 0)
      throw new KnowledgeBaseError("No changes provided to commit.");

    // Validate everything up front — no partial writes on validation failure.
    const planned = changes.map((change) => ({
      change,
      rel: this.resolveSourcePath(change.path),
    }));
    const seen = new Set<string>();
    for (const { rel } of planned) {
      if (seen.has(rel))
        throw new KnowledgeBaseError(`Duplicate path in change set: "${rel}".`);
      seen.add(rel);
    }

    const paths = planned.map((p) => p.rel);
    return withRepoLock(this.lockKey(), async () => {
      await options.beforeApply?.();
      // The tree is clean between mutations (each commit is atomic under this
      // lock), so a delete target must exist now; reject before any writes.
      for (const { change, rel } of planned) {
        if (change.op === "delete" && !existsSync(join(this.root, rel))) {
          throw new KnowledgeBaseError(
            `Cannot delete "${rel}": path does not exist.`,
          );
        }
      }
      try {
        for (const { change, rel } of planned) {
          const abs = join(this.root, rel);
          if (change.op === "write") {
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, change.content);
          } else {
            await rm(abs, { force: true });
          }
        }
        // `-A` stages writes, modifications, and removals for these paths.
        await git(["add", "-A", "--", ...paths], this.root);
        return await this.commitStaged(meta);
      } catch (err) {
        // Roll the affected paths back to HEAD so a failed batch never leaves
        // partial working-tree changes behind.
        await this.rollbackPaths(paths);
        throw err;
      }
    });
  }

  /** Best-effort restore of the given paths to their committed (HEAD) state. */
  private async rollbackPaths(paths: string[]): Promise<void> {
    await gitOptional(["reset", "--quiet", "--", ...paths], this.root);
    await gitOptional(["checkout", "HEAD", "--", ...paths], this.root);
    await gitOptional(["clean", "-fdq", "--", ...paths], this.root);
  }

  /**
   * Commit whatever is currently staged. Caller must already hold the repo lock
   * and have staged the intended changes. Throws if nothing is staged. The
   * recorded `changedPaths`/`KB-Paths` reflect the actual staged diff, not the
   * requested paths, so no-op writes never appear as changes.
   */
  private async commitStaged(meta: KbCommitMeta): Promise<KbCommitResult> {
    const staged = await git(["diff", "--cached", "--name-only"], this.root);
    const changedPaths = staged.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (changedPaths.length === 0) {
      throw new KnowledgeBaseError(
        "Nothing staged to commit (changes were a no-op).",
      );
    }
    const message = buildCommitMessage(meta, changedPaths);
    const { dir, file } = await this.writeMessageFile(message);
    try {
      const { name, email } = actorIdentity(meta.actor);
      await git(
        [
          "-c",
          `user.name=${name}`,
          "-c",
          `user.email=${email}`,
          "commit",
          "-F",
          file,
        ],
        this.root,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const head = (await git(["rev-parse", "HEAD"], this.root)).stdout.trim();
    return { commit: head, shortCommit: head.slice(0, 12), changedPaths };
  }

  private async writeMessageFile(
    message: string,
  ): Promise<{ dir: string; file: string }> {
    const dir = await mkdtemp(join(tmpdir(), "kb-commit-"));
    const file = join(dir, "message.txt");
    await writeFile(file, message, "utf8");
    return { dir, file };
  }

  /** Read a source file's text content. Rejects reserved/generated paths. */
  async readEntryFile(path: string): Promise<string> {
    await this.ensureInitialized();
    const rel = this.resolveSourcePath(path);
    const abs = join(this.root, rel);
    if (!existsSync(abs))
      throw new KnowledgeBaseError(`Knowledge file not found: "${rel}".`);
    return readFile(abs, "utf8");
  }

  /** Read a source file's raw bytes (assets). Rejects reserved/generated paths. */
  async readEntryBytes(path: string): Promise<Buffer> {
    return (await this.readEntryBytesBounded(path)).content;
  }

  /** Read at most `maxBytes` bytes from a source file. Rejects reserved/generated paths. */
  async readEntryBytesBounded(
    path: string,
    maxBytes = Number.MAX_SAFE_INTEGER,
  ): Promise<KbBoundedBytes> {
    await this.ensureInitialized();
    const rel = this.resolveSourcePath(path);
    return this.readBoundedAbs(rel, join(this.root, rel), maxBytes);
  }

  /** Stat a source file/folder without reading its content. Rejects reserved/generated paths. */
  async statSourcePath(path: string): Promise<KbSourceStat> {
    await this.ensureInitialized();
    const rel = this.resolveSourcePath(path);
    const abs = join(this.root, rel);
    if (!existsSync(abs))
      throw new KnowledgeBaseError(`Knowledge path not found: "${rel}".`);
    const info = await stat(abs);
    return {
      path: rel,
      type: info.isDirectory() ? "dir" : "file",
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
    };
  }

  /**
   * Walk the current working tree, returning only source-of-truth nodes
   * classified by {@link classifyKnowledgePath}. Implementation paths (`.git`,
   * `.gitignore`, the `.kb` control dir, `.kb/generated`) are never emitted, but
   * the walk still descends into `.kb` so versioned `.kb/comments/*.jsonl` logs
   * are exposed.
   */
  async listTree(): Promise<KbTreeNode[]> {
    await this.ensureInitialized();
    const nodes: KbTreeNode[] = [];
    const walk = async (relDir: string): Promise<void> => {
      const absDir = relDir ? join(this.root, relDir) : this.root;
      const entries = await readdir(absDir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        // Never descend into or emit git internals or generated artifacts.
        if (
          rel === ".git" ||
          rel === KB_GENERATED_DIR ||
          rel.startsWith(`${KB_GENERATED_DIR}/`)
        )
          continue;
        const kind = classifyKnowledgePath(rel);
        const emit = kind !== "reserved" && kind !== "generated";
        if (entry.isDirectory()) {
          if (emit) nodes.push({ path: rel, type: "dir", kind });
          await walk(rel);
        } else if (emit) {
          nodes.push({ path: rel, type: "file", kind });
        }
      }
    };
    await walk("");
    return nodes;
  }

  /**
   * Commit history for the whole KB, or scoped to one entry path (file/folder).
   * Answers both whole-KB and per-entry change questions from Git.
   */
  async history(
    opts: { path?: string; limit?: number } = {},
  ): Promise<KbHistoryEntry[]> {
    await this.ensureInitialized();
    const limit = opts.limit ?? HISTORY_LIMIT_DEFAULT;
    const args = ["log", `--max-count=${limit}`, `--format=${LOG_FORMAT}`];
    if (opts.path) args.push("--", this.resolveSourcePath(opts.path));
    const res = await git(args, this.root);
    return res.stdout
      .split(RECORD_SEP)
      .map((chunk) => chunk.replace(/^\n+/, ""))
      .filter((chunk) => chunk.trim().length > 0)
      .map(parseHistoryRecord);
  }

  /**
   * Unified diff between two revisions (defaults `to` = working tree), optionally
   * scoped to one entry path. Returns raw patch text.
   */
  async diff(opts: {
    from: string;
    to?: string;
    path?: string;
  }): Promise<string> {
    await this.ensureInitialized();
    // `--end-of-options` plus revision validation stops option-shaped revisions
    // (e.g. `--output=<file>`) from turning this read-only diff into a write.
    const args = [
      "diff",
      "--end-of-options",
      assertGitRevision(opts.from, "diff from"),
    ];
    if (opts.to) args.push(assertGitRevision(opts.to, "diff to"));
    if (opts.path) args.push("--", this.resolveSourcePath(opts.path));
    return (await git(args, this.root)).stdout;
  }

  /** The patch a single commit introduced, optionally scoped to one path. */
  async showCommit(commit: string, path?: string): Promise<string> {
    await this.ensureInitialized();
    const args = [
      "show",
      "--end-of-options",
      assertGitRevision(commit, "commit"),
    ];
    if (path) args.push("--", this.resolveSourcePath(path));
    return (await git(args, this.root)).stdout;
  }

  /**
   * The source files a single commit changed, optionally scoped to one path,
   * with their change status. Rename/copy fold to `M` (the UI diffs old→new
   * text); type changes fold to `M`.
   */
  async commitChangedFiles(
    commit: string,
    path?: string,
  ): Promise<KbCommitFileChange[]> {
    await this.ensureInitialized();
    // `-z` NUL-separates records/paths so slug paths with unusual bytes never
    // split wrong; `--format=` drops the commit header, leaving only the list.
    const args = [
      "show",
      "--name-status",
      "-z",
      "--format=",
      "--end-of-options",
      assertGitRevision(commit, "commit"),
    ];
    if (path) args.push("--", this.resolveSourcePath(path));
    const tokens = (await git(args, this.root)).stdout
      .split("\u0000")
      .filter((t) => t.length > 0);
    const files: KbCommitFileChange[] = [];
    for (let i = 0; i < tokens.length;) {
      const letter = tokens[i++]?.[0];
      if (letter === "R" || letter === "C") {
        const oldPath = tokens[i++];
        const newPath = tokens[i++];
        if (newPath)
          files.push({
            status: letter === "R" ? "renamed" : "modified",
            path: newPath,
            ...(oldPath !== undefined ? { oldPath } : {}),
          });
      } else if (
        letter === "A" ||
        letter === "M" ||
        letter === "D" ||
        letter === "T"
      ) {
        const p = tokens[i++];
        if (p)
          files.push({
            status:
              letter === "A"
                ? "added"
                : letter === "D"
                  ? "deleted"
                  : "modified",
            path: p,
          });
      } else {
        i++; // Skip an unexpected token defensively.
      }
    }
    return files;
  }

  /** Read a source file's text as it existed at a given commit. */
  async readFileAtCommit(commit: string, path: string): Promise<string> {
    await this.ensureInitialized();
    const rev = assertGitRevision(commit, "commit");
    const rel = this.resolveSourcePath(path);
    const res = await gitOptional(
      ["show", "--end-of-options", `${rev}:${rel}`],
      this.root,
    );
    if (res.code !== 0) {
      throw new KnowledgeBaseError(
        `No "${rel}" at commit ${rev}: ${res.stderr.trim()}`,
      );
    }
    return res.stdout;
  }

  /**
   * Restore the given source paths to their state at `commit`, then commit the
   * restoration forward (history is never rewritten).
   */
  async restorePaths(
    commit: string,
    paths: string[],
    meta: KbCommitMeta,
  ): Promise<KbCommitResult> {
    await this.ensureInitialized();
    if (paths.length === 0)
      throw new KnowledgeBaseError("No paths provided to restore.");
    commit = assertGitRevision(commit, "commit");
    const rels = paths.map((p) => this.resolveSourcePath(p));
    return withRepoLock(this.lockKey(), async () => {
      try {
        for (const rel of rels) {
          // Restore an exact snapshot, not a checkout overlay: first drop the
          // path's current tracked content (index + worktree), so children added
          // after the target commit are removed and folder scopes become an exact
          // tree. `--ignore-unmatch` tolerates a path absent from the index.
          await gitOptional(
            ["rm", "-r", "--quiet", "--ignore-unmatch", "--", rel],
            this.root,
          );
          // If the path existed at the target, lay its exact tree back down.
          const existedAtTarget =
            (
              await gitOptional(
                ["cat-file", "-e", `${commit}:${rel}`],
                this.root,
              )
            ).code === 0;
          if (existedAtTarget) {
            const res = await gitOptional(
              ["checkout", commit, "--", rel],
              this.root,
            );
            if (res.code !== 0) {
              throw new KnowledgeBaseError(
                `Failed to restore "${rel}" from ${commit}: ${res.stderr.trim()}`,
              );
            }
          }
        }
        return await this.commitStaged(meta);
      } catch (err) {
        await this.rollbackPaths(rels);
        throw err;
      }
    });
  }

  /**
   * Revert a previous commit as a new forward commit. Aborts and throws on
   * conflict, leaving the working tree clean.
   */
  async revertCommit(
    commit: string,
    meta: KbCommitMeta,
  ): Promise<KbCommitResult> {
    await this.ensureInitialized();
    commit = assertGitRevision(commit, "commit");
    return withRepoLock(this.lockKey(), async () => {
      const res = await gitOptional(
        ["revert", "--no-commit", "--end-of-options", commit],
        this.root,
      );
      if (res.code !== 0) {
        await gitOptional(["revert", "--abort"], this.root);
        throw new KnowledgeBaseError(
          `Failed to revert ${commit}: ${res.stderr.trim()}`,
        );
      }
      try {
        return await this.commitStaged(meta);
      } catch (err) {
        // Undo the staged (uncommitted) revert so the tree stays clean.
        await gitOptional(["reset", "--hard", "HEAD"], this.root);
        throw err;
      }
    });
  }

  // ---- Generated (rebuildable) artifacts: separate from source of truth. ----

  /** Absolute path for a generated artifact under `.kb/generated/`. */
  private generatedAbs(name: string): string {
    const rel = normalizeKnowledgeRelativePath(name);
    if (!rel)
      throw new KnowledgeBaseError("Generated artifact name is required.");
    return join(this.root, KB_GENERATED_DIR, rel);
  }

  /** Write a rebuildable index/cache under `.kb/generated/` (never committed). */
  async writeGeneratedFile(
    name: string,
    content: string | Uint8Array,
  ): Promise<void> {
    await this.ensureInitialized();
    const abs = this.generatedAbs(name);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  /** Read a generated artifact, or null when it has not been built yet. */
  async readGeneratedFile(name: string): Promise<string | null> {
    const result = await this.readGeneratedFileBounded(name);
    return result?.content ?? null;
  }

  /** Read at most `maxBytes` bytes from a generated artifact. */
  async readGeneratedFileBounded(
    name: string,
    maxBytes = Number.MAX_SAFE_INTEGER,
  ): Promise<KbBoundedText | null> {
    await this.ensureInitialized();
    const rel = normalizeKnowledgeRelativePath(name);
    const abs = this.generatedAbs(rel);
    if (!existsSync(abs)) return null;
    const result = await this.readBoundedAbs(
      `${KB_GENERATED_DIR}/${rel}`,
      abs,
      maxBytes,
    );
    return { ...result, content: result.content.toString("utf8") };
  }

  private async readBoundedAbs(
    rel: string,
    abs: string,
    maxBytes: number,
  ): Promise<KbBoundedBytes> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new KnowledgeBaseError("maxBytes must be a positive safe integer.");
    }
    if (!existsSync(abs))
      throw new KnowledgeBaseError(`Knowledge file not found: "${rel}".`);
    const info = await stat(abs);
    if (!info.isFile())
      throw new KnowledgeBaseError(`Knowledge path is not a file: "${rel}".`);
    if (info.size <= maxBytes) {
      return {
        path: rel,
        content: await readFile(abs),
        sizeBytes: info.size,
        truncated: false,
      };
    }
    const file = await open(abs, "r");
    try {
      const buffer = Buffer.allocUnsafe(maxBytes);
      const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
      return {
        path: rel,
        content: buffer.subarray(0, bytesRead),
        sizeBytes: info.size,
        truncated: true,
      };
    } finally {
      await file.close();
    }
  }

  /** Drop all generated artifacts; the source of truth is untouched. */
  async clearGenerated(): Promise<void> {
    await this.ensureInitialized();
    await rm(join(this.root, KB_GENERATED_DIR), {
      recursive: true,
      force: true,
    });
  }
}

function actorIdentity(actor: KbActor): { name: string; email: string } {
  const name = actor.name.trim() || actor.kind;
  const email = actor.id
    ? `${slugForEmail(actor.id)}@kb.local`
    : `${actor.kind}@kb.local`;
  return { name, email };
}

function slugForEmail(id: string): string {
  return (
    id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "actor"
  );
}

function buildCommitMessage(meta: KbCommitMeta, paths: string[]): string {
  const subject = firstLine(meta.reason) || "Update knowledge base";
  const lines = [subject];
  if (meta.body?.trim()) lines.push("", meta.body.trim());
  const trailers: string[] = [];
  const actorId = meta.actor.id
    ? `${meta.actor.kind}:${meta.actor.id}`
    : meta.actor.kind;
  trailers.push(`KB-Actor: ${actorId} (${meta.actor.name})`);
  if (meta.sessionId) trailers.push(`KB-Session: ${meta.sessionId}`);
  if (meta.taskId) trailers.push(`KB-Task: ${meta.taskId}`);
  if (meta.entryIds?.length)
    trailers.push(`KB-Entry: ${meta.entryIds.join(", ")}`);
  if (paths.length) trailers.push(`KB-Paths: ${paths.join(", ")}`);
  lines.push("", ...trailers);
  return lines.join("\n") + "\n";
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]*):\s?(.*)$/;

function parseHistoryRecord(chunk: string): KbHistoryEntry {
  const [commit = "", author = "", authorEmail = "", date = "", body = ""] =
    chunk.split(FIELD_SEP);
  const lines = body.replace(/\n+$/, "").split("\n");
  const subject = lines[0]?.trim() ?? "";
  const trailers: Record<string, string> = {};
  // Trailers are the final contiguous block of `Key: value` lines.
  for (let i = lines.length - 1; i > 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (line === "") continue;
    const match = TRAILER_RE.exec(line);
    if (!match) break;
    const [, key, value = ""] = match;
    if (key) trailers[key] = value;
  }
  return {
    commit,
    shortCommit: commit.slice(0, 12),
    author,
    authorEmail,
    date,
    subject,
    trailers,
  };
}
