/**
 * Worktree read surface: changed-file lists, per-file diffs (raw unified text +
 * text-sized full old/new contents), file contents at a ref or in the working
 * tree, the branch commit log, and gitignore-aware
 * directory listings — all parameterized by worktree row + {@link WorktreeDiffScope}.
 *
 * Read-only throughout — no repo lock needed; git handles concurrent readers.
 */
import { realpathSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import type {
  WorktreeChangeStatus,
  WorktreeChangeFile,
  WorktreeChangesResponse,
  WorktreeCommitLogEntry,
  WorktreeDiffScope,
  WorktreeFileDiffResponse,
  WorktreeFileResponse,
  WorktreeGitStatus,
  WorktreeLogResponse,
  WorktreeTreeEntry,
} from "@assistant/shared";
import { git, gitOptional, gitRawStdout } from "../gitExec.ts";
import type { WorktreeRow } from "../db/worktreeStore.ts";

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_DIFF_CHARS = 700_000;

/** A ref must look like a git rev; blocks option injection (`--foo`) and paths. */
export function isSafeRef(ref: string): boolean {
  return /^[0-9A-Za-z._/~^-]{1,128}$/.test(ref) && !ref.startsWith("-");
}

function safePath(root: string, relPath: string): string {
  if (!relPath || isAbsolute(relPath)) throw new Error("Invalid file path.");
  const abs = join(root, relPath);
  const back = relative(root, abs);
  if (!back || back.startsWith("..") || isAbsolute(back))
    throw new Error("Invalid file path.");
  return abs;
}

/**
 * Resolve a repo-relative path for READING file content. {@link safePath} is
 * lexical only; file reads follow symlinks, so a repo containing
 * `secret -> /etc/passwd` would otherwise leak content outside the worktree.
 * The resolved real path must stay inside the (real) worktree root.
 */
export function containedRealPath(root: string, relPath: string): string {
  const abs = safePath(root, relPath);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return abs; // missing file — the read fails naturally
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep))
    throw new Error("Invalid file path.");
  return real;
}

function assertScope(scope: WorktreeDiffScope): void {
  if (scope.kind !== "range") return;
  if (
    !isSafeRef(scope.from) ||
    (scope.to !== undefined && !isSafeRef(scope.to))
  ) {
    throw new Error("Invalid revision range.");
  }
}

/* --------------------------------- changes -------------------------------- */

export async function getWorktreeChanges(
  row: WorktreeRow,
  scope: WorktreeDiffScope,
): Promise<WorktreeChangesResponse> {
  assertScope(scope);
  const files =
    scope.kind === "workingTree"
      ? await workingTreeFiles(row)
      : await rangeFiles(row, scope.from, scope.to);
  const [branchRes, headRes] = await Promise.all([
    gitOptional(["rev-parse", "--abbrev-ref", "HEAD"], row.path),
    gitOptional(["rev-parse", "--short", "HEAD"], row.path),
  ]);
  const branchRaw = branchRes.code === 0 ? branchRes.stdout.trim() : "";
  return changesResponse(
    row,
    scope,
    files,
    branchRaw && branchRaw !== "HEAD" ? branchRaw : null,
    headRes.code === 0 ? headRes.stdout.trim() || null : null,
  );
}

/** Build a working-tree response from the status watcher's shared git reads. */
export function worktreeChangesFromSnapshot(
  row: WorktreeRow,
  identity: Pick<WorktreeGitStatus, "branch" | "head">,
  files: WorktreeChangeFile[],
): WorktreeChangesResponse {
  return changesResponse(
    row,
    { kind: "workingTree" },
    files,
    identity.branch,
    identity.head,
  );
}

