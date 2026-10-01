import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
  constants,
} from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./config.ts";
import { recordNewArtifacts } from "./mcp/toolGroups/packRuntime.ts";

/** Provider-facing budgets. Full output is moved to a session artifact instead. */
export const OUTPUT_BUDGETS = {
  readDefaultLines: 400,
  logReadDefaultLines: 120,
  readChars: 12_000,
  explicitReadChars: 24_000,
  shellChars: 12_000,
  failureChars: 16_000,
  qualitySuccessChars: 2_000,
  maxLines: 160,
} as const;

export interface ReadWindowDecision {
  input: Record<string, unknown>;
  boundedByDefault: boolean;
  logLike: boolean;
  fileBytes?: number;
  startLine: number;
  limit?: number;
}

/** Structured line metadata reported by Claude's native FileReadOutput. */
export interface ReadResultMetadata {
  numLines: number;
  startLine: number;
  totalLines: number;
  truncatedByTokenCap?: boolean;
}

export interface BoundedOutput {
  text: string;
  elided: boolean;
  mode: "unchanged" | "read" | "shell" | "quality-success" | "failure" | "diff";
  rawChars: number;
  retainedChars: number;
}

export interface OutputArtifact {
  path: string;
  url: string;
}

export interface TaskOutputEvidence {
  artifactId?: string;
  originalBytes?: number;
  capturedBytes?: number;
  truncated?: boolean;
  text?: boolean;
  refusalReason?: string;
}

const TASK_OUTPUT_MAX_BYTES = 65_536;
const TASK_OUTPUT_HALF_BYTES = 32 * 1024;
const TASK_OUTPUT_CHUNK_BYTES = 64 * 1024;
const TASK_OUTPUT_SCAN_MAX_BYTES = 64 * 1024 * 1024;
const LOG_EXTENSIONS = new Set([".jsonl", ".ndjson", ".log", ".out", ".trace"]);

function cleanPath(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function isLogLikePath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    LOG_EXTENSIONS.has(extname(lower)) ||
    /(?:^|[/\\])(?:logs?|traces?)(?:[/\\]|$)/.test(lower)
  );
}

/** Add a conservative default range to an otherwise unbounded native read. */
export async function prepareReadWindow(
  input: Record<string, unknown>,
  cwd: string,
): Promise<ReadWindowDecision> {
  const next = { ...input };
  const path =
    typeof input.path === "string"
      ? input.path
      : typeof input.file_path === "string"
        ? input.file_path
        : "";
  const logLike = isLogLikePath(path);
  const boundedByDefault = input.limit === undefined;
  if (boundedByDefault)
    next.limit = logLike
      ? OUTPUT_BUDGETS.logReadDefaultLines
      : OUTPUT_BUDGETS.readDefaultLines;

  let fileBytes: number | undefined;
  if (path) {
    try {
      const absolute = isAbsolute(cleanPath(path))
        ? cleanPath(path)
        : resolve(cwd, cleanPath(path));
      fileBytes = (await stat(absolute)).size;
    } catch {
      // The native tool owns path/readability errors. Metadata is best effort.
    }
  }
  return {
    input: next,
    boundedByDefault,
    logLike,
    ...(fileBytes !== undefined ? { fileBytes } : {}),
    startLine:
      typeof input.offset === "number" && input.offset > 0
        ? Math.floor(input.offset)
        : 1,
    ...(typeof next.limit === "number" && next.limit > 0
      ? { limit: Math.floor(next.limit) }
      : {}),
  };
}

function truncateHead(
  text: string,
  maxChars: number,
  maxLines: number,
): string {
  const lines = text.split("\n");
  let value = lines.slice(0, maxLines).join("\n");
  if (value.length <= maxChars) return value;
  value = value.slice(0, maxChars);
  const lastNewline = value.lastIndexOf("\n");
  return (
    lastNewline > maxChars / 2 ? value.slice(0, lastNewline) : value
  ).trimEnd();
}

