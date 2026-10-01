/**
 * Pure, framework-free helpers for the Knowledge history rich-diff views: strip
 * a leading YAML frontmatter block, compute a line-level diff (the "Rendered"
 * view), and compute a word-level diff (the inline "suggested changes" view).
 * Deterministic and unit-testable without a browser.
 */

type MarkdownDiffRunType = "equal" | "add" | "del";

export interface MarkdownDiffRun {
  type: MarkdownDiffRunType;
  /** The lines in this run (no trailing newlines). */
  lines: string[];
}

/** One inline word-level segment: contiguous unchanged, added, or removed text. */
export interface MarkdownWordSegment {
  type: MarkdownDiffRunType;
  text: string;
}

export interface MarkdownDiffOptions {
  /** Treat leading/trailing whitespace as insignificant when comparing. */
  ignoreWhitespace?: boolean;
  /**
   * Token splitter for the WORD diff. Defaults to whitespace-delimited words,
   * which is right for prose; code callers pass a finer one (see
   * `toolOutput.ts`'s `tokenizeCode`) so a mark lands on the identifier that
   * changed rather than the whole `oldName(1);` blob.
   */
  tokenize?: (text: string) => string[];
}

/**
 * Remove a leading YAML frontmatter block (`---\n … \n---`) so the rendered diff
 * matches the frontmatter-free entry body the viewer shows. Text without a
 * leading `---` fence is returned unchanged.
 */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return text;
  return text.slice(match[0].length).replace(/^\r?\n/, "");
}

/** Beyond this token-pair product we skip LCS and emit a coarse whole-block diff. */
const LCS_CELL_LIMIT = 4_000_000;

/**
 * Line-level diff between two texts, as ordered runs (adjacent same-type runs
 * merged). Common prefix/suffix are trimmed before the LCS so large mostly
 * unchanged documents stay cheap; a pathologically large differing middle
 * degrades to one delete + one add run rather than a slow DP.
 */
export function diffMarkdownLines(
  oldText: string,
  newText: string,
  options: MarkdownDiffOptions = {},
): MarkdownDiffRun[] {
  const norm = options.ignoreWhitespace
    ? (line: string) => line.trim()
    : identity;
  return diffTokens(splitLines(oldText), splitLines(newText), norm).map(
    (run) => ({ type: run.type, lines: run.tokens }),
  );
}

/**
 * Word-level diff between two texts, as ordered inline segments — the basis for
 * the "Inline" (Google-Docs-style suggested changes) view. Whitespace is kept as
 * its own tokens so spacing is preserved when segments are concatenated.
 */
export function diffMarkdownWords(
  oldText: string,
  newText: string,
  options: MarkdownDiffOptions = {},
): MarkdownWordSegment[] {
  const norm = options.ignoreWhitespace
    ? (token: string) => (/^\s+$/.test(token) ? " " : token)
    : identity;
  const split = options.tokenize ?? tokenizeWords;
  return diffTokens(split(oldText), split(newText), norm).map((run) => ({
    type: run.type,
    text: run.tokens.join(""),
  }));
}

/**
 * Build a single Markdown string that renders the new document with inline
 * change marks: added words wrapped in `<ins>`, removed words in `<del>`
 * ("suggested changes"). Works line-by-line so block structure (headings,
 * lists, blank-line paragraph breaks) is preserved and no `<ins>`/`<del>` ever
 * spans a block boundary. Requires the renderer to allow raw HTML.
 */
export function buildRenderedDiffMarkdown(
  oldText: string,
  newText: string,
  options: MarkdownDiffOptions = {},
): { markdown: string; changed: boolean } {
  const runs = diffMarkdownLines(oldText, newText, options);
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    if (run.type === "equal") {
      out.push(...run.lines);
      continue;
    }
    const next = runs[i + 1];
    if (run.type === "del" && next?.type === "add") {
      // A modified region: align old/new lines by index and mark word changes.
      changed = true;
      const count = Math.max(run.lines.length, next.lines.length);
      for (let k = 0; k < count; k++) {
        const oldLine = run.lines[k];
        const newLine = next.lines[k];
        if (oldLine !== undefined && newLine !== undefined)
          out.push(mergeLineInline(oldLine, newLine, options));
        else if (oldLine !== undefined)
          out.push(wrapLineContent(oldLine, "del"));
        else if (newLine !== undefined)
          out.push(wrapLineContent(newLine, "ins"));
      }
      i++; // Consumed the paired add run.
      continue;
    }
    // A lone insertion or deletion of whole lines.
    changed = true;
    const tag = run.type === "add" ? "ins" : "del";
    for (const line of run.lines) out.push(wrapLineContent(line, tag));
  }
  return { markdown: out.join("\n"), changed };
}

