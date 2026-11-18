/**
 * Header fields the relay passes on, as raw `[name, value, …]` lists so
 * repeats and order survive. Imports nothing.
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * The header fields as received, in order and with every repeat, without
 * the hop-by-hop ones: the edge reads repeats (a second `Host`, a repeated
 * session key), and a harness reads a provider's answer unchanged.
 */
export function forwardable(rawHeaders: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (!HOP_BY_HOP.has(rawHeaders[i]!.toLowerCase()))
      out.push(rawHeaders[i]!, rawHeaders[i + 1]!);
  return out;
}

/** `headers` without every field whose lower-cased name is in `drop`. */
function without(
  headers: readonly string[],
  drop: (lowerName: string) => boolean,
): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < headers.length; i += 2)
    if (!drop(headers[i]!.toLowerCase()))
      out.push(headers[i]!, headers[i + 1]!);
  return out;
}

/**
 * The fields a decrypted token-host request carries to the edge: as received
 * (repeats, order, `authorization`, `Origin`), without hop-by-hop fields,
 * without every caller `x-pandeck-*` field in any case, and with every caller
 * `Host` replaced by one loopback `Host`, so the edge sees a loopback caller
 * exactly as it does through the plain listener.
 */
export function interceptedHeaders(
  rawHeaders: readonly string[],
  loopbackHost: string,
): string[] {
  return [
    ...without(
      forwardable(rawHeaders),
      (name) => name === "host" || name.startsWith("x-pandeck-"),
    ),
    "host",
    loopbackHost,
  ];
}
