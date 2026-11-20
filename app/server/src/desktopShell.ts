/**
 * The server as the private child of the desktop shell's local mode
 * (`docs/desktop-local-mode.md`).
 *
 * The shell starts the packaged server with `ASSISTANT_DESKTOP_SHELL` set to
 * its own pid and a loopback host, and changes nothing else about it: the token, origin checks,
 * boot lock and graceful shutdown are the ones every server has. Two things
 * differ, and only because a loopback server on a laptop has no reverse proxy
 * or service manager around it:
 *
 * - A page on any other site can rebind its own host name to 127.0.0.1 and then
 *   reach this server as same-origin, which `isOriginAllowed` accepts and which
 *   would hand it the token injected into `index.html`. So every request must
 *   NAME a loopback host.
 * - Nothing else stops this server if the shell dies. A normal quit sends
 *   SIGTERM; a crashed shell sends nothing, so the server watches the shell's
 *   pid. The shell passes it rather than the server reading `process.ppid`:
 *   a shell that dies before the watch starts has already reparented this
 *   process, and the watch would wait on init forever. Checking a pid works
 *   the same on macOS and Linux, where end-of-file on an inherited stdin pipe
 *   does not under Bun.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The shell's pid, or undefined when this server is not the shell's child. */
export function parseDesktopShellPid(
  value: string | undefined,
): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const pid = Number(value);
  // 0 and 1 are never a shell: kill(0) signals our group, 1 is init.
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

/** Read once at startup, before `scrubInstanceEnvironment` deletes it. */
export const DESKTOP_SHELL_PID = parseDesktopShellPid(
  process.env.ASSISTANT_DESKTOP_SHELL,
);
export const DESKTOP_SHELL = DESKTOP_SHELL_PID !== undefined;

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

/** Run `stop` once, soon after process `shellPid` is gone. */
export function stopWhenShellExits(
  shellPid: number,
  stop: () => void,
  opts: { intervalMs?: number; exists?: (pid: number) => boolean } = {},
): void {
  const exists = opts.exists ?? processExists;
  const timer = setInterval(() => {
    if (exists(shellPid)) return;
    clearInterval(timer);
    stop();
  }, opts.intervalMs ?? 1000);
  timer.unref();
}