function changesResponse(
  row: WorktreeRow,
  scope: WorktreeDiffScope,
  files: WorktreeChangeFile[],
  branch: string | null,
  head: string | null,
): WorktreeChangesResponse {
  files.sort((a, b) => a.path.localeCompare(b.path));
  const totals = files.reduce(
    (acc, file) => ({
      files: acc.files + 1,
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
  return {
    worktreeId: row.id,
    branch,
    head,
    scope,
    files,
    totals,
    updatedAt: Date.now(),
  };
}

async function workingTreeFiles(
  row: WorktreeRow,
): Promise<WorktreeChangeFile[]> {
  const [statusRes, numstatRes] = await Promise.all([
    git(["status", "--porcelain=v1", "--untracked-files=all", "-z"], row.path),
    gitOptional(["diff", "--numstat", "-z", "HEAD", "--"], row.path),
  ]);
  return hydrateWorkingTreeFiles(
    row,
    parsePorcelainV1Z(statusRes.stdout),
    parseNumstatZ(numstatRes.code === 0 ? numstatRes.stdout : ""),
  );
}

/** Parse the v2 `-z` snapshot already read by worktreeStatus. */
export async function workingTreeFilesFromPorcelainV2(
  row: WorktreeRow,
  statusStdout: string,
  numstatStdout: string,
): Promise<WorktreeChangeFile[]> {
  return hydrateWorkingTreeFiles(
    row,
    parsePorcelainV2Z(statusStdout),
    parseNumstatZ(numstatStdout),
  );
}

async function hydrateWorkingTreeFiles(
  row: WorktreeRow,
  files: WorktreeChangeFile[],
  stats: Map<
    string,
    Pick<WorktreeChangeFile, "additions" | "deletions" | "binary">
  >,
): Promise<WorktreeChangeFile[]> {
  await Promise.all(
    files.map(async (file) => {
      const found =
        stats.get(file.path) ??
        (file.oldPath ? stats.get(file.oldPath) : undefined);
      if (found) Object.assign(file, found);
      if (file.status === "untracked")
        Object.assign(file, await untrackedStats(row.path, file.path));
    }),
  );
  return files;
}

async function rangeFiles(
  row: WorktreeRow,
  from: string,
  to?: string,
): Promise<WorktreeChangeFile[]> {
  const range = to ? [from, to] : [from];
  const [nameStatusRes, numstatRes] = await Promise.all([
    git(["diff", "--name-status", "--find-renames", ...range, "--"], row.path),
    gitOptional(["diff", "--numstat", ...range, "--"], row.path),
  ]);
  const files = parseNameStatus(nameStatusRes.stdout);
  const stats = parseNumstat(numstatRes.code === 0 ? numstatRes.stdout : "");
  for (const file of files) {
    const found =
      stats.get(file.path) ??
      (file.oldPath ? stats.get(file.oldPath) : undefined);
    if (found) Object.assign(file, found);
  }
  return files;
}

function statusFromPorcelain(xy: string): WorktreeChangeStatus {
  if (xy.includes("?")) return "untracked";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("C")) return "copied";
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("M")) return "modified";
  return "changed";
}

function changeFile(
  xy: string,
  path: string,
  oldPath?: string,
): WorktreeChangeFile {
  return {
    path,
    ...(oldPath !== undefined ? { oldPath } : {}),
    status: statusFromPorcelain(xy),
    additions: 0,
    deletions: 0,
    binary: false,
  };
}

function parsePorcelainV1Z(stdout: string): WorktreeChangeFile[] {
  const files: WorktreeChangeFile[] = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    const renamed = xy.includes("R") || xy.includes("C");
    const oldPath = renamed ? records[(index += 1)] : undefined;
    files.push(changeFile(xy, path, oldPath));
  }
  return files;
}

