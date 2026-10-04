import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentType, Harness, SessionForkOrigin } from "@assistant/shared";
import { readSessionHeaderId } from "./sessionOpen.ts";

function piForkOrigin(
  kind: AgentType,
  origin: Omit<SessionForkOrigin, "harness" | "agentType">,
): SessionForkOrigin {
  return { ...origin, harness: "pi", agentType: kind };
}

export const FORK_ORIGIN_CUSTOM_TYPE = "web.fork_origin";

type ForkEntryLike = {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string };
};

export function readForkOrigin(
  kind: AgentType,
  sm: SessionManager,
): SessionForkOrigin | undefined {
  // Every entry, not the current BRANCH: where a session came from is a fact
  // about the session, and `/clear` resets the leaf, which would otherwise
  // leave the marker off-branch and silently un-fork the session in the UI.
  const entries = sm.getEntries() as ForkEntryLike[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry?.type !== "custom" ||
      entry.customType !== FORK_ORIGIN_CUSTOM_TYPE
    )
      continue;
    const data = entry.data;
    if (!data || typeof data !== "object") continue;
    const obj = data as Record<string, unknown>;
    const parentSessionFile =
      typeof obj.parentSessionFile === "string"
        ? obj.parentSessionFile
        : undefined;
    if (!parentSessionFile) continue;
    if (!isHarness(obj.harness) || !isForkOriginAgentType(obj.agentType))
      continue;
    return {
      harness: obj.harness,
      agentType: obj.agentType,
      parentSessionFile,
      ...(typeof obj.parentSessionId === "string"
        ? { parentSessionId: obj.parentSessionId }
        : {}),
      ...(typeof obj.parentEntryId === "string"
        ? { parentEntryId: obj.parentEntryId }
        : {}),
      ...(obj.position === "before" || obj.position === "at"
        ? { position: obj.position }
        : {}),
      ...(typeof obj.createdAt === "number"
        ? { createdAt: obj.createdAt }
        : {}),
    };
  }

  const parentSessionFile = sm.getHeader()?.parentSession;
  if (!parentSessionFile) return undefined;
  let parentSessionId: string | undefined;
  try {
    if (existsSync(parentSessionFile)) {
      parentSessionId = readSessionHeaderId(parentSessionFile);
    }
  } catch {
    // best-effort only; the file path is still useful for direct loading.
  }
  return piForkOrigin(kind, {
    parentSessionFile,
    ...(parentSessionId ? { parentSessionId } : {}),
  });
}

function isHarness(value: unknown): value is Harness {
  return value === "pi" || value === "claude-sdk";
}

/**
 * The personas a fork-origin entry may name. Narrower than the shared
 * `isAgentType`: it omits `workflow-coordinator`, so a coordinator's fork
 * origin is skipped. Widening it is a behavior change of its own.
 */
function isForkOriginAgentType(value: unknown): value is AgentType {
  return (
    value === "assistant" ||
    value === "workshop" ||
    value === "developer" ||
    value === "personal-assistant"
  );
}

/** True until the fork receives its first new user prompt after the origin marker. */
export function isForkAutoRenamePending(sm: SessionManager): boolean {
  const entries = sm.getBranch() as ForkEntryLike[];
  let originIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry?.type === "custom" &&
      entry.customType === FORK_ORIGIN_CUSTOM_TYPE
    ) {
      originIndex = i;
      break;
    }
  }
  if (originIndex < 0) return false;
  return !entries
    .slice(originIndex + 1)
    .some(
      (entry) => entry.type === "message" && entry.message?.role === "user",
    );
}
