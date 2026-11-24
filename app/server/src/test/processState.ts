/**
 * What a test sees of a real process: its state letter and process group, on
 * Linux from `/proc/<pid>/stat`, elsewhere (macOS) from `ps`. A test that
 * asserts a process is gone must see a real answer on every platform, so
 * nothing here answers "gone" just because `/proc` is missing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ProcessSample {
  /** `R`, `S`, `D`, `Z`… as the kernel reports it; `gone` once reaped. */
  state: string;
  pgrp?: number;
}

/** One sample of `pid`. */
export function processSample(pid: number): ProcessSample {
  if (process.platform === "linux") {
    let text: string;
    try {
      text = readFileSync(`/proc/${pid}/stat`, "latin1");
    } catch {
      return { state: "gone" };
    }
    const [state, , pgrp] = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { state: state ?? "?", pgrp: Number(pgrp) };
  }
  let out: string;
  try {
    out = execFileSync("/bin/ps", ["-o", "stat=,pgid=", "-p", String(pid)], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // `ps` exits 1 when no such process exists.
    return { state: "gone" };
  }
  const match = /^\s*([A-Za-z])\S*\s+(\d+)\s*$/.exec(out);
  if (!match) return out.trim() === "" ? { state: "gone" } : { state: "?" };
  return { state: match[1]!, pgrp: Number(match[2]) };
}

/** Whether `pid` still runs code: not reaped, and not a zombie. */
export function processRuns(pid: number): boolean {
  return !["gone", "Z", "X"].includes(processSample(pid).state);
}
