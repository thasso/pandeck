/**
 * Whether two configured URLs address the same origin (scheme, host and port),
 * the boundary a stored credential is bound to. An integration whose URL moves
 * to another origin must not keep sending the old credential: otherwise anyone
 * who can change the URL, the Personal Assistant included, could send a secret
 * they cannot read to a host they choose. A URL without an origin of its own
 * (`file:`, `data:`) matches nothing; one that does not parse matches only
 * itself.
 */
export function sameOrigin(a: string, b: string): boolean {
  const origin = (url: string) => {
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  };
  const left = origin(a);
  if (left === undefined) return a === b;
  return left !== "null" && left === origin(b);
}
