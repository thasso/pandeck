/**
 * How a library reaches browsers: one topic per library, named like it
 * (`skills`, `agents`), and one list shape (`libraryList`).
 *
 * The library domains stay independent of the session hub; the hub installs
 * the topic broadcaster during construction, exactly as the Knowledge Base
 * domain does. This is the ONE seam by which library state reaches browsers:
 * it addresses the library's topic, never every connection, so a window that
 * is not showing a library pays nothing for it.
 */
import type {
  EntryLibraryList,
  LibraryTopic,
  ServerMessage,
} from "@assistant/shared";
import { errorText } from "../errors.ts";
import { scanLibrary, type LibraryScan } from "./libraryScanner.ts";
import type { LibraryStore } from "./libraryStore.ts";

interface LibraryBroadcaster {
  /** Deliver to the connections currently showing the library's topic. */
  broadcast(message: ServerMessage, topic: LibraryTopic): void;
}

let broadcaster: LibraryBroadcaster = {
  broadcast: () => {
    // Unit tests and one-shot callers may run without a live hub.
  },
};

/** Installed once by the hub: deliver to one library topic's subscribers. */
export function setLibraryBroadcaster(next: LibraryBroadcaster): void {
  broadcaster = next;
}

export function libraryBroadcaster(): LibraryBroadcaster {
  return broadcaster;
}

/** What a library adds to its list beyond the scan (the agents' runtimes). */
type ListExtension = (
  library: LibraryStore,
  scan: LibraryScan,
) => Promise<Partial<EntryLibraryList>>;

/**
 * Build a topic's one list message. A failed scan answers with `error` rather
 * than an empty library: a browser must not draw "nothing here yet" over a
 * read that never happened. Per-folder failures are not this error — they are
 * diagnostics inside the list.
 */
export async function libraryListMessage(
  topic: LibraryTopic,
  library: LibraryStore,
  extend?: ListExtension,
): Promise<ServerMessage> {
  try {
    await library.ensureInitialized();
    const scan = await scanLibrary(library.kind, library.root);
    return {
      type: "libraryList",
      library: topic,
      list: {
        libraryPath: library.root,
        entries: scan.entries,
        diagnostics: scan.diagnostics,
        ...(extend ? await extend(library, scan) : {}),
      },
    };
  } catch (error) {
    return {
      type: "libraryList",
      library: topic,
      error: `Failed to read the ${library.kind.plural} library: ${errorText(error)}`,
    };
  }
}

// A publish covers both the scan and its broadcast. Keeping each topic's whole
// operation in one chain means a later authoritative read cannot finish first
// and then be overwritten by an older in-flight scan.
const publishQueues = new Map<LibraryTopic, Promise<void>>();

/** Scan now and push the result to every subscriber of the library's topic. */
export function publishLibrary(
  topic: LibraryTopic,
  library: LibraryStore,
  extend?: ListExtension,
): Promise<void> {
  const publish = (publishQueues.get(topic) ?? Promise.resolve()).then(
    async () => {
      broadcaster.broadcast(
        await libraryListMessage(topic, library, extend),
        topic,
      );
    },
  );
  publishQueues.set(
    topic,
    publish.catch(() => undefined),
  );
  return publish;
}
