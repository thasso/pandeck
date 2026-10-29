/**
 * Preloaded by the Bun install check only, into the packaged server and,
 * through `BUN_OPTIONS`, into the spawn broker that server starts. On SIGWINCH
 * the process opens the check's disposable file three times without closing it
 * and forces collection, so Bun 1.4.2 raises its "closed during garbage
 * collection" error into the process's own `uncaughtException` handlers. This
 * file installs no handler: whether the process keeps running and warns is up
 * to the production one (`collectedFileHandle.ts`).
 */
import { gc, sleep } from "bun";
import { open } from "node:fs/promises";

const role = process.execArgv.includes("-e") ? "spawn broker" : "server";
const leaked = process.env.PA_CHECK_LEAKED_FILE;

// Opened and dropped: only the collector can close it.
async function leak() {
  await open(leaked);
}

process.on("SIGWINCH", async () => {
  for (let i = 0; i < 3; i += 1) await leak();
  for (let i = 0; i < 20; i += 1) {
    gc(true);
    await sleep(20);
  }
  console.error(
    `[collected-file-handle check] collected in ${role} ${process.pid}`,
  );
});
console.error(`[collected-file-handle check] armed in ${role} ${process.pid}`);
