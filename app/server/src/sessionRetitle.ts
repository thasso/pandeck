/**
 * `/rename`: rerun the session-naming agent over where a conversation has got
 * to. It reads the app-owned log only — the user's prompts and the agent's
 * visible replies, newest kept first, never tool calls, thinking or results —
 * so it neither opens a harness nor waits for a running turn.
 */
import { existsSync } from "node:fs";
import { sessionStore } from "./db/sessionStore.ts";
import { getSettings } from "./settings.ts";
import { canonicalSessionLogPath } from "./sessionStorage.ts";
import {
  regenerateSessionTitle,
  type RetitleTranscriptEntry,
} from "./sessionNaming.ts";
import {
  beginSessionRetitle,
  endSessionRetitle,
  ownsSessionRetitle,
} from "./sessionRetitlePending.ts";
import { taskNamingReference } from "./taskNaming.ts";
import { findOriginTask, readTask } from "./tasks.ts";
import {
  includeOptions,
  readSessionWindow,
} from "./tools/sessions/sessionInspection.ts";

/** Log records read from the end of the session (visible text only). */
const RETITLE_RECORD_LIMIT = 40;
/** Ceiling on one prompt or reply; its opening states what it is about. */
const RETITLE_ENTRY_MAX_CHARS = 1_200;
/** Ceiling on the whole conversation handed to the naming agent. */
const RETITLE_TRANSCRIPT_MAX_CHARS = 12_000;
/** Ceiling on the user's guidance. */
const RETITLE_GUIDANCE_MAX_CHARS = 1_000;

function clipEntry(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > RETITLE_ENTRY_MAX_CHARS
    ? `${trimmed.slice(0, RETITLE_ENTRY_MAX_CHARS - 1).trimEnd()}…`
    : trimmed;
}

/**
 * The newest visible turns that fit the budget, oldest first. Model-only
 * `<memory>` context can lead a stored prompt; it is not what the user said.
 */
export function recentTranscript(sessionId: string): RetitleTranscriptEntry[] {
  const logPath = canonicalSessionLogPath(sessionId);
  if (!existsSync(logPath)) return [];
  const { records } = readSessionWindow(
    logPath,
    "latest",
    RETITLE_RECORD_LIMIT,
    includeOptions({}),
  );
  const out: RetitleTranscriptEntry[] = [];
  let budget = RETITLE_TRANSCRIPT_MAX_CHARS;
  for (const record of [...records].reverse()) {
    if (record.role === "tool") continue;
    const text = clipEntry(
      record.text.replace(/^\s*<memory>\s*[\s\S]*?<\/memory>\s*/i, ""),
    );
    if (!text) continue;
    if (text.length > budget) break;
    budget -= text.length;
    out.push({ role: record.role, text });
  }
  return out.reverse();
}

/** The session's origin Task, as naming context and the exact title prefix. */
function originTaskNaming(sessionId: string) {
  const origin = findOriginTask(sessionId);
  if (!origin) return {};
  const task = readTask(origin.id);
  const reference = taskNamingReference({
    id: origin.id,
    ...(task?.ticket ? { ticket: task.ticket } : {}),
  });
  return {
    reference,
    context: `${reference.display} (${origin.status}): ${origin.title}`,
  };
}

/**
 * Generate and apply a new title. `rename` persists it through the engine that
 * holds the session; `changed` re-broadcasts the list whenever the pending
 * state or the title moved. Resolves to the applied title, or undefined when a
 * manual rename or a newer `/rename` overtook this run. Failures throw after
 * the pending state is cleared, leaving the old title in place.
 */
export async function retitleSession(input: {
  sessionId: string;
  guidance?: string;
  rename: (title: string) => Promise<void>;
  changed: () => Promise<void>;
}): Promise<string | undefined> {
  const { sessionId } = input;
  const token = beginSessionRetitle(sessionId);
  await input.changed();
  try {
    const guidance = input.guidance
      ?.trim()
      .slice(0, RETITLE_GUIDANCE_MAX_CHARS);
    const currentTitle = sessionStore.get(sessionId)?.title;
    const title = await regenerateSessionTitle(
      {
        sessionId,
        ...(currentTitle ? { currentTitle } : {}),
        transcript: recentTranscript(sessionId),
        ...(guidance ? { guidance } : {}),
        ...originTaskNaming(sessionId),
      },
      getSettings().sessionNaming,
    );
    if (!ownsSessionRetitle(sessionId, token)) return undefined;
    // Spent before renaming, so no broadcast shows the new title as pending.
    endSessionRetitle(sessionId, token);
    await input.rename(title);
    return title;
  } finally {
    endSessionRetitle(sessionId, token);
    await input.changed();
  }
}
