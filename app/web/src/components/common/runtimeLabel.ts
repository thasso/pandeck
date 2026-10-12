import type { ThinkingLevel } from "@assistant/shared";
import { THINKING_LABELS } from "./ModelThinkingSelect.tsx";

/**
 * What an agent runs on, as one line: "Opus · High · Work". The model, how hard
 * it thinks (the word alone — "thinking" is implied, and "off" says nothing),
 * then the account. Every surface that names a runtime in a line uses this, so
 * the parts read in the same order everywhere; missing parts are left out.
 */
export function runtimeLabel({
  model,
  thinkingLevel,
  account,
}: {
  model?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  account?: string | undefined;
}): string {
  return [
    model,
    thinkingLevel && thinkingLevel !== "off"
      ? THINKING_LABELS[thinkingLevel]
      : undefined,
    account,
  ]
    .filter(Boolean)
    .join(" · ");
}
