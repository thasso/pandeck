/**
 * Keeping the server the OOM killer's LAST victim without shielding its agents.
 *
 * The service unit lowers the server's `oom_score_adj` (the NixOS module's
 * `oomScoreAdjust`, -900 by default). Every child inherits that value at fork,
 * so an agent's runaway test run would be shielded too. The kernel scores a
 * process as its RSS + swap + page tables PLUS `oom_score_adj` thousandths of
 * the memory it is choosing within: RAM + swap for a global OOM, the cgroup's
 * limit for a cgroup-local one. On a 47 GB host with 52 GB of swap, -900 is
 * about -89 GiB, so in a global OOM every process outside the unit would be
 * killed before a 35 GB runaway inside it.
 *
 * Two layers hand children back the neutral score, 0. Where this server starts
 * a process itself, {@link releaseChildOomScore} raises it right after the
 * spawn; the spawn broker raises itself, so every git it runs starts at 0. The
 * rest start in vendor code (the Claude CLI and its tools, pi's bash tool), so
 * a sweep of the server's own cgroup raises every other process once a second.
 * A process a vendor forked stays shielded until the next sweep, while it is
 * still new and small.
 *
 * Both layers only ever raise: a child that chose a higher value keeps it
 * (Chromium renderers do), and the server keeps its protection. The server is
 * the unit's main process, since the package wrapper `exec`s the Bun runtime,
 * so it is the only process to keep. Unprivileged raising is always allowed;
 * lowering is allowed down to the value systemd set, because that privileged
 * write recorded it as the floor (`oom_score_adj_min`), which children inherit.
 */
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SWEEP_INTERVAL_MS = 1_000;
const RELEASED_SCORE = "0";
const scoreBuffer = Buffer.alloc(16);

/** Raises one `oom_score_adj` file to 0 if it is negative; true when it did. */
function raiseScore(path: string): boolean {
  try {
    const fd = openSync(path, "r");
    let length: number;
    try {
      length = readSync(fd, scoreBuffer, 0, scoreBuffer.length, 0);
    } finally {
      closeSync(fd);
    }
    if (!(Number(scoreBuffer.toString("latin1", 0, length)) < 0)) return false;
    writeFileSync(path, RELEASED_SCORE);
    return true;
  } catch {
    // Gone already, or not ours to change (another uid, a non-dumpable process).
    return false;
  }
}

interface SweepOptions {
  /** Where `<pid>/oom_score_adj` lives: `/proc` outside tests. */
  procRoot: string;
  /** The unit cgroup's `cgroup.procs`. */
  procsPath: string;
  /** Processes that keep their low score. */
  keep: ReadonlySet<number>;
}

/**
 * One pass over the cgroup; returns the pids it raised. It keeps no memory
 * between passes: every live pid's score is read again (about 3 ms for 500
 * processes), so a reused pid or a failed write is simply handled next pass.
 */
export function sweepChildOomScores(options: SweepOptions): number[] {
  let listing: string;
  try {
    listing = readFileSync(options.procsPath, "latin1");
  } catch {
    return [];
  }
  const raised: number[] = [];
  for (const line of listing.split("\n")) {
    const pid = Number(line);
    if (!Number.isInteger(pid) || pid <= 0 || options.keep.has(pid)) continue;
    if (raiseScore(join(options.procRoot, String(pid), "oom_score_adj")))
      raised.push(pid);
  }
  return raised;
}

let lowered: boolean | undefined;

/** Whether this process runs with the unit's lowered score. */
function runsLowered(): boolean {
  if (lowered === undefined) {
    try {
      lowered =
        process.platform === "linux" &&
        Number(readFileSync("/proc/self/oom_score_adj", "latin1")) < 0;
    } catch {
      lowered = false;
    }
  }
  return lowered;
}

/** Call right after this server spawns a child; a no-op outside the unit. */
export function releaseChildOomScore(pid: number | undefined): void {
  if (pid === undefined || !runsLowered()) return;
  raiseScore(`/proc/${pid}/oom_score_adj`);
}

/** This process's cgroup v2 path, or undefined. */
function ownCgroup(): string | undefined {
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("0::"));
    return line?.slice(3);
  } catch {
    return undefined;
  }
}

/**
 * Starts the sweep when this process runs with a lowered score (the systemd
 * unit's `OOMScoreAdjust`); anywhere else — development, tests, macOS — it
 * does nothing.
 */
export function startChildOomScoreRelease(): void {
  if (!runsLowered()) return;
  const cgroup = ownCgroup();
  if (!cgroup) return;

  const options = {
    procRoot: "/proc",
    procsPath: join("/sys/fs/cgroup", cgroup, "cgroup.procs"),
    keep: new Set([process.pid]),
  };
  sweepChildOomScores(options);
  setInterval(() => sweepChildOomScores(options), SWEEP_INTERVAL_MS).unref();
}
