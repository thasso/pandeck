/**
 * pi's answer to "what does the agent's history hold of the cut turn?"
 * (`interruptedTurnEvidence.ts`). pi persists its transcript as soon as it
 * holds a user message and appends every message after, so the prompt is on
 * disk the moment the turn starts and each assistant message is one step.
 */
import { existsSync } from "node:fs";
import {
  scanInterruptedTurn,
  type InterruptedTurnEvidence,
  type TurnLineKind,
} from "../interruptedTurnEvidence.ts";
import { canonicalPiSessionPath } from "../sessionStorage.ts";
import { piStore } from "./piStore.ts";

export function piInterruptedTurn(
  id: string,
  since: number,
): InterruptedTurnEvidence | undefined {
  const path = canonicalPiSessionPath(id);
  // No transcript at all: the prompt never reached pi, which writes one with
  // its first user message. A legacy transcript elsewhere is not read here.
  if (!existsSync(path))
    return piStore.hasTranscript(id)
      ? undefined
      : { promptKept: false, modelSteps: 0 };
  return scanInterruptedTurn(path, since, piTurnLine);
}

export function piTurnLine(line: Record<string, unknown>): TurnLineKind {
  if (line.type !== "message") return undefined;
  const role = (line.message as { role?: unknown } | undefined)?.role;
  if (role === "user") return { kind: "prompt" };
  if (role === "assistant") return { kind: "step" };
  return undefined;
}
