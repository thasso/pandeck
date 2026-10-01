import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { UNLABELED_SESSION_TITLE } from "@assistant/shared";
import { deriveTitle } from "../sessions.ts";

type BranchEntryLike = {
  type?: string;
  message?: { role?: string };
};

const GENERIC_TITLES = new Set(["New chat", "New session"]);

/** True when the durable native branch already contains a human prompt. */
export function piSessionHasUserPrompt(
  sm: Pick<SessionManager, "getBranch">,
): boolean {
  let branch: BranchEntryLike[];
  try {
    branch = sm.getBranch() as BranchEntryLike[];
  } catch {
    return false;
  }
  return branch.some(
    (entry) => entry.type === "message" && entry.message?.role === "user",
  );
}

/** Restore the app-side live title from durable native/session-index state. */
export function restorePiLiveTitle(
  nativeSessionName: string | undefined,
  storedTitle: string | undefined,
): string | undefined {
  const title =
    meaningfulTitle(nativeSessionName) ?? meaningfulTitle(storedTitle);
  return title ? deriveTitle(title, "") : undefined;
}

/** Only unnamed sessions with no durable user prompt may derive their title from the next prompt. */
export function shouldAutoNamePiSession(input: {
  sessionManager: Pick<SessionManager, "getBranch">;
  nativeSessionName?: string;
  storedTitle?: string;
}): boolean {
  const restored = restorePiLiveTitle(
    input.nativeSessionName,
    input.storedTitle,
  );
  return (
    (!restored || restored === UNLABELED_SESSION_TITLE) &&
    !piSessionHasUserPrompt(input.sessionManager)
  );
}

function meaningfulTitle(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || GENERIC_TITLES.has(trimmed)) return undefined;
  return trimmed;
}
