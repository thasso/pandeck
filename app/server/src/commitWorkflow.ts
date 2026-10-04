import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { AgentSession, SessionManager } from "./piSdk/index.ts";
import type { ToolSessionManager } from "./mcp/tool.ts";
import type {
  AgentType,
  CommitDisplay,
  CommitFileChange,
  CommitTotals,
  TaskSummary,
} from "@assistant/shared";
import { CWD } from "./config.ts";
import {
  git,
  gitOptional,
  repoLockKey,
  resolveRepoRoot,
  withRepoLock,
} from "./gitExec.ts";
import { getSettings } from "./settings.ts";
import {
  type CommitAgentBlocker,
  type CommitAgentResult,
  formatCommitMessage,
  generateCommitMessageJson,
} from "./commitAgent.ts";
import {
  listSessionTasks,
  readTask,
  taskSummaryOf,
  updateTask,
} from "./tasks.ts";
import { errorText } from "./errors.ts";

const CUSTOM_TYPE = "workshop.commit";
const MAX_AGENT_DIFF_CHARS = 120_000;
const HUGE_DIFF_CHARS = 400_000;
const EXTREME_DIFF_CHARS = 1_500_000;
const MAX_UNTRACKED_FILE_CHARS = 12_000;
const MAX_UNTRACKED_TOTAL_CHARS = 60_000;
const MAX_TASK_DESCRIPTION_CHARS = 6_000;
const MAX_TASK_CONTEXT_CHARS = 24_000;
const MAX_LEFTOVER_PATHS = 40;
/** Porcelain XY codes of an unresolved merge entry. */
const CONFLICT_STATUS = /^(UU|AA|DD|AU|UD|DU|UA)/;

type CommitMessageGenerator = (prompt: string) => Promise<CommitAgentResult>;
let commitMessageGeneratorForTests: CommitMessageGenerator | undefined;

/** Test seam: production always uses the configured no-tool commit agent. */
export function setCommitMessageGeneratorForTests(
  generator: CommitMessageGenerator | null,
): void {
  commitMessageGeneratorForTests = generator ?? undefined;
}

