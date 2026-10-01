/**
 * Broadcaster seam for the skills library. The skills domain stays independent
 * of the session hub; the hub installs the connected-client broadcaster during
 * construction, exactly as the Knowledge Base domain does.
 *
 * This is the ONE seam by which skills state reaches browsers: it addresses the
 * `skills` topic, never every connection, so a window that is not showing the
 * library pays nothing.
 */
import type { ServerMessage } from "@assistant/shared";

export interface SkillLibraryBroadcaster {
  /** Deliver to the connections currently showing the library (topic `skills`). */
  broadcast(message: ServerMessage): void;
}

let broadcaster: SkillLibraryBroadcaster = {
  broadcast: () => {
    // Unit tests and one-shot callers may run without a live hub.
  },
};

export function setSkillLibraryBroadcaster(
  next: SkillLibraryBroadcaster,
): void {
  broadcaster = next;
}

export function skillLibraryBroadcaster(): SkillLibraryBroadcaster {
  return broadcaster;
}
