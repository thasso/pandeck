const WEB_BUILD_STORAGE_KEY = "assistant.webBuildId";

interface BuildIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Remember the web build this browser most recently ran. A changed id means a
 * deployment happened while this document stayed open (or since its last use),
 * so the caller must reload before using the new server protocol.
 */
export function recordWebBuild(
  storage: BuildIdStorage,
  incoming: string,
): boolean {
  const previous = storage.getItem(WEB_BUILD_STORAGE_KEY);
  storage.setItem(WEB_BUILD_STORAGE_KEY, incoming);
  return previous !== null && previous !== incoming;
}
