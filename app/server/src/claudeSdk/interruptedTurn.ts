/**
 * The Claude SDK's answer to "what does the agent's history hold of the cut
 * turn?" (`interruptedTurnEvidence.ts`). The session resumes from the CLI
 * transcript its record's provider session id names; the CLI writes the user
 * line when the prompt is submitted and each assistant message in parts that
 * share one message id.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  claudeConfigDir,
  DEFAULT_CLAUDE_PROFILE_ID,
} from "../credentialProfiles.ts";
import {
  scanInterruptedTurn,
  type InterruptedTurnEvidence,
  type TurnLineKind,
} from "../interruptedTurnEvidence.ts";
import { CLAUDE_SDK_STORE_DIR } from "../sessionStorage.ts";
import { readClaudeSdkRecordMeta } from "./claudeSdkRecords.ts";

export function claudeInterruptedTurn(
  id: string,
  since: number,
  boundProfileId: string | undefined,
): InterruptedTurnEvidence | undefined {
  let meta;
  try {
    meta = readClaudeSdkRecordMeta(CLAUDE_SDK_STORE_DIR, id)?.meta;
  } catch {
    return undefined;
  }
  // The record is persisted with its resume id when a turn completes, so a
  // first turn cut short leaves none: the session would resume with no history.
  if (!meta?.providerSessionId) return { promptKept: false, modelSteps: 0 };
  const path = transcriptPath(
    claudeConfigDir(
      boundProfileId ?? meta.credentialProfileId ?? DEFAULT_CLAUDE_PROFILE_ID,
    ),
    meta.providerSessionId,
  );
  return path ? scanInterruptedTurn(path, since, claudeTurnLine) : undefined;
}

function transcriptPath(
  configDir: string,
  providerSessionId: string,
): string | undefined {
  const projects = join(configDir, "projects");
  if (!existsSync(projects)) return undefined;
  for (const dir of readdirSync(projects)) {
    const path = join(projects, dir, `${providerSessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

export function claudeTurnLine(line: Record<string, unknown>): TurnLineKind {
  if (line.isSidechain === true) return undefined;
  const message = line.message as
    { id?: unknown; content?: unknown } | undefined;
  if (line.type === "assistant")
    return {
      kind: "step",
      ...(typeof message?.id === "string" ? { id: message.id } : {}),
    };
  if (line.type !== "user" || line.isMeta === true) return undefined;
  const content = message?.content;
  // A user line made only of tool results is the agent's own step, not a prompt.
  const prompt =
    typeof content === "string" ||
    (Array.isArray(content) &&
      content.some(
        (block) => (block as { type?: unknown })?.type !== "tool_result",
      ));
  return prompt ? { kind: "prompt" } : undefined;
}
