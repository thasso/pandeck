/**
 * Where each engine keeps a session on disk (`docs/agent-harnesses.md`),
 * answered from paths alone: nothing here opens an engine store or loads an
 * engine SDK, so a list projection or a storage-backed view can ask it cheaply.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "@assistant/shared";
import { CLAUDE_SDK_STORE_DIR, piNativeFile } from "../sessionStorage.ts";
import type { ActiveNativeRef } from "./activeEngine.ts";

interface SessionStorage {
  /**
   * The `file` a session's ref and list item carry: pi's canonical transcript,
   * which its rename and removal go through; a Claude session's own id.
   */
  refFile(ref: ActiveNativeRef): string;
  /** The engine's own transcript for the session, when there is one on disk. */
  transcript(ref: ActiveNativeRef): string | undefined;
  /** Whether the engine has what reopening the session needs on disk. */
  stored(ref: ActiveNativeRef): boolean;
  /** Why the session cannot be reopened when it has not. */
  missing: string;
}

const storage: Record<Harness, SessionStorage> = {
  pi: {
    refFile: (ref) => piFile(ref),
    transcript: (ref) => {
      const file = piFile(ref);
      return existsSync(file) ? file : undefined;
    },
    stored: (ref) => existsSync(piFile(ref)),
    missing: "no pi transcript on disk",
  },
  // The record holds what a reopen needs; the native transcript lives with
  // the SDK and is never ours to name.
  "claude-sdk": {
    refFile: (ref) => ref.sessionId,
    transcript: () => undefined,
    // Plainly on disk: a record that cannot even be stat'ed is not reopenable.
    stored: (ref) =>
      existsSync(join(CLAUDE_SDK_STORE_DIR, `${ref.sessionId}.json`)),
    missing: "no Claude SDK state on disk",
  },
};

/** A pi binding's transcript: its native id's file (design 20). */
function piFile(ref: ActiveNativeRef): string {
  return piNativeFile(ref.sessionId, ref.nativeSessionId ?? ref.sessionId);
}

/** The `file` a session's ref and list item carry, for its active binding. */
export function sessionRefFile(ref: ActiveNativeRef): string {
  return storage[ref.harness].refFile(ref);
}

/** The active binding engine's own transcript, when one is on disk. */
export function engineTranscript(ref: ActiveNativeRef): string | undefined {
  return storage[ref.harness].transcript(ref);
}

/** Whether a session can be reopened from disk, and why not when it cannot. */
export function storedSessionState(
  ref: ActiveNativeRef,
): { stored: true } | { stored: false; reason: string } {
  const engine = storage[ref.harness];
  return engine.stored(ref)
    ? { stored: true }
    : { stored: false, reason: engine.missing };
}
