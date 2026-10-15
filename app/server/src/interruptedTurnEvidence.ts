/**
 * What an agent's OWN history says about a turn the server died inside.
 *
 * The app log cannot answer it: both harnesses flush a turn's entries to that
 * log at completion, so a killed turn leaves only its open run bracket there.
 * The harness's native transcript is written as the turn goes — the prompt
 * when it is submitted, each model response as it lands — and it is what the
 * agent resumes from. So it alone decides whether a plain "continue" picks the
 * work up again or the prompt has to be sent again.
 *
 * Each harness knows its own line format and supplies {@link classify}; this
 * owns the reading, which is the same for both.
 */
import { readFileSync } from "node:fs";

export interface InterruptedTurnEvidence {
  /** The turn's prompt is in the agent's history, so the agent resumes with it. */
  promptKept: boolean;
  /** Model responses recorded after that prompt. */
  modelSteps: number;
}

/** One native transcript line, as a harness reads it. */
export type TurnLineKind =
  | { kind: "prompt" }
  /** `id` merges lines of one response the harness writes in parts. */
  | { kind: "step"; id?: string }
  | undefined;

/**
 * Scan a JSONL transcript for the turn that started at `since` (epoch ms, the
 * app log's run bracket, written before the prompt is handed to the harness).
 * Undefined when the file cannot be read: unknown is not "lost".
 */
export function scanInterruptedTurn(
  path: string,
  since: number,
  classify: (line: Record<string, unknown>) => TurnLineKind,
): InterruptedTurnEvidence | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let promptKept = false;
  let modelSteps = 0;
  const seen = new Set<string>();
  for (const text of raw.split("\n")) {
    if (!text) continue;
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      continue; // a torn last line is what a killed process leaves
    }
    if (!line || typeof line !== "object") continue;
    const record = line as Record<string, unknown>;
    const at =
      typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    if (!(at >= since)) continue;
    const kind = classify(record);
    if (kind?.kind === "prompt") promptKept = true;
    else if (kind?.kind === "step" && promptKept) {
      if (kind.id !== undefined) {
        if (seen.has(kind.id)) continue;
        seen.add(kind.id);
      }
      modelSteps += 1;
    }
  }
  return { promptKept, modelSteps };
}
