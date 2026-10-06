/**
 * The Knowledge Base folder's Git layer (docs/knowledge-base.md).
 *
 * `DATA_DIR/knowledge` is a plain Git repository the user also edits directly
 * — in an editor, with `git pull`, through the browser's Commit. So a tool
 * write is a GUEST in someone else's working tree:
 *
 * - it touches only its own paths, and commits only those (`git commit --
 *   <paths>`), never whatever else happens to be staged;
 * - it refuses a path that has uncommitted changes, rather than committing (or
 *   rolling back) an edit it did not make;
 * - it never rewrites repository config or `.gitignore`: identity and signing
 *   are passed per commit.
 *
 * Writes serialize on the folder's ordinary repo lock (`repoLockKey`), the
 * same one the browser's Commit takes, and validate every path before
 * touching the filesystem.
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
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  git,
  gitBoundedStdout,
  gitOptional,
  repoLockKey,
  withRepoLock,
} from "./gitExec.ts";
import {
  isHiddenKnowledgePath,
  normalizeKnowledgeRelativePath,
} from "./knowledgeBaseContract.ts";
import { knowledgeBaseRoot } from "./knowledgeBaseSettings.ts";

const HISTORY_LIMIT_DEFAULT = 50;
// Unit/record separators keep git log parsing robust against arbitrary text.
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
// %B (raw body) is parsed for the trailing trailer block ourselves — more
// robust than git's %(trailers) heuristics for our fixed KB-* trailer keys.
const LOG_FORMAT =
  ["%H", "%an", "%ae", "%aI", "%B"].join(FIELD_SEP) + RECORD_SEP;

/** Actor attributed to a KB mutation; drives commit author + `KB-Actor` trailer. */
interface KbActor {
  kind: "user" | "agent" | "system";
  id?: string;
  name: string;
}

/** Structured provenance recorded on every KB commit. */
export interface KbCommitMeta {
  actor: KbActor;
  /** Short imperative reason; becomes the commit subject line. */
  reason: string;
  sessionId?: string;
  taskId?: string;
}

/** A single file change applied within one commit. */
export type KbFileChange =
  | { op: "write"; path: string; content: string | Uint8Array }
  | { op: "delete"; path: string };

export interface KbCommitResult {
  /** Full commit hash. */
  commit: string;
  /** Abbreviated (12-char) commit hash for compact display. */
  shortCommit: string;
  /** Normalized relative paths the commit changed. */
  changedPaths: string[];
}

export interface KbTreeNode {
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

/** Storage error: invalid paths, refused writes, empty commits, git faults. */
export class KnowledgeBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeBaseError";
  }
}

/**
 * Validate a caller-supplied Git revision before it reaches `git show` as a
 * positional argument. Rejects empty values and anything that could be parsed
 * as an option (a leading `-`). Callers ALSO pass `--end-of-options`.
 */
function assertGitRevision(value: string, label: string): string {
  const rev = value.trim();
  if (!rev) throw new KnowledgeBaseError(`A ${label} revision is required.`);
  if (rev.startsWith("-"))
    throw new KnowledgeBaseError(`Invalid ${label} revision: "${value}".`);
  return rev;
}

/** In-flight repo initializations by resolved root (see `doInitialize`). */
const initializing = new Map<string, Promise<void>>();

/**
 * Git-backed KB folder. Construct with the repo root (defaults to the folder
 * in effect, `knowledgeBaseRoot()`); tests pass a temp directory. Initialization is lazy
 * and idempotent — the first call ensures the folder is a repository.
 */
export class KnowledgeBaseStore {
  readonly root: string;
  private initialized: Promise<void> | undefined;

  constructor(root: string = knowledgeBaseRoot()) {
    this.root = root;
  }

  /** Ensure the root exists and is a Git repository with a first commit. */
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

  /**
   * One initialization per folder at a time, however many stores ask: the
   * repo lock's key changes when `git init` creates `.git`, so two stores
   * initializing the same new folder concurrently could otherwise hold
   * different keys. Only the IN-FLIGHT run is shared — a later call re-checks
   * the folder, which may have been removed meanwhile.
   */
  private doInitialize(): Promise<void> {
    const key = resolve(this.root);
    let pending = initializing.get(key);
    if (!pending) {
      pending = this.initializeRepo().finally(() => initializing.delete(key));
      initializing.set(key, pending);
    }
    return pending;
  }

