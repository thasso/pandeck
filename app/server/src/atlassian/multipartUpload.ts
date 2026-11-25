/**
 * One Confluence attachment upload as a streamed `multipart/form-data` body
 * (Task-1441 P8a, v04 V1 with v05 W1, v06 X5 and v07 Y1).
 *
 * The body is byte for byte what Node's own `FormData` serialization sends for
 * the form the upload always built, a `file` part and then the fields, except
 * for the boundary. It is pulled one piece at a time, so the bytes are never
 * buffered a second time as a `Blob` or a whole body:
 *
 * - every file piece is a fresh copy of at most 1 MiB,
 *   `new Uint8Array(bytes.subarray(offset, end))`, never a view or a slice of
 *   the source (a `Buffer`'s `slice` is a view). A piece the runtime still
 *   holds after an abort therefore never keeps the whole source alive;
 * - each piece is fed to one SHA-256 before it is enqueued, so the digest
 *   covers exactly the bytes handed to fetch. Only when it equals the approved
 *   digest does the body go on with the CRLF, the fields and the closing
 *   boundary; otherwise the stream errors and no closing boundary is ever
 *   sent.
 *
 * The body owns its lifecycle. It leaves `pending` exactly once, for
 * `completed` (the tail was enqueued and the stream closed), `errored` (a
 * digest mismatch, or `retire()` while pending) or `cancelled` (the consumer
 * cancelled it), and drops its reference to the bytes on that move. `retire()`
 * is synchronous and state-idempotent: it errors a pending stream, aborts the
 * private `signal` and drops the bytes, without waiting on the peer or a
 * timer. The caller retires the body once the request has settled, on every
 * path, and counts the upload as sent only when the state is `completed`.
 *
 * Imports only `node:` modules, so the gateway edge may import it
 * (`workerBoundary.test.ts`).
 */
import { createHash, randomBytes, type Hash } from "node:crypto";

/** The most file bytes one piece of the stream carries. */
const PIECE_BYTES = 1024 * 1024;

/** The stream's error when the body is retired or the digest differs. */
const RETIRED = "The upload body was retired before it was sent whole.";
const DIGEST_MISMATCH =
  "The upload's bytes do not match the approved digest; the body was not completed.";

export type MultipartUploadState =
  "pending" | "completed" | "errored" | "cancelled";

export interface MultipartUploadInput {
  /** The verified bytes; read piece by piece, never kept past a terminal state. */
  bytes: Uint8Array;
  /** The approved digest, 64 lowercase hex characters. */
  sha256: string;
  fileName: string;
  /** The file part's type; empty or absent means `application/octet-stream`. */
  mediaType?: string | null | undefined;
  /** The text parts after the file, in order. */
  fields: ReadonlyArray<readonly [name: string, value: string]>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

/** `FormData`'s escaping of a part name or file name. */
const escapeName = (value: string): string =>
  value.replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/"/g, "%22");

/** `FormData`'s line-ending normalization of names and field values. */
const normalizeLinefeeds = (value: string): string =>
  value.replace(/\r?\n|\r/g, "\r\n");

/**
 * A `Blob`'s type as its constructor keeps it: lowercased, or empty when it
 * holds a character outside U+0020-U+007E.
 */
const blobType = (type: string): string =>
  /[^ -~]/.test(type) ? "" : type.toLowerCase();

/** A streamed multipart body; construct it with `multipartUpload`. */
export class MultipartUpload {
  readonly contentType: string;
  readonly contentLength: number;
  readonly stream: ReadableStream<Uint8Array>;
  /** Aborted by `retire()`; `atlassianFetch` combines it with the call's own. */
  readonly signal: AbortSignal;
  #state: MultipartUploadState = "pending";
  #bytes: Uint8Array | null;
  #hash: Hash | null = createHash("sha256");
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #abort = new AbortController();

  /** @internal Use `multipartUpload`. */
  constructor(input: MultipartUploadInput, boundary: string) {
    if (!SHA256_HEX.test(input.sha256))
      throw new TypeError("multipartUpload needs a 64-hex SHA-256 digest.");
    this.#bytes = input.bytes;
    this.signal = this.#abort.signal;
    this.contentType = `multipart/form-data; boundary=${boundary}`;
    const prefix = `--${boundary}\r\nContent-Disposition: form-data`;
    const type =
      blobType(input.mediaType || "application/octet-stream") ||
      "application/octet-stream";
    const head = encoder.encode(
      `${prefix}; name="file"` +
        (input.fileName ? `; filename="${escapeName(input.fileName)}"` : "") +
        `\r\nContent-Type: ${type}\r\n\r\n`,
    );
    const tail = encoder.encode(
      "\r\n" +
        input.fields
          .map(
            ([name, value]) =>
              `${prefix}; name="${escapeName(normalizeLinefeeds(name))}"\r\n\r\n${normalizeLinefeeds(value)}\r\n`,
          )
          .join("") +
        `--${boundary}--\r\n`,
    );
    const expected = input.sha256;
    const total = input.bytes.byteLength;
    this.contentLength = head.byteLength + total + tail.byteLength;
    let offset = -1; // -1: the head is next
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      pull: (controller) => {
        const bytes = this.#bytes;
        const hash = this.#hash;
        if (this.#state !== "pending" || !bytes || !hash) return;
        if (offset < 0) {
          offset = 0;
          controller.enqueue(head);
          return;
        }
        if (offset < total) {
          const end = Math.min(offset + PIECE_BYTES, total);
          const piece = new Uint8Array(bytes.subarray(offset, end));
          offset = end;
          hash.update(piece);
          controller.enqueue(piece);
          return;
        }
        // Every file byte was handed over: the tail goes only after the
        // digest matched, so a mismatch never sends a closing boundary.
        if (hash.digest("hex") !== expected) {
          this.#settle("errored");
          controller.error(new Error(DIGEST_MISMATCH));
          return;
        }
        controller.enqueue(tail);
        controller.close();
        this.#settle("completed");
      },
      cancel: () => {
        if (this.#state === "pending") this.#settle("cancelled");
      },
    });
  }

  /** `pending` until the source ends; then one terminal value, never changed. */
  get state(): MultipartUploadState {
    return this.#state;
  }

  /**
   * Error a pending stream, abort the private signal and drop the bytes.
   * Synchronous and state-idempotent; safe on every path.
   */
  retire(): void {
    if (this.#state === "pending") {
      this.#settle("errored");
      try {
        this.#controller?.error(new Error(RETIRED));
      } catch {
        // Already closed or errored by the consumer: nothing left to stop.
      }
    }
    this.#abort.abort();
    this.#bytes = null;
    this.#controller = undefined;
  }

  #settle(state: Exclude<MultipartUploadState, "pending">): void {
    this.#state = state;
    this.#bytes = null;
    this.#hash = null;
  }
}

/** The body for one upload, under a fresh random boundary. */
export function multipartUpload(input: MultipartUploadInput): MultipartUpload {
  return new MultipartUpload(
    input,
    `----pandeck-upload-${randomBytes(16).toString("hex")}`,
  );
}
