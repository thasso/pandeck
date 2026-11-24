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
 * Processes are observed through `processTable.ts`: `/proc` on Linux, the
 * stock `ps` and `lsof` on macOS, whose coarse start times make every signal
 * re-prove ownership (`stopCheckoutProcesses`). One snapshot finds our descendants;
 * only those have their working directory read, so the scan costs one table
 * read plus one directory read per descendant, and a removal only waits when
 * something was actually running. A platform without a table finds nothing.
 */
import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import {
  procTable,
  systemProcessTable,
  type ProcessRecord,
  type ProcessTable,
} from "./processTable.ts";

const TERM_GRACE_MS = 2_000;
const POLL_MS = 100;

export interface CheckoutProcessStop {
  /** Pids that were sent SIGTERM. */
  terminated: number[];
  /** Pids still alive after the grace period, sent SIGKILL. */
  killed: number[];
}

export interface CheckoutProcessOptions {
  /** A fake `/proc` to read instead of the system's table (tests). */
  procRoot?: string;
  /** A process table to read instead of the system's (tests). */
  table?: ProcessTable;
  selfPid?: number;
  graceMs?: number;
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

function tableOf(options: CheckoutProcessOptions): ProcessTable | undefined {
  if (options.table) return options.table;
  if (options.procRoot !== undefined) return procTable(options.procRoot);
  return systemProcessTable();
}

/** `pid`, its parent, its parent's parent… as far as the table knows. */
function ancestry(table: Map<number, ProcessRecord>, pid: number): number[] {
  const chain: number[] = [];
  for (let at: number | undefined = pid; at && at > 1;) {
    if (chain.includes(at) || chain.length > 256) break;
    chain.push(at);
    at = table.get(at)?.ppid;
  }
  return chain;
}

/** A process as found: its pid, start time and parent when found. */
interface ProcessIdentity {
  pid: number;
  start: string;
  ppid: number;
}

/** Our processes whose cwd is `root` or below it. */
export async function checkoutProcesses(
  root: string,
  options: CheckoutProcessOptions = {},
): Promise<number[]> {
  const table = tableOf(options);
  if (!table) return [];
  return (await ownedInside(root, table, options)).map((found) => found.pid);
}

async function ownedInside(
  root: string,
  table: ProcessTable,
  options: CheckoutProcessOptions,
): Promise<ProcessIdentity[]> {
  const self = options.selfPid ?? process.pid;
  const snapshot = await table.snapshot();
  if (!snapshot) return [];
  const protectedPids = new Set(ancestry(snapshot, self));
  const descendants: number[] = [];
  for (const pid of snapshot.keys()) {
    if (protectedPids.has(pid)) continue;
    const chain = ancestry(snapshot, pid);
    // Two levels down at least: chain[1] is the parent.
    if (chain[1] === self || !chain.includes(self)) continue;
    descendants.push(pid);
  }
  if (descendants.length === 0) return [];
  // Table cwds are always resolved paths.
  const real = await realpath(root).catch(() => root);
  const cwds = await table.cwds(descendants);
  const ours: ProcessIdentity[] = [];
  for (const pid of descendants) {
    const cwd = cwds.get(pid);
    if (cwd === undefined || (cwd !== real && !cwd.startsWith(real + sep)))
      continue;
    const { start, ppid } = snapshot.get(pid)!;
    ours.push({ pid, start, ppid });
  }
  return ours;
}

/**
 * Which of `found` are still the processes found — not gone, and not a new
 * one reusing the pid — and which cannot be told (the table read failed).
 */
async function stillRunning(
  table: ProcessTable,
  found: readonly ProcessIdentity[],
): Promise<{ same: ProcessIdentity[]; unknown: ProcessIdentity[] }> {
  if (found.length === 0) return { same: [], unknown: [] };
  const now = await table.records(found.map((one) => one.pid));
  if (!now) return { same: [], unknown: [...found] };
  return {
    same: found.filter((one) => now.get(one.pid)?.start === one.start),
    unknown: [],
  };
}

/** SIGTERM our processes inside `root`, SIGKILL whatever outlives the grace. */
export async function stopCheckoutProcesses(
  root: string,
  options: CheckoutProcessOptions = {},
): Promise<CheckoutProcessStop> {
  const table = tableOf(options);
  if (!table) return { terminated: [], killed: [] };
  const signal =
    options.signal ?? ((pid: number, sig) => process.kill(pid, sig));
  // Every signal is preceded by a check that the pid is still the process
  // found: over a two-second grace a pid can be recycled, and the new owner
  // must never receive our signal. Where the table's start time tells a reused
  // pid apart (Linux, start ticks), that identity is the check. Where it is
  // coarse (macOS, to the second), a same-second reuse would pass it, so the
  // whole ownership test is redone from fresh reads: still at least two levels
  // below us, outside our ancestry, its working directory still inside the
  // checkout, and then, as the LAST read, the same start and parent as when
  // found. Anything not re-read is never signalled. Neither platform has an
  // atomic pid handle: the gap between the last read and the signal remains,
  // microseconds for an in-process `/proc` read, tens of milliseconds for a
  // brokered `ps`.
  const recheck = async (
    found: readonly ProcessIdentity[],
  ): Promise<ProcessIdentity[]> => {
    if (found.length === 0) return [];
    if (!table.coarseStart) return (await stillRunning(table, found)).same;
    const owned = new Map(
      (await ownedInside(root, table, options)).map((one) => [one.pid, one]),
    );
    const same = (a: ProcessIdentity, b: ProcessRecord | undefined) =>
      b?.start === a.start && b.ppid === a.ppid;
    const stillOwned = found.filter((one) => same(one, owned.get(one.pid)));
    if (stillOwned.length === 0) return [];
    // The working directory came from a read AFTER the ownership snapshot, so
    // a pid reused in between could pair the old identity with the new
    // process's directory. Identity and parent are therefore read once more,
    // last, right before the signal.
    const last = await table.records(stillOwned.map((one) => one.pid));
    if (!last) return [];
    return stillOwned.filter((one) => same(one, last.get(one.pid)));
  };
  const send = async (
    found: readonly ProcessIdentity[],
    sig: NodeJS.Signals,
  ): Promise<ProcessIdentity[]> => {
    const sent: ProcessIdentity[] = [];
    for (const one of await recheck(found)) {
      try {
        signal(one.pid, sig);
        sent.push(one);
      } catch {
        // Gone, or not ours to signal after all.
      }
    }
    return sent;
  };
  const terminated = await send(
    await ownedInside(root, table, options),
    "SIGTERM",
  );
  if (terminated.length === 0) return { terminated: [], killed: [] };
  const deadline = Date.now() + (options.graceMs ?? TERM_GRACE_MS);
  let running = terminated;
  while (running.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const { same, unknown } = await stillRunning(table, running);
    // An unreadable round proves no exit: keep waiting for those.
    running = [...same, ...unknown];
  }
  const killed = (await send(running, "SIGKILL")).map((found) => found.pid);
  return { terminated: terminated.map((found) => found.pid), killed };
}
