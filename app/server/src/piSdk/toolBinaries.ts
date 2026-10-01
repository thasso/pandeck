/**
 * Host `rg`/`fd` linked into pi's managed bin directory.
 *
 * pi's grep and find tools resolve their binary through `ensureTool` →
 * `getToolPath` on EVERY call. `getToolPath` first checks `<agent dir>/bin/rg`
 * with `existsSync`; only when that is absent does it probe PATH with
 * `spawnSync(name, ["--version"])`, a synchronous fork of this whole server that
 * blocks the event loop for tens of milliseconds per tool call. A symlink to the
 * host binary short-circuits the probe without patching pi's tools.
 *
 * pi reads that directory ONCE, when its tools module loads, from the
 * process-wide agent dir (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`). The
 * per-credential-profile agent dirs handed to `createAgentSession` never reach
 * it, so one directory serves every session, including profiles created later.
 *
 * Links are only ever CREATED, exclusively. pi's own download and an operator
 * write the same names, and no rename can compare-and-swap against them, so an
 * existing entry is never replaced or removed — a broken symlink is reported
 * with the manual fix instead.
 */
import { lstatSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { findOnPath } from "../hostTools.ts";

/** pi's managed-binaries directory, as its tools and shell resolve it. */
export function piBinDir(): string {
  return join(getAgentDir(), "bin");
}

/** pi's file name for each tool, and the PATH names it accepts for it. */
const PI_TOOLS: ReadonlyArray<{ name: string; pathNames: string[] }> = [
  { name: "rg", pathNames: ["rg"] },
  { name: "fd", pathNames: ["fd", "fdfind"] },
];

type LinkOutcome =
  | { kind: "linked"; target: string }
  | { kind: "kept" }
  | { kind: "broken" }
  | { kind: "missing" };

function linkOne(
  binDir: string,
  tool: (typeof PI_TOOLS)[number],
  resolve: (name: string) => string | undefined,
): LinkOutcome {
  const link = join(binDir, tool.name);
  let existing = true;
  try {
    lstatSync(link);
  } catch {
    existing = false;
  }
  if (existing) {
    // Whatever is there stays. A real file, a directory or a working symlink
    // already satisfies pi's existsSync check; only a broken one does not.
    try {
      statSync(link);
      return { kind: "kept" };
    } catch {
      return { kind: "broken" };
    }
  }
  const target = tool.pathNames.map(resolve).find(Boolean);
  if (!target) return { kind: "missing" };
  mkdirSync(binDir, { recursive: true });
  // Exclusive create: whatever appeared since the lstat wins.
  try {
    symlinkSync(target, link);
  } catch {
    return { kind: "kept" };
  }
  return { kind: "linked", target };
}

/**
 * Links the host's `rg` and `fd` into {@link piBinDir} where nothing is yet.
 * Idempotent; a binary missing from PATH is logged and left to pi's own
 * behaviour (probe, then download). Failures never block startup.
 */
export function linkPiToolBinaries(
  options: {
    binDir?: string;
    resolve?: (name: string) => string | undefined;
    log?: (line: string) => void;
  } = {},
): void {
  const binDir = options.binDir ?? piBinDir();
  // Never a binary inside the bin dir itself: that would link to itself or
  // to a sibling pi may replace.
  const resolve =
    options.resolve ?? ((name: string) => findOnPath(name, binDir));
  const log = options.log ?? ((line: string) => console.log(line));
  for (const tool of PI_TOOLS) {
    const link = join(binDir, tool.name);
    const probe = `pi's ${tool.name === "rg" ? "grep" : "find"} tool will fork the server to probe PATH on every call`;
    try {
      const outcome = linkOne(binDir, tool, resolve);
      if (outcome.kind === "linked")
        log(`[assistant] pi tools: linked ${link} -> ${outcome.target}`);
      else if (outcome.kind === "broken")
        log(
          `[assistant] pi tools: ${link} is a broken symlink and is left alone; ${probe}. Run \`rm ${link}\` and the next start links the host binary.`,
        );
      else if (outcome.kind === "missing")
        log(
          `[assistant] pi tools: ${tool.pathNames.join("/")} not on PATH; ${probe}`,
        );
    } catch (err) {
      log(
        `[assistant] pi tools: could not link ${tool.name} into ${binDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
