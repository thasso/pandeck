/**
 * `/rename`: rerun the session-naming agent over where a conversation has got
 * to. It reads the app-owned log only — the user's prompts and the agent's
 * visible replies, newest kept first, never tool calls, thinking or results —
 * so it neither opens a harness nor waits for a running turn.
 */
import { existsSync } from "node:fs";
import { sessionStore } from "./db/sessionStore.ts";
import { sourceRequiresEnterprise } from "./sessionEnterprise.ts";
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
  readSessionFirstWithin,
  readSessionTailWithin,
} from "./tools/sessions/sessionInspection.ts";

/** Log records read from the end of the session (visible text only). */
const RETITLE_RECORD_LIMIT = 40;
/** The furthest back from the log's end the recent turns are looked for. */
const RETITLE_TAIL_MAX_BYTES = 1024 * 1024;
/** The furthest into the log the opening prompt is looked for. */
const RETITLE_HEAD_MAX_BYTES = 256 * 1024;
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

function visibleText(text: string): string {
  return clipEntry(text.replace(/^\s*<memory>\s*[\s\S]*?<\/memory>\s*/i, ""));
}

/** What the naming agent reads of a session's conversation. */
export interface NamingTranscript {
  /** The prompt the session opened with, when the recent turns omit it. */
  opening?: string;
  /** The newest visible turns that fit the budget, oldest first. */
  recent: RetitleTranscriptEntry[];
}

/**
 * Bounded twice over: the tail read never scans past the log's last
 * {@link RETITLE_TAIL_MAX_BYTES}, so a tool-heavy log yields fewer turns rather
 * than a full parse on the server thread, and the opening prompt comes from a
 * forward scan that stops at the first visible record or after
 * {@link RETITLE_HEAD_MAX_BYTES} (finishing the line it is in). Model-only
 * `<memory>` context can lead a stored prompt; it is not what the user said.
 */
export function namingTranscript(sessionId: string): NamingTranscript {
  const logPath = canonicalSessionLogPath(sessionId);
  if (!existsSync(logPath)) return { recent: [] };
  const include = includeOptions({});
  const tail = readSessionTailWithin(
    logPath,
    RETITLE_TAIL_MAX_BYTES,
    RETITLE_RECORD_LIMIT,
    include,
  );
  const recent: RetitleTranscriptEntry[] = [];
  const kept = new Set<string>();
  let budget = RETITLE_TRANSCRIPT_MAX_CHARS;
  for (const record of [...tail].reverse()) {
    if (record.role === "tool") continue;
    const text = visibleText(record.text);
    if (!text) continue;
    if (text.length > budget) break;
    budget -= text.length;
    kept.add(record.entryId);
    recent.push({ role: record.role, text });
  }
  recent.reverse();
  const first = readSessionFirstWithin(
    logPath,
    RETITLE_HEAD_MAX_BYTES,
    include,
  );
  const opening =
    first?.role === "user" && !kept.has(first.entryId)
      ? visibleText(first.text)
      : undefined;
  return { ...(opening ? { opening } : {}), recent };
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
 * manual rename or a newer `/rename` overtook this run — which then reports
 * nothing, failures included. Otherwise a failure throws after the pending
 * state is cleared, leaving the old title in place.
 */
export async function retitleSession(input: {
  sessionId: string;
  guidance?: string;
  rename: (title: string) => Promise<void>;
  changed: () => Promise<void>;
}): Promise<string | undefined> {
  const { sessionId } = input;
  const requiresEnterprise = sourceRequiresEnterprise([sessionId]);
  const token = beginSessionRetitle(sessionId);
  await input.changed();
  try {
    let title: string;
    try {
      const transcript = namingTranscript(sessionId);
      if (!transcript.opening && !transcript.recent.length)
        throw new Error(
          "Nothing to name yet — this session has no conversation.",
        );
      const guidance = input.guidance
        ?.trim()
        .slice(0, RETITLE_GUIDANCE_MAX_CHARS);
      const currentTitle = sessionStore.get(sessionId)?.title;
      title = await regenerateSessionTitle(
        {
          sessionId,
          requiresEnterprise,
          ...(currentTitle ? { currentTitle } : {}),
          ...(transcript.opening ? { opening: transcript.opening } : {}),
          transcript: transcript.recent,
          ...(guidance ? { guidance } : {}),
          ...originTaskNaming(sessionId),
        },
        getSettings().sessionNaming,
      );
    } catch (err) {
      if (!ownsSessionRetitle(sessionId, token)) return undefined;
      throw err;
    }
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
