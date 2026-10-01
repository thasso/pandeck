/**
 * Dev supervisor — replaces `tsx watch` for the server.
 *
 * `tsx watch` restarts the whole process the instant a source file changes,
 * which kills the in-process agent mid-turn (see the Workshop agent). Instead we
 * run the server as a child and, on a source change, ask it to reload *gracefully*
 * via SIGUSR2: the server defers the reload until no agent run is active, tells
 * connected clients, then exits cleanly. We respawn it and the web client
 * auto-reconnects with the conversation restored from disk.
 *
 * Web/UI code is handled by Vite HMR and is not watched here.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";

const indexPath = fileURLToPath(new URL("./index.ts", import.meta.url));
// Source that, when changed, requires a server reload to take effect.
const WATCH_DIRS = [
  fileURLToPath(new URL("./", import.meta.url)), // app/server/src
  fileURLToPath(new URL("../../shared/", import.meta.url)), // app/shared
];
const DEBOUNCE_MS = 120;

let child: ChildProcess | null = null;
/** We sent SIGUSR2 and expect a clean exit we should respawn from. */
let reloadRequested = false;
/** The child crashed; wait for a file change before respawning (no crash loop). */
let awaitingChange = false;
let shuttingDown = false;

function spawnChild(): void {
  reloadRequested = false;
  child = spawn(process.execPath, ["--import", "tsx", indexPath], {
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    child = null;
    if (reloadRequested) {
      console.log("[supervisor] applying changes — restarting server");
      spawnChild();
    } else {
      console.error(
        `[supervisor] server exited unexpectedly (code=${code}, signal=${signal}); ` +
          "waiting for a file change to restart",
      );
      awaitingChange = true;
    }
  });
}

function onSourceChange(): void {
  if (awaitingChange) {
    // Recovering from a crash: a fix landed, bring the server back up.
    awaitingChange = false;
    spawnChild();
    return;
  }
  // Ask the running server to reload once it's idle. Idempotent: repeated edits
  // while a run is in flight just re-signal; the server reloads when it can.
  if (child) {
    reloadRequested = true;
    child.kill("SIGUSR2");
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleChange(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(onSourceChange, DEBOUNCE_MS);
}

for (const dir of WATCH_DIRS) {
  watch(dir, { recursive: true }, (_event, filename) => {
    if (filename && filename.toString().endsWith(".ts")) scheduleChange();
  });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shuttingDown = true;
    child?.kill(sig);
    process.exit(0);
  });
}

console.log("[supervisor] starting server (graceful reload on source changes)");
spawnChild();
