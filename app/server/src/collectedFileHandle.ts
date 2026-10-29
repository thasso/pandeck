/**
 * A `node:fs/promises` FileHandle that is never closed gets closed when the
 * garbage collector reclaims it. Node 24 does that with a DEP0137 warning and
 * Bun 1.3.13 said nothing, but Bun 1.4.2 then raises an uncaught
 * `ERR_INVALID_STATE` ("A FileHandle object was closed during garbage
 * collection. This used to be allowed with a deprecation warning but is now
 * considered an error. …"). Its descriptor is already closed by then, so
 * exiting for it would trade one leaked handle for every live session.
 *
 * ONE predicate serves every fatal handler a Bun process of this server runs:
 * the server's (`index.ts`) and the spawn broker's, which runs this same source
 * inside its `-e` script (`spawnBroker.ts`). It matches the code AND the
 * message's first sentence. Every other `ERR_INVALID_STATE`, and every other
 * exception, stays fatal. Plain JavaScript by design, like the broker's handler.
 */
import { runInThisContext } from "node:vm";

/** `(err, where) => boolean`: warns and answers true for exactly that error. */
export const COLLECTED_FILE_HANDLE_SOURCE = String.raw`(function ignoreCollectedFileHandle(err, where) {
  if (
    err === null ||
    typeof err !== "object" ||
    err.code !== "ERR_INVALID_STATE" ||
    typeof err.message !== "string" ||
    !err.message.startsWith("A FileHandle object was closed during garbage collection.")
  )
    return false;
  console.warn(
    "[" + where + "] Warning: a leaked FileHandle was closed during garbage " +
      "collection, which Node only warns about; not exiting. " + err.message,
  );
  return true;
})`;

/**
 * True, after logging a warning, for Bun's error about a FileHandle closed
 * during garbage collection; false, logging nothing, for anything else.
 */
export const ignoreCollectedFileHandle = runInThisContext(
  COLLECTED_FILE_HANDLE_SOURCE,
) as (err: unknown, where: string) => boolean;
