/**
 * The streamed upload body (Task-1441 P8a): byte equality with Node's own
 * `FormData` serialization (v04 V2, v05 W4), the digest check before the tail,
 * per-piece copies for every input type (v07 Y1/Y2), and the owned lifecycle
 * (v05 W1) with the retention oracles and their control (v06 X1, v07 Y3).
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  MIB,
  arrayBuffersNow,
  patterned,
  retentionControl,
  settleGc,
} from "../test/forcedGc.ts";
import {
  multipartUpload,
  type MultipartUpload,
  type MultipartUploadInput,
} from "./multipartUpload.ts";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Every chunk the stream yields, in order, and their concatenation. */
async function drain(
  upload: MultipartUpload,
): Promise<{ chunks: Uint8Array[]; body: Buffer }> {
  const chunks: Uint8Array[] = [];
  const reader = upload.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return { chunks, body: Buffer.concat(chunks) };
}

/**
 * What Node's `FormData` sends for today's form (the form
 * `executeAttachmentChange` built before P8a), with its boundary replaced by
 * `boundary`. Never derived from the new encoder.
 */
async function formDataBody(
  input: Omit<MultipartUploadInput, "sha256">,
  boundary: string,
): Promise<Buffer> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(input.bytes)], {
      type: input.mediaType || "application/octet-stream",
    }),
    input.fileName,
  );
  for (const [name, value] of input.fields) form.append(name, value);
  const response = new Response(form);
  const theirs = /boundary=(.+)$/.exec(
    response.headers.get("content-type") ?? "",
  )?.[1];
  if (!theirs) throw new Error("FormData answered no boundary");
  const raw = Buffer.from(await response.arrayBuffer());
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const next = raw.indexOf(theirs, at, "latin1");
    if (next < 0) break;
    parts.push(raw.subarray(at, next), Buffer.from(boundary, "latin1"));
    at = next + theirs.length;
  }
  parts.push(raw.subarray(at));
  return Buffer.concat(parts);
}

const boundaryOf = (upload: MultipartUpload): string =>
  /boundary=(.+)$/.exec(upload.contentType)![1]!;

interface OracleCase {
  name: string;
  input: Omit<MultipartUploadInput, "sha256">;
}

const BASE: Omit<MultipartUploadInput, "sha256"> = {
  bytes: patterned(10),
  fileName: "notes.txt",
  mediaType: "text/plain",
  fields: [["minorEdit", "true"]],
};

const ORACLE: OracleCase[] = [
  ...[
    "notes.txt",
    'quote".txt',
    "cr\r.txt",
    "lf\n.txt",
    "crlf\r\n.txt",
    "café.txt",
    "😀.png",
    "lone\uD800.txt",
  ].map((fileName) => ({
    name: `file name ${JSON.stringify(fileName)}`,
    input: { ...BASE, fileName },
  })),
  ...[
    "",
    "Image/PNG",
    "text/plain\r\nX-Bad: 1",
    "tëxt/plain",
    null,
    undefined,
  ].map((mediaType) => ({
    name: `media type ${JSON.stringify(mediaType)}`,
    input: { ...BASE, mediaType },
  })),
  ...[
    "line\nfeed",
    "crlf\r\nline",
    "lone\rcr",
    "ünïcode ✓",
    "lone\uDC00surrogate",
  ].map((comment) => ({
    name: `comment ${JSON.stringify(comment)}`,
    input: {
      ...BASE,
      fields: [
        ["minorEdit", "true"],
        ["comment", comment],
      ] as const,
    },
  })),
  ...['na"me', "na\rme", "na\nme", "na\r\nme"].map((field) => ({
    name: `field name ${JSON.stringify(field)}`,
    input: { ...BASE, fields: [[field, "v"]] as const },
  })),
  ...[1, MIB, MIB + 1, 3 * MIB + 5].map((size) => ({
    name: `size ${size}`,
    input: { ...BASE, bytes: patterned(size, size) },
  })),
];

