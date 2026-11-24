/**
 * How the Worker observes processes for `checkoutProcesses.ts`: every
 * process's parent and start time as one table, the working directories of a
 * few chosen pids, and the current start times of pids already found.
 *
 * Linux reads `/proc` directly. macOS has no `/proc`; its stock tools read the
 * same kernel facts: `/bin/ps` (one `sysctl(KERN_PROC_ALL)` snapshot) for
 * parent and start time, `/usr/sbin/lsof -d cwd` for working directories. They
 * run through the spawn broker (`docs/child-processes.md`), never forked from
 * the server, with an absolute path, a fixed environment, `/` as their cwd and a
 * timeout.
 *
 * A start time is an opaque identity compared only with one read the same way.
 * On Linux it is the start tick, which tells a reused pid apart. On macOS it is
 * `ps`'s `lstart`, to the second in UTC: a pid reused within that second would
 * compare equal, so the table says `coarseStart` and its caller re-proves
 * ownership before each signal (`checkoutProcesses.ts`). Stock macOS offers no
 * finer per-process start time without native code.
 *
 * Every read is best-effort: a process that is gone, unreadable or unparsable
 * is simply absent from the answer, and a whole read that fails answers
 * `undefined`. Callers decide what absence means (`checkoutProcesses.ts`
 * never signals a process whose identity it could not re-read).
 */
import { readdir, readFile, readlink } from "node:fs/promises";
import { brokerExecFile } from "../spawnBroker.ts";

export interface ProcessRecord {
  ppid: number;
  start: string;
}

export interface ProcessTable {
  /**
   * Whether a start time is too coarse to tell a reused pid apart on its own
   * (macOS: to the second). A caller then re-checks full ownership before
   * every signal instead of identity alone.
   */
  readonly coarseStart: boolean;
  /** Every visible process's parent and start time; undefined when unreadable. */
  snapshot(): Promise<Map<number, ProcessRecord> | undefined>;
  /** The resolved working directory of each of `pids` that could be read. */
  cwds(pids: readonly number[]): Promise<Map<number, string>>;
  /**
   * The current parent and start time of each of `pids` still running; a pid
   * missing from the map is gone. Undefined when the read itself failed, so
   * nothing is known about any of them.
   */
  records(
    pids: readonly number[],
  ): Promise<Map<number, ProcessRecord> | undefined>;
}

/** `ppid` and `starttime` from a `/proc/<pid>/stat` line, or undefined. */
function parseProcStat(stat: string): ProcessRecord | undefined {
  // `pid (comm) state ppid …` — comm may hold spaces or parentheses, so the
  // fields count from the LAST `)`: state is field 3, starttime field 22.
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = stat.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  const start = fields[19]?.trim() ?? "";
  if (!Number.isInteger(ppid) || !/^\d+$/.test(start)) return undefined;
  return { ppid, start };
}

/** The `/proc` table; `procRoot` is a seam for tests. */
export function procTable(procRoot = "/proc"): ProcessTable {
  const statOf = async (pid: number) => {
    try {
      return parseProcStat(await readFile(`${procRoot}/${pid}/stat`, "utf8"));
    } catch {
      return undefined;
    }
  };
  return {
    coarseStart: false,
    async snapshot() {
      let names: string[];
      try {
        names = await readdir(procRoot);
      } catch {
        return undefined;
      }
      const table = new Map<number, ProcessRecord>();
      await Promise.all(
        names
          .filter((name) => /^\d+$/.test(name))
          .map(async (name) => {
            const record = await statOf(Number(name));
            if (record) table.set(Number(name), record);
          }),
      );
      return table;
    },
    async cwds(pids) {
      const found = new Map<number, string>();
      await Promise.all(
        pids.map(async (pid) => {
          try {
            // `/proc/<pid>/cwd` is always the resolved path.
            found.set(pid, await readlink(`${procRoot}/${pid}/cwd`));
          } catch {
            // Gone, or not ours to read.
          }
        }),
      );
      return found;
    },
    async records(pids) {
      const found = new Map<number, ProcessRecord>();
      await Promise.all(
        pids.map(async (pid) => {
          const record = await statOf(pid);
          if (record) found.set(pid, record);
        }),
      );
      return found;
    },
  };
}

