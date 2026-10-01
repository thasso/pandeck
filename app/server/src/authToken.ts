import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

/**
 * Shared secret that gates the WS upgrade and the `/api/*` HTTP surface. Without
 * it, anyone able to reach the dev server's port (we bind `0.0.0.0` so the UI is
 * reachable from a phone on the LAN) could drive the Workshop agent — whose Bash
 * tool is arbitrary code execution. The token is the real access control; the
 * Origin allowlist in {@link ./index.ts} is only defense-in-depth against
 * drive-by CSRF from a malicious site loaded in the user's browser.
 *
 * Provisioning order:
 *  1. `ASSISTANT_TOKEN` env, if set — lets prod/CI pin a known value.
 *  2. Otherwise a persisted random token at `DATA_DIR/.assistant-token`
 *     (already git-ignored via `assistant-data/`).
 *
 * The token is injected into the SPA shell at serve time — never baked into the
 * built JS bundle — so a Nix/prod build carries no secret: the Node server
 * replaces the `"%ASSISTANT_TOKEN%"` placeholder in `index.html` (see
 * `index.ts`), and in dev the Vite plugin in `vite.config.ts` resolves this same
 * file. This module stays dependency-light (node builtins + config.ts only) so
 * `vite.config.ts` can import it without pulling in the rest of the server.
 */

const TOKEN_FILE = join(DATA_DIR, ".assistant-token");

let cached: string | undefined;

/** Safe startup status. The token value must never enter logs. */
export function authTokenStartupMessage(): string {
  return `[assistant] API/WS token authentication enabled (set ASSISTANT_TOKEN or use ${TOKEN_FILE})`;
}

export function resolveAuthToken(): string {
  if (cached) return cached;

  const fromEnv = process.env.ASSISTANT_TOKEN?.trim();
  if (fromEnv) {
    cached = fromEnv;
    return cached;
  }

  cached = readOrCreateTokenFile();
  return cached;
}

function readOrCreateTokenFile(): string {
  const existing = tryReadToken();
  if (existing) return existing;

  const token = randomBytes(24).toString("hex");
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    // Exclusive create so a concurrent writer (the server and the Vite config
    // both resolve this on startup) can't clobber a token the other already
    // wrote. On EEXIST we re-read and converge on the winner's value.
    writeFileSync(TOKEN_FILE, token, { flag: "wx", mode: 0o600 });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = tryReadToken();
      if (raced) return raced;
    }
    throw err;
  }
}

function tryReadToken(): string | undefined {
  try {
    const contents = readFileSync(TOKEN_FILE, "utf8").trim();
    return contents || undefined;
  } catch {
    return undefined;
  }
}
