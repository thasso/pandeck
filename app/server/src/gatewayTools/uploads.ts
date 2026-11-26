/**
 * The edge's upload store (Task-1441 P8a, v02 AC6 with v03 K1/K5/K7, v09 P1
 * and v10 S2): the approved bytes of a client-mode `uploadAttachment`, sent
 * by Pandeck in `uploads.put` chunks before the `tools.apply` that writes
 * them.
 *
 * - **Scope.** Each client connection gets one scope (`store.scope(userId)`),
 *   created by the listener and never named on the wire. An upload is found
 *   only through the scope that opened it; another connection's id reads as
 *   unknown and is never touched.
 * - **Reservation.** `open` reserves `2U + 2 MiB` (U the streams' bytes) from
 *   the process's one `FileBudget`, shared with file downloads, before any
 *   byte arrives. A held budget answers `UPLOAD_BUSY` and stores nothing.
 * - **Receiving.** A `put` appends one chunk at exactly the stream's received
 *   offset. It is copied synchronously into the stream's buffer, allocated
 *   once at its first put, and hashed. A stream whose last byte arrives must
 *   match its declared SHA-256 (`streamComplete`); the upload is `sealed`
 *   once every stream is complete. Any bad put discards the upload.
 * - **Lifetime.** An unattached upload (receiving or sealed) is discarded and
 *   its reservation released on `release`, on its connection's end, after
 *   `UPLOAD_IDLE_MS` without an open or put, or `UPLOAD_MAX_UNATTACHED_MS`
 *   after its open.
 * - **Consumption.** The host's `tools.apply` runs `consume` synchronously:
 *   a sealed upload whose streams match the items exactly becomes `attached`
 *   to that one apply; any other outcome discards it. Attached, it is immune
 *   to put, release, timers and the connection's end, and it is released
 *   exactly once, when the apply's execution and its answer's output have
 *   both settled (P7a H1's two holds).
 *
 * Every refusal is a fixed text: no id, name, size or byte reaches one, and
 * nothing here logs.
 */
import { createHash, randomBytes, type Hash } from "node:crypto";
import type { FileBudget } from "./host.ts";
import { ITEMS_INVALID } from "./twoPhase.ts";

const MIB = 1024 * 1024;
/** The most an upload carries, its items' total included (W). */
export const UPLOAD_MAX_BYTES = 100 * MIB;
/** The most streams, and upload items, one upload carries. */
const UPLOAD_MAX_STREAMS = 10;
/** The largest chunk one `put` carries. */
export const UPLOAD_CHUNK_MAX_BYTES = MIB;
/** What one upload reserves beyond twice its bytes. */
const UPLOAD_RESERVE_OVERHEAD = 2 * MIB;
/** An unattached upload with no open or put for this long is discarded. */
export const UPLOAD_IDLE_MS = 60_000;
/** An unattached upload this long after its open is discarded. */
export const UPLOAD_MAX_UNATTACHED_MS = 600_000;
/** The upload apply's deadline ceiling (v02 AC9). */
const UPLOAD_APPLY_MAX_MS = 145_000;
/** Ids remembered per connection as expired, to answer `UPLOAD_EXPIRED`. */
const EXPIRED_REMEMBERED = 16;

export const UPLOAD_BUSY =
  "The gateway is already transferring a file; try again when it finishes. Nothing was uploaded.";
export const UPLOAD_SOURCE_MISSING =
  "The gateway did not receive the file for this upload; nothing was written.";
export const UPLOAD_MISMATCH =
  "The file received for this item does not match the approved one; nothing was written for it.";
export const UPLOAD_EXPIRED =
  "The gateway no longer holds the file for this upload; nothing was written. Ask for the upload again.";
/** A malformed `uploads.*` request, or a put that does not continue its stream. */
export const UPLOAD_INVALID =
  "The upload request is not valid; the gateway discarded the upload and nothing was written.";
/** A put or release naming an upload an apply already took. */
export const UPLOAD_IN_USE =
  "This upload is already being applied; nothing was changed.";

/**
 * The edge's upload apply deadline (v08 N1, v09 P3): the tool's own write
 * deadline plus 1 s per started MiB of the items' bytes, at most 145 s. The
 * bytes are already here, so no transfer time falls inside it. Pandeck's link
 * keeps its own copy of this formula (`gatewayClientLink.ts`), pinned by a
 * shared table test.
 */
export function uploadApplyDeadlineMs(work: number, baseMs = 45_000): number {
  return Math.min(UPLOAD_APPLY_MAX_MS, baseMs + 1_000 * Math.ceil(work / MIB));
}

/** One upload source as `tools.prepare` carries it (v02 AC2). */
export interface UploadEntry {
  stagedAttachmentId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  /** Card text only: a host path or an attachment name, never opened. */
  source: string;
}