/** Runs a stock tool; tests replace it. Resolves its stdout, or undefined. */
export type ToolRunner = (
  file: string,
  args: readonly string[],
) => Promise<string | undefined>;

const TOOL_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LC_ALL: "C",
  TZ: "UTC",
};
const MAX_TOOL_OUTPUT = 16 * 1024 * 1024;

/** How long one `ps` or `lsof` may take before its answer counts as unknown. */
const TOOL_TIMEOUT_MS = 5_000;

/**
 * Runs a stock tool through the spawn broker. `ps` exits 1 when a named pid is
 * gone and `lsof` when any is unreadable; both still print every other one, so
 * stdout is the answer whenever the tool ran. A failure to run at all, a
 * signal, an overflow, or no answer within `timeoutMs` (`lsof` can wedge on an
 * unresponsive mount) is no answer: the broker cancels the child, and the
 * caller treats the read as unknown, which never signals.
 */
export function brokerToolRunner(timeoutMs = TOOL_TIMEOUT_MS): ToolRunner {
  return async (file, args) => {
    const outcome = await brokerExecFile({
      file,
      args: [...args],
      cwd: "/",
      env: TOOL_ENV,
      maxBuffer: MAX_TOOL_OUTPUT,
      encoding: "utf8",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const code = outcome.error?.code;
    if (outcome.error && code !== 1) return undefined;
    return outcome.stdout;
  };
}

const PS = "/bin/ps";
const LSOF = "/usr/sbin/lsof";
/** `Mon Nov 23 15:09:26 2026`, as `ps -o lstart` prints it under `LC_ALL=C`. */
const LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/;

/** `pid ppid lstart` lines into a table; a malformed line is skipped. */
function parsePsTable(text: string): Map<number, ProcessRecord> {
  const table = new Map<number, ProcessRecord>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match || !LSTART.test(match[3]!)) continue;
    table.set(Number(match[1]), { ppid: Number(match[2]), start: match[3]! });
  }
  return table;
}

/**
 * `lsof -F pfn` output into working directories: a `p<pid>` line opens a
 * process, its `fcwd` file's `n<path>` line names the directory. Any other
 * field is ignored.
 */
function parseLsofCwds(text: string): Map<number, string> {
  const found = new Map<number, string>();
  let pid: number | undefined;
  let file: string | undefined;
  for (const line of text.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = /^\d+$/.test(value) ? Number(value) : undefined;
      file = undefined;
    } else if (tag === "f") file = value;
    else if (tag === "n" && pid !== undefined && file === "cwd") {
      // A path lsof could not name exactly (escaped bytes, an appended note)
      // simply matches no checkout: absence, never a wider match.
      if (value.startsWith("/")) found.set(pid, value);
    }
  }
  return found;
}

/** The macOS table over `ps` and `lsof`; `run` is a seam for tests. */
export function darwinTable(
  run: ToolRunner = brokerToolRunner(),
): ProcessTable {
  return {
    coarseStart: true,
    async snapshot() {
      const text = await run(PS, ["-A", "-o", "pid=,ppid=,lstart="]);
      return text === undefined ? undefined : parsePsTable(text);
    },
    async cwds(pids) {
      if (pids.length === 0) return new Map();
      // -a ANDs the selections; -n/-P skip name lookups, -w its warnings.
      const text = await run(LSOF, [
        "-a",
        "-n",
        "-P",
        "-w",
        "-d",
        "cwd",
        "-F",
        "pfn",
        "-p",
        pids.join(","),
      ]);
      return text === undefined ? new Map() : parseLsofCwds(text);
    },
    async records(pids) {
      if (pids.length === 0) return new Map();
      const text = await run(PS, [
        "-o",
        "pid=,ppid=,lstart=",
        "-p",
        pids.join(","),
      ]);
      return text === undefined ? undefined : parsePsTable(text);
    },
  };
}

/** The table for this platform, or undefined where none is known. */
export function systemProcessTable(): ProcessTable | undefined {
  if (process.platform === "linux") return procTable();
  if (process.platform === "darwin") return darwinTable();
  return undefined;
}
