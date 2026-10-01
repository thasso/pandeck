/**
 * Takes this server's DATA_DIR lock at import time. `index.ts` imports this
 * FIRST, so its module graph evaluates it before any store opens the database
 * or touches a file under `DATA_DIR`; a second server on the same directory
 * exits here with the owner named, before it can write anything. `index.ts`
 * releases it on exit, after closing the database.
 */
import { DATA_DIR } from "./config.ts";
import {
  acquireServerInstanceLock,
  ServerInstanceLockedError,
  type ServerInstanceLock,
} from "./serverInstanceLock.ts";

function acquire(): ServerInstanceLock {
  try {
    return acquireServerInstanceLock(DATA_DIR);
  } catch (err) {
    if (!(err instanceof ServerInstanceLockedError)) throw err;
    console.error(`[assistant] ${err.message}`);
    process.exit(1);
  }
}

export const serverBootLock = acquire();