function parsePorcelainV2Z(stdout: string): WorktreeChangeFile[] {
  const files: WorktreeChangeFile[] = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record || record.startsWith("# ") || record.startsWith("! ")) continue;
    if (record.startsWith("? ")) {
      files.push(changeFile("??", record.slice(2)));
      continue;
    }

    const ordinary = /^1 (\S{2}) (?:\S+ ){6}(.*)$/s.exec(record);
    if (ordinary) {
      files.push(changeFile(ordinary[1]!, ordinary[2]!));
      continue;
    }
    const renamed = /^2 (\S{2}) (?:\S+ ){7}(.*)$/s.exec(record);
    if (renamed) {
      files.push(changeFile(renamed[1]!, renamed[2]!, records[(index += 1)]));
      continue;
    }
    const unmerged = /^u (\S{2}) (?:\S+ ){8}(.*)$/s.exec(record);
    if (unmerged) files.push(changeFile(unmerged[1]!, unmerged[2]!));
  }
  return files;
}

function parseNameStatus(stdout: string): WorktreeChangeFile[] {
  const files: WorktreeChangeFile[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [code, a, b] = line.split("\t");
    if (!code || !a) continue;
    const letter = code[0];
    const status: WorktreeChangeStatus =
      letter === "A"
        ? "added"
        : letter === "D"
          ? "deleted"
          : letter === "R"
            ? "renamed"
            : letter === "C"
              ? "copied"
              : letter === "M"
                ? "modified"
                : "changed";
    const renamed = letter === "R" || letter === "C";
    files.push({
      path: renamed && b ? b : a,
      ...(renamed && b ? { oldPath: a } : {}),
      status,
      additions: 0,
      deletions: 0,
      binary: false,
    });
  }
  return files;
}

function parseNumstat(
  stdout: string,
): Map<string, Pick<WorktreeChangeFile, "additions" | "deletions" | "binary">> {
  const stats = new Map<
    string,
    Pick<WorktreeChangeFile, "additions" | "deletions" | "binary">
  >();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [a, d, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    stats.set(normalizeNumstatPath(path), fileStats(a, d));
  }
  return stats;
}

function parseNumstatZ(
  stdout: string,
): Map<string, Pick<WorktreeChangeFile, "additions" | "deletions" | "binary">> {
  const stats = new Map<
    string,
    Pick<WorktreeChangeFile, "additions" | "deletions" | "binary">
  >();
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    const [a, d, ...pathParts] = record.split("\t");
    let path = pathParts.join("\t");
    if (!path) {
      index += 1; // rename/copy old path
      path = records[(index += 1)] ?? ""; // rename/copy destination
    }
    if (path) stats.set(path, fileStats(a, d));
  }
  return stats;
}

function fileStats(
  additions: string | undefined,
  deletions: string | undefined,
): Pick<WorktreeChangeFile, "additions" | "deletions" | "binary"> {
  return {
    additions: additions === "-" ? 0 : Number(additions) || 0,
    deletions: deletions === "-" ? 0 : Number(deletions) || 0,
    binary: additions === "-" || deletions === "-",
  };
}

function normalizeNumstatPath(path: string): string {
  // Git prints simple renames as e.g. app/{old.ts => new.ts}. Fall back to the
  // post-rename side, which is the path the UI opens.
  const brace = path.match(/^(.*)\{.* => (.*)\}(.*)$/);
  if (brace) return `${brace[1] ?? ""}${brace[2] ?? ""}${brace[3] ?? ""}`;
  const arrow = path.match(/^.* => (.*)$/);
  return arrow?.[1] ?? path;
}

/* -------------------------------- file diff -------------------------------- */

