import { closeSync, fstatSync, writeSync } from "node:fs";

/**
 * The contract between this server and a desktop shell that launches it as a
 * private, loopback-only child (`app/shell/src/local_server.rs`). Absent unless
 * the shell sets all of it; a systemd, Nix or developer launch never does.
 *
 * - `ASSISTANT_SUPERVISOR_READY_FD` names an inherited pipe. After `listen`
 *   succeeds the server writes ONE JSON line there with the nonce, its pid and
 *   the port it actually bound, then closes it. The shell trusts only that
 *   line: a listener merely answering `/api/health` on some port may belong to
 *   anything else on the machine.
 * - `ASSISTANT_SUPERVISOR_NONCE` is a per-launch random value the line must
 *   echo. It is never logged and is scrubbed with the instance variables
 *   before anything spawns, so a descendant cannot forge readiness.
 * - `ASSISTANT_SUPERVISOR_LIFELINE=stdin`: the shell holds the only write end
 *   of this process's stdin. EOF means the shell is gone (quit, crash or
 *   SIGKILL) and the server drains as if it had been sent SIGTERM.
 *
 * Supervision also changes two listener rules. The requested port becomes a
 * PREFERENCE: if it is taken, the server binds an OS-chosen port instead of
 * failing, and reports that one. And every request must name a loopback host
 * on the bound port, which keeps a DNS-rebinding page from reading the token
 * the served HTML carries.
 */
export interface SupervisedLaunch {
  readyFd: number;
  nonce: string;
  lifeline: boolean;
}

export const SUPERVISOR_ENV_VARS = [
  "ASSISTANT_SUPERVISOR_READY_FD",
  "ASSISTANT_SUPERVISOR_NONCE",
  "ASSISTANT_SUPERVISOR_LIFELINE",
] as const;

const NONCE_PATTERN = /^[0-9a-f]{32,128}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Read and validate the supervision variables. Any partial or malformed set is
 * a launch error rather than a silent unsupervised boot: the shell would wait
 * out its deadline for a readiness line that can never come.
 */
export function readSupervisedLaunch(
  env: NodeJS.ProcessEnv,
  host: string,
): SupervisedLaunch | undefined {
  const fdText = env.ASSISTANT_SUPERVISOR_READY_FD;
  const nonce = env.ASSISTANT_SUPERVISOR_NONCE;
  const lifeline = env.ASSISTANT_SUPERVISOR_LIFELINE;
  if (fdText === undefined && nonce === undefined && lifeline === undefined)
    return undefined;
  if (!fdText || !/^\d+$/.test(fdText) || Number(fdText) < 3)
    throw new Error(
      "ASSISTANT_SUPERVISOR_READY_FD must name an inherited descriptor >= 3.",
    );
  if (!nonce || !NONCE_PATTERN.test(nonce))
    throw new Error("ASSISTANT_SUPERVISOR_NONCE must be 32-128 hex digits.");
  if (lifeline !== undefined && lifeline !== "stdin")
    throw new Error("ASSISTANT_SUPERVISOR_LIFELINE must be 'stdin' if set.");
  if (host !== "127.0.0.1" && host !== "::1")
    throw new Error("A supervised server must bind a loopback address.");
  const readyFd = Number(fdText);
  try {
    fstatSync(readyFd);
  } catch {
    throw new Error(
      `ASSISTANT_SUPERVISOR_READY_FD ${readyFd} is not an open descriptor.`,
    );
  }
  return { readyFd, nonce, lifeline: lifeline === "stdin" };
}

/**
 * Whether a request's `Host` names this loopback listener. Exact port, so a
 * page served from another local port (or a rebinding domain resolving to
 * 127.0.0.1) is refused even before the Origin check sees it.
 */
export function isSupervisedLoopbackHost(
  hostHeader: string | undefined,
  port: number,
): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const separator = host.lastIndexOf(":");
  if (separator <= 0) return false;
  const name = host.slice(0, separator);
  const portText = host.slice(separator + 1);
  return (
    LOOPBACK_HOSTS.has(name) &&
    /^\d+$/.test(portText) &&
    Number(portText) === port
  );
}

/** The one line the shell accepts as proof that this child is listening. */
export function readinessLine(
  launch: SupervisedLaunch,
  port: number,
  pid: number,
): string {
  return `${JSON.stringify({ type: "pandeck-ready", nonce: launch.nonce, pid, port })}\n`;
}

/** Write readiness once and close the pipe. Throws if the shell is unreachable. */
export function reportSupervisedReady(
  launch: SupervisedLaunch,
  port: number,
): void {
  const line = Buffer.from(readinessLine(launch, port, process.pid));
  try {
    let written = 0;
    while (written < line.length)
      written += writeSync(launch.readyFd, line, written);
  } finally {
    closeSync(launch.readyFd);
  }
}

/**
 * Drain when the supervising shell's end of stdin closes. The signal goes
 * through the ordinary SIGTERM handler so there is one shutdown path.
 */
export function watchSupervisorLifeline(
  stdin: NodeJS.ReadableStream,
  onLost: () => void,
): void {
  let fired = false;
  const lost = () => {
    if (fired) return;
    fired = true;
    onLost();
  };
  stdin.on("end", lost);
  stdin.on("close", lost);
  stdin.on("error", lost);
  // Discard anything written: the pipe exists only to be closed.
  stdin.on("data", () => undefined);
  stdin.resume();
}
