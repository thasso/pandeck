/**
 * Pure parsers for the native file/shell tools' text payloads, so the transcript
 * can render REAL file line numbers instead of a second, meaningless 1..N gutter.
 *
 * The two harnesses hand us different shapes:
 *  - Claude's `Read` returns `cat -n`-style `"<line>\t<code>"` rows, so the true
 *    numbers are inside the text and must be lifted out into the gutter.
 *  - pi's `read` returns raw file text with NO numbers; the caller supplies the
 *    starting line from the call's `offset` argument.
 *  - pi's `edit` result carries a rendered, line-numbered diff (`details.diff`,
 *    plumbed to the client as `DisplayBlock.resultDiff`): `"<sign><num> <text>"`
 *    rows plus `" ... "` elision rows.
 *  - Claude's `Edit` reports only success text, so its diff is computed from the
 *    call's own old/new strings and has no line numbers at all.
 */

/** A numbered file excerpt lifted out of a tool's text output. */
export interface NumberedFileOutput {
  /** Real file line of the first code row. */
  startLine: number;
  /** The code with the number gutter stripped. */
  code: string;
  /** Trailing tool notice (e.g. "[Showing lines 1-50 of 900 …]"), if any. */
  notice?: string;
}

const NUMBERED_ROW = /^\s*(\d+)\t(.*)$/;

/**
 * Lift a `cat -n`-style gutter out of file output. Returns `null` unless the
 * text really is a numbered excerpt: every code row must match and the numbers
 * must be consecutive, so ordinary file content that merely starts with digits
 * is never mistaken for a gutter (and never silently mangled).
 */
export function parseNumberedFileOutput(
  text: string,
): NumberedFileOutput | null {
  if (text.length === 0) return null;
  const { body, notice } = splitTrailingNotice(text);
  const lines = body.split("\n");
  // A trailing empty line is an artifact of the final newline, not a row.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return null;

  const code: string[] = [];
  let expected: number | null = null;
  let startLine = 0;
  for (const line of lines) {
    const match = NUMBERED_ROW.exec(line);
    if (!match) return null;
    const number = Number(match[1]);
    const content = match[2] ?? "";
    if (expected === null) {
      startLine = number;
    } else if (number !== expected) {
      return null;
    }
    expected = number + 1;
    code.push(content);
  }
  if (startLine < 1) return null;
  return {
    startLine,
    code: code.join("\n"),
    ...(notice !== undefined ? { notice } : {}),
  };
}

/**
 * Split a trailing bracketed tool notice (pi's `[Showing lines …]`, Claude's
 * truncation hints) off the payload. Only a final block separated by a blank
 * line counts, so bracketed content inside a file is left alone.
 */
function splitTrailingNotice(text: string): {
  body: string;
  notice?: string;
} {
  const index = text.lastIndexOf("\n\n[");
  if (index < 0) return { body: text };
  const notice = text.slice(index + 2).trim();
  if (!notice.endsWith("]") || notice.includes("\n\n")) return { body: text };
  return { body: text.slice(0, index), notice };
}

/** One rendered row of a tool diff. */
export interface ToolDiffRow {
  kind: "add" | "del" | "context" | "gap";
  /** Real file line number; absent for gaps and for computed (unpositioned) diffs. */
  line?: number;
  text: string;
  /**
   * Intra-line word segments for a replaced line (`markIntralineChanges`), so an
   * add/remove row can highlight WHAT changed inside it — the reason the app used
   * a real diff renderer in the first place. Absent when the row is a pure
   * insertion/deletion or the pairing was too weak to be useful.
   */
  segments?: Array<{ text: string; changed: boolean }>;
}

const DIFF_ROW = /^([+\- ])(\s*)(\d+) (.*)$/;
const DIFF_GAP = /^\s*\.\.\.\s*$/;

/**
 * Parse a provider-rendered, line-numbered diff (`DisplayBlock.resultDiff`).
 * Returns `null` when the text is not that shape, so the caller falls back to
 * diffing the call's own strings.
 */
export function parseNumberedDiff(text: string): ToolDiffRow[] | null {
  if (text.trim().length === 0) return null;
  const rows: ToolDiffRow[] = [];
  let numbered = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    if (DIFF_GAP.test(line)) {
      rows.push({ kind: "gap", text: "…" });
      continue;
    }
    const match = DIFF_ROW.exec(line);
    if (!match) return null;
    numbered += 1;
    rows.push({
      kind: match[1] === "+" ? "add" : match[1] === "-" ? "del" : "context",
      line: Number(match[3]),
      text: match[4] ?? "",
    });
  }
  return numbered > 0 ? rows : null;
}