export async function getWorktreeFileDiff(
  row: WorktreeRow,
  path: string,
  scope: WorktreeDiffScope,
): Promise<WorktreeFileDiffResponse> {
  assertScope(scope);
  safePath(row.path, path);
  const changes = await getWorktreeChanges(row, scope);
  const file = changes.files.find(
    (item) => item.path === path || item.oldPath === path,
  );
  if (!file) throw new Error("File is not changed in this scope.");

  const oldRef = scope.kind === "workingTree" ? "HEAD" : scope.from;
  const newRef = scope.kind === "workingTree" ? undefined : scope.to;
  const oldSource =
    file.status === "added" || file.status === "untracked"
      ? undefined
      : `${oldRef}:${file.oldPath ?? file.path}`;
  const newSource =
    file.status === "deleted"
      ? undefined
      : newRef
        ? `${newRef}:${file.path}`
        : file.path;

  const oldContent = oldSource
    ? await showFile(row.path, oldSource)
    : { text: "", binary: false, truncated: false };
  const newContent = newSource
    ? newRef
      ? await showFile(row.path, newSource)
      : await readWorkingFile(row.path, file.path)
    : { text: "", binary: false, truncated: false };

  const binary = file.binary || oldContent.binary || newContent.binary;
  let diff = "";
  if (!binary) {
    if (file.status === "untracked") {
      diff = untrackedDiff(file.path, newContent.text);
    } else {
      const range =
        scope.kind === "workingTree"
          ? ["HEAD"]
          : scope.to
            ? [scope.from, scope.to]
            : [scope.from];
      const res = await gitOptional(
        [
          "diff",
          "--no-ext-diff",
          "--no-color",
          "--find-renames",
          ...range,
          "--",
          file.path,
          ...(file.oldPath ? [file.oldPath] : []),
        ],
        row.path,
      );
      diff = res.code === 0 ? truncateDiff(res.stdout) : "";
    }
  }

  // Resolve the committed new side to a stable oid so the client can anchor
  // review comments at exactly the displayed content (ref anchors).
  let newOid: string | undefined;
  if (newRef) {
    const oidRes = await gitOptional(
      ["rev-parse", "--verify", `${newRef}^{commit}`],
      row.path,
    );
    if (oidRes.code === 0) newOid = oidRes.stdout.trim() || undefined;
  }

  return {
    worktreeId: row.id,
    path: file.path,
    ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
    status: file.status,
    language: languageForPath(file.path),
    binary,
    truncated: oldContent.truncated || newContent.truncated,
    diff,
    oldContent: binary ? "" : oldContent.text,
    newContent: binary ? "" : newContent.text,
    ...(newOid ? { newOid } : {}),
    updatedAt: Date.now(),
  };
}

function truncateDiff(diff: string): string {
  return diff.length > MAX_DIFF_CHARS
    ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… diff truncated …\n`
    : diff;
}

function untrackedDiff(path: string, content: string): string {
  const lines = content.split("\n");
  const lineCount = content ? countLines(content) : 0;
  const body = lines
    .map((line, index) =>
      index === lines.length - 1 && line === "" ? "" : `+${line}`,
    )
    .filter((line, index) => !(index === lines.length - 1 && line === ""))
    .join("\n");
  const diff = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lineCount} @@`,
    body,
  ].join("\n");
  return truncateDiff(diff);
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.endsWith("\n")
    ? text.split("\n").length - 1
    : text.split("\n").length;
}

interface TextContent {
  text: string;
  binary: boolean;
  truncated: boolean;
}

async function showFile(cwd: string, source: string): Promise<TextContent> {
  const res = await gitOptional(["show", source], cwd);
  if (res.code !== 0) return { text: "", binary: false, truncated: false };
  const truncated = res.stdout.length > MAX_TEXT_BYTES;
  const text = truncated ? res.stdout.slice(0, MAX_TEXT_BYTES) : res.stdout;
  if (text.includes("\0")) return { text: "", binary: true, truncated };
  return { text, binary: false, truncated };
}

async function readWorkingFile(
  root: string,
  relPath: string,
): Promise<TextContent> {
  try {
    const buffer = await readFile(containedRealPath(root, relPath));
    const truncated = buffer.length > MAX_TEXT_BYTES;
    const slice = truncated ? buffer.subarray(0, MAX_TEXT_BYTES) : buffer;
    if (slice.includes(0)) return { text: "", binary: true, truncated };
    return { text: slice.toString("utf8"), binary: false, truncated };
  } catch {
    return { text: "", binary: false, truncated: false };
  }
}

