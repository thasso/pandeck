/**
 * The server as the private child of the desktop shell's local mode
 * (`docs/desktop-local-mode.md`).
 *
 * The shell starts the packaged server with `ASSISTANT_DESKTOP_SHELL=1` and a
 * loopback host, and changes nothing else about it: the token, origin checks,
 * boot lock and graceful shutdown are the ones every server has. Two things
 * differ, and only because a loopback server on a laptop has no reverse proxy
 * or service manager around it:
 *
 * - A page on any other site can rebind its own host name to 127.0.0.1 and then
 *   reach this server as same-origin, which `isOriginAllowed` accepts and which
 *   would hand it the token injected into `index.html`. So every request must
 *   NAME a loopback host.
 * - Nothing else stops this server if the shell dies. A normal quit sends
 *   SIGTERM; a crashed shell sends nothing, so the server watches for its
 *   parent to disappear. Checking the parent's pid works the same on macOS and
 *   Linux, where an end-of-file on an inherited stdin pipe does not under Bun.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Read once at startup, before `scrubInstanceEnvironment` deletes it. */
export const DESKTOP_SHELL = process.env.ASSISTANT_DESKTOP_SHELL === "1";

/** Whether a request's Host header names this machine's loopback. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/** Whether `pid` still exists. EPERM means it does, under another user. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Run `stop` once, soon after process `parentPid` is gone. */
export function stopWhenParentExits(
  parentPid: number,
  stop: () => void,
  opts: { intervalMs?: number; exists?: (pid: number) => boolean } = {},
): void {
  const exists = opts.exists ?? processExists;
  const timer = setInterval(() => {
    if (exists(parentPid)) return;
    clearInterval(timer);
    stop();
  }, opts.intervalMs ?? 1000);
  timer.unref();
}
