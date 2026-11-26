/**
 * A local HTTP peer for streamed upload tests (Task-1441 P8a): it parses a
 * `multipart/form-data` body as it arrives, hashing the `file` part without
 * holding it, so a 100 MiB upload costs the peer a few KiB. Loopback only;
 * every value is fake.
 */
import { createHash, type Hash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/** How much of the stream is held back to find the part's end in. */
const HOLDBACK = 64 * 1024;

/** Hashes the first part's bytes of a multipart body as it streams by. */
export class MultipartSink {
  readonly #boundary: Buffer;
  readonly #hash: Hash = createHash("sha256");
  #pending = Buffer.alloc(0);
  #inFile = false;
  /** Body bytes seen so far. */
  received = 0;
  /** File bytes hashed so far. */
  fileBytes = 0;
  /** Whether the closing boundary arrived. */
  closed = false;

  constructor(contentType: string) {
    const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
    if (!boundary) throw new Error("no multipart boundary");
    this.#boundary = Buffer.from(boundary, "latin1");
  }

  push(chunk: Buffer): void {
    this.received += chunk.byteLength;
    this.#pending = Buffer.concat([this.#pending, chunk]);
    if (!this.#inFile) {
      const headEnd = this.#pending.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      this.#pending = this.#pending.subarray(headEnd + 4);
      this.#inFile = true;
    }
    if (this.#pending.byteLength > HOLDBACK) {
      const hashed = this.#pending.byteLength - HOLDBACK;
      this.#hash.update(this.#pending.subarray(0, hashed));
      this.fileBytes += hashed;
      this.#pending = Buffer.from(this.#pending.subarray(hashed));
    }
  }

  /** The file part's digest, once the body ended; `undefined` when it never ended its part. */
  finish(): string | undefined {
    const end = this.#pending.indexOf(
      Buffer.concat([Buffer.from("\r\n--"), this.#boundary]),
    );
    if (end < 0) return undefined;
    this.#hash.update(this.#pending.subarray(0, end));
    this.fileBytes += end;
    this.closed = this.#pending
      .subarray(end)
      .includes(Buffer.concat([this.#boundary, Buffer.from("--\r\n")]));
    return this.#hash.digest("hex");
  }
}

/** Whether `bytes` holds the closing boundary for `contentType`. */
export function hasClosingBoundary(
  bytes: Buffer,
  contentType: string,
): boolean {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? "";
  return bytes.includes(`--${boundary}--`, 0, "latin1");
}

export type UploadHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

/**
 * A server that answers the attachment-by-name read with no attachment and
 * hands every POST to `upload`.
 */
export async function uploadPeer(
  upload: UploadHandler,
): Promise<{ base: string; server: Server; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ results: [] }));
      return;
    }
    upload(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