/** One stream `uploads.open` declares. */
interface UploadStreamSpec {
  stagedAttachmentId: string;
  size: number;
  sha256: string;
}

type Refusal = { ok: false; code: "tool_error"; message: string };
const refusal = (message: string): Refusal => ({
  ok: false,
  code: "tool_error",
  message,
});

type UploadOpenAnswer = { ok: true; uploadId: string } | Refusal;
type UploadPutAnswer =
  | { ok: true; received: number; streamComplete: boolean; sealed: boolean }
  | Refusal;
type UploadReleaseAnswer = { ok: true } | Refusal;

/** An attached upload, as the apply that took it sees it. */
export interface AttachedUpload {
  /** The items' total bytes (W), for the apply's deadline. */
  readonly work: number;
  /**
   * The sealed bytes of the item's source, rechecked for length and digest;
   * throws `UPLOAD_MISMATCH` (a defect) before any write for that item.
   */
  stagedBytes(attachment: {
    stagedAttachmentId?: unknown;
    size?: unknown;
    sha256?: unknown;
  }): Promise<Uint8Array>;
  /** The apply's own execution settled: the execution hold. */
  executionSettled(): void;
}

/** `consume`'s outcome: the attached upload, or the apply's refusal text. */
export type UploadConsumed =
  | { ok: true; upload: AttachedUpload; outputSettled: () => void }
  | { ok: false; message: string; outputSettled: () => void };

/** One connection's view of the store. */
export interface UploadScope {
  open(request: {
    streams: UploadStreamSpec[];
    work: number;
  }): UploadOpenAnswer;
  /**
   * `chunk`, one buffer or the received slices in order, is copied before
   * this returns; no buffer or slice of the caller's is kept.
   */
  put(
    request: { uploadId: string; stagedAttachmentId: string; offset: number },
    chunk: Uint8Array | readonly Uint8Array[],
  ): UploadPutAnswer;
  release(uploadId: string): UploadReleaseAnswer;
  /**
   * A request the listener could not decode: the named upload, if it is this
   * connection's and unattached, is discarded (v03 K7).
   */
  invalid(uploadId?: string): Refusal;
  /** The connection ended: its unattached uploads are discarded. */
  end(): void;
  /**
   * The host's synchronous consumption for one `tools.apply` (v03 K5). The
   * caller registers `outputSettled` with the answer's output hold at once,
   * whatever the outcome.
   */
  consume(uploadId: string, items: readonly unknown[]): UploadConsumed;
}

export interface UploadStore {
  scope(userId: string): UploadScope;
}

interface Stream {
  size: number;
  sha256: string;
  received: number;
  buffer: Uint8Array | undefined;
  hash: Hash | undefined;
  complete: boolean;
}

type UploadState = "receiving" | "sealed" | "attached" | "gone";

interface Upload {
  state: UploadState;
  work: number;
  streams: Map<string, Stream>;
  release: () => void;
  idle: ReturnType<typeof setTimeout> | undefined;
  absolute: ReturnType<typeof setTimeout> | undefined;
}

interface StoreOptions {
  /** The process's one file budget, shared with the host's downloads. */
  fileBudget: FileBudget;
  idleMs?: number;
  maxUnattachedMs?: number;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const isSize = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= UPLOAD_MAX_BYTES;

/** Whether `streams` and `work` are a valid open (v02 AC6). */
function validOpen(streams: UploadStreamSpec[], work: number): boolean {
  if (streams.length < 1 || streams.length > UPLOAD_MAX_STREAMS) return false;
  const ids = new Set<string>();
  let total = 0;
  for (const stream of streams) {
    if (ids.has(stream.stagedAttachmentId)) return false;
    ids.add(stream.stagedAttachmentId);
    if (!isSize(stream.size) || !SHA256_RE.test(stream.sha256)) return false;
    total += stream.size;
  }
  return (
    Number.isSafeInteger(work) && total <= work && work <= UPLOAD_MAX_BYTES
  );
}

/** One `uploadAttachment` item's attachment fields, else undefined. */
function uploadAttachmentOf(
  item: unknown,
): { id: unknown; size: unknown; sha256: unknown } | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const { operation, attachment } = item as {
    operation?: unknown;
    attachment?: unknown;
  };
  if (operation !== "uploadAttachment") return undefined;
  const fields =
    typeof attachment === "object" && attachment !== null
      ? (attachment as Record<string, unknown>)
      : {};
  return {
    id: fields.stagedAttachmentId,
    size: fields.size,
    sha256: fields.sha256,
  };
}

/**
 * v02 AC6's whole-call validation, pure: every upload item names a sealed
 * stream with its exact size and digest, the items' total is the open's
 * `work` and at most 100 MiB, and every stream is referenced.
 */
