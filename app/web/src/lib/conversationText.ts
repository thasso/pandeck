import { SPEECH_SYNTHESIS_LIMITS } from "@assistant/shared";

/** The ordinary send path has no separate per-prompt instruction field. */
export const VOICE_REPLY_HINT =
  "[Voice conversation: answer briefly in plain spoken sentences.]";

/** Only prose reaches this transform. Callers never pass tool or thinking blocks. */
export function spokenMarkdown(markdown: string): string {
  return speechProse(markdown, true).text.trim();
}

interface SourceText {
  text: string;
  /** Exclusive Markdown source offset for each output character. */
  ends: number[];
}

function speechProse(
  markdown: string,
  final: boolean,
): SourceText & { boundary: boolean } {
  const lines: SourceText[] = [];
  let fence: string | undefined;
  let indented = false;
  let offset = 0;
  for (const line of markdown.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const mapped = {
      text: line,
      ends: Array.from({ length: line.length }, (_, i) => start + i + 1),
    };
    const omitted = () => ({
      text: "Code omitted.",
      ends: Array<number>(13).fill(start + line.length),
    });
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        /^\s*(?:`{3,}|~{3,})\s*$/.test(line)
      )
        fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker;
      lines.push(omitted());
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) {
      if (!indented) lines.push(omitted());
      indented = true;
      continue;
    }
    if (indented && !line.trim()) continue;
    indented = false;
    if (!/^\s*\[[^\]]+\]:/.test(line)) lines.push(mapped);
  }
  const prose: SourceText[] = [];
  let table = false;
  let tableDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const mapped = lines[i]!;
    const line = mapped.text;
    const depth = quoteDepth(line);
    const row = line.replace(/^\s*(?:>\s*)+/, "");
    const cells = tableCells(row);
    if (
      table &&
      depth === tableDepth &&
      cells &&
      !/^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s)/.test(row)
    )
      continue;
    table = false;
    const next = lines[i + 1]?.text;
    const nextRow = next?.replace(/^\s*(?:>\s*)+/, "");
    const delimiter =
      next === undefined || quoteDepth(next) !== depth
        ? null
        : tableCells(nextRow!);
    if (
      cells &&
      delimiter?.length === cells.length &&
      delimiter.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
    ) {
      table = true;
      tableDepth = depth;
      i++;
      continue;
    }
    // Until the next line is known, a pipe-bearing row may become a table
    // header. Never speak it and then retract it when its delimiter arrives.
    if (
      !final &&
      cells &&
      (next === undefined ||
        (i + 1 === lines.length - 1 && /^[| :-]*$/.test(nextRow!)))
    )
      break;
    prose.push(mapped);
  }
  const source: SourceText = { text: "", ends: [] };
  for (const line of prose) {
    if (source.text) {
      source.text += "\n";
      source.ends.push(line.ends[0] ?? source.ends.at(-1) ?? 0);
    }
    source.text += line.text;
    for (const end of line.ends) source.ends.push(end);
  }
  const stable = final ? source.text : stableInlinePrefix(source.text);
  let result: SourceText = {
    text: stable,
    ends: source.ends.slice(0, stable.length),
  };
  const transforms: [RegExp, string | number][] = [
    [/!\[[^\]]*\]\([^)]*\)/g, ""],
    [/\[([^\]]+)\]\([^)]*\)/g, 1],
    [/\[([^\]]+)\]\[[^\]]*\]/g, 1],
    [/!?\[[^\]]*\](?:\([^)]*)?$/g, ""],
    [/!?\[[^\]]*$/g, ""],
    [/<[^>]*>/g, ""],
    [/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, ""],
    [/[`*_~]/g, ""],
    [/&amp;/g, "&"],
    [/&lt;/g, "<"],
    [/&gt;/g, ">"],
    [/&quot;/g, '"'],
    [/\s+/g, " "],
  ];
  for (const [pattern, replacement] of transforms)
    result = replaceSourceText(result, pattern, replacement);
  // A raw trailing space does not settle the trailing sentence. An open inline
  // construct does establish that following text exists, even while held back.
  const boundary =
    stable.length < source.text.length && /\s$/.test(result.text);
  return { ...result, boundary };
}

/** Preserve source positions through removals, link labels and entity decoding. */
function replaceSourceText(
  source: SourceText,
  pattern: RegExp,
  replacement: string | number,
): SourceText {
  const result: SourceText = { text: "", ends: [] };
  let start = 0;
  for (const match of source.text.matchAll(pattern)) {
    const index = match.index;
    result.text += source.text.slice(start, index);
    for (let i = start; i < index; i++) result.ends.push(source.ends[i]!);
    const value =
      typeof replacement === "number" ? match[replacement]! : replacement;
    result.text += value;
    if (typeof replacement === "number") {
      const label = index + match[0].indexOf(value);
      for (let i = label; i < label + value.length; i++)
        result.ends.push(source.ends[i]!);
    } else {
      const end = source.ends[index + match[0].length - 1]!;
      for (let i = 0; i < value.length; i++) result.ends.push(end);
    }
    start = index + match[0].length;
  }
  result.text += source.text.slice(start);
  for (let i = start; i < source.ends.length; i++)
    result.ends.push(source.ends[i]!);
  return result;
}

function quoteDepth(line: string): number {
  return /^\s*(?:>\s*)+/.exec(line)?.[0].match(/>/g)?.length ?? 0;
}