describe("byte equality with Node's FormData", () => {
  test.each(ORACLE.map((oracle) => [oracle.name, oracle] as const))(
    "%s",
    async (_name, { input }) => {
      const upload = multipartUpload({ ...input, sha256: sha256(input.bytes) });
      const { body } = await drain(upload);
      expect(body.equals(await formDataBody(input, boundaryOf(upload)))).toBe(
        true,
      );
      expect(upload.contentLength).toBe(body.byteLength);
      expect(upload.state).toBe("completed");
    },
  );

  test("the boundary is fresh and random", () => {
    const one = multipartUpload({ ...BASE, sha256: sha256(BASE.bytes) });
    const two = multipartUpload({ ...BASE, sha256: sha256(BASE.bytes) });
    expect(boundaryOf(one)).toMatch(/^----pandeck-upload-[0-9a-f]{32}$/);
    expect(boundaryOf(one)).not.toBe(boundaryOf(two));
    one.retire();
    two.retire();
  });

  test("a digest that is not 64 lowercase hex is a programming error", () => {
    for (const digest of ["", "A".repeat(64), "a".repeat(63)])
      expect(() => multipartUpload({ ...BASE, sha256: digest })).toThrow(
        TypeError,
      );
  });
});

describe("the digest is checked before the tail", () => {
  test("a wrong digest errors after the last file byte, before any byte of the tail", async () => {
    const bytes = patterned(3 * MIB + 5, 7);
    const upload = multipartUpload({
      ...BASE,
      bytes,
      sha256: sha256(patterned(10, 99)),
    });
    const emitted: Uint8Array[] = [];
    const reader = upload.stream.getReader();
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          emitted.push(value);
        }
      })(),
    ).rejects.toThrow(/do not match the approved digest/);
    const body = Buffer.concat(emitted);
    const head = body.byteLength - bytes.byteLength;
    expect(head).toBeGreaterThan(0);
    // The last emitted byte is the file's last byte: no CRLF, no field, no
    // closing boundary.
    expect(body.subarray(head).equals(bytes)).toBe(true);
    expect(body.includes(`${boundaryOf(upload)}--`, 0, "latin1")).toBe(false);
    expect(upload.state).toBe("errored");
  });
});

/** Y2's three sources, each 2 MiB + 3 patterned bytes, at least 4 KiB. */
function sources(): [string, Uint8Array][] {
  const size = 2 * MIB + 3;
  const plain = patterned(size, 11);
  const concatenated = Buffer.concat(
    [0, 1, 2].map((part) => {
      const piece = Buffer.alloc(part === 2 ? size - 2 * MIB : MIB);
      piece.set(patterned(piece.byteLength, 20 + part));
      return piece;
    }),
  );
  const larger = Buffer.from(patterned(size + 4099, 31));
  const view = larger.subarray(4099);
  return [
    ["a plain Uint8Array", plain],
    ["a Buffer built like readUploadBytes's", concatenated],
    ["a Buffer view past offset 0", view],
  ];
}

describe("every file piece is a fresh copy", () => {
  test.each(sources())("%s", async (_name, source) => {
    expect(source.byteLength).toBeGreaterThanOrEqual(4096);
    if (_name.includes("view")) expect(source.byteOffset).toBeGreaterThan(0);
    const input = { ...BASE, bytes: source };
    const upload = multipartUpload({ ...input, sha256: sha256(source) });
    const { chunks, body } = await drain(upload);
    const head = chunks[0]!.byteLength;
    const files = chunks.slice(1, -1);
    expect(files.length).toBe(3);
    for (const chunk of files) {
      expect(chunk.buffer).not.toBe(source.buffer);
      expect(chunk.byteOffset).toBe(0);
      expect(chunk.byteLength).toBeLessThanOrEqual(MIB);
      expect(Object.getPrototypeOf(chunk)).toBe(Uint8Array.prototype);
    }
    expect(Buffer.concat(files).equals(source)).toBe(true);
    expect(body.subarray(head, head + source.byteLength).equals(source)).toBe(
      true,
    );
    expect(body.equals(await formDataBody(input, boundaryOf(upload)))).toBe(
      true,
    );
  });
});

