/**
 * Display-block helpers for a turn that is still streaming, shared by both
 * harness session classes and the runtime's live stats. Leaf module: it imports
 * only shared types.
 */
import type { DisplayBlock } from "@assistant/shared";

/** Append a streamed text or thinking delta, extending the last block of that kind. */
export function appendText(
  blocks: DisplayBlock[],
  kind: "text" | "thinking",
  delta: string,
): void {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) last.text += delta;
  else blocks.push({ kind, text: delta });
}

/** Patch the tool block with `toolId` in place. */
export function updateTool(
  blocks: DisplayBlock[],
  toolId: string,
  patch: Partial<Extract<DisplayBlock, { kind: "tool" }>>,
): void {
  for (const b of blocks)
    if (b.kind === "tool" && b.toolId === toolId) Object.assign(b, patch);
}

/**
 * Fast, provider-agnostic token estimate for live text. Completed turns use
 * the provider's real usage instead.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
