/**
 * The server as the private child of the desktop shell's local mode
 * (`docs/desktop-local-mode.md`).
 *
 * The shell starts the packaged server with `ASSISTANT_DESKTOP_SHELL=1`, a
 * loopback host and a pipe on stdin, and changes nothing else about it: the
 * token, origin checks, boot lock and graceful shutdown are the ones every
 * server has. Two things differ, and only because a loopback server on a laptop
 * has no reverse proxy in front of it:
 *
 * - A page on any other site can rebind its own host name to 127.0.0.1 and then
 *   reach this server as same-origin, which `isOriginAllowed` accepts and which
 *   would hand it the token injected into `index.html`. So every request must
 *   NAME a loopback host.
 * - Nothing else stops this server if the shell dies. The shell holds the write
 *   end of stdin; end-of-file means it is gone, so the server stops itself the
 *   same way systemd would.
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

/** Run `stop` once when the shell closes its end of our stdin. */
export function stopWhenShellExits(
  stdin: NodeJS.ReadableStream,
  stop: () => void,
): void {
  let stopped = false;
  const once = () => {
    if (stopped) return;
    stopped = true;
    stop();
  };
  stdin.on("end", once);
  stdin.on("close", once);
  stdin.on("error", once);
  // Drain anything written so the pipe can reach end-of-file.
  stdin.resume();
}