  private async initializeRepo(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    // Init runs under the repo lock every git mutation of this folder takes.
    // Before `git init` that key is the folder itself, after it the repo's
    // `.git`; no write can fall between the two, since every write awaits this.
    await withRepoLock(await repoLockKey(this.root), async () => {
      if (!existsSync(join(this.root, ".git")))
        await git(["init", "-b", "main"], this.root);
      const hasHead =
        (await gitOptional(["rev-parse", "--verify", "HEAD"], this.root))
          .code === 0;
      // An unborn branch has nothing to diff History or Changes against.
      if (!hasHead)
        await this.commit(
          ["--allow-empty"],
          {
            actor: { kind: "system", name: "Knowledge Base" },
            reason: "Initialize knowledge base",
          },
          [],
        );
    });
  }

  /** The absolute path of a KB file, for tools that hand the agent a path. */
  absolutePath(path: string): string {
    return join(this.root, this.resolvePath(path));
  }

  private resolvePath(input: string): string {
    let rel: string;
    try {
      rel = normalizeKnowledgeRelativePath(input);
    } catch (err) {
      throw new KnowledgeBaseError((err as Error).message);
    }
    if (!rel)
      throw new KnowledgeBaseError("A Knowledge Base path is required.");
    if (isHiddenKnowledgePath(rel))
      throw new KnowledgeBaseError(
        `"${rel}" is a hidden path (a segment starts with "."); the tools do not read or write those.`,
      );
    return rel;
  }

  /**
   * Refuse paths with uncommitted changes — modified, staged, deleted or
   * untracked, a folder's contents included. Caller holds the repo lock.
   */
  private async assertUnchanged(paths: string[]): Promise<void> {
    const status = await git(
      ["status", "--porcelain=v1", "--untracked-files=all", "--", ...paths],
      this.root,
    );
    const dirty = status.stdout
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    if (dirty.length === 0) return;
    const shown = dirty.slice(0, 5).join(", ");
    throw new KnowledgeBaseError(
      `Uncommitted changes in the Knowledge Base: ${shown}${dirty.length > 5 ? ", …" : ""}. Those are the user's own edits; ask them to commit or discard them (Knowledge → Uncommitted changes) before changing these files.`,
    );
  }

