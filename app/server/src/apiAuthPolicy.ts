/**
 * WHICH requests to `/api/*` may skip the token and Origin checks.
 *
 * This is a decision, separated from the checking in `index.ts` so it can be
 * asserted directly. Every entry is a hole in the app's only access control, so
 * each one states what carries the credential instead:
 *
 * - `/api/health` answers nothing about the user.
 * - the OAuth start/callback pair are top-level browser navigations, protected
 *   by the OAuth `state` parameter.
 * - `/api/file-grants/<id>/…` carries an opaque, directory-scoped grant id in
 *   the PATH, which is the credential (`docs/served-files.md`). It is also
 *   loaded from an opaque origin (the sandbox CSP), so it sends `Origin: null`
 *   and holds no token to send — neither check could apply to it.
 *
 * Adding a fourth entry means arguing for it in the same terms. Note what is
 * NOT here: `/api/files/…` (raw bytes of any host file) and the `/api/file-grants`
 * MINT are both fully gated, and the exemption above is a strict path PREFIX
 * with a trailing slash, so it cannot swallow the mint route beside it.
 */

import { FILE_GRANT_PREFIX } from "./directFileGrants.ts";

const EXEMPT_PATHS = new Set([
  "/api/health",
  "/api/google/oauth/start",
  "/api/google/oauth/callback",
  "/api/slack/oauth/start",
  "/api/slack/oauth/callback",
  "/api/tempo/oauth/start",
  "/api/tempo/oauth/callback",
]);

/** True when this pathname carries its own credential (or needs none). */
export function apiPathSkipsAuth(pathname: string): boolean {
  return EXEMPT_PATHS.has(pathname) || pathname.startsWith(FILE_GRANT_PREFIX);
}
