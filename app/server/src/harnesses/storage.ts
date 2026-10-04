/**
 * Where each engine keeps a session on disk (`docs/agent-harnesses.md`),
 * answered from paths alone: nothing here opens an engine store or loads an
 * engine SDK, so a list projection or a storage-backed view can ask it cheaply.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "@assistant/shared";
import {
  canonicalPiSessionPath,
  CLAUDE_SDK_STORE_DIR,
} from "../sessionStorage.ts";

interface SessionStorage {
  /**
   * The `file` a session's ref and list item carry: pi's canonical transcript,
   * which its rename and removal go through; a Claude session's own id.
   */
  refFile(id: string): string;
  /** The engine's own transcript for the session, when there is one on disk. */
  transcript(id: string): string | undefined;
  /** Whether the engine has what reopening the session needs on disk. */
  stored(id: string): boolean;
  /** Why the session cannot be reopened when it has not. */
  missing: string;
}

const storage: Record<Harness, SessionStorage> = {
  pi: {
    refFile: (id) => canonicalPiSessionPath(id),
    transcript: (id) => {
      const file = canonicalPiSessionPath(id);
      return existsSync(file) ? file : undefined;
    },
    stored: (id) => existsSync(canonicalPiSessionPath(id)),
    missing: "no pi transcript on disk",
  },
  // The record holds what a reopen needs; the native transcript lives with
  // the SDK and is never ours to name.
  "claude-sdk": {
    refFile: (id) => id,
    transcript: () => undefined,
    // Plainly on disk: a record that cannot even be stat'ed is not reopenable.
    stored: (id) => existsSync(join(CLAUDE_SDK_STORE_DIR, `${id}.json`)),
    missing: "no Claude SDK state on disk",
  },
};

/** The `file` a session's ref and list item carry. */
export function sessionRefFile(harness: Harness, id: string): string {
  return storage[harness].refFile(id);
}

/** The engine's own transcript of a session, when one is on disk. */
export function engineTranscript(
  harness: Harness,
  id: string,
): string | undefined {
  return storage[harness].transcript(id);
}

/** Whether a session can be reopened from disk, and why not when it cannot. */
export function storedSessionState(
  harness: Harness,
  id: string,
): { stored: true } | { stored: false; reason: string } {
  const engine = storage[harness];
  return engine.stored(id)
    ? { stored: true }
    : { stored: false, reason: engine.missing };
}