/**
 * Flatten line-diff runs into rows WITHOUT line numbers — the fallback for a
 * harness that reports no positioned diff. Snippet-relative numbers would be
 * worse than none here: they look like file lines and are not.
 */
export function diffRowsFromRuns(
  runs: ReadonlyArray<{
    type: "equal" | "add" | "del";
    lines: readonly string[];
  }>,
): ToolDiffRow[] {
  const rows: ToolDiffRow[] = [];
  for (const run of runs) {
    const kind = run.type === "equal" ? "context" : run.type;
    for (const line of run.lines) rows.push({ kind, text: line });
  }
  return rows;
}

/**
 * Split code into identifier / whitespace / single-punctuation tokens, so an
 * intra-line mark lands on the part that changed (`oldName` in
 * `const v = oldName(1);`) instead of the whole whitespace-delimited blob the
 * prose tokenizer would produce.
 */
export function tokenizeCode(text: string): string[] {
  return text.match(/[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g) ?? [];
}

/**
 * Beyond this fraction of changed characters a "replaced line" pair is really two
 * different lines; word marks would then cover most of the row and add noise, so
 * the rows stay whole-line coloured.
 */
const INTRALINE_MAX_CHANGE_RATIO = 0.7;

/**
 * Pair each removed line with the added line that replaced it and compute
 * word-level segments for both, the way the @pierre/diffs surface does for the
 * worktree views. Pairing is positional within one contiguous del-run/add-run
 * couple (that is what a line diff gives us); unpaired rows and weak pairs keep
 * whole-line colouring only.
 */
export function markIntralineChanges(
  rows: ToolDiffRow[],
  diffWords: (
    oldText: string,
    newText: string,
  ) => Array<{ type: "equal" | "add" | "del"; text: string }>,
): ToolDiffRow[] {
  const out = rows.slice();
  let index = 0;
  while (index < out.length) {
    if (out[index]?.kind !== "del") {
      index += 1;
      continue;
    }
    let delEnd = index;
    while (out[delEnd]?.kind === "del") delEnd += 1;
    let addEnd = delEnd;
    while (out[addEnd]?.kind === "add") addEnd += 1;

    const pairs = Math.min(delEnd - index, addEnd - delEnd);
    for (let offset = 0; offset < pairs; offset += 1) {
      const removed = out[index + offset];
      const added = out[delEnd + offset];
      if (!removed || !added) continue;
      const segments = intralineSegments(removed.text, added.text, diffWords);
      if (!segments) continue;
      out[index + offset] = { ...removed, segments: segments.removed };
      out[delEnd + offset] = { ...added, segments: segments.added };
    }
    index = addEnd > delEnd ? addEnd : delEnd;
  }
  return out;
}

function intralineSegments(
  oldLine: string,
  newLine: string,
  diffWords: (
    oldText: string,
    newText: string,
  ) => Array<{ type: "equal" | "add" | "del"; text: string }>,
): {
  removed: Array<{ text: string; changed: boolean }>;
  added: Array<{ text: string; changed: boolean }>;
} | null {
  if (oldLine.length === 0 || newLine.length === 0) return null;
  const segments = diffWords(oldLine, newLine);
  const changedChars = segments
    .filter((s) => s.type !== "equal")
    .reduce((sum, s) => sum + s.text.length, 0);
  const totalChars = oldLine.length + newLine.length;
  if (
    totalChars === 0 ||
    changedChars / totalChars > INTRALINE_MAX_CHANGE_RATIO
  )
    return null;

  const removed: Array<{ text: string; changed: boolean }> = [];
  const added: Array<{ text: string; changed: boolean }> = [];
  for (const segment of segments) {
    if (segment.type !== "add")
      removed.push({ text: segment.text, changed: segment.type === "del" });
    if (segment.type !== "del")
      added.push({ text: segment.text, changed: segment.type === "add" });
  }
  const anyMarked =
    removed.some((s) => s.changed) || added.some((s) => s.changed);
  return anyMarked
    ? { removed: mergeSegments(removed), added: mergeSegments(added) }
    : null;
}

/** Join neighbouring segments of the same kind so marks read as spans, not per-token boxes. */
function mergeSegments(
  segments: Array<{ text: string; changed: boolean }>,
): Array<{ text: string; changed: boolean }> {
  const out: Array<{ text: string; changed: boolean }> = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (last && last.changed === segment.changed) last.text += segment.text;
    else out.push({ ...segment });
  }
  return out;
}

/** The command a `bash`-family call ran, for the shell-style header line. */
export function bashCommand(args: unknown): string | null {
  if (args == null || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}