/** Split only unescaped pipes outside inline code. Outer pipes are optional. */
function tableCells(line: string): string[] | null {
  const cells: string[] = [];
  let start = 0;
  let code = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "`") {
      const marker = /^`+/.exec(line.slice(i))![0];
      if (!code) code = marker;
      else if (code === marker) code = "";
      i += marker.length - 1;
    } else if (!code && line[i] === "|") {
      cells.push(line.slice(start, i));
      start = i + 1;
    }
  }
  if (!cells.length) return null;
  cells.push(line.slice(start));
  if (!cells[0]!.trim()) cells.shift();
  if (!cells.at(-1)!.trim()) cells.pop();
  return cells.length ? cells : null;
}

/** Streaming inline syntax may still replace its label/markers. Keep the
 * trailing open construct out of speech until its meaning is settled. */
function stableInlinePrefix(source: string): string {
  const open: { marker: string; start: number }[] = [];
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\") {
      i++;
      continue;
    }
    const current = open.at(-1);
    if (current?.marker.startsWith("`")) {
      if (char === "`") {
        const marker = /^`+/.exec(source.slice(i))![0];
        if (marker === current.marker) open.pop();
        i += marker.length - 1;
      }
      continue;
    }
    if (char === "[") {
      const start = source[i - 1] === "!" ? i - 1 : i;
      const labelEnd = closingDelimiter(source, i, "[", "]");
      if (labelEnd === undefined || labelEnd === source.length - 1)
        return source.slice(0, Math.min(start, open[0]?.start ?? start));
      let end = labelEnd;
      const next = source[end + 1];
      if (next === "(" || next === "[") {
        const targetEnd = closingDelimiter(
          source,
          end + 1,
          next,
          next === "(" ? ")" : "]",
        );
        if (targetEnd === undefined)
          return source.slice(0, Math.min(start, open[0]?.start ?? start));
        end = targetEnd;
      }
      i = end;
    } else if (char === "<" && /[a-z!/?]/i.test(source[i + 1] ?? "")) {
      const end = source.indexOf(">", i + 1);
      if (end < 0) return source.slice(0, Math.min(i, open[0]?.start ?? i));
      i = end;
    } else if (char === "`" || char === "*" || char === "_" || char === "~") {
      let end = i + 1;
      while (source[end] === char) end++;
      const marker = source.slice(i, end);
      const before = source[i - 1] ?? " ";
      const after = source[i + marker.length];
      if (char === "~" && marker.length === 1 && after !== undefined) continue;
      if (char !== "_" || !/\w/.test(before) || !/\w/.test(after ?? "")) {
        if (current?.marker === marker && !/\s/.test(before)) open.pop();
        else if (char === "`" || after === undefined || !/\s/.test(after))
          open.push({ marker, start: i });
      }
      i += marker.length - 1;
    }
  }
  return open.length ? source.slice(0, open[0]!.start) : source;
}

function closingDelimiter(
  source: string,
  start: number,
  left: string,
  right: string,
): number | undefined {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === left) depth++;
    if (source[i] === right && --depth === 0) return i;
  }
  return undefined;
}

/** Stable complete sentences, plus a bounded tail only when it is final/long. */
export function speechChunks(markdown: string, final: boolean): string[] {
  return speechSegments(markdown, final).map((segment) => segment.text);
}

/** Resume by Markdown source offset, not by the changing number of prose chunks. */
export function speechSegments(
  markdown: string,
  final: boolean,
  after = 0,
): { text: string; end: number }[] {
  const prose = speechProse(markdown, final);
  let from = prose.ends.findIndex((end) => end > after);
  if (from < 0) return [];
  while (/\s/.test(prose.text[from] ?? "") && from < prose.text.length) from++;
  const text = prose.text.slice(from).trimEnd();
  const ends = prose.ends.slice(from, from + text.length);
  const chunks: { text: string; end: number }[] = [];
  const append = (start: number, end: number) => {
    while (start < end && /\s/.test(text[start]!)) start++;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    const max = SPEECH_SYNTHESIS_LIMITS.maxTextChars;
    while (end - start > max) {
      const split = start + breakAt(text.slice(start, end), max);
      chunks.push({
        text: text.slice(start, split).trim(),
        end: ends[split - 1]!,
      });
      start = split;
      while (start < end && /\s/.test(text[start]!)) start++;
    }
    if (end > start)
      chunks.push({ text: text.slice(start, end), end: ends[end - 1]! });
  };
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!/[.!?]/.test(text[i]!)) continue;
    let end = i + 1;
    while (end < text.length && /["')\]]/.test(text[end]!)) end++;
    if (end < text.length && !/\s/.test(text[end]!)) continue;
    if (end === text.length && !final && !prose.boundary) continue;
    const prefix = text.slice(start, end);
    if (/\b(?:Mr|Mrs|Ms|Dr|Prof|e\.g|i\.e)\.$/i.test(prefix)) continue;
    append(start, end);
    start = end;
    i = end - 1;
  }
  const max = SPEECH_SYNTHESIS_LIMITS.maxTextChars;
  while (text.length - start > max) {
    const end = start + breakAt(text.slice(start), max);
    append(start, end);
    start = end;
    while (start < text.length && /\s/.test(text[start]!)) start++;
  }
  if (final) append(start, text.length);
  return chunks;
}

function breakAt(text: string, max: number): number {
  const space = text.lastIndexOf(" ", max);
  return space > max / 2 ? space : max;
}

/** Ignore recognizer feedback that is a prefix/subsequence of our own speech.
 * No grace interval: that would swallow a genuine short interruption such as stop.
 */
export function isPlaybackEcho(
  transcript: string,
  spoken: string,
  partial = false,
): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const heard = normalize(transcript);
  const said = normalize(spoken);
  // Streaming recognition can end mid-word ("resp" before "responder").
  // Only relax the last token after a complete preceding word. A short
  // single-word interruption such as "stop" still needs an exact echo match.
  const unfinished = partial && heard.includes(" ");
  return (
    heard.length > 0 &&
    ` ${said} `.includes(` ${heard}${unfinished ? "" : " "}`)
  );
}
