import { SPEECH_SYNTHESIS_LIMITS } from "@assistant/shared";

/** The ordinary send path has no separate per-prompt instruction field. */
export const VOICE_REPLY_HINT =
  "[Voice conversation: answer briefly in plain spoken sentences.]";

/** Only prose reaches this transform. Callers never pass tool or thinking blocks. */
export function spokenMarkdown(markdown: string): string {
  return speechProse(markdown, true).text;
}

function speechProse(
  markdown: string,
  final: boolean,
): { text: string; boundary: boolean } {
  const lines: string[] = [];
  let fence: string | undefined;
  let indented = false;
  for (const line of markdown.split("\n")) {
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
      lines.push("Code omitted.");
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) {
      if (!indented) lines.push("Code omitted.");
      indented = true;
      continue;
    }
    if (indented && !line.trim()) continue;
    indented = false;
    if (!/^\s*\[[^\]]+\]:/.test(line)) lines.push(line);
  }
  const prose: string[] = [];
  let table = false;
  let tableDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
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
    const next = lines[i + 1];
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
    prose.push(line);
  }
  const source = prose.join("\n");
  const stable = final ? source : stableInlinePrefix(source);
  const text = stable
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/!?\[[^\]]*\](?:\([^)]*)?$/g, "")
    .replace(/!?\[[^\]]*$/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
  return { text: text.trim(), boundary: /\s$/.test(text) };
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
  const { text, boundary } = speechProse(markdown, final);
  const chunks: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!/[.!?]/.test(text[i]!)) continue;
    let end = i + 1;
    while (end < text.length && /["')\]]/.test(text[end]!)) end++;
    if (end < text.length && !/\s/.test(text[end]!)) continue;
    if (end === text.length && !final && !boundary) continue;
    const prefix = text.slice(start, end);
    if (/\b(?:Mr|Mrs|Ms|Dr|Prof|e\.g|i\.e)\.$/i.test(prefix)) continue;
    appendBounded(chunks, prefix);
    start = end;
    i = end - 1;
  }
  let tail = text.slice(start).trim();
  const max = SPEECH_SYNTHESIS_LIMITS.maxTextChars;
  while (tail.length > max) {
    const end = breakAt(tail, max);
    chunks.push(tail.slice(0, end).trim());
    tail = tail.slice(end).trim();
  }
  if (final && tail) chunks.push(tail);
  return chunks;
}

function breakAt(text: string, max: number): number {
  const space = text.lastIndexOf(" ", max);
  return space > max / 2 ? space : max;
}

function appendBounded(chunks: string[], value: string): void {
  let text = value.trim();
  const max = SPEECH_SYNTHESIS_LIMITS.maxTextChars;
  while (text.length > max) {
    const end = breakAt(text, max);
    chunks.push(text.slice(0, end).trim());
    text = text.slice(end).trim();
  }
  if (text) chunks.push(text);
}

/** Ignore recognizer feedback that is a prefix/subsequence of our own speech.
 * No grace interval: that would swallow a genuine short interruption such as stop.
 */
export function isPlaybackEcho(transcript: string, spoken: string): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const heard = normalize(transcript);
  const said = normalize(spoken);
  return heard.length > 0 && ` ${said} `.includes(` ${heard} `);
}
