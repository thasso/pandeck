import type {
  KnowledgeEntryResponse,
  KnowledgeInspectResponse,
  KnowledgeTreeResponse,
} from "@assistant/shared/knowledgeBase";
import { authHeaders, serverHttpOrigin, withToken } from "./serverOrigin.ts";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${serverHttpOrigin()}${path}`, {
    headers: { ...authHeaders() },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      typeof json?.error === "string"
        ? json.error
        : `Request failed (${res.status})`,
    );
  return json as T;
}

/** Fetch the compact Knowledge tree for the app-shell sidebar browser. */
export function fetchKnowledgeTree(): Promise<KnowledgeTreeResponse> {
  return getJson<KnowledgeTreeResponse>("/api/knowledge/tree");
}

/** Fetch one readable KB entry document (or invalid-entry state) by stable id. */
export function fetchKnowledgeEntry(
  entryId: string,
): Promise<KnowledgeEntryResponse> {
  return getJson<KnowledgeEntryResponse>(
    `/api/knowledge/entry?id=${encodeURIComponent(entryId)}`,
  );
}

/**
 * Fetch one entry document (or invalid-entry state) by folder path. Invalid
 * entries have no `kb.id`, so they are addressable only this way.
 */
export function fetchKnowledgeEntryByPath(
  folder: string,
): Promise<KnowledgeEntryResponse> {
  return getJson<KnowledgeEntryResponse>(
    `/api/knowledge/entry?path=${encodeURIComponent(folder)}`,
  );
}

/** Fetch compact right-inspector data for a KB entry without body Markdown. */
export function fetchKnowledgeInspector(
  target: { id: string } | { path: string },
  opts: { diffCommit?: string; diffMaxChars?: number } = {},
): Promise<KnowledgeInspectResponse> {
  const params = new URLSearchParams();
  if ("id" in target) params.set("id", target.id);
  else params.set("path", target.path);
  if (opts.diffCommit) params.set("diffCommit", opts.diffCommit);
  if (opts.diffMaxChars) params.set("diffMaxChars", String(opts.diffMaxChars));
  return getJson<KnowledgeInspectResponse>(
    `/api/knowledge/inspect?${params.toString()}`,
  );
}

/**
 * Absolute, token-carrying URL for an entry-local KB asset, suitable for
 * header-less contexts such as `<img src>` and download anchors.
 */
export function knowledgeAssetUrl(entryId: string, assetPath: string): string {
  const query = `id=${encodeURIComponent(entryId)}&path=${encodeURIComponent(assetPath)}`;
  return withToken(`${serverHttpOrigin()}/api/knowledge/asset?${query}`);
}

/**
 * Absolute, token-carrying URL for any KB source file (entry asset or loose
 * file) addressed by its full, repo-relative tree path. Suitable for
 * header-less contexts such as `<img src>`, `<iframe src>`, and downloads.
 */
export function knowledgeFileUrl(path: string): string {
  return withToken(
    `${serverHttpOrigin()}/api/knowledge/file?path=${encodeURIComponent(path)}`,
  );
}

/** Fetch a KB source file as UTF-8 text (JSON/YAML/CSV/etc.) with auth headers. */
export async function fetchKnowledgeFileText(path: string): Promise<string> {
  const res = await fetch(
    `${serverHttpOrigin()}/api/knowledge/file?path=${encodeURIComponent(path)}`,
    { headers: { ...authHeaders() } },
  );
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(
      typeof (json as { error?: unknown })?.error === "string"
        ? (json as { error: string }).error
        : `Request failed (${res.status})`,
    );
  }
  return res.text();
}