function itemsMatch(upload: Upload, items: readonly unknown[]): boolean {
  const referenced = new Set<string>();
  let work = 0;
  let count = 0;
  for (const item of items) {
    const fields = uploadAttachmentOf(item);
    if (!fields) continue;
    count += 1;
    if (typeof fields.id !== "string") return false;
    const stream = upload.streams.get(fields.id);
    if (
      !stream?.complete ||
      !isSize(fields.size) ||
      fields.size !== stream.size ||
      fields.sha256 !== stream.sha256
    )
      return false;
    referenced.add(fields.id);
    work += fields.size;
  }
  return (
    count > 0 &&
    work <= UPLOAD_MAX_BYTES &&
    work === upload.work &&
    referenced.size === upload.streams.size
  );
}

/** The armed test probe, if any; production never arms one. */
let allocationProbe:
  { allocations: number; buffer: ArrayBuffer | undefined } | undefined;

/** A stream's backing store: the store's one allocation per stream. */
function allocateStream(size: number): Uint8Array {
  const buffer = new ArrayBuffer(size);
  if (allocationProbe) {
    allocationProbe.allocations += 1;
    allocationProbe.buffer = buffer;
  }
  return new Uint8Array(buffer);
}

/**
 * Test-only (v04 V3, v06 X1): arms a probe on the store's stream allocation
 * until `disarm`. It counts allocations, and `takeBuffer` returns the newest
 * stream's backing `ArrayBuffer` once, then forgets it, so the caller can
 * turn it into a `WeakRef` at once and hold nothing strong. Unarmed, the
 * store keeps no reference beyond its own.
 */
export function probeUploadAllocations(): {
  readonly allocations: number;
  takeBuffer(): ArrayBuffer | undefined;
  disarm(): void;
} {
  const probe = {
    allocations: 0,
    buffer: undefined as ArrayBuffer | undefined,
  };
  allocationProbe = probe;
  return {
    get allocations() {
      return probe.allocations;
    },
    takeBuffer() {
      const { buffer } = probe;
      probe.buffer = undefined;
      return buffer;
    },
    disarm() {
      probe.buffer = undefined;
      if (allocationProbe === probe) allocationProbe = undefined;
    },
  };
}