async function untrackedStats(
  root: string,
  relPath: string,
): Promise<Pick<WorktreeChangeFile, "additions" | "deletions" | "binary">> {
  const file = await readWorkingFile(root, relPath);
  if (file.binary) return { additions: 0, deletions: 0, binary: true };
  return { additions: countLines(file.text), deletions: 0, binary: false };
}

/* ------------------------------- file content ------------------------------ */

export async function getWorktreeFileContent(
  row: WorktreeRow,
  path: string,
  ref?: string,
): Promise<WorktreeFileResponse> {
  if (ref !== undefined && !isSafeRef(ref))
    throw new Error("Invalid revision.");
  safePath(row.path, path);
  const content = ref
    ? await showFile(row.path, `${ref}:${path}`)
    : await readWorkingFile(row.path, path);
  return {
    worktreeId: row.id,
    path,
    ...(ref ? { ref } : {}),
    language: languageForPath(path),
    mimeType: mimeForPath(path),
    binary: content.binary,
    truncated: content.truncated,
    content: content.text,
    updatedAt: Date.now(),
  };
}

/* --------------------------------- raw file --------------------------------- */

const MAX_RAW_BYTES = 20 * 1024 * 1024;

export interface WorktreeRawFile {
  content: Buffer;
  contentType: string;
}

/**
 * Raw file bytes for browser-native rendering (images, HTML previews,
 * downloads) — working tree by default, `git show` at a ref. Same containment
 * guard as text reads; refuses (never truncates) over-size files.
 */
export async function getWorktreeFileRaw(
  row: WorktreeRow,
  path: string,
  ref?: string,
): Promise<WorktreeRawFile> {
  if (ref !== undefined && !isSafeRef(ref))
    throw new Error("Invalid revision.");
  safePath(row.path, path);
  let content: Buffer;
  if (ref) {
    const res = await gitRawStdout(
      ["show", `${ref}:${path}`],
      row.path,
      MAX_RAW_BYTES + 1,
    );
    if (res.code !== 0) throw new Error("File not found at that revision.");
    content = res.content;
  } else {
    content = await readFile(containedRealPath(row.path, path)).catch(() => {
      throw new Error("File not found.");
    });
  }
  if (content.length > MAX_RAW_BYTES)
    throw new Error("File is too large to serve raw.");
  return { content, contentType: rawMimeForPath(path, content) };
}

const RAW_BINARY_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
};

function rawMimeForPath(path: string, content: Buffer): string {
  const ext = extname(path).slice(1).toLowerCase();
  const binary = RAW_BINARY_MIME[ext];
  if (binary) return binary;
  if (ext === "html" || ext === "htm") return "text/html; charset=utf-8";
  if (ext === "md" || ext === "markdown") return "text/markdown; charset=utf-8";
  if (ext === "json") return "application/json; charset=utf-8";
  if (ext === "css") return "text/css; charset=utf-8";
  if (content.includes(0)) return "application/octet-stream";
  return "text/plain; charset=utf-8";
}

/* ---------------------------------- log ------------------------------------ */

export async function getWorktreeLog(
  row: WorktreeRow,
  limit: number,
): Promise<WorktreeLogResponse> {
  const capped = Math.max(1, Math.min(limit || 50, 200));
  const logRes = await gitOptional(
    [
      "log",
      `--format=%H%x00%h%x00%s%x00%an%x00%at`,
      "-n",
      String(capped),
      "HEAD",
    ],
    row.path,
  );
  if (logRes.code !== 0) return { worktreeId: row.id, entries: [] };
  // Commits unique to the branch, so base-branch context commits can be marked.
  const branchOnlyRes = await gitOptional(
    ["rev-list", `${row.baseBranch}..HEAD`],
    row.path,
  );
  const branchOnly = new Set(
    branchOnlyRes.code === 0
      ? branchOnlyRes.stdout.split("\n").filter(Boolean)
      : [],
  );
  const entries: WorktreeCommitLogEntry[] = [];
  for (const line of logRes.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [oid, shortOid, subject, author, at] = line.split("\0");
    if (!oid || !shortOid) continue;
    entries.push({
      oid,
      shortOid,
      subject: subject ?? "",
      author: author ?? "",
      authoredAt: (Number(at) || 0) * 1000,
      ...(branchOnly.has(oid) ? {} : { onBase: true }),
    });
  }
  return { worktreeId: row.id, entries };
}

