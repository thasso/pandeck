/**
 * Copies a file on a session's Worker to a server path through `files.open`,
 * as a stream, one read piece in memory at a time. Never read on the server:
 * the path may come from the agent's own output. Shared by the hosts that
 * persist a Worker file as a session artifact (`sessionHookHost.ts`,
 * `backgroundWorkHost.ts`).
 */
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { CheckoutSide } from "./placement.ts";

export async function copyFromWorker(
  side: CheckoutSide,
  source: string,
  destination: string,
): Promise<void> {
  // Lazy: `servedFileAccess.ts` reaches the in-process Worker, which imports
  // the hosts that call this, so a static import would close a cycle.
  const { openServedFile } = await import("../servedFileAccess.ts");
  const handle = await openServedFile(source, { stat: false, side });
  try {
    await pipeline(
      handle.createReadStream({ start: 0, end: Number.MAX_SAFE_INTEGER }),
      createWriteStream(destination),
    );
  } finally {
    await handle.close();
  }
}
