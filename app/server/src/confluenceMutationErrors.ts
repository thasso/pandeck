/**
 * Typed errors of the shared Confluence mutation core (`confluenceMutate.ts`,
 * `confluenceMutateApply.ts`, `confluenceAttachmentChange.ts`, Task-1463),
 * its delete guard, and the signal helpers every request of it goes through.
 * A caller decides
 * what to show by type and status alone, never by parsing a message: the
 * local tool shows every message as it always did, while the gateway's edge
 * must not repeat raw upstream text.
 */
import {
  AtlassianHttpError,
  type AtlassianCallOptions,
} from "./atlassian/atlassianFetch.ts";

/**
 * The core's own refusal or failure text. It may embed what the caller's
 * `describeError` made of another error, but no raw upstream text of its own.
 */
export class ConfluenceMutationError extends Error {}

/**
 * Confluence rejected a request that changes it (page create, comment, page or
 * title update, page or attachment delete, label add or remove, attachment
 * upload). Same message, status and reasons as the transport's error; a failed
 * read stays a plain `AtlassianHttpError`.
 */
export class ConfluenceWriteHttpError extends AtlassianHttpError {}

/**
 * The trash-only rule's delete guard: a page or attachment delete goes ahead
 * only when the read that verified it reported `status` exactly `"current"`.
 * Anything else, a missing status included, refuses, because a read that says
 * nothing about state proves nothing. Delete paths only; every other operation
 * ignores status.
 *
 * This is proof from the verification read, not a conditional DELETE: a change
 * made elsewhere between that read and the DELETE is not caught here.
 *
 * @param subject How the refusal names the resource: `Page <id>` or the file name.
 */
export function requireCurrentForDelete(
  status: unknown,
  subject: string,
): void {
  if (status === "current") return;
  const shown =
    typeof status === "string" && /^[a-z_]{1,20}$/.test(status)
      ? status
      : "unknown";
  throw new ConfluenceMutationError(
    `${subject} is not confirmed current (status ${shown}); nothing was deleted.`,
  );
}

/** Runs one write request, retyping Confluence's rejection as `ConfluenceWriteHttpError`. */
export async function confluenceWrite<T>(
  call: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (signal?.aborted) throw err;
    if (
      err instanceof AtlassianHttpError &&
      !(err instanceof ConfluenceWriteHttpError)
    )
      throw new ConfluenceWriteHttpError(err.message, err.status, err.reasons);
    throw err;
  }
}

/**
 * The trailing `query, options` arguments of a call that has no query: none
 * without a signal, so the call keeps its exact argument list.
 */
export function signalTail(
  signal: AbortSignal | undefined,
): [query?: undefined, options?: AtlassianCallOptions] {
  return signal ? [undefined, { signal }] : [];
}

/** The trailing `options` argument: none without a signal. */
export function signalOptions(
  signal: AbortSignal | undefined,
): [options?: AtlassianCallOptions] {
  return signal ? [{ signal }] : [];
}

/** Throws the abort reason when the signal has aborted. */
export function stopIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
