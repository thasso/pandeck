import { parseDocumentTarget } from "@assistant/shared/documentTargets";
import {
  bodyContentHash,
  type AgentContentBlock,
  type LazyBlockRef,
} from "@assistant/shared/session";
import {
  normalizedToolName,
  toolCardOf,
  toolCardReadsInput,
  toolCardReadsOutput,
  type ToolCardKind,
} from "@assistant/shared/toolCards";
import type { AssistantRawEntry, ToolResultRawEntry } from "./rawEntry.ts";

const TOOL_OUTPUT_PREVIEW_LINES = 12;
const THINKING_PREVIEW_CHARS = 240;
const TOOL_INPUT_INLINE_BYTES = 512;
const TOOL_OUTPUT_INLINE_BYTES = 1200;

export interface ToolCallInfo {
  entryId: string;
  blockIndex: number;
  name: string;
  input: unknown;
}

/**
 * The server's `show_files` address rule: the tool emits relative API paths
 * (`directFileUrlPath`/`sessionArtifactUrlPath`), which is what both ends
 * parse. The web additionally resolves absolute urls against its own origin,
 * which the server does not know; a payload of only such urls is the one
 * asymmetry left, and it is one the tool never produces.
 */
function resolveShowFilesTarget(url: string): string | null {
  const target = parseDocumentTarget(url);
  return target?.kind === "hostFile" || target?.kind === "sessionArtifact"
    ? url
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasValidQuestionInput(input: unknown): boolean {
  return (
    isRecord(input) &&
    Array.isArray(input.questions) &&
    input.questions.length > 0 &&
    input.questions.every((question) => isRecord(question))
  );
}

/**
 * The running question card reads its validated request from the call input,
 * so that input stays whole from `toolStarted` on. A request the card could
 * not lay out (no question records) is summarized like any other input: the
 * card then shows its header only, which is all it could show anyway.
 */
export function shouldKeepFullToolInput(
  name: string | undefined,
  input: unknown,
): boolean {
  return (
    normalizedToolName(name ?? "") === "ask_questions" &&
    hasValidQuestionInput(input)
  );
}

/**
 * The card a COMPLETED result renders as — the shared decision the web
 * registry makes from the same name, arguments, output and error flag
 * (`@assistant/shared/toolCards`), so a payload stays whole exactly when a
 * card will read it, in both harnesses' spellings.
 */
export function completedToolCardOf(
  name: string,
  input: unknown,
  output: string,
  isError: boolean,
): ToolCardKind | null {
  return toolCardOf(
    { name, args: input, output, isError },
    resolveShowFilesTarget,
  );
}

function toolCardForResult(
  entry: ToolResultRawEntry,
  call: ToolCallInfo | undefined,
  output: string,
): ToolCardKind | null {
  return completedToolCardOf(
    entry.toolName ?? call?.name ?? "",
    call?.input,
    output,
    entry.isError ?? false,
  );
}

/** The result's payload is read by a card, so it stays whole on the wire. */
function shouldKeepFullToolPayload(
  entry: ToolResultRawEntry,
  call: ToolCallInfo | undefined,
  output: string,
): boolean {
  const card = toolCardForResult(entry, call, output);
  return card !== null && toolCardReadsOutput(card);
}

/**
 * The result's card reads the CALL's input, so the declaring entry keeps that
 * input whole (and is re-sent when it was summarized before the result). Only
 * the cards that read their arguments qualify: the peer, show-files, workshop
 * and worktree cards render from the payload alone, and the Google/Jira cards
 * read the `render` marker, which every summary keeps.
 */
export function resultKeepsFullToolInput(
  entry: ToolResultRawEntry,
  call: ToolCallInfo | undefined,
  output: string,
): boolean {
  const card = toolCardForResult(entry, call, output);
  if (card === null || !toolCardReadsInput(card)) return false;
  return card !== "agentQuestion" || hasValidQuestionInput(call?.input);
}

/** True when the lazy projection would summarize this call's input. */
export function toolInputExceedsInline(input: unknown): boolean {
  return jsonBytes(input) > TOOL_INPUT_INLINE_BYTES;
}

/**
 * The compact form of a tool input: the call's own input when small or needed
 * whole, otherwise a summary plus its size, for the caller to reference the
 * full value (a lazy ref on a durable entry, a live ref on a stream).
 */
export function compactToolInput(
  name: string | undefined,
  input: unknown,
  keepFullInput = false,
): { input: unknown; inputSummary?: string; fullBytes?: number } {
  const bytes = jsonBytes(input);
  if (
    bytes <= TOOL_INPUT_INLINE_BYTES ||
    (keepFullInput && shouldKeepFullToolInput(name, input))
  )
    return { input };
  const summary = summarizeToolInput(input);
  const label = summaryLabel(summary);
  return {
    input: summary,
    ...(label !== undefined ? { inputSummary: label } : {}),
    fullBytes: bytes,
  };
}

export function lazyAssistantContent(
  entry: AssistantRawEntry,
  fullToolCallIds: ReadonlySet<string>,
): AgentContentBlock[] {
  return entry.content.map((block, blockIndex) => {
    if (block.type === "thinking")
      return lazyTextBlock(
        block,
        entry.id,
        blockIndex,
        "thinking",
        THINKING_PREVIEW_CHARS,
      );
    if (block.type !== "toolCall") return block;
    if (fullToolCallIds.has(block.toolCallId)) return block;
    const compact = compactToolInput(block.name, block.input);
    if (compact.fullBytes === undefined) return block;
    return {
      ...block,
      input: compact.input,
      ...(compact.inputSummary !== undefined
        ? { inputSummary: compact.inputSummary }
        : {}),
      inputLazy: lazyRef(
        entry.id,
        blockIndex,
        "toolInput",
        compact.fullBytes,
        jsonBytes(compact.input),
        undefined,
        memoizedHash(block, () => jsonHash(block.input)),
      ),
    };
  });
}

export function lazyToolResultContent(
  entry: ToolResultRawEntry,
  call: ToolCallInfo | undefined,
): AgentContentBlock[] {
  const output = textOf(entry.content);
  if (shouldKeepFullToolPayload(entry, call, output)) return entry.content;
  if (
    Buffer.byteLength(output) <= TOOL_OUTPUT_INLINE_BYTES &&
    output.split("\n").length <= TOOL_OUTPUT_PREVIEW_LINES
  )
    return entry.content;
  return entry.content.map((block, blockIndex) => {
    if (block.type !== "text") return block;
    // A line cap alone does not bound minified JSON or base64 image results: one
    // "line" can be hundreds of kilobytes. Bound both dimensions so first-load
    // snapshots never inline an entire single-line payload.
    return lazyTextBlock(
      block,
      entry.id,
      blockIndex,
      "toolOutput",
      TOOL_OUTPUT_INLINE_BYTES,
      TOOL_OUTPUT_PREVIEW_LINES,
    );
  });
}

/**
 * Content identities, memoized per raw log block. Log blocks are immutable
 * objects that every projection walks again (each attach projects the whole
 * timeline), and the identity is a SHA-256 over the body — hashing megabytes
 * of thinking and tool output on every reconnect would be a visible attach
 * cost, so each block is hashed once per process.
 */
const blockHashes = new WeakMap<object, string | undefined>();

function memoizedHash(
  block: object,
  compute: () => string | undefined,
): string | undefined {
  if (blockHashes.has(block)) return blockHashes.get(block);
  const hash = compute();
  blockHashes.set(block, hash);
  return hash;
}

function lazyTextBlock<
  T extends Extract<AgentContentBlock, { type: "text" | "thinking" }>,
>(
  block: T,
  entryId: string,
  blockIndex: number,
  kind: LazyBlockRef["kind"],
  maxChars?: number,
  maxLines?: number,
): T {
  const full = block.text;
  const preview = previewText(full, maxChars, maxLines);
  if (preview.length >= full.length) return block;
  return {
    ...block,
    text: preview,
    lazy: lazyRef(
      entryId,
      blockIndex,
      kind,
      full.length,
      preview.length,
      full,
      memoizedHash(block, () => bodyContentHash(full)),
    ),
  };
}

function lazyRef(
  entryId: string,
  blockIndex: number,
  kind: LazyBlockRef["kind"],
  fullLength: number,
  previewLength: number,
  fullText?: string,
  contentHash?: string,
): LazyBlockRef {
  const lineCount =
    fullText === undefined ? undefined : fullText.split("\n").length;
  const previewLineCount =
    fullText === undefined
      ? undefined
      : previewText(fullText, undefined, TOOL_OUTPUT_PREVIEW_LINES).split("\n")
          .length;
  return {
    entryId,
    blockIndex,
    kind,
    fullLength,
    previewLength,
    ...(contentHash !== undefined ? { contentHash } : {}),
    ...(lineCount !== undefined ? { lineCount } : {}),
    ...(previewLineCount !== undefined ? { previewLineCount } : {}),
  };
}

function previewText(
  text: string,
  maxChars?: number,
  maxLines?: number,
): string {
  let preview = text;
  if (maxLines !== undefined)
    preview = preview.split("\n").slice(0, maxLines).join("\n");
  if (maxChars !== undefined && preview.length > maxChars)
    preview = preview.slice(0, maxChars);
  return preview;
}

function textOf(content: readonly AgentContentBlock[]): string {
  return content
    .filter(
      (c): c is Extract<AgentContentBlock, { type: "text" }> =>
        c.type === "text",
    )
    .map((c) => c.text)
    .join("\n");
}

function jsonString(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : serialized;
  } catch {
    return undefined;
  }
}

