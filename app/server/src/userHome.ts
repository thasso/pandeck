import { homedir } from "node:os";

/**
 * The user's home directory, read from `HOME` on every call. Node's
 * `os.homedir()` does that already; Bun's resolves once at startup and ignores
 * a later `HOME` change, so a test that redirects `HOME` would still read and
 * write the real `~/.claude`. Server code resolves home only through here
 * (`architecture.test.ts`).
 */
export function userHomeDir(): string {
  return process.env.HOME || homedir();
}
