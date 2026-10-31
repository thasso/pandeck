/**
 * Stopping what still RUNS inside a checkout before it is deleted.
 *
 * A dev server an agent left running keeps writing into its checkout after
 * `git worktree remove` — Vite recreates `.vite/deps`, and the "removed"
 * worktree comes back as a folder of cache files nobody owns. Background work
 * the app tracks is stopped through its supervisor first; this is the net for
 * everything else: a process whose working directory is inside the checkout.
 *
 * Only processes this server provably started are candidates: descendants at
 * least two levels down. Its DIRECT children are its own harnesses and helpers
 * (an idle Claude session's CLI runs in its checkout), torn down by their
 * owners, while whatever an agent started sits below them. Nothing is inferred
 * from cgroup membership alone: a process re-parented out of our tree cannot be
 * told apart from an app helper, so a deliberately detached (`nohup`/`setsid`)
 * process whose parent already exited is left alone — the tracked-work stop
 * covers background work the app knows about. This server and its ancestors
 * are never signalled, and a user's own shell or editor in the same folder is
 * never our descendant.
 *
 * Linux-only by nature (`/proc`); elsewhere it finds nothing. The scan is a
 * `readlink` per process — about 10 ms for a few hundred — and a removal only
 * waits when something was actually running.
 */
import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import { sep } from "node:path";

const TERM_GRACE_MS = 2_000;
const POLL_MS = 100;

export interface CheckoutProcessStop {
  /** Pids that were sent SIGTERM. */
  terminated: number[];
  /** Pids still alive after the grace period, sent SIGKILL. */
  killed: number[];
}

export interface CheckoutProcessOptions {
  procRoot?: string;
  selfPid?: number;
  graceMs?: number;
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

/** `ppid` and `starttime` from `/proc/<pid>/stat`, or undefined once gone. */
async function statOf(
  procRoot: string,
  pid: number,
): Promise<{ ppid: number; start: string } | undefined> {
  try {
    const stat = await readFile(`${procRoot}/${pid}/stat`, "utf8");
    // `pid (comm) state ppid …` — comm may hold spaces or parentheses, so the
    // fields count from the LAST `)`: state is field 3, starttime field 22.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    if (!Number.isInteger(ppid)) return undefined;
    return { ppid, start: fields[19] ?? "" };
  } catch {
    return undefined;
  }
}

async function parentOf(
  procRoot: string,
  pid: number,
): Promise<number | undefined> {
  return (await statOf(procRoot, pid))?.ppid;
}

async function ancestry(procRoot: string, pid: number): Promise<number[]> {
  const chain: number[] = [];
  for (let at: number | undefined = pid; at && at > 1;) {
    if (chain.includes(at) || chain.length > 256) break;
    chain.push(at);
    at = await parentOf(procRoot, at);
  }
  return chain;
}

/** A process as found: its pid and start time, so a reused pid is not it. */
interface ProcessIdentity {
  pid: number;
  start: string;
}

/** Our processes whose cwd is `root` or below it. */
export async function checkoutProcesses(
  root: string,
  options: CheckoutProcessOptions = {},
): Promise<number[]> {
  return (await ownedInside(root, options)).map((found) => found.pid);
}

async function ownedInside(
  root: string,
  options: CheckoutProcessOptions,
): Promise<ProcessIdentity[]> {
  const procRoot = options.procRoot ?? "/proc";
  const self = options.selfPid ?? process.pid;
  // `/proc/<pid>/cwd` is always the resolved path.
  const real = await realpath(root).catch(() => root);
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch {
    return [];
  }
  const inside = (
    await Promise.all(
      names
        .filter((name) => /^\d+$/.test(name))
        .map(async (name) => {
          try {
            const cwd = await readlink(`${procRoot}/${name}/cwd`);
            return cwd === real || cwd.startsWith(real + sep)
              ? Number(name)
              : undefined;
          } catch {
            return undefined;
          }
        }),
    )
  ).filter((pid): pid is number => pid !== undefined);
  if (inside.length === 0) return [];

  const protectedPids = new Set(await ancestry(procRoot, self));
  const ours: ProcessIdentity[] = [];
  for (const pid of inside) {
    if (protectedPids.has(pid)) continue;
    const chain = await ancestry(procRoot, pid);
    // Two levels down at least: chain[1] is the parent.
    if (chain[1] === self || !chain.includes(self)) continue;
    const start = (await statOf(procRoot, pid))?.start;
    if (start) ours.push({ pid, start });
  }
  return ours;
}

/** Still the process we found — not gone, and not a new one reusing its pid. */
async function sameProcess(
  procRoot: string,
  found: ProcessIdentity,
): Promise<boolean> {
  return (await statOf(procRoot, found.pid))?.start === found.start;
}

/** SIGTERM our processes inside `root`, SIGKILL whatever outlives the grace. */
export async function stopCheckoutProcesses(
  root: string,
  options: CheckoutProcessOptions = {},
): Promise<CheckoutProcessStop> {
  const procRoot = options.procRoot ?? "/proc";
  const signal =
    options.signal ?? ((pid: number, sig) => process.kill(pid, sig));
  // Every signal is preceded by an identity check: over a two-second grace a
  // pid can be recycled, and the new owner must never receive our SIGKILL. The
  // window left between check and signal is microseconds, not seconds.
  const send = async (
    found: ProcessIdentity,
    sig: NodeJS.Signals,
  ): Promise<boolean> => {
    if (!(await sameProcess(procRoot, found))) return false;
    try {
      signal(found.pid, sig);
      return true;
    } catch {
      // Gone, or not ours to signal after all.
      return false;
    }
  };
  const terminated: ProcessIdentity[] = [];
  for (const found of await ownedInside(root, options))
    if (await send(found, "SIGTERM")) terminated.push(found);
  if (terminated.length === 0) return { terminated: [], killed: [] };
  const deadline = Date.now() + (options.graceMs ?? TERM_GRACE_MS);
  let running = terminated;
  while (running.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const still: ProcessIdentity[] = [];
    for (const found of running)
      if (await sameProcess(procRoot, found)) still.push(found);
    running = still;
  }
  const killed: number[] = [];
  for (const found of running)
    if (await send(found, "SIGKILL")) killed.push(found.pid);
  return { terminated: terminated.map((found) => found.pid), killed };
}