/** Leading block markup (blockquote, heading, list/ordered marker) kept outside the mark. */
const BLOCK_MARKER =
  /^(\s{0,3}(?:>\s?)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?)([\s\S]*)$/;

function wrapLineContent(line: string, tag: "ins" | "del"): string {
  const match = BLOCK_MARKER.exec(line);
  const prefix = match?.[1] ?? "";
  const rest = match?.[2] ?? line;
  if (rest.trim() === "") return line;
  return `${prefix}<${tag}>${rest}</${tag}>`;
}

function mergeLineInline(
  oldLine: string,
  newLine: string,
  options: MarkdownDiffOptions,
): string {
  return diffMarkdownWords(oldLine, newLine, options)
    .map((segment) => {
      if (segment.type === "equal" || segment.text.trim() === "")
        return segment.text;
      const tag = segment.type === "add" ? "ins" : "del";
      return `<${tag}>${segment.text}</${tag}>`;
    })
    .join("");
}

interface TokenRun {
  type: MarkdownDiffRunType;
  tokens: string[];
}

/**
 * Core diff over two token arrays, comparing tokens by their normalized key but
 * emitting the original tokens. Trims common prefix/suffix, then LCS on the
 * middle (with a coarse fallback for very large regions).
 */
function diffTokens(
  a: string[],
  b: string[],
  norm: (token: string) => string,
): TokenRun[] {
  const aKeys = a.map(norm);
  const bKeys = b.map(norm);

  const runs: TokenRun[] = [];
  const push = (type: MarkdownDiffRunType, tokens: string[]) => {
    if (tokens.length === 0) return;
    const last = runs[runs.length - 1];
    if (last && last.type === type) last.tokens.push(...tokens);
    else runs.push({ type, tokens: [...tokens] });
  };

  let start = 0;
  const maxPrefix = Math.min(a.length, b.length);
  while (start < maxPrefix && aKeys[start] === bKeys[start]) start++;
  push("equal", a.slice(0, start));

  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && aKeys[aEnd - 1] === bKeys[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }

  const aMid = a.slice(start, aEnd);
  const bMid = b.slice(start, bEnd);
  if (
    aMid.length === 0 ||
    bMid.length === 0 ||
    aMid.length * bMid.length > LCS_CELL_LIMIT
  ) {
    push("del", aMid);
    push("add", bMid);
  } else {
    for (const op of lcsDiff(
      aKeys.slice(start, aEnd),
      bKeys.slice(start, bEnd),
      aMid,
      bMid,
    ))
      push(op.type, op.tokens);
  }

  push("equal", a.slice(aEnd));
  return runs;
}

/** Classic LCS DP edit script; compares by keys, emits the paired originals. */
function lcsDiff(
  aKeys: string[],
  bKeys: string[],
  a: string[],
  b: string[],
): TokenRun[] {
  const n = aKeys.length;
  const m = bKeys.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  const at = (i: number, j: number) => dp[i * width + j]!;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        aKeys[i] === bKeys[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const ops: TokenRun[] = [];
  const emit = (type: MarkdownDiffRunType, token: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.tokens.push(token);
    else ops.push({ type, tokens: [token] });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aKeys[i] === bKeys[j]) {
      emit("equal", a[i]!);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      emit("del", a[i]!);
      i++;
    } else {
      emit("add", b[j]!);
      j++;
    }
  }
  while (i < n) emit("del", a[i++]!);
  while (j < m) emit("add", b[j++]!);
  return ops;
}

function identity(value: string): string {
  return value;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

/** Split into alternating word and whitespace tokens, preserving all characters. */
function tokenizeWords(text: string): string[] {
  if (text === "") return [];
  return text
    .replace(/\r\n/g, "\n")
    .split(/(\s+)/)
    .filter((token) => token.length > 0);
}
