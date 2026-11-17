/**
 * The stable opaque key of a peer-prompt row: a sent card's `messageKey`, a
 * request's reply key, and what a withdraw names. Never the raw id, which
 * stays server-side. Its own module so readers that only need the key (the
 * session list) do not import the peer-prompt engine.
 */
export function peerPromptKey(id: string): string {
  let hash = 5381;
  for (let i = 0; i < id.length; i++)
    hash = ((hash << 5) + hash + id.charCodeAt(i)) >>> 0;
  return `k${hash.toString(36)}`;
}