export interface CommitWorkflowOptions {
  source: "slash" | "tool";
  dryRun?: boolean;
  force?: boolean;
  additionalContext?: string;
  commandText?: string;
  /** Session context is optional for worktree-page auto-commit; slash commands provide it. */
  session?: AgentSession;
  /** Harness-neutral session manager supplied by an AgentTool caller. */
  sessionManager?: Pick<ToolSessionManager, "getBranch" | "appendCustomEntry">;
  sessionKind?: AgentType;
  sessionId?: string;
  /** Working directory whose enclosing git repo should be committed. Defaults to the app CWD. */
  cwd?: string;
  /** When set, this branch identity is revalidated inside the repository lock. */
  expectedBranch?: string;
  /**
   * Commit only what the caller already staged: the index is reviewed,
   * fingerprinted and committed as-is, with no `git add -A`. Unstaged and
   * untracked paths stay in the working tree and never enter the review.
   */
  stagedOnly?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export const NO_CHANGES_TO_COMMIT_REASON = "No changes to commit.";
const NO_STAGED_CHANGES_TO_COMMIT_REASON = "No staged changes to commit.";

export interface CommitWorkflowResult {
  status: "committed" | "dry-run" | "blocked" | "failed";
  source: "slash" | "tool";
  dryRun: boolean;
  forced: boolean;
  /** True when only the pre-staged index was reviewed and committed. */
  stagedOnly?: boolean;
  repoRoot?: string;
  headBefore?: string;
  headAfter?: string;
  commitHash?: string;
  commitMessage?: string;
  agent?: CommitAgentResult;
  customEntryId?: string;
  acceptedFromEntryId?: string;
  changeFingerprint?: string;
  files: CommitFileChange[];
  totals: CommitTotals;
  blockers: CommitAgentBlocker[];
  warnings: string[];
  includedUserEntryIds: string[];
  sessionTouchedPaths: string[];
  promptCheckpointEntryId?: string;
  commandText?: string;
  addressedTasks: TaskSummary[];
  error?: string;
  createdAt: number;
}

export function isNoChangesCommitResult(
  result: Pick<CommitWorkflowResult, "status" | "files" | "blockers">,
): boolean {
  return (
    result.status === "blocked" &&
    result.files.length === 0 &&
    result.blockers.some(
      (blocker) =>
        blocker.reason === NO_CHANGES_TO_COMMIT_REASON ||
        blocker.reason === NO_STAGED_CHANGES_TO_COMMIT_REASON,
    )
  );
}

interface SessionEntryLike {
  type: string;
  id: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  customType?: string;
  data?: unknown;
}

interface UntrackedSummary {
  path: string;
  included: boolean;
  reason?: string;
  content?: string;
}

interface CommitTaskContext extends TaskSummary {
  description?: string;
  descriptionTruncated?: boolean;
}

function truncate(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n\n[TRUNCATED ${text.length - max} characters]`,
    truncated: true,
  };
}

async function currentHead(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await gitOptional(
    ["rev-parse", "--verify", "HEAD"],
    repoRoot,
    signal,
  );
  return res.code === 0 ? res.stdout.trim() : "(no HEAD)";
}

function parseNulList(text: string): string[] {
  return text
    .split("\0")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** One `git status --porcelain=v1 -z` record; `from` is the rename/copy source. */
interface StatusEntry {
  code: string;
  path: string;
  from?: string;
}

/**
 * Parse NUL-delimited porcelain status. A rename or copy record is followed by
 * a separate source-path field, and no path is C-quoted, so paths compare
 * exactly against tool-touched paths and numstat destinations.
 */
function parseStatusEntries(text: string): StatusEntry[] {
  const fields = text.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (/[RC]/.test(code)) {
      const from = fields[index + 1] ?? "";
      index += 1;
      entries.push({ code, path, from });
    } else entries.push({ code, path });
  }
  return entries;
}

/** Render entries in the familiar one-line porcelain shape for prompts and fingerprints. */
function renderStatusEntries(entries: StatusEntry[]): string {
  if (entries.length === 0) return "";
  return (
    entries
      .map(
        (entry) =>
          `${entry.code} ${entry.from !== undefined ? `${entry.from} -> ${entry.path}` : entry.path}`,
      )
      .join("\n") + "\n"
  );
}

interface NumstatEntry {
  path: string;
  additions?: number;
  deletions?: number;
}

/**
 * Parse `git diff --numstat -z`: `add\tdel\tpath\0`, or for a rename/copy
 * `add\tdel\t\0source\0destination\0`, keyed by the destination path.
 */
function parseNumstatEntries(text: string): NumstatEntry[] {
  const fields = text.split("\0");
  const entries: NumstatEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (!field) continue;
    // Only the first two tabs delimit; a path may itself contain tabs.
    const match = /^([^\t]*)\t([^\t]*)\t([\s\S]*)$/.exec(field);
    if (!match) continue;
    const [, addRaw = "", delRaw = "", inlinePath = ""] = match;
    let path = inlinePath;
    if (!path) {
      path = fields[index + 2] ?? "";
      index += 2;
    }
    if (!path) continue;
    const additions = addRaw === "-" ? undefined : Number(addRaw);
    const deletions = delRaw === "-" ? undefined : Number(delRaw);
    entries.push({
      path,
      ...(additions !== undefined && Number.isFinite(additions)
        ? { additions }
        : {}),
      ...(deletions !== undefined && Number.isFinite(deletions)
        ? { deletions }
        : {}),
    });
  }
  return entries;
}

async function untrackedFiles(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await git(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    repoRoot,
    signal,
  );
  return parseNulList(res.stdout);
}

/** Hash every untracked file, including those beyond the agent-summary cap. */
async function fingerprintUntrackedFiles(
  repoRoot: string,
  files: string[],
  signal?: AbortSignal,
): Promise<string> {
  const values = new Map<string, string>();
  const regularFiles: Array<{ path: string; executable: boolean }> = [];
  for (const path of files) {
    try {
      const stat = lstatSync(join(repoRoot, path));
      if (stat.isSymbolicLink()) {
        // Git commits the link text, not the referent. Hashing the referent
        // would fail for a dangling link and make external content part of the
        // worktree fingerprint for an ordinary link.
        values.set(path, `symlink:${readlinkSync(join(repoRoot, path))}`);
      } else if (stat.isFile()) {
        regularFiles.push({ path, executable: Boolean(stat.mode & 0o111) });
      } else {
        values.set(path, `special:${stat.mode}`);
      }
    } catch {
      // A temp file can disappear after ls-files. Keep that state in the
      // fingerprint rather than failing the whole human or agent workflow.
      values.set(path, "unreadable");
    }
  }

  for (let offset = 0; offset < regularFiles.length; offset += 100) {
    const batch = regularFiles.slice(offset, offset + 100);
    const result = await gitOptional(
      ["hash-object", "--", ...batch.map((file) => file.path)],
      repoRoot,
      signal,
    );
    const hashes = result.stdout.trimEnd().split("\n");
    if (
      result.code === 0 &&
      hashes.length === batch.length &&
      hashes.every(Boolean)
    ) {
      for (let index = 0; index < batch.length; index += 1) {
        const file = batch[index]!;
        values.set(
          file.path,
          `file:${file.executable ? "x" : "-"}:${hashes[index]!}`,
        );
      }
      continue;
    }

    // One unreadable/racing path makes hash-object reject the whole batch. Fall
    // back per path so its stable marker does not hide hashes for its siblings.
    for (const file of batch) {
      const single = await gitOptional(
        ["hash-object", "--", file.path],
        repoRoot,
        signal,
      );
      values.set(
        file.path,
        single.code === 0 && single.stdout.trim()
          ? `file:${file.executable ? "x" : "-"}:${single.stdout.trim()}`
          : "unreadable",
      );
    }
  }

  const fingerprint = createHash("sha256");
  for (const path of files)
    fingerprint
      .update(path)
      .update("\0")
      .update(values.get(path) ?? "unreadable")
      .update("\0");
  return fingerprint.digest("hex");
}

function isProbablyText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function readUntrackedSummaries(
  repoRoot: string,
  files: string[],
): UntrackedSummary[] {
  const summaries: UntrackedSummary[] = [];
  let remaining = MAX_UNTRACKED_TOTAL_CHARS;
  for (const path of files.slice(0, 80)) {
    const absolute = join(repoRoot, path);
    try {
      if (lstatSync(absolute).isSymbolicLink()) {
        summaries.push({
          path,
          included: true,
          content: readlinkSync(absolute),
        });
        continue;
      }
      const buffer = readFileSync(absolute);
      if (buffer.length === 0) {
        summaries.push({ path, included: true, content: "" });
        continue;
      }
      if (buffer.length > 256_000) {
        summaries.push({
          path,
          included: false,
          reason: `large file (${buffer.length} bytes)`,
        });
        continue;
      }
      if (!isProbablyText(buffer.subarray(0, Math.min(buffer.length, 8192)))) {
        summaries.push({
          path,
          included: false,
          reason: `binary or non-UTF-8 file (${buffer.length} bytes)`,
        });
        continue;
      }
      const max = Math.min(MAX_UNTRACKED_FILE_CHARS, Math.max(0, remaining));
      const content = buffer.toString("utf8");
      const truncated = content.length > max;
      const shown = truncated
        ? `${content.slice(0, max)}\n[TRUNCATED ${content.length - max} characters]`
        : content;
      remaining -= shown.length;
      summaries.push({ path, included: true, content: shown });
    } catch (err) {
      summaries.push({
        path,
        included: false,
        reason: `could not read: ${errorText(err)}`,
      });
    }
  }
  if (files.length > 80) {
    summaries.push({
      path: `... ${files.length - 80} more untracked files`,
      included: false,
      reason: "not listed",
    });
  }
  return summaries;
}

function renderUntrackedSummaries(summaries: UntrackedSummary[]): string {
  if (summaries.length === 0) return "";
  return summaries
    .map((item) => {
      if (!item.included)
        return `Untracked file: ${item.path}\n[content omitted: ${item.reason ?? "not included"}]`;
      return [
        `Untracked file: ${item.path}`,
        "```",
        item.content ?? "",
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text"
      ) {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeSessionPath(path: string, repoRoot: string): string {
  const cleaned = path.trim().replace(/^@+/, "");
  if (!cleaned) return "";
  return isAbsolute(cleaned) ? relative(repoRoot, cleaned) || "." : cleaned;
}

function collectToolTouchedPaths(
  entry: SessionEntryLike,
  repoRoot: string,
): string[] {
  if (entry.type !== "message" || entry.message?.role !== "assistant")
    return [];
  const content = entry.message.content;
  if (!Array.isArray(content)) return [];
  const paths: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as {
      type?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (item.type !== "toolCall" || typeof item.name !== "string") continue;
    if (!item.arguments || typeof item.arguments !== "object") continue;
    const args = item.arguments as Record<string, unknown>;
    const path = args.path ?? args.file_path ?? args.filePath;
    if (
      typeof path === "string" &&
      ["edit", "write", "read"].includes(item.name)
    ) {
      const normalized = normalizeSessionPath(path, repoRoot);
      if (normalized) paths.push(normalized);
    }
  }
  return paths;
}

function isCommitEntry(entry: SessionEntryLike): boolean {
  return entry.type === "custom" && entry.customType === CUSTOM_TYPE;
}

function commitEntryStatus(entry: SessionEntryLike): string | undefined {
  const data = entry.data as { status?: unknown } | undefined;
  return typeof data?.status === "string" ? data.status : undefined;
}

function collectSessionContextSinceLastCommit(
  sm: Pick<ToolSessionManager, "getBranch">,
  repoRoot: string,
): {
  prompts: Array<{ id: string; text: string }>;
  checkpointEntryId?: string;
  touchedPaths: string[];
} {
  const branch = sm.getBranch() as SessionEntryLike[];
  let checkpointIndex = -1;
  let checkpointEntryId: string | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (isCommitEntry(entry) && commitEntryStatus(entry) === "committed") {
      checkpointIndex = i;
      checkpointEntryId = entry.id;
      break;
    }
  }

  const prompts: Array<{ id: string; text: string }> = [];
  const touched = new Set<string>();
  for (const entry of branch.slice(checkpointIndex + 1)) {
    if (entry.type === "message" && entry.message?.role === "user") {
      const text = textContent(entry.message.content).trim();
      if (text) prompts.push({ id: entry.id, text });
    }
    for (const path of collectToolTouchedPaths(entry, repoRoot))
      touched.add(path);
  }
  return {
    prompts,
    ...(checkpointEntryId !== undefined ? { checkpointEntryId } : {}),
    touchedPaths: [...touched].sort(),
  };
}

function lineLooksAddedSecret(line: string): boolean {
  if (!/^\+(?!\+)/.test(line)) return false;
  const value = line.slice(1);
  return [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bxox[pbar]-[A-Za-z0-9-]{20,}/,
    /\bghp_[A-Za-z0-9_]{20,}/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/,
    /\bsk-ant-[A-Za-z0-9_-]{20,}/,
    /\bsk-proj-[A-Za-z0-9_-]{20,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{20,}/,
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\b\s*[:=]\s*["'][^"']{12,}["']/i,
  ].some((re) => re.test(value));
}

function suspiciousPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (/(^|\/)\.env(?:\.|$)/.test(lower)) return "environment file";
  if (/\.(pem|key|p12|pfx|crt|cer)$/i.test(path))
    return "key/certificate-like file";
  if (/(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/.test(lower))
    return "SSH key-like file";
  if (/(^|\/)(credentials|secrets?|tokens?)(\.|\/|$)/.test(lower))
    return "credentials/secret-like path";
  return undefined;
}

function collectDeterministicFindings(args: {
  status: StatusEntry[];
  diff: string;
  untracked: string[];
  untrackedSummaries: UntrackedSummary[];
  gitDir: string;
}): { blockers: CommitAgentBlocker[]; warnings: string[] } {
  const blockers: CommitAgentBlocker[] = [];
  const warnings: string[] = [];

  const conflictLines = renderStatusEntries(
    args.status.filter((entry) => CONFLICT_STATUS.test(entry.code)),
  )
    .split("\n")
    .filter(Boolean);
  for (const line of conflictLines) {
    blockers.push({
      kind: "unsafe",
      reason: `Unresolved merge conflict in status line: ${line}`,
    });
  }

  const mergePaths = ["MERGE_HEAD", "rebase-merge", "rebase-apply"].map((p) =>
    join(args.gitDir, p),
  );
  if (mergePaths.some((p) => existsSync(p))) {
    blockers.push({
      kind: "unsafe",
      reason: "A merge or rebase appears to be in progress.",
    });
  }

  const paths = new Set<string>(args.status.map((entry) => entry.path));
  for (const path of args.untracked) paths.add(path);

  for (const path of paths) {
    const reason = suspiciousPath(path);
    if (reason)
      blockers.push({
        kind: "secret",
        file: path,
        reason: `Suspicious ${reason}; verify it should be committed.`,
      });
  }

  const secretLineCount = args.diff
    .split("\n")
    .filter(lineLooksAddedSecret).length;
  if (secretLineCount > 0) {
    blockers.push({
      kind: "secret",
      reason: `${secretLineCount} added line(s) look like credentials, tokens, passwords, or private keys.`,
    });
  }

  for (const summary of args.untrackedSummaries) {
    if (
      summary.content &&
      summary.content
        .split("\n")
        .some((line) => lineLooksAddedSecret(`+${line}`))
    ) {
      blockers.push({
        kind: "secret",
        file: summary.path,
        reason: "Untracked file content looks like it may contain a secret.",
      });
    }
    if (!summary.included && summary.reason?.startsWith("binary")) {
      warnings.push(
        `Untracked binary/non-text file will be included if committed: ${summary.path}`,
      );
    }
  }

  if (args.diff.length > HUGE_DIFF_CHARS) {
    blockers.push({
      kind: "too_broad",
      reason: `Diff is very large (${args.diff.length} characters); split the commit or force if intentional.`,
    });
  } else if (args.diff.length > MAX_AGENT_DIFF_CHARS) {
    warnings.push(
      `Diff is large (${args.diff.length} characters); the commit agent will receive a truncated patch.`,
    );
  }
  if (args.diff.length > EXTREME_DIFF_CHARS) {
    blockers.push({
      kind: "too_broad",
      reason: `Diff is extremely large (${args.diff.length} characters), making automated review unreliable.`,
    });
  }

  return { blockers, warnings };
}

function renderPrompts(prompts: Array<{ id: string; text: string }>): string {
  if (prompts.length === 0)
    return "(No new user prompts since the previous commit checkpoint.)";
  return prompts
    .map((p, i) => `Prompt ${i + 1} [${p.id}]:\n<<<\n${p.text}\n>>>`)
    .join("\n\n");
}

function renderBlockers(blockers: CommitAgentBlocker[]): string {
  if (blockers.length === 0) return "(none)";
  return blockers
    .map((b) => `- ${b.kind}${b.file ? ` ${b.file}` : ""}: ${b.reason}`)
    .join("\n");
}

function renderWarnings(warnings: string[]): string {
  if (warnings.length === 0) return "(none)";
  return warnings.map((w) => `- ${w}`).join("\n");
}

function renderPaths(paths: string[]): string {
  if (paths.length === 0) return "(none recorded)";
  return paths.map((path) => `- ${path}`).join("\n");
}

function commitRelevantTasks(
  kind: AgentType | undefined,
  sessionId: string | undefined,
): CommitTaskContext[] {
  if (!kind || !sessionId) return [];
  let remainingDescriptionChars = MAX_TASK_CONTEXT_CHARS;
  return listSessionTasks(kind, sessionId)
    .filter(
      (task) =>
        task.status === "doing" || (task.status === "done" && !task.commitHash),
    )
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "doing" ? -1 : 1;
      const aTime = a.completedAt ?? a.updatedAt;
      const bTime = b.completedAt ?? b.updatedAt;
      return bTime - aTime;
    })
    .slice(0, 12)
    .map((task) => {
      const full = readTask(task.id);
      const rawDescription = full?.description.trim() ?? "";
      const maxForTask = Math.min(
        MAX_TASK_DESCRIPTION_CHARS,
        Math.max(0, remainingDescriptionChars),
      );
      const descriptionTruncated = rawDescription.length > maxForTask;
      const description = descriptionTruncated
        ? rawDescription.slice(0, maxForTask).trimEnd()
        : rawDescription;
      remainingDescriptionChars -= description.length;
      return {
        ...task,
        ...(description ? { description, descriptionTruncated } : {}),
      };
    });
}

