/**
 * The per-entry reads of a user-owned library ([Task-614](pa://task/614),
 * `docs/skills.md`, `docs/agent-definitions.md`): one entry's manifest, its
 * supporting files and its history, under `/api/<library>/`.
 *
 * The library LIST arrives on the library's topic through `useAssistant`; only
 * the body is fetched, and only for the row the user opened. An entry is
 * addressed by its declared name, so nothing here ever sends a path except the
 * entry-relative file path, which the server confines to the entry.
 *
 * Each library's fetchers are created once, so `useFetchState` sees the same
 * function for the same library on every render.
 */
import type {
  EntryDetailResponse,
  EntryFilePreviewResponse,
  EntryHistory,
  LibraryTopic,
} from "@assistant/shared";
import { authHeaders, serverHttpOrigin, withToken } from "./serverOrigin.ts";

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    headers: { ...authHeaders() },
    ...(signal ? { signal } : {}),
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (json as { error?: unknown }).error;
    throw new Error(
      typeof error === "string" ? error : `Request failed (${res.status})`,
    );
  }
  return json as T;
}

/** The reads of one library, keyed the way `useFetchState` keys them. */
export interface LibraryApi {
  /** The manifest and bounded file tree of the entry named `name`. */
  detail(name: string, signal?: AbortSignal): Promise<EntryDetailResponse>;
  /** A bounded preview; `key` is `<name>\0<entry-relative path>`. */
  filePreview(
    key: string,
    signal?: AbortSignal,
  ): Promise<EntryFilePreviewResponse>;
  /** The entry folder's recent commits, newest first. */
  history(name: string, signal?: AbortSignal): Promise<EntryHistory>;
  /** Token-carrying raw/download URL for one entry-relative regular file. */
  fileUrl(name: string, path: string): string;
}

const apis = new Map<LibraryTopic, LibraryApi>();

/** The reads of `library`; the same object for the same library, always. */
export function libraryApi(library: LibraryTopic): LibraryApi {
  const cached = apis.get(library);
  if (cached) return cached;
  const base = () => `${serverHttpOrigin()}/api/${library}`;
  const named = (name: string) => `name=${encodeURIComponent(name)}`;
  const api: LibraryApi = {
    detail: (name, signal) =>
      getJson(`${base()}/detail?${named(name)}`, signal),
    filePreview: (key, signal) => {
      const separator = key.indexOf("\0");
      if (separator <= 0) throw new Error("Invalid file preview key.");
      const name = key.slice(0, separator);
      const path = key.slice(separator + 1);
      return getJson(
        `${base()}/file?${named(name)}&path=${encodeURIComponent(path)}&preview=text`,
        signal,
      );
    },
    history: (name, signal) =>
      getJson(`${base()}/history?${named(name)}`, signal),
    fileUrl: (name, path) =>
      withToken(
        `${base()}/file?${named(name)}&path=${encodeURIComponent(path)}`,
      ),
  };
  apis.set(library, api);
  return api;
}