describe("the owned lifecycle", () => {
  const small = () => {
    const bytes = patterned(2 * MIB + 3);
    return multipartUpload({ ...BASE, bytes, sha256: sha256(bytes) });
  };

  test("completion: completed; a later retire keeps the state and aborts the signal", async () => {
    const upload = small();
    await drain(upload);
    expect(upload.state).toBe("completed");
    expect(upload.signal.aborted).toBe(false);
    upload.retire();
    expect(upload.state).toBe("completed");
    expect(upload.signal.aborted).toBe(true);
  });

  test("a consumer cancel: cancelled", async () => {
    const upload = small();
    const reader = upload.stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(upload.state).toBe("cancelled");
    upload.retire();
    expect(upload.state).toBe("cancelled");
  });

  test("retire while pending, with an active reader: the reader fails, errored, signal aborted", async () => {
    const upload = small();
    const reader = upload.stream.getReader();
    await reader.read();
    await reader.read();
    upload.retire();
    expect(upload.state).toBe("errored");
    expect(upload.signal.aborted).toBe(true);
    await expect(reader.read()).rejects.toThrow(/retired/);
    await expect(reader.closed).rejects.toThrow(/retired/);
  });

  test("retire twice leaves the state unchanged", () => {
    const upload = small();
    upload.retire();
    upload.retire();
    expect(upload.state).toBe("errored");
  });
});

/**
 * Retention (v06 X1, X2, v07 Y3): each case has one source allocation, made
 * after the baseline and held only by the upload; the test keeps a `WeakRef`
 * to its backing `ArrayBuffer` and nothing else. The control runs first.
 */
describe("a terminal body keeps none of the source", () => {
  const SIZE = 16 * MIB;

  test("control: a retained 1-byte view is seen, and dropping it clears both oracles", async () => {
    const control = await retentionControl();
    expect(control.retainedVisible).toBe(true);
    expect(control.retainedArrayBuffers).toBeGreaterThanOrEqual(90 * MIB);
    expect(control.clearedAfterDrop).toBe(true);
    expect(control.arrayBuffersAfterDrop).toBeLessThanOrEqual(2 * MIB);
  });

  type Source = () => Uint8Array;
  const plain: Source = () => patterned(SIZE, 41);
  /** Source 2 of Y2: the runtime type the local path delivers. */
  const concatenated: Source = () => {
    const source = Buffer.concat([
      Buffer.from(patterned(SIZE / 2, 42)),
      Buffer.from(patterned(SIZE / 2 + 3, 43)),
    ]);
    if (source.buffer.byteLength !== source.byteLength)
      throw new Error("the Buffer fixture shares a pool allocation");
    return source;
  };

  type Ending = (upload: MultipartUpload) => Promise<void>;
  const ENDINGS: [string, boolean, Ending][] = [
    ["completed", true, async (upload) => void (await drain(upload))],
    [
      "errored on a digest mismatch",
      false,
      async (upload) => {
        await drain(upload).catch(() => undefined);
      },
    ],
    [
      "cancelled",
      true,
      async (upload) => {
        const reader = upload.stream.getReader();
        await reader.read();
        await reader.read();
        await reader.cancel();
      },
    ],
    [
      "retired while pending",
      true,
      async (upload) => {
        const reader = upload.stream.getReader();
        await reader.read();
        await reader.read();
        upload.retire();
        await reader.closed.catch(() => undefined);
      },
    ],
  ];

  const CASES = ENDINGS.flatMap(([ending, matching, end]) =>
    (
      [
        ["a plain Uint8Array", plain],
        ["a Buffer source", concatenated],
      ] as const
    ).map(
      ([kind, source]) =>
        [`${ending}, ${kind}`, matching, end, source] as const,
    ),
  );

  test.each(CASES)("%s", async (_name, matching, end, source) => {
    await settleGc();
    const baseline = arrayBuffersNow();
    const { upload, target } = ((): {
      upload: MultipartUpload;
      target: WeakRef<ArrayBufferLike>;
    } => {
      const bytes = source();
      return {
        upload: multipartUpload({
          ...BASE,
          bytes,
          sha256: matching ? sha256(bytes) : "0".repeat(64),
        }),
        target: new WeakRef(bytes.buffer),
      };
    })();
    await end(upload);
    expect(upload.state).not.toBe("pending");
    await settleGc();
    expect(target.deref()).toBeUndefined();
    expect(arrayBuffersNow() - baseline).toBeLessThanOrEqual(2 * MIB);
    // The upload itself is still alive: it, not its collection, let go.
    expect(upload.contentLength).toBeGreaterThan(SIZE);
  });
});