function renderTasks(tasks: CommitTaskContext[]): string {
  if (tasks.length === 0) return "(none recorded)";
  return tasks
    .map((task) => {
      const header = [`- [${task.status}] ${task.title} (${task.id})`];
      if (task.projectId) header.push(`project=${task.projectId}`);
      if (task.jiraIssueKeys?.length)
        header.push(`jira=${task.jiraIssueKeys.join(",")}`);
      if (task.githubIssues?.length)
        header.push(`github=${task.githubIssues.join(",")}`);
      if (task.commitHash) header.push(`alreadyCommitted=${task.commitHash}`);
      const lines = [header.join("; ")];
      if (task.description) {
        lines.push("  Description:", indent(task.description, "    "));
        if (task.descriptionTruncated)
          lines.push("    [description truncated]");
      } else if (task.descriptionPreview) {
        lines.push(`  Notes: ${task.descriptionPreview}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function markCommittedTasks(
  tasks: TaskSummary[],
  commitHash: string | undefined,
): TaskSummary[] {
  if (!commitHash) return tasks;
  const now = Date.now();
  const marked: TaskSummary[] = [];
  for (const task of tasks) {
    if (task.status !== "done" || task.commitHash) {
      marked.push(task);
      continue;
    }
    try {
      marked.push(
        taskSummaryOf(updateTask(task.id, { commitHash, committedAt: now })),
      );
    } catch {
      marked.push(task);
    }
  }
  return marked;
}

function statusKind(code: string): CommitFileChange["status"] {
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code === "??") return "untracked";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  if (code.includes("M")) return "modified";
  return "changed";
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.endsWith("\n")
    ? text.split("\n").length - 1
    : text.split("\n").length;
}

function buildFileChanges(args: {
  status: StatusEntry[];
  numstat: NumstatEntry[];
  untrackedSummaries: UntrackedSummary[];
  touchedPaths: string[];
}): { files: CommitFileChange[]; totals: CommitTotals } {
  const touched = new Set(args.touchedPaths);
  const byPath = new Map<string, CommitFileChange>();

  for (const entry of args.status) {
    byPath.set(entry.path, {
      path: entry.path,
      status: statusKind(entry.code),
      sessionTouched: touched.has(entry.path),
    });
  }

  for (const entry of args.numstat) {
    const existing = byPath.get(entry.path) ?? {
      path: entry.path,
      status: "changed" as const,
      sessionTouched: touched.has(entry.path),
    };
    byPath.set(entry.path, {
      ...existing,
      ...(entry.additions !== undefined ? { additions: entry.additions } : {}),
      ...(entry.deletions !== undefined ? { deletions: entry.deletions } : {}),
    });
  }

  for (const summary of args.untrackedSummaries) {
    const existing = byPath.get(summary.path) ?? {
      path: summary.path,
      status: "untracked" as const,
      sessionTouched: touched.has(summary.path),
    };
    if (
      summary.included &&
      summary.content !== undefined &&
      existing.additions === undefined
    ) {
      existing.additions = countLines(
        summary.content.replace(/\n\[TRUNCATED [\s\S]*$/, ""),
      );
      existing.deletions = 0;
    }
    byPath.set(summary.path, existing);
  }

  const files = [...byPath.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const totals = files.reduce<CommitTotals>(
    (acc, file) => ({
      files: acc.files + 1,
      additions: acc.additions + (file.additions ?? 0),
      deletions: acc.deletions + (file.deletions ?? 0),
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
  return { files, totals };
}

/**
 * Split `git status --porcelain=v1` into the lines that touch the index and
 * the paths that only differ in the working tree (or are untracked). The
 * staged half blanks the worktree column so the index fingerprint ignores
 * tree-only edits; conflict codes are kept whole and still reach the
 * deterministic blockers.
 */
function splitStatusByIndex(entries: StatusEntry[]): {
  staged: StatusEntry[];
  unstagedPaths: string[];
} {
  const staged: StatusEntry[] = [];
  const unstagedPaths: string[] = [];
  for (const entry of entries) {
    const index = entry.code[0]!;
    const worktree = entry.code[1]!;
    if (index !== " " && index !== "?" && index !== "!")
      staged.push(
        CONFLICT_STATUS.test(entry.code)
          ? entry
          : { ...entry, code: `${index} ` },
      );
    if (worktree !== " " || index === "?") unstagedPaths.push(entry.path);
  }
  return { staged, unstagedPaths };
}

/** The reviewed status entries: the whole tree, or the index half only. */
function reviewedStatus(
  entries: StatusEntry[],
  stagedOnly: boolean,
): { status: StatusEntry[]; unstagedPaths: string[] } {
  if (!stagedOnly) return { status: entries, unstagedPaths: [] };
  const split = splitStatusByIndex(entries);
  return { status: split.staged, unstagedPaths: split.unstagedPaths };
}

/** `git diff` arguments for the reviewed change set: index vs HEAD, or tree vs HEAD. */
function reviewDiffArgs(stagedOnly: boolean, ...flags: string[]): string[] {
  return stagedOnly
    ? ["diff", "--cached", ...flags, "--"]
    : ["diff", ...flags, "HEAD", "--"];
}

function fingerprintChangeSet(args: {
  headBefore: string;
  status: string;
  diffStat: string;
  fullDiffHash: string;
}): string {
  return createHash("sha256")
    .update(args.headBefore)
    .update("\0")
    .update(args.status)
    .update("\0")
    .update(args.diffStat)
    .update("\0")
    .update(args.fullDiffHash)
    .digest("hex");
}

function fingerprintContent(
  trackedBinaryDiff: string,
  untrackedFingerprint: string,
): string {
  return createHash("sha256")
    .update(trackedBinaryDiff)
    .update("\0")
    .update(untrackedFingerprint)
    .digest("hex");
}

/** Minimal locked revalidation: no prompt excerpts, stats parsing or scans. */
async function gatherChangeFingerprint(
  repoRoot: string,
  stagedOnly: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const [headBefore, status, diffStat, trackedDiff, untracked] =
    await Promise.all([
      currentHead(repoRoot, signal),
      git(["status", "--porcelain=v1", "-uall", "-z"], repoRoot, signal),
      gitOptional(reviewDiffArgs(stagedOnly, "--stat"), repoRoot, signal),
      gitOptional(
        reviewDiffArgs(
          stagedOnly,
          "--binary",
          "--full-index",
          "--find-renames",
        ),
        repoRoot,
        signal,
      ),
      stagedOnly ? Promise.resolve([]) : untrackedFiles(repoRoot, signal),
    ]);
  const untrackedFingerprint = await fingerprintUntrackedFiles(
    repoRoot,
    untracked,
    signal,
  );
  return fingerprintChangeSet({
    headBefore,
    status: renderStatusEntries(
      reviewedStatus(parseStatusEntries(status.stdout), stagedOnly).status,
    ),
    diffStat: diffStat.stdout,
    fullDiffHash: fingerprintContent(trackedDiff.stdout, untrackedFingerprint),
  });
}

export function toCommitDisplay(result: CommitWorkflowResult): CommitDisplay {
  return {
    ...(result.customEntryId !== undefined
      ? { entryId: result.customEntryId }
      : {}),
    status: result.status,
    dryRun: result.dryRun,
    forced: result.forced,
    ...(result.stagedOnly ? { stagedOnly: true } : {}),
    ...(result.repoRoot
      ? { repoRoot: relative(CWD, result.repoRoot) || "." }
      : {}),
    ...(result.commitHash !== undefined
      ? { commitHash: result.commitHash }
      : {}),
    ...(result.commitMessage !== undefined
      ? { commitMessage: result.commitMessage }
      : {}),
    blockers: result.blockers,
    warnings: result.warnings,
    files: result.files,
    totals: result.totals,
    addressedTasks: result.addressedTasks,
    canAcceptDryRun:
      result.status === "dry-run" && Boolean(result.customEntryId),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

function composeAgentPrompt(args: {
  repoRoot: string;
  headBefore: string;
  dryRun: boolean;
  force: boolean;
  stagedOnly: boolean;
  unstagedPaths: string[];
  additionalContext: string;
  prompts: Array<{ id: string; text: string }>;
  tasks: CommitTaskContext[];
  touchedPaths: string[];
  status: string;
  diffStat: string;
  diff: string;
  diffTruncated: boolean;
  untrackedSummaries: UntrackedSummary[];
  blockers: CommitAgentBlocker[];
  warnings: string[];
}): string {
  const untrackedText =
    renderUntrackedSummaries(args.untrackedSummaries) || "(none)";
  const diffNote = args.diffTruncated
    ? `The patch below is truncated to ${MAX_AGENT_DIFF_CHARS} characters. Rely on status/stat for the full file list.`
    : "The patch below is complete for tracked changes.";
  const leftover = args.unstagedPaths;
  const scopeNote = args.stagedOnly
    ? [
        `Scope: staged index only. ${leftover.length} unstaged or untracked path(s) remain in the working tree and are NOT part of this commit; do not describe them.`,
        ...(leftover.length > 0
          ? [renderPaths(leftover.slice(0, MAX_LEFTOVER_PATHS))]
          : []),
        ...(leftover.length > MAX_LEFTOVER_PATHS
          ? [`- … and ${leftover.length - MAX_LEFTOVER_PATHS} more`]
          : []),
      ].join("\n")
    : "Scope: the complete working tree; every tracked change and non-ignored untracked file is staged.";

  return [
    "Create a structured commit-message decision for the following repository changes.",
    `Repository root: ${args.repoRoot}`,
    `HEAD before commit: ${args.headBefore}`,
    `Mode: ${args.dryRun ? "dry-run preview" : "real commit"}`,
    scopeNote,
    `User requested force: ${args.force ? "yes" : "no"}. Your safety status should still be objective; the caller decides whether force overrides blockers.`,
    "",
    "Additional context from the /commit command or tool caller:",
    args.additionalContext.trim() || "(none)",
    "",
    "Relevant user prompts since the previous successful commit in this session:",
    renderPrompts(args.prompts),
    "",
    "Relevant Session Tasks:",
    renderTasks(args.tasks),
    "",
    "Files observed in this session's tool calls since the previous successful commit:",
    renderPaths(args.touchedPaths),
    "",
    "Deterministic preflight blockers:",
    renderBlockers(args.blockers),
    "",
    "Deterministic preflight warnings:",
    renderWarnings(args.warnings),
    "",
    args.stagedOnly
      ? "git status --porcelain=v1 (index entries only):"
      : "git status --porcelain=v1 -uall:",
    "```",
    args.status.trim() || "(clean)",
    "```",
    "",
    "Diff stat:",
    "```",
    args.diffStat.trim() || "(none)",
    "```",
    "",
    "Untracked file summaries/content:",
    untrackedText,
    "",
    diffNote,
    "Tracked patch:",
    "```diff",
    args.diff || "(none)",
    "```",
    "",
    "Return the JSON object only.",
  ].join("\n");
}

async function gatherDiffContext(
  repoRoot: string,
  stagedOnly: boolean,
  signal?: AbortSignal,
) {
  const [
    fullStatusRes,
    gitDirRes,
    diffRes,
    fingerprintDiffRes,
    statRes,
    numstatRes,
    untracked,
  ] = await Promise.all([
    git(["status", "--porcelain=v1", "-uall", "-z"], repoRoot, signal),
    git(["rev-parse", "--git-dir"], repoRoot, signal),
    gitOptional(reviewDiffArgs(stagedOnly, "--find-renames"), repoRoot, signal),
    gitOptional(
      reviewDiffArgs(stagedOnly, "--binary", "--full-index", "--find-renames"),
      repoRoot,
      signal,
    ),
    gitOptional(reviewDiffArgs(stagedOnly, "--stat"), repoRoot, signal),
    gitOptional(
      reviewDiffArgs(stagedOnly, "--numstat", "--find-renames", "-z"),
      repoRoot,
      signal,
    ),
    // Staged scope never reads untracked files: a path enters the commit only
    // once the caller adds it, and then `diff --cached` already carries it.
    stagedOnly ? Promise.resolve([]) : untrackedFiles(repoRoot, signal),
  ]);
  const { status: statusEntries, unstagedPaths } = reviewedStatus(
    parseStatusEntries(fullStatusRes.stdout),
    stagedOnly,
  );
  const status = renderStatusEntries(statusEntries);
  const gitDirRaw = gitDirRes.stdout.trim();
  const gitDir = gitDirRaw.startsWith("/")
    ? gitDirRaw
    : join(repoRoot, gitDirRaw);
  const untrackedFingerprint = await fingerprintUntrackedFiles(
    repoRoot,
    untracked,
    signal,
  );
  const untrackedSummaries = readUntrackedSummaries(repoRoot, untracked);
  const untrackedText = renderUntrackedSummaries(untrackedSummaries);
  const fullDiff = [diffRes.stdout, untrackedText].filter(Boolean).join("\n\n");
  const fullDiffHash = fingerprintContent(
    fingerprintDiffRes.stdout,
    untrackedFingerprint,
  );
  const findings = collectDeterministicFindings({
    status: statusEntries,
    diff: fullDiff,
    untracked,
    untrackedSummaries,
    gitDir,
  });
  const truncated = truncate(diffRes.stdout, MAX_AGENT_DIFF_CHARS);
  return {
    status,
    statusEntries,
    unstagedPaths,
    diffStat: statRes.stdout,
    numstat: parseNumstatEntries(numstatRes.stdout),
    diff: truncated.text,
    fullDiffLength: fullDiff.length,
    fullDiffHash,
    diffTruncated: truncated.truncated,
    untracked,
    untrackedSummaries,
    blockers: findings.blockers,
    warnings: findings.warnings,
  };
}

async function stagedDiff(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<{ status: string; diffStat: string; diff: string }> {
  const [status, diffStat, diff] = await Promise.all([
    git(["status", "--porcelain=v1", "-uall"], repoRoot, signal),
    git(["diff", "--cached", "--stat"], repoRoot, signal),
    git(["diff", "--cached", "--find-renames"], repoRoot, signal),
  ]);
  return {
    status: status.stdout,
    diffStat: diffStat.stdout,
    diff: diff.stdout,
  };
}

function writeCommitMessageFile(
  message: string,
): Promise<{ dir: string; file: string }> {
  return mkdtemp(join(tmpdir(), "assistant-commit-")).then((dir) => {
    const file = join(dir, "COMMIT_MESSAGE");
    writeFileSync(file, `${message.trim()}\n`, "utf8");
    return { dir, file };
  });
}

function appendCustomResult(
  sm: Pick<ToolSessionManager, "appendCustomEntry"> | undefined,
  result: CommitWorkflowResult,
): string | undefined {
  if (!sm) return undefined;
  try {
    const id = sm.appendCustomEntry(CUSTOM_TYPE, { version: 1, ...result });
    if (id !== undefined) result.customEntryId = id;
    return id;
  } catch {
    return undefined;
  }
}

export async function runCommitWorkflow(
  options: CommitWorkflowOptions,
): Promise<CommitWorkflowResult> {
  const dryRun = Boolean(options.dryRun);
  const forced = Boolean(options.force);
  const stagedOnly = Boolean(options.stagedOnly);
  const createdAt = Date.now();
  const sessionManager =
    options.sessionManager ?? options.session?.sessionManager;
  let prompts: Array<{ id: string; text: string }> = [];
  let checkpointEntryId: string | undefined;
  let sessionTouchedPaths: string[] = [];
  let includedUserEntryIds: string[] = [];
  let files: CommitFileChange[] = [];
  let totals: CommitTotals = { files: 0, additions: 0, deletions: 0 };
  let changeFingerprint: string | undefined;
  let addressedTasks: TaskSummary[] = commitRelevantTasks(
    options.sessionKind,
    options.sessionId,
  );

  const baseResult = (
    patch: Partial<CommitWorkflowResult>,
  ): CommitWorkflowResult => {
    const changeFingerprintValue = patch.changeFingerprint ?? changeFingerprint;
    return {
      status: patch.status ?? "failed",
      source: options.source,
      dryRun,
      forced,
      ...(stagedOnly ? { stagedOnly } : {}),
      files: patch.files ?? files,
      totals: patch.totals ?? totals,
      ...(changeFingerprintValue !== undefined
        ? { changeFingerprint: changeFingerprintValue }
        : {}),
      blockers: patch.blockers ?? [],
      warnings: patch.warnings ?? [],
      includedUserEntryIds,
      sessionTouchedPaths,
      ...(checkpointEntryId !== undefined
        ? { promptCheckpointEntryId: checkpointEntryId }
        : {}),
      ...(options.commandText !== undefined
        ? { commandText: options.commandText }
        : {}),
      addressedTasks: patch.addressedTasks ?? addressedTasks,
      createdAt,
      ...patch,
    };
  };

  try {
    options.onProgress?.("Inspecting git changes…");
    const repoRoot = await resolveRepoRoot(options.cwd ?? CWD, options.signal);
    const sessionContext = sessionManager
      ? collectSessionContextSinceLastCommit(sessionManager, repoRoot)
      : { prompts: [], checkpointEntryId: undefined, touchedPaths: [] };
    prompts = sessionContext.prompts;
    checkpointEntryId = sessionContext.checkpointEntryId;
    sessionTouchedPaths = sessionContext.touchedPaths;
    includedUserEntryIds = prompts.map((p) => p.id);
    const headBefore = await currentHead(repoRoot, options.signal);
    const diffContext = await gatherDiffContext(
      repoRoot,
      stagedOnly,
      options.signal,
    );
    ({ files, totals } = buildFileChanges({
      status: diffContext.statusEntries,
      numstat: diffContext.numstat,
      untrackedSummaries: diffContext.untrackedSummaries,
      touchedPaths: sessionTouchedPaths,
    }));
    changeFingerprint = fingerprintChangeSet({
      headBefore,
      status: diffContext.status,
      diffStat: diffContext.diffStat,
      fullDiffHash: diffContext.fullDiffHash,
    });
    const hasChanges = diffContext.status.trim().length > 0;
    if (!hasChanges) {
      const result = baseResult({
        status: "blocked",
        repoRoot,
        headBefore,
        blockers: [
          {
            kind: "unclear",
            reason: stagedOnly
              ? NO_STAGED_CHANGES_TO_COMMIT_REASON
              : NO_CHANGES_TO_COMMIT_REASON,
          },
        ],
      });
      appendCustomResult(sessionManager, result);
      return result;
    }

    options.onProgress?.("Generating commit message…");
    const agentPrompt = composeAgentPrompt({
      repoRoot,
      headBefore,
      dryRun,
      force: forced,
      stagedOnly,
      unstagedPaths: diffContext.unstagedPaths,
      additionalContext: options.additionalContext ?? "",
      prompts,
      tasks: addressedTasks,
      touchedPaths: sessionTouchedPaths,
      status: diffContext.status,
      diffStat: diffContext.diffStat,
      diff: diffContext.diff,
      diffTruncated: diffContext.diffTruncated,
      untrackedSummaries: diffContext.untrackedSummaries,
      blockers: diffContext.blockers,
      warnings: diffContext.warnings,
    });
    const agent = commitMessageGeneratorForTests
      ? await commitMessageGeneratorForTests(agentPrompt)
      : await generateCommitMessageJson(agentPrompt, getSettings().commitAgent);
    const commitMessage = formatCommitMessage(agent);
    const blockers = [...diffContext.blockers, ...agent.blockers];
    if (agent.status === "block" && agent.blockers.length === 0) {
      blockers.push({
        kind: "unsafe",
        reason: "Commit agent returned block without a specific blocker.",
      });
    }
    const warnings = [...diffContext.warnings, ...agent.warnings];
    const blocked = blockers.length > 0 || agent.status === "block";

    if (dryRun) {
      const result = baseResult({
        status: blocked && !forced ? "blocked" : "dry-run",
        repoRoot,
        headBefore,
        commitMessage,
        agent,
        blockers,
        warnings,
      });
      appendCustomResult(sessionManager, result);
      return result;
    }

    if (blocked && !forced) {
      const result = baseResult({
        status: "blocked",
        repoRoot,
        headBefore,
        commitMessage,
        agent,
        blockers,
        warnings,
      });
      appendCustomResult(sessionManager, result);
      return result;
    }

    // Stage + commit under the per-repo mutation lock: a concurrent worktree
    // merge (which stages a squash in the main checkout) must never interleave
    // with `git add -A`/`git commit` here, or this commit could swallow the
    // merge's staged state under the wrong message.
    const commitOutcome = await withRepoLock(
      await repoLockKey(repoRoot),
      async () => {
        if (options.expectedBranch !== undefined) {
          const branch = await gitOptional(
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            repoRoot,
            options.signal,
          );
          const actualBranch = branch.code === 0 ? branch.stdout.trim() : "";
          if (actualBranch !== options.expectedBranch) {
            return {
              blocked: {
                kind: "unsafe" as const,
                reason: `The checked-out branch changed from ${options.expectedBranch} to ${actualBranch || "a detached HEAD"}. Reinspect the worktree and retry.`,
              },
            };
          }
        }

        // The commit message was generated from the earlier fingerprint. Check
        // it again while holding the same repository lock that protects staging
        // so a PA git mutation cannot move the target between review and add.
        const lockedFingerprint = await gatherChangeFingerprint(
          repoRoot,
          stagedOnly,
          options.signal,
        );
        if (lockedFingerprint !== changeFingerprint) {
          return {
            blocked: {
              kind: "unsafe" as const,
              reason:
                "The change set moved after commit-message generation. Reinspect the current changes and retry.",
            },
          };
        }

        if (!stagedOnly) {
          options.onProgress?.("Staging all changes…");
          await git(["add", "-A"], repoRoot, options.signal);
        }
        const staged = await stagedDiff(repoRoot, options.signal);
        if (!staged.diff.trim() && !staged.diffStat.trim())
          return "empty" as const;

        options.onProgress?.("Creating git commit…");
        const { dir, file } = await writeCommitMessageFile(commitMessage);
        try {
          await git(["commit", "-F", file], repoRoot, options.signal);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        return "committed" as const;
      },
    );
    if (commitOutcome !== "committed") {
      const result = baseResult(
        commitOutcome === "empty"
          ? {
              status: "failed",
              repoRoot,
              headBefore,
              commitMessage,
              agent,
              blockers,
              warnings,
              error: stagedOnly
                ? "No staged diff remained in the index."
                : "No staged diff remained after git add -A.",
            }
          : {
              status: "blocked",
              repoRoot,
              headBefore,
              commitMessage,
              agent,
              blockers: [...blockers, commitOutcome.blocked],
              warnings,
            },
      );
      appendCustomResult(sessionManager, result);
      return result;
    }
    const headAfter = await currentHead(repoRoot, options.signal);
    const commitHash = headAfter.slice(0, 12);
    addressedTasks = markCommittedTasks(addressedTasks, commitHash);
    const result = baseResult({
      status: "committed",
      repoRoot,
      headBefore,
      headAfter,
      commitHash,
      commitMessage,
      agent,
      blockers,
      warnings,
      addressedTasks,
    });
    appendCustomResult(sessionManager, result);
    return result;
  } catch (err) {
    const result = baseResult({ status: "failed", error: errorText(err) });
    appendCustomResult(sessionManager, result);
    return result;
  }
}

function commitDataFromEntry(
  sm: SessionManager,
  entryId: string,
): (CommitWorkflowResult & { version?: number }) | undefined {
  const entry = sm.getEntry(entryId) as
    { type?: string; customType?: string; data?: unknown } | undefined;
  if (!entry || entry.type !== "custom" || entry.customType !== CUSTOM_TYPE)
    return undefined;
  if (!entry.data || typeof entry.data !== "object") return undefined;
  return entry.data as CommitWorkflowResult & { version?: number };
}

export async function acceptCommitDryRun(options: {
  session: AgentSession;
  entryId: string;
  /** Working directory whose enclosing git repo the dry run targeted. Defaults to the app CWD. */
  cwd?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<CommitWorkflowResult> {
  const sessionManager = options.session.sessionManager;
  const source = "slash" as const;
  const forced = false;
  const dryRun = false;
  const createdAt = Date.now();
  const previous = commitDataFromEntry(sessionManager, options.entryId);
  const stagedOnly = Boolean(previous?.stagedOnly);

  const baseResult = (
    patch: Partial<CommitWorkflowResult>,
  ): CommitWorkflowResult => ({
    status: patch.status ?? "failed",
    source,
    dryRun,
    forced,
    ...(stagedOnly ? { stagedOnly } : {}),
    files: patch.files ?? previous?.files ?? [],
    totals: patch.totals ??
      previous?.totals ?? { files: 0, additions: 0, deletions: 0 },
    blockers: patch.blockers ?? [],
    warnings: patch.warnings ?? previous?.warnings ?? [],
    includedUserEntryIds: previous?.includedUserEntryIds ?? [],
    sessionTouchedPaths: previous?.sessionTouchedPaths ?? [],
    ...(previous?.promptCheckpointEntryId !== undefined
      ? { promptCheckpointEntryId: previous?.promptCheckpointEntryId }
      : {}),
    addressedTasks: patch.addressedTasks ?? previous?.addressedTasks ?? [],
    acceptedFromEntryId: options.entryId,
    createdAt,
    ...patch,
  });

  try {
    if (!previous || previous.status !== "dry-run" || !previous.commitMessage) {
      const result = baseResult({
        status: "failed",
        error:
          "Dry-run entry is missing, is not accepted, or has no commit message.",
      });
      appendCustomResult(sessionManager, result);
      return result;
    }

    options.onProgress?.("Rechecking git changes…");
    // Recheck the SAME repo the dry run scanned (a worktree session's cwd),
    // never the app CWD — otherwise the fingerprint compares the wrong checkout.
    const repoRoot = await resolveRepoRoot(options.cwd ?? CWD, options.signal);
    const headBefore = await currentHead(repoRoot, options.signal);
    const diffContext = await gatherDiffContext(
      repoRoot,
      stagedOnly,
      options.signal,
    );
    const fingerprint = fingerprintChangeSet({
      headBefore,
      status: diffContext.status,
      diffStat: diffContext.diffStat,
      fullDiffHash: diffContext.fullDiffHash,
    });
    if (
      previous.changeFingerprint &&
      previous.changeFingerprint !== fingerprint
    ) {
      const result = baseResult({
        status: "failed",
        repoRoot,
        headBefore,
        commitMessage: previous.commitMessage,
        changeFingerprint: fingerprint,
        error:
          "The working tree changed since the dry run. Run /commit --dry again before accepting.",
      });
      appendCustomResult(sessionManager, result);
      return result;
    }

    if (!diffContext.status.trim()) {
      const result = baseResult({
        status: "failed",
        repoRoot,
        headBefore,
        commitMessage: previous.commitMessage,
        changeFingerprint: fingerprint,
        error: "No changes remain to commit.",
      });
      appendCustomResult(sessionManager, result);
      return result;
    }

    // Same interleaving guard as the direct commit path: stage + commit under
    // the per-repo mutation lock so a concurrent worktree merge can't slip in.
    const acceptedMessage = previous.commitMessage;
    const outcome = await withRepoLock(
      await repoLockKey(repoRoot),
      async () => {
        // The unlocked recheck above can be outrun by a PA git mutation;
        // compare once more under the lock that protects staging.
        const lockedFingerprint = await gatherChangeFingerprint(
          repoRoot,
          stagedOnly,
          options.signal,
        );
        if (lockedFingerprint !== fingerprint) return "moved" as const;
        if (!stagedOnly) {
          options.onProgress?.("Staging all changes…");
          await git(["add", "-A"], repoRoot, options.signal);
        }
        options.onProgress?.("Creating git commit…");
        const { dir, file } = await writeCommitMessageFile(acceptedMessage);
        try {
          await git(["commit", "-F", file], repoRoot, options.signal);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        return "committed" as const;
      },
    );
    if (outcome === "moved") {
      const result = baseResult({
        status: "failed",
        repoRoot,
        headBefore,
        commitMessage: previous.commitMessage,
        changeFingerprint: fingerprint,
        error:
          "The change set moved while the commit was being prepared. Run /commit --dry again before accepting.",
      });
      appendCustomResult(sessionManager, result);
      return result;
    }
    const headAfter = await currentHead(repoRoot, options.signal);
    const commitHash = headAfter.slice(0, 12);
    const addressedTasks = markCommittedTasks(
      previous.addressedTasks ?? [],
      commitHash,
    );
    const result = baseResult({
      status: "committed",
      repoRoot,
      headBefore,
      headAfter,
      commitHash,
      commitMessage: previous.commitMessage,
      changeFingerprint: fingerprint,
      files: previous.files,
      totals: previous.totals,
      warnings: previous.warnings,
      addressedTasks,
    });
    appendCustomResult(sessionManager, result);
    return result;
  } catch (err) {
    const result = baseResult({ status: "failed", error: errorText(err) });
    appendCustomResult(sessionManager, result);
    return result;
  }
}