  /**
   * Apply a batch of writes/deletes as one commit of exactly those paths.
   *
   * Every path is validated before any filesystem write, and every path must
   * be free of uncommitted changes, so a refused or failed batch leaves the
   * folder as it was.
   */
  async commitChanges(
    changes: KbFileChange[],
    meta: KbCommitMeta,
  ): Promise<KbCommitResult> {
    await this.ensureInitialized();
    if (changes.length === 0)
      throw new KnowledgeBaseError("No changes provided to commit.");
    const planned = changes.map((change) => ({
      change,
      rel: this.resolvePath(change.path),
    }));
    const paths = planned.map((p) => p.rel);
    if (new Set(paths).size !== paths.length)
      throw new KnowledgeBaseError("A path appears twice in one change set.");

    return withRepoLock(await repoLockKey(this.root), async () => {
      await this.assertUnchanged(paths);
      for (const { change, rel } of planned) {
        const abs = join(this.root, rel);
        if (change.op === "delete" && !existsSync(abs))
          throw new KnowledgeBaseError(`Cannot delete "${rel}": not found.`);
        if (change.op === "write" && existsSync(abs)) {
          if ((await stat(abs)).isDirectory())
            throw new KnowledgeBaseError(`"${rel}" is a folder, not a file.`);
        }
      }
      try {
        for (const { change, rel } of planned) {
          const abs = join(this.root, rel);
          if (change.op === "write") {
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, change.content);
          } else {
            await rm(abs, { recursive: true, force: true });
          }
        }
        return await this.commitPaths(paths, meta);
      } catch (err) {
        await this.rollbackPaths(paths);
        throw err;
      }
    });
  }

  /** Move (rename) one file or folder, committed as one change. */
  async move(
    from: string,
    to: string,
    meta: KbCommitMeta,
  ): Promise<KbCommitResult> {
    await this.ensureInitialized();
    const source = this.resolvePath(from);
    const target = this.resolvePath(to);
    if (source === target || target.startsWith(`${source}/`))
      throw new KnowledgeBaseError(
        `Cannot move "${source}" to "${target}": the target is the source or inside it.`,
      );
    return withRepoLock(await repoLockKey(this.root), async () => {
      if (!existsSync(join(this.root, source)))
        throw new KnowledgeBaseError(`Cannot move "${source}": not found.`);
      if (existsSync(join(this.root, target)))
        throw new KnowledgeBaseError(
          `Cannot move to "${target}": it already exists.`,
        );
      await this.assertUnchanged([source, target]);
      await mkdir(dirname(join(this.root, target)), { recursive: true });
      try {
        // `git mv` stages the rename itself; the source no longer exists to add.
        await git(["mv", "--", source, target], this.root);
        return await this.commitPaths([source, target], meta, false);
      } catch (err) {
        await this.rollbackPaths([source, target]);
        throw err;
      }
    });
  }

  /** Stage and commit exactly `paths`. Caller holds the repo lock. */
  private async commitPaths(
    paths: string[],
    meta: KbCommitMeta,
    stage = true,
  ): Promise<KbCommitResult> {
    if (stage) await git(["add", "-A", "--", ...paths], this.root);
    const staged = await git(
      ["diff", "--cached", "--name-only", "--no-renames", "--", ...paths],
      this.root,
    );
    const changedPaths = staged.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (changedPaths.length === 0)
      throw new KnowledgeBaseError(
        "Nothing to commit: the change leaves every file as it was.",
      );
    await this.commit(["--", ...paths], meta, changedPaths);
    const head = (await git(["rev-parse", "HEAD"], this.root)).stdout.trim();
    return { commit: head, shortCommit: head.slice(0, 12), changedPaths };
  }

  /**
   * `git commit` with the actor's identity and the KB trailers. Identity,
   * signing and GC are set for this one command, never in the repo config:
   * the folder is the user's, and so is its configuration. Auto-GC stays in
   * the foreground so no background process outlives the repo lock.
   */
  private async commit(
    args: string[],
    meta: KbCommitMeta,
    changedPaths: string[],
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "kb-commit-"));
    const file = join(dir, "message.txt");
    try {
      await writeFile(file, buildCommitMessage(meta, changedPaths), "utf8");
      const { name, email } = actorIdentity(meta.actor);
      await git(
        [
          "-c",
          `user.name=${name}`,
          "-c",
          `user.email=${email}`,
          "-c",
          "commit.gpgsign=false",
          "-c",
          "gc.autoDetach=false",
          "commit",
          "--no-verify",
          "-F",
          file,
          ...args,
        ],
        this.root,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Restore paths this call changed to HEAD. Safe because
   * {@link assertUnchanged} proved they had no uncommitted edits before.
   */
  private async rollbackPaths(paths: string[]): Promise<void> {
    await gitOptional(["reset", "--quiet", "--", ...paths], this.root);
    await gitOptional(["checkout", "HEAD", "--", ...paths], this.root);
    await gitOptional(["clean", "-fdq", "--", ...paths], this.root);
  }

  /** Every path with uncommitted changes, untracked files included. */
  async uncommittedPaths(): Promise<Set<string>> {
    await this.ensureInitialized();
    const status = await git(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      this.root,
    );
    const paths = new Set<string>();
    const records = status.stdout.split("\0");
    for (let i = 0; i < records.length; i++) {
      const record = records[i] ?? "";
      if (record.length < 4) continue;
      paths.add(record.slice(3));
      // A rename's record is followed by its source path.
      if (record[0] === "R" || record[0] === "C") paths.add(records[++i] ?? "");
    }
    return paths;
  }

  /** Read a file's text. */
  async readText(path: string): Promise<string> {
    await this.ensureInitialized();
    const rel = this.resolvePath(path);
    const abs = join(this.root, rel);
    if (!existsSync(abs))
      throw new KnowledgeBaseError(`Knowledge file not found: "${rel}".`);
    if ((await stat(abs)).isDirectory())
      throw new KnowledgeBaseError(`"${rel}" is a folder, not a file.`);
    return readFile(abs, "utf8");
  }

  /** Read at most `maxBytes` bytes of a file. */
  async readBytes(
    path: string,
    maxBytes = Number.MAX_SAFE_INTEGER,
  ): Promise<KbBoundedBytes> {
    await this.ensureInitialized();
    const rel = this.resolvePath(path);
    const abs = join(this.root, rel);
    if (!existsSync(abs))
      throw new KnowledgeBaseError(`Knowledge file not found: "${rel}".`);
    const info = await stat(abs);
    if (!info.isFile())
      throw new KnowledgeBaseError(`"${rel}" is a folder, not a file.`);
    const length = Math.max(0, Math.min(info.size, Math.floor(maxBytes)));
    const handle = await open(abs, "r");
    try {
      const content = Buffer.alloc(length);
      const { bytesRead } = await handle.read(content, 0, length, 0);
      return {
        path: rel,
        content: content.subarray(0, bytesRead),
        sizeBytes: info.size,
        truncated: info.size > bytesRead,
      };
    } finally {
      await handle.close();
    }
  }

  /** Whether a (non-hidden) path exists, and what it is. */
  async kindOf(path: string): Promise<"file" | "dir" | null> {
    await this.ensureInitialized();
    const abs = join(this.root, this.resolvePath(path));
    if (!existsSync(abs)) return null;
    return (await stat(abs)).isDirectory() ? "dir" : "file";
  }

  /**
   * Walk the working tree — uncommitted files included, hidden paths
   * ({@link isHiddenKnowledgePath}) skipped — optionally under one folder.
   */
  async listTree(under = ""): Promise<KbTreeNode[]> {
    await this.ensureInitialized();
    const start = under ? this.resolvePath(under) : "";
    const nodes: KbTreeNode[] = [];
    const walk = async (relDir: string): Promise<void> => {
      const absDir = relDir ? join(this.root, relDir) : this.root;
      const entries = await readdir(absDir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entry.name.startsWith(".")) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        const info = await stat(join(this.root, rel));
        nodes.push({
          path: rel,
          type: entry.isDirectory() ? "dir" : "file",
          sizeBytes: entry.isDirectory() ? 0 : info.size,
          mtimeMs: info.mtimeMs,
        });
        if (entry.isDirectory()) await walk(rel);
      }
    };
    if (start && (await this.kindOf(start)) !== "dir")
      throw new KnowledgeBaseError(`"${start}" is not a folder.`);
    await walk(start);
    return nodes;
  }

  /** Commit history for the whole KB, or for one file or folder. */
  async history(
    opts: { path?: string; limit?: number } = {},
  ): Promise<KbHistoryEntry[]> {
    await this.ensureInitialized();
    const limit = opts.limit ?? HISTORY_LIMIT_DEFAULT;
    const args = ["log", `--max-count=${limit}`, `--format=${LOG_FORMAT}`];
    if (opts.path) args.push("--follow", "--", this.resolvePath(opts.path));
    const res = await gitOptional(args, this.root);
    // `--follow` only takes one FILE; a folder's history is the plain log.
    const out =
      res.code === 0
        ? res
        : await git(
            args.filter((arg) => arg !== "--follow"),
            this.root,
          );
    return out.stdout
      .split(RECORD_SEP)
      .map((chunk) => chunk.replace(/^\n+/, ""))
      .filter((chunk) => chunk.trim().length > 0)
      .map(parseHistoryRecord);
  }

  /** The patch one commit introduced, optionally scoped to one path, bounded. */
  async showCommit(
    commit: string,
    opts: { path?: string; maxChars: number },
  ): Promise<{ patch: string; totalChars: number; truncated: boolean }> {
    await this.ensureInitialized();
    const args = [
      "show",
      "--format=",
      "--end-of-options",
      assertGitRevision(commit, "commit"),
    ];
    if (opts.path) args.push("--", this.resolvePath(opts.path));
    return gitBoundedStdout(args, this.root, opts.maxChars);
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
  const subject = meta.reason.split("\n")[0]?.trim() || "Update knowledge base";
  const actorId = meta.actor.id
    ? `${meta.actor.kind}:${meta.actor.id}`
    : meta.actor.kind;
  const trailers = [`KB-Actor: ${actorId} (${meta.actor.name})`];
  if (meta.sessionId) trailers.push(`KB-Session: ${meta.sessionId}`);
  if (meta.taskId) trailers.push(`KB-Task: ${meta.taskId}`);
  if (paths.length) trailers.push(`KB-Paths: ${paths.join(", ")}`);
  return [subject, "", ...trailers].join("\n") + "\n";
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