/* ---------------------------------- tree ----------------------------------- */

/**
 * One directory level of the worktree's working tree. The default is
 * gitignore-aware; `includeIgnored` adds ignored files to the same tracked and
 * untracked listing.
 */
export async function getWorktreeTree(
  row: WorktreeRow,
  dir: string,
  includeIgnored = false,
): Promise<WorktreeTreeEntry[]> {
  const normalizedDir = dir.replace(/\/+$/, "");
  const prefix = normalizedDir ? `${normalizedDir}/` : "";
  if (includeIgnored) {
    // Git can include ignored files only by recursively enumerating every path.
    // Read the requested directory directly instead: the HTTP contract asks for
    // one level, and this also preserves empty ignored directories.
    const absoluteDir = normalizedDir
      ? containedRealPath(row.path, normalizedDir)
      : realpathSync(row.path);
    const entries = (
      await readdir(absoluteDir, { withFileTypes: true })
    ).filter((entry) => entry.name !== ".git");
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        if (entry.isDirectory()) return undefined;
        try {
          return (await lstat(join(absoluteDir, entry.name))).size;
        } catch {
          return undefined;
        }
      }),
    );
    const visible = entries.map((entry, index): WorktreeTreeEntry => ({
      name: entry.name,
      path: `${prefix}${entry.name}`,
      kind: entry.isDirectory() ? "dir" : "file",
      ...(sizes[index] !== undefined ? { size: sizes[index] } : {}),
    }));
    return visible.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  if (normalizedDir) safePath(row.path, normalizedDir);
  const res = await git(
    [
      "ls-files",
      "-co",
      "--exclude-standard",
      "-z",
      "--",
      ...(prefix ? [prefix] : []),
    ],
    row.path,
  );
  const dirs = new Set<string>();
  const files: WorktreeTreeEntry[] = [];
  for (const path of res.stdout.split("\0")) {
    if (!path || !path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      dirs.add(rest.slice(0, slash));
    } else {
      files.push({ name: rest, path, kind: "file" });
    }
  }
  const sizes = await Promise.all(
    files.map(async (file) => {
      try {
        // lstat, not stat: a repo symlink must not disclose metadata (size /
        // existence) of a target outside the worktree.
        return (await lstat(join(row.path, file.path))).size;
      } catch {
        return undefined;
      }
    }),
  );
  files.forEach((file, index) => {
    if (sizes[index] !== undefined) file.size = sizes[index];
  });
  const dirEntries: WorktreeTreeEntry[] = [...dirs]
    .sort()
    .map((name) => ({ name, path: `${prefix}${name}`, kind: "dir" }));
  return [...dirEntries, ...files.sort((a, b) => a.name.localeCompare(b.name))];
}

/* --------------------------------- language -------------------------------- */

function languageForPath(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    jsonl: "json",
    css: "css",
    scss: "scss",
    html: "xml",
    md: "markdown",
    markdown: "markdown",
    yml: "yaml",
    yaml: "yaml",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    xml: "xml",
    toml: "toml",
    sql: "sql",
  };
  return map[ext] ?? (ext || "plaintext");
}

function mimeForPath(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (["ts", "tsx"].includes(ext)) return "text/typescript";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "text/javascript";
  if (ext === "json") return "application/json";
  if (ext === "css") return "text/css";
  if (ext === "html") return "text/html";
  if (["yml", "yaml"].includes(ext)) return "application/yaml";
  return "text/plain";
}