export function createUploadStore(options: StoreOptions): UploadStore {
  const idleMs = options.idleMs ?? UPLOAD_IDLE_MS;
  const maxUnattachedMs = options.maxUnattachedMs ?? UPLOAD_MAX_UNATTACHED_MS;
  const { fileBudget } = options;

  /** Drop the bytes and timers; the caller decides when the budget goes. */
  const drop = (upload: Upload): void => {
    upload.state = "gone";
    clearTimeout(upload.idle);
    clearTimeout(upload.absolute);
    upload.idle = undefined;
    upload.absolute = undefined;
    for (const stream of upload.streams.values()) {
      stream.buffer = undefined;
      stream.hash = undefined;
    }
    upload.streams.clear();
  };

  return {
    scope(_userId) {
      // The scope object is the connection's identity: an id is looked up
      // only in the map of the scope that opened it.
      const uploads = new Map<string, Upload>();
      const expired: string[] = [];
      let ended = false;

      /** Discard an unattached upload now, budget included. */
      const discard = (id: string, upload: Upload): void => {
        uploads.delete(id);
        drop(upload);
        upload.release();
      };

      const expire = (id: string, upload: Upload): void => {
        if (upload.state !== "receiving" && upload.state !== "sealed") return;
        discard(id, upload);
        expired.push(id);
        if (expired.length > EXPIRED_REMEMBERED) expired.shift();
      };

      const touch = (id: string, upload: Upload): void => {
        clearTimeout(upload.idle);
        upload.idle = setTimeout(() => expire(id, upload), idleMs);
        upload.idle.unref?.();
      };

      /** This scope's unattached upload `id`, discarded; else nothing. */
      const discardUnattached = (id: string | undefined): void => {
        const upload = id === undefined ? undefined : uploads.get(id);
        if (upload && upload.state !== "attached") discard(id!, upload);
      };

      const scope: UploadScope = {
        open({ streams, work }) {
          if (ended || !validOpen(streams, work))
            return refusal(UPLOAD_INVALID);
          const bytes = streams.reduce((sum, stream) => sum + stream.size, 0);
          const release = fileBudget.reserve(
            2 * bytes + UPLOAD_RESERVE_OVERHEAD,
          );
          if (!release) return refusal(UPLOAD_BUSY);
          const id = `upl-${randomBytes(16).toString("hex")}`;
          const upload: Upload = {
            state: "receiving",
            work,
            streams: new Map(
              streams.map((stream) => [
                stream.stagedAttachmentId,
                {
                  size: stream.size,
                  sha256: stream.sha256,
                  received: 0,
                  buffer: undefined,
                  hash: undefined,
                  complete: false,
                },
              ]),
            ),
            release,
            idle: undefined,
            absolute: undefined,
          };
          uploads.set(id, upload);
          touch(id, upload);
          upload.absolute = setTimeout(
            () => expire(id, upload),
            maxUnattachedMs,
          );
          upload.absolute.unref?.();
          return { ok: true, uploadId: id };
        },

        put({ uploadId, stagedAttachmentId, offset }, chunk) {
          const upload = uploads.get(uploadId);
          if (!upload) return refusal(UPLOAD_EXPIRED);
          if (upload.state === "attached") return refusal(UPLOAD_IN_USE);
          const stream =
            upload.state === "receiving"
              ? upload.streams.get(stagedAttachmentId)
              : undefined;
          const parts = chunk instanceof Uint8Array ? [chunk] : chunk;
          let length = 0;
          for (const part of parts) length += part.byteLength;
          if (
            !stream ||
            stream.complete ||
            offset !== stream.received ||
            length < 1 ||
            length > UPLOAD_CHUNK_MAX_BYTES ||
            offset + length > stream.size
          ) {
            discard(uploadId, upload);
            return refusal(UPLOAD_INVALID);
          }
          // Copied and hashed synchronously, before anything can await: the
          // request's payload is not kept past this call (v03 K7).
          stream.buffer ??= allocateStream(stream.size);
          stream.hash ??= createHash("sha256");
          // Slice by slice, straight into place: the put's only copy (F004a).
          let at = offset;
          for (const part of parts) {
            stream.buffer.set(part, at);
            stream.hash.update(part);
            at += part.byteLength;
          }
          stream.received += length;
          let streamComplete = false;
          if (stream.received === stream.size) {
            const digest = stream.hash.digest("hex");
            stream.hash = undefined;
            if (digest !== stream.sha256) {
              discard(uploadId, upload);
              return refusal(UPLOAD_MISMATCH);
            }
            stream.complete = true;
            streamComplete = true;
          }
          const sealed = [...upload.streams.values()].every(
            (each) => each.complete,
          );
          if (sealed) upload.state = "sealed";
          touch(uploadId, upload);
          return {
            ok: true,
            received: stream.received,
            streamComplete,
            sealed,
          };
        },

        release(uploadId) {
          const upload = uploads.get(uploadId);
          if (upload?.state === "attached") return refusal(UPLOAD_IN_USE);
          if (upload) discard(uploadId, upload);
          return { ok: true };
        },

        invalid(uploadId) {
          discardUnattached(uploadId);
          return refusal(UPLOAD_INVALID);
        },

        end() {
          ended = true;
          for (const [id, upload] of [...uploads])
            if (upload.state !== "attached") discard(id, upload);
        },

        consume(uploadId, items) {
          const upload = uploads.get(uploadId);
          const nothing = () => {};
          if (!upload || upload.state === "attached")
            return {
              ok: false,
              message: expired.includes(uploadId)
                ? UPLOAD_EXPIRED
                : ITEMS_INVALID,
              outputSettled: nothing,
            };
          if (upload.state !== "sealed" || !itemsMatch(upload, items)) {
            // Discarded: the bytes go now, the reservation once the refusal's
            // output has settled (v03 K5).
            uploads.delete(uploadId);
            drop(upload);
            return {
              ok: false,
              message: ITEMS_INVALID,
              outputSettled: upload.release,
            };
          }
          upload.state = "attached";
          clearTimeout(upload.idle);
          clearTimeout(upload.absolute);
          upload.idle = undefined;
          upload.absolute = undefined;
          let execution = false;
          let output = false;
          const settle = () => {
            if (!execution || !output || upload.state === "gone") return;
            uploads.delete(uploadId);
            drop(upload);
            upload.release();
          };
          const attached: AttachedUpload = {
            work: upload.work,
            async stagedBytes(attachment) {
              const stream =
                typeof attachment.stagedAttachmentId === "string"
                  ? upload.streams.get(attachment.stagedAttachmentId)
                  : undefined;
              const bytes = stream?.complete ? stream.buffer : undefined;
              if (
                !stream ||
                !bytes ||
                bytes.byteLength !== stream.size ||
                attachment.size !== stream.size ||
                attachment.sha256 !== stream.sha256 ||
                createHash("sha256").update(bytes).digest("hex") !==
                  stream.sha256
              )
                throw new UploadMismatchError();
              return bytes;
            },
            executionSettled() {
              execution = true;
              settle();
            },
          };
          return {
            ok: true,
            upload: attached,
            outputSettled() {
              output = true;
              settle();
            },
          };
        },
      };
      return scope;
    },
  };
}

/** `stagedBytes` found no matching sealed bytes: a defect, before any write. */
export class UploadMismatchError extends Error {
  constructor() {
    super(UPLOAD_MISMATCH);
    this.name = "UploadMismatchError";
  }
}
