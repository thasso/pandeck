/**
 * The read side of the skills library as the browser sees it.
 *
 * Subscribing to the `skills` topic IS the authoritative read: this module
 * bootstraps storage if needed, scans the working tree fresh, and publishes the
 * result through the single topic seam. Nothing here caches — the library is
 * hand-authored, and a cached index would let Settings show a skill that no
 * longer matches the file a session is about to inject.
 *
 * Every subscriber receives the same publish, so a second window that opens the
 * library also refreshes the first one instead of the two drifting apart.
 */
import type { ServerMessage, SkillLibraryList } from "@assistant/shared";
import { errorText } from "../errors.ts";
import { skillLibraryBroadcaster } from "./skillLibraryEvents.ts";
import { scanSkillLibrary } from "./skillLibraryScanner.ts";
import {
  skillLibraryStore as store,
  type SkillLibraryStore,
} from "./skillLibraryStore.ts";

// A subscription publish covers both the scan and its broadcast. Keeping the
// whole operation in one chain means a later authoritative read cannot finish
// first and then be overwritten by an older in-flight scan.
let publishQueue: Promise<void> = Promise.resolve();

/** One fresh working-tree read of the whole library. */
async function readSkillLibrary(
  library: SkillLibraryStore,
): Promise<SkillLibraryList> {
  await library.ensureInitialized();
  const scan = await scanSkillLibrary(library.root);
  return {
    libraryPath: library.root,
    skills: scan.skills,
    diagnostics: scan.diagnostics,
  };
}

/**
 * Build the topic's one list message. A failed scan answers with `error` rather
 * than an empty library: a browser must not draw "no skills yet" over a read
 * that never happened. Per-folder failures are not this error — they are
 * diagnostics inside the list.
 */
export async function skillLibraryListMessage(
  library: SkillLibraryStore = store,
): Promise<ServerMessage> {
  try {
    return { type: "skillList", list: await readSkillLibrary(library) };
  } catch (error) {
    return {
      type: "skillList",
      error: `Failed to read the skills library: ${errorText(error)}`,
    };
  }
}

/** Scan now and push the result to every `skills` subscriber. */
export function publishSkillLibrary(
  library: SkillLibraryStore = store,
): Promise<void> {
  const publish = publishQueue.then(async () => {
    skillLibraryBroadcaster().broadcast(await skillLibraryListMessage(library));
  });
  publishQueue = publish.catch(() => undefined);
  return publish;
}
