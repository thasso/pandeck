import { SPEECH_SYNTHESIS_LIMITS } from "@assistant/shared";

/** The ordinary send path has no separate per-prompt instruction field. */
export const VOICE_REPLY_HINT =
  "[Voice conversation: answer briefly in plain spoken sentences.]";

/** Only prose reaches this transform. Callers never pass tool or thinking blocks. */
export function spokenMarkdown(markdown: string): string {
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
    if (!line.includes("|") && !/^\s*\[[^\]]+\]:/.test(line)) lines.push(line);
  }
  return lines
    .join("\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/!?\[[^\]]*\](?:\([^)]*)?$/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable complete sentences, plus a bounded tail only when it is final/long. */
export function speechChunks(markdown: string, final: boolean): string[] {
  const text = spokenMarkdown(markdown);
  const chunks: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!/[.!?]/.test(text[i]!)) continue;
    let end = i + 1;
    while (end < text.length && /["')\]]/.test(text[end]!)) end++;
    if (end < text.length && !/\s/.test(text[end]!)) continue;
    if (end === text.length && !final) continue;
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