function truncateTail(
  text: string,
  maxChars: number,
  maxLines: number,
): string {
  const lines = text.split("\n");
  let value = lines.slice(-maxLines).join("\n");
  if (value.length <= maxChars) return value;
  value = value.slice(-maxChars);
  const firstNewline = value.indexOf("\n");
  return (
    firstNewline >= 0 ? value.slice(firstNewline + 1) : value
  ).trimStart();
}

function exceedsBudget(
  text: string,
  maxChars: number,
  maxLines: number,
): boolean {
  return text.length > maxChars || text.split("\n").length > maxLines;
}

function commandFrom(input: Record<string, unknown>): string {
  for (const key of ["command", "cmd", "script"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function isQualityGateCommand(command: string): boolean {
  return /(?:^|[;&|]\s*|\b)(?:pnpm|npm|yarn|bun)\s+(?:(?:--filter|-[FC])\s+\S+\s+)*(?:run\s+)?(?:test(?::\S+)?|typecheck|build|lint|check)(?:\s|$)|\b(?:vitest|jest|pytest|cargo\s+test|go\s+test|tsc)(?:\s|$)/i.test(
    command,
  );
}

function isDiffCommand(command: string): boolean {
  return /\bgit\s+(?:diff|show|log\s+-p)\b/.test(command);
}

function isConflictCommand(command: string): boolean {
  return /\bgit\s+(?:rebase|merge|cherry-pick)\b/.test(command);
}

function conciseSuccess(
  raw: string,
  command: string,
  exitCode: number | undefined,
): string {
  const meaningful = raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-8)
    .join("\n");
  const summary = truncateTail(
    meaningful || "(no output)",
    OUTPUT_BUDGETS.qualitySuccessChars,
    8,
  );
  return [
    `[Quality gate passed${exitCode !== undefined ? `; exit ${exitCode}` : ""}]`,
    command ? `Command: ${command}` : "",
    summary,
  ]
    .filter(Boolean)
    .join("\n");
}

function appendTrailingNotice(text: string, message: string): string {
  const index = text.lastIndexOf("\n\n[");
  if (index >= 0) {
    const existing = text.slice(index + 2).trim();
    if (existing.endsWith("]") && !existing.includes("\n\n"))
      return `${text.slice(0, index).trimEnd()}\n\n[${existing.slice(1, -1)} ${message}]`;
  }
  return `${text.trimEnd()}\n\n[${message}]`;
}

function contentBodyLines(content: string): number {
  const notice = content.lastIndexOf("\n\n[");
  const body = notice >= 0 ? content.slice(0, notice) : content;
  return body.length === 0 ? 0 : body.split("\n").length;
}

function readNavigation(
  decision: ReadWindowDecision,
  raw: string,
  result?: ReadResultMetadata,
): string | undefined {
  if (!decision.boundedByDefault) return undefined;
  const limit = decision.limit ?? OUTPUT_BUDGETS.readDefaultLines;
  const returnedLines = result?.numLines ?? contentBodyLines(raw);
  const startLine = result?.startLine ?? decision.startLine;
  const mayHaveClipped = result
    ? result.truncatedByTokenCap === true ||
      startLine + returnedLines - 1 < result.totalLines
    : returnedLines >= limit;
  if (!mayHaveClipped) return undefined;
  const previous = Math.max(1, startLine - limit);
  const next = startLine + returnedLines;
  const size =
    decision.fileBytes === undefined
      ? "unknown size"
      : `${decision.fileBytes.toLocaleString("en-US")} bytes`;
  const logHint = decision.logLike
    ? " Log/JSONL input: prefer rg '<pattern>' <path>, jq -c '<filter>' <path>, or a structured summary over sequential raw reads."
    : "";
  return `Bounded default window: ${size}; previous offset=${previous}, next offset=${next}.${logHint}`;
}

/** Apply the harness-neutral provider-context policy to a text result. */
export function boundNativeOutput(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  raw: string;
  isError?: boolean;
  exitCode?: number;
  readDecision?: ReadWindowDecision;
  readResult?: ReadResultMetadata;
}): BoundedOutput {
  const { toolName, toolInput, raw, readDecision, readResult } = input;
  const command = commandFrom(toolInput);
  const failed =
    input.isError || (input.exitCode !== undefined && input.exitCode !== 0);
  let text = raw;
  let mode: BoundedOutput["mode"] = "unchanged";
  let elided = false;

  if (toolName.toLowerCase() === "read") {
    const explicit = readDecision
      ? !readDecision.boundedByDefault
      : toolInput.limit !== undefined;
    const budget = explicit
      ? OUTPUT_BUDGETS.explicitReadChars
      : OUTPUT_BUDGETS.readChars;
    if (text.length > budget) {
      const requestedLines =
        readDecision?.limit ??
        (typeof toolInput.limit === "number"
          ? Math.max(1, Math.floor(toolInput.limit))
          : OUTPUT_BUDGETS.readDefaultLines);
      text = truncateHead(text, budget, requestedLines);
      elided = true;
      mode = "read";
    }
    const navigation = readDecision
      ? readNavigation(readDecision, raw, readResult)
      : undefined;
    if (navigation && !text.includes("Bounded default window:")) {
      text = appendTrailingNotice(text, navigation);
      // Navigation annotates the complete retained window; it does not remove
      // text and therefore must not trigger raw-output artifact persistence.
      mode = "read";
    }
  } else if (toolName.toLowerCase() === "bash") {
    if (failed) {
      const tail = truncateTail(
        raw,
        OUTPUT_BUDGETS.failureChars,
        OUTPUT_BUDGETS.maxLines,
      );
      text = [
        `[Command failed${input.exitCode !== undefined ? `; exit ${input.exitCode}` : ""}]`,
        command ? `Command: ${command}` : "",
        tail,
        isConflictCommand(command)
          ? "Conflict diagnostics: git status --short; git diff --name-only --diff-filter=U; then git diff --cc -- <path>."
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      elided = exceedsBudget(
        raw,
        OUTPUT_BUDGETS.failureChars,
        OUTPUT_BUDGETS.maxLines,
      );
      mode = "failure";
    } else if (isQualityGateCommand(command)) {
      text = conciseSuccess(raw, command, input.exitCode);
      elided = exceedsBudget(raw, OUTPUT_BUDGETS.qualitySuccessChars, 8);
      mode = "quality-success";
    } else if (raw.length > OUTPUT_BUDGETS.shellChars) {
      if (isDiffCommand(command)) {
        text = [
          command ? `Command: ${command}` : "",
          truncateHead(raw, OUTPUT_BUDGETS.shellChars, OUTPUT_BUDGETS.maxLines),
          "Diff output bounded. Start with git diff --stat, then request selected hunks with git diff -- <path>.",
        ]
          .filter(Boolean)
          .join("\n");
        mode = "diff";
      } else {
        text = [
          command ? `Command: ${command}` : "",
          truncateTail(raw, OUTPUT_BUDGETS.shellChars, OUTPUT_BUDGETS.maxLines),
        ]
          .filter(Boolean)
          .join("\n");
        mode = "shell";
      }
      elided = true;
    }
  } else if (raw.length > OUTPUT_BUDGETS.shellChars) {
    text = truncateHead(
      raw,
      OUTPUT_BUDGETS.shellChars,
      OUTPUT_BUDGETS.maxLines,
    );
    elided = true;
    mode = "shell";
  }

  return {
    text,
    elided,
    mode,
    rawChars: raw.length,
    retainedChars: text.length,
  };
}

export function addArtifactNotice(
  result: BoundedOutput,
  artifact: OutputArtifact,
): BoundedOutput {
  if (!result.elided) return result;
  const text = appendTrailingNotice(
    result.text,
    `Full raw output: ${artifact.path}; audit: ${artifact.url}`,
  );
  return { ...result, text, retainedChars: text.length };
}

function taskOutputRefusal(
  reason: string,
  originalBytes?: number,
): TaskOutputEvidence {
  return {
    ...(originalBytes !== undefined ? { originalBytes } : {}),
    capturedBytes: 0,
    text: false,
    truncated: false,
    refusalReason: reason.slice(0, 500),
  };
}

function pathWithinRoot(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function hasSymlinkComponent(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  let current = root;
  for (const part of child.split(/[\\/]/u)) {
    if (!part) continue;
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(0x1b)}(?:\\[[0-?]*[\\x20-\\x2f]*[@-~]|\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${String.fromCharCode(0x1b)}\\\\)|[()][0-2A-Z])`,
  "gu",
);
const UNSAFE_CONTROL_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(0x0b)}${String.fromCharCode(0x0c)}${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
  "gu",
);

function stripTaskOutputTerminalData(text: string): string {
  // Remove CSI, OSC, and the short ESC sequences used by terminal output before
  // dropping the remaining C0/C1 controls. Tabs and line breaks are ordinary
  // output whitespace; other controls are terminal data, not text.
  return text
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(UNSAFE_CONTROL_PATTERN, "");
}

function decodeTaskOutputWindow(
  bytes: Buffer,
  start: number,
  end: number,
): string {
  while (start < end && (bytes[start]! & 0xc0) === 0x80) start += 1;
  let sequenceStart = end;
  while (sequenceStart > start && (bytes[sequenceStart - 1]! & 0xc0) === 0x80)
    sequenceStart -= 1;
  let boundary = end;
  if (sequenceStart < end) {
    const lead = bytes[sequenceStart - 1]!;
    const expected =
      lead < 0x80
        ? 1
        : lead >= 0xc2 && lead <= 0xdf
          ? 2
          : lead >= 0xe0 && lead <= 0xef
            ? 3
            : lead >= 0xf0 && lead <= 0xf4
              ? 4
              : 1;
    if (expected > end - (sequenceStart - 1)) boundary = sequenceStart - 1;
  } else if (boundary > start) {
    const lead = bytes[boundary - 1]!;
    if (
      (lead >= 0xc2 && lead <= 0xdf) ||
      (lead >= 0xe0 && lead <= 0xef) ||
      (lead >= 0xf0 && lead <= 0xf4)
    )
      boundary -= 1;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(start, boundary),
  );
}

/**
 * Capture Claude's task output without trusting the path it reports. The file
 * is opened once and all reads use that descriptor, so a later path replacement
 * cannot make the capture read a different file.
 */
export function captureTaskOutputArtifact(input: {
  sessionId: string;
  outputFile: string;
  trustedRoot: string;
  sourceTool?: string;
  artifactLabel?: string;
}): TaskOutputEvidence {
  const outputFile = input.outputFile.trim();
  if (!outputFile || outputFile.includes("\u0000"))
    return taskOutputRefusal("invalid-output-reference");

  let root: string;
  let candidate: string;
  try {
    root = realpathSync(resolve(input.trustedRoot));
    candidate = resolve(root, outputFile);
    if (!pathWithinRoot(root, candidate))
      return taskOutputRefusal("output-outside-trusted-root");
    if (hasSymlinkComponent(root, candidate))
      return taskOutputRefusal("output-path-contains-symlink");
  } catch {
    return taskOutputRefusal("output-path-unavailable");
  }

  let fd: number | undefined;
  try {
    fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile()) return taskOutputRefusal("output-is-not-regular");
    if ((opened.mode & 0o444) === 0)
      return taskOutputRefusal("output-unreadable");
    const uid = process.getuid?.();
    if (uid !== undefined && opened.uid !== uid)
      return taskOutputRefusal("output-owner-mismatch", opened.size);
    let openedPath: string;
    try {
      openedPath = realpathSync(`/proc/self/fd/${fd}`);
    } catch {
      return taskOutputRefusal("output-identity-unavailable", opened.size);
    }
    if (!pathWithinRoot(root, openedPath))
      return taskOutputRefusal("output-path-swapped", opened.size);
    if (!Number.isSafeInteger(opened.size) || opened.size < 0)
      return taskOutputRefusal("output-size-invalid");
    if (opened.size > TASK_OUTPUT_SCAN_MAX_BYTES)
      return taskOutputRefusal("output-too-large-to-scan", opened.size);

    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunk = Buffer.allocUnsafe(TASK_OUTPUT_CHUNK_BYTES);
    let offset = 0;
    try {
      while (offset < opened.size) {
        const count = readSync(
          fd,
          chunk,
          0,
          Math.min(chunk.length, opened.size - offset),
          offset,
        );
        if (count === 0)
          return taskOutputRefusal("output-read-incomplete", opened.size);
        if (chunk.subarray(0, count).includes(0))
          return taskOutputRefusal("output-is-binary", opened.size);
        decoder.decode(chunk.subarray(0, count), { stream: true });
        offset += count;
      }
      decoder.decode();
    } catch {
      return taskOutputRefusal("output-is-not-utf8", opened.size);
    }

    const firstEnd =
      opened.size <= TASK_OUTPUT_MAX_BYTES
        ? opened.size
        : TASK_OUTPUT_HALF_BYTES;
    const first = Buffer.alloc(firstEnd);
    if (firstEnd > 0) {
      const count = readSync(fd, first, 0, firstEnd, 0);
      if (count !== firstEnd)
        return taskOutputRefusal("output-read-incomplete", opened.size);
    }
    const tailStart = Math.max(0, opened.size - TASK_OUTPUT_HALF_BYTES);
    const tail = Buffer.alloc(
      opened.size > TASK_OUTPUT_MAX_BYTES ? opened.size - tailStart : 0,
    );
    if (tail.length > 0) {
      const count = readSync(fd, tail, 0, tail.length, tailStart);
      if (count !== tail.length)
        return taskOutputRefusal("output-read-incomplete", opened.size);
    }
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      return taskOutputRefusal("output-changed-during-capture", opened.size);

    const raw =
      opened.size <= TASK_OUTPUT_MAX_BYTES
        ? decodeTaskOutputWindow(first, 0, first.length)
        : `${decodeTaskOutputWindow(first, 0, first.length)}${decodeTaskOutputWindow(tail, 0, tail.length)}`;
    const body = stripTaskOutputTerminalData(raw);
    const bodyBytes = Buffer.from(body, "utf8");
    if (bodyBytes.length > TASK_OUTPUT_MAX_BYTES)
      return taskOutputRefusal("output-capture-overflow", opened.size);

    const artifactRoot = join(
      DATA_DIR,
      "session-artifacts",
      input.sessionId,
      "task-output",
      randomUUID(),
    );
    const artifactPath = join(artifactRoot, "output.txt");
    try {
      mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
      writeFileSync(artifactPath, bodyBytes, { mode: 0o600 });
      const [artifact] = recordNewArtifacts(
        input.sessionId,
        artifactRoot,
        new Set(),
        input.artifactLabel ?? "Claude background task output",
        input.sourceTool ?? "Claude background task",
      );
      if (!artifact)
        return taskOutputRefusal("artifact-registration-failed", opened.size);
      return {
        artifactId: artifact.id,
        originalBytes: opened.size,
        capturedBytes: bodyBytes.length,
        truncated: opened.size > TASK_OUTPUT_MAX_BYTES,
        text: true,
      };
    } catch {
      rmSync(artifactRoot, { recursive: true, force: true });
      return taskOutputRefusal("artifact-write-failed", opened.size);
    }
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    return taskOutputRefusal(
      code === "EACCES" ? "output-unreadable" : "output-open-failed",
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function artifactSourcePath(
  raw: string,
  explicit?: string,
): string | undefined {
  if (explicit) return explicit;
  const match = raw.match(/Full output(?::| saved to:)\s*([^\]\n]+)/i);
  return match?.[1]?.trim();
}

/** Persist an elided native result and register it in the session artifact drawer. */
export async function persistOutputArtifact(input: {
  sessionId: string;
  toolName: string;
  raw: string;
  sourcePath?: string;
}): Promise<OutputArtifact> {
  const safeTool = input.toolName.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const root = join(
    DATA_DIR,
    "session-artifacts",
    input.sessionId,
    "tool-output",
    randomUUID(),
  );
  await mkdir(root, { recursive: true });
  const path = join(root, `${safeTool || "tool"}.log`);
  const source = artifactSourcePath(input.raw, input.sourcePath);
  let copied = false;
  if (source) {
    try {
      await copyFile(source, path);
      copied = true;
    } catch {
      // Vendor temp artifacts are best effort; the hook still has its raw result.
    }
  }
  if (!copied) await writeFile(path, input.raw, "utf8");
  const [artifact] = recordNewArtifacts(
    input.sessionId,
    root,
    new Set(),
    `Full ${input.toolName} output`,
    input.toolName,
  );
  return {
    path,
    url:
      artifact?.url ??
      `/api/session-artifacts/${encodeURIComponent(input.sessionId)}/tool-output/${encodeURIComponent(basename(root))}/${encodeURIComponent(basename(path))}`,
  };
}

function fileReadTextRecord(
  value: unknown,
):
  | { output: Record<string, unknown>; file: Record<string, unknown> }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const output = value as Record<string, unknown>;
  if (output.type !== "text" || !output.file || typeof output.file !== "object")
    return undefined;
  const file = output.file as Record<string, unknown>;
  return typeof file.content === "string" ? { output, file } : undefined;
}

/** Line metadata from Claude's native FileReadOutput, when this is one. */
export function readResultMetadataFromUnknownToolOutput(
  value: unknown,
): ReadResultMetadata | undefined {
  const match = fileReadTextRecord(value);
  if (!match) return undefined;
  const { file } = match;
  if (
    typeof file.numLines !== "number" ||
    typeof file.startLine !== "number" ||
    typeof file.totalLines !== "number"
  )
    return undefined;
  return {
    numLines: file.numLines,
    startLine: file.startLine,
    totalLines: file.totalLines,
    ...(file.truncatedByTokenCap === true ? { truncatedByTokenCap: true } : {}),
  };
}

/** Extract provider result text without depending on either harness's types. */
export function textFromUnknownToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(textFromUnknownToolOutput).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const read = fileReadTextRecord(value);
  if (read) return read.file.content as string;
  const record = value as Record<string, unknown>;
  if (record.type === "image") return "";
  const preferred = ["stdout", "stderr", "output", "content", "text"]
    .map((key) => textFromUnknownToolOutput(record[key]))
    .filter(Boolean);
  if (preferred.length) return preferred.join("\n");
  return "";
}

/** Locate a vendor-owned complete-output file carried beside a bounded preview. */
export function fullOutputPathFromUnknownToolOutput(
  value: unknown,
): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = fullOutputPathFromUnknownToolOutput(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of [
    "fullOutputPath",
    "full_output_path",
    "rawOutputPath",
    "raw_output_path",
  ]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  for (const nested of Object.values(record)) {
    const found = fullOutputPathFromUnknownToolOutput(nested);
    if (found) return found;
  }
  return undefined;
}

/** Keep Claude native result object shape while replacing its textual payload. */
export function replaceUnknownToolOutputText(
  value: unknown,
  replacement: string,
): unknown {
  if (typeof value === "string") return replacement;
  if (Array.isArray(value)) {
    let replaced = false;
    const next = value.map((item) => {
      if (replaced) return item;
      if (typeof item === "string") {
        replaced = true;
        return replacement;
      }
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") {
          replaced = true;
          return { ...record, text: replacement };
        }
      }
      return item;
    });
    return replaced ? next : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const read = fileReadTextRecord(value);
  if (read)
    return {
      ...read.output,
      file: {
        ...read.file,
        content: replacement,
        numLines: contentBodyLines(replacement),
      },
    };
  const record = value as Record<string, unknown>;
  for (const key of ["stdout", "output", "content", "text"]) {
    if (!(key in record)) continue;
    const nested = replaceUnknownToolOutputText(record[key], replacement);
    if (nested === undefined) continue;
    const next = { ...record, [key]: nested };
    // A bounded Bash payload combines both streams; avoid retaining an unbounded
    // stderr beside the replaced stdout while preserving the response schema.
    if (key === "stdout" && typeof record.stderr === "string") next.stderr = "";
    return next;
  }
  return undefined;
}
