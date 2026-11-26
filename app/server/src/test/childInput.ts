/**
 * A spawned child's input for tests (Task-1446 F009). A child may exit, or
 * close its stdin, before reading what the test writes (`git config` never
 * reads it); the write then fails with EPIPE, which the test judges by the
 * child's exit code and output instead. Every other stdin error is kept for
 * the test to fail on, and none is ever unhandled.
 */
import type { Writable } from "node:stream";

/** Ends `stdin` with `input`; the returned function gives a non-EPIPE error. */
export function endChildInput(
  stdin: Writable,
  input: string,
): () => Error | undefined {
  let failure: Error | undefined;
  stdin.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") failure ??= err;
  });
  stdin.end(input);
  return () => failure;
}