function jsonBytes(value: unknown): number {
  const serialized = jsonString(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized);
}

function jsonHash(value: unknown): string | undefined {
  const serialized = jsonString(value);
  return serialized === undefined ? undefined : bodyContentHash(serialized);
}

function summarizeToolInput(input: unknown): unknown {
  if (input === null || input === undefined || typeof input !== "object")
    return input;
  if (Array.isArray(input)) return { summary: `Array(${input.length})` };
  const obj = input as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of [
    "command",
    "cmd",
    "path",
    "file_path",
    "filePath",
    "pattern",
    "query",
  ]) {
    const value = obj[key];
    if (typeof value === "string")
      summary[key] = value.length > 240 ? `${value.slice(0, 240)}…` : value;
  }
  const labeled =
    Object.keys(summary).length > 0
      ? summary
      : { summary: `Object(${Object.keys(obj).slice(0, 8).join(", ")})` };
  // The `render` marker is the one argument the Google/Jira cards read: a
  // summary that dropped it would un-match a card whose payload is whole.
  return typeof obj.render === "boolean"
    ? { ...labeled, render: obj.render }
    : labeled;
}

function summaryLabel(summary: unknown): string | undefined {
  if (summary === null || summary === undefined) return undefined;
  if (typeof summary !== "object") return String(summary);
  const obj = summary as Record<string, unknown>;
  const value =
    obj.command ??
    obj.cmd ??
    obj.path ??
    obj.file_path ??
    obj.filePath ??
    obj.pattern ??
    obj.query ??
    obj.summary;
  return typeof value === "string" ? value : undefined;
}
