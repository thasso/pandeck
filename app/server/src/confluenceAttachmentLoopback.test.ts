/**
 * The streamed upload against a real local HTTP peer, on Node (Task-1441 P8a):
 *
 * - v04 V2 / v06 X5: a 100 MiB `confluencePost` arrives whole with
 *   Content-Length framing and a matching digest, while the live
 *   arrayBuffers + heapUsed delta, sampled after a forced GC at every 10th
 *   pull, stays within 16 MiB;
 * - v05 W1: the shared executor in the five peer scenarios (normal, early
 *   200, early 400, a paused peer under a deadline, a mid-body close), each
 *   ending in a terminal body before the executor settles, the source
 *   released after settlement, and the peer seeing its connection end.
 *
 * Retention follows v06 X1/X2: one source allocation per case, made after
 * the baseline and watched only through a `WeakRef` to its `ArrayBuffer`;
 * the control runs first.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomFillSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { ConfluencePageMutationItemDisplay } from "@assistant/shared";
import { AtlassianHttpError } from "./atlassian/atlassianFetch.ts";
import { confluencePost } from "./atlassian/confluenceClient.ts";
import type { MultipartUpload } from "./atlassian/multipartUpload.ts";
import {
  BODY_NOT_COMPLETED,
  executeAttachmentChange,
} from "./confluenceAttachmentChange.ts";
import { ConfluenceMutationError } from "./confluenceMutationErrors.ts";
import {
  MIB,
  arrayBuffersNow,
  forceGc,
  retentionControl,
  settleGc,
} from "./test/forcedGc.ts";
import {
  hasClosingBoundary,
  uploadPeer,
  type UploadHandler,
} from "./test/multipartSink.ts";

/** Every body the shared core built, to read its state at settlement. */
const built = vi.hoisted(() => [] as MultipartUpload[]);

vi.mock("./atlassian/multipartUpload.ts", async (importActual) => {
  const actual =
    await importActual<typeof import("./atlassian/multipartUpload.ts")>();
  return {
    ...actual,
    multipartUpload: (input: Parameters<typeof actual.multipartUpload>[0]) => {
      const upload = actual.multipartUpload(input);
      built.push(upload);
      return upload;
    },
  };
});

const { multipartUpload } = await import("./atlassian/multipartUpload.ts");

const peers: { close(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(peers.map((peer) => peer.close()));
});

const configFor = (base: string) => ({
  host: base,
  atlassianEmail: "loopback@example.com",
  atlassianToken: "loopback-token",
});

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Fresh random bytes: one allocation, made by the caller's scope. */
function randomSource(size: number): Uint8Array {
  return randomFillSync(new Uint8Array(size));
}

test("control: a retained 1-byte view is seen, and dropping it clears both oracles", async () => {
  const control = await retentionControl();
  expect(control.retainedVisible).toBe(true);
  expect(control.retainedArrayBuffers).toBeGreaterThanOrEqual(90 * MIB);
  expect(control.clearedAfterDrop).toBe(true);
  expect(control.arrayBuffersAfterDrop).toBeLessThanOrEqual(2 * MIB);
});

/**
 * The 100 MiB peer runs in its own process, so its socket and parse buffers
 * stay out of the sender's live figure.
 */
async function peerProcess(): Promise<{
  base: string;
  uploads: { length?: string; chunked: boolean; digest?: string }[];
  child: ChildProcess;
}> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./test/multipartPeerFixture.ts", import.meta.url)),
    ],
    { env: process.env, stdio: ["ignore", "pipe", "inherit"] },
  );
  peers.push({
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    },
  });
  const uploads: { length?: string; chunked: boolean; digest?: string }[] = [];
  const port = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      if (line.startsWith("ready ")) resolve(line.slice(6));
      else if (line.startsWith("upload "))
        uploads.push(JSON.parse(line.slice(7)) as (typeof uploads)[number]);
    });
    child.once("exit", (code) =>
      reject(new Error(`the peer exited early: ${code}`)),
    );
  });
  return { base: `http://127.0.0.1:${port}`, uploads, child };
}

test("100 MiB arrives whole with Content-Length framing, within 16 MiB live", async () => {
  const peer = await peerProcess();
  await settleGc();
  const baseline = arrayBuffersNow();
  let livePeak = 0;
  let expected = "";
  let contentLength = 0;
  let state = "";
  const target = await (async () => {
    const source = randomSource(100 * MIB);
    expected = sha256(source);
    const upload = multipartUpload({
      bytes: source,
      sha256: expected,
      fileName: "big.bin",
      mediaType: "application/octet-stream",
      fields: [["minorEdit", "true"]],
    });
    contentLength = upload.contentLength;
    // The transfer's own live figure: the source is part of the baseline.
    await settleGc();
    const live = process.memoryUsage();
    const liveBase = live.arrayBuffers + live.heapUsed;
    const reader = upload.stream.getReader();
    let pulls = 0;
    // Sample inside every 10th pull, after a forced GC (v06 X5).
    Object.defineProperty(upload, "stream", {
      value: new ReadableStream<Uint8Array>({
        async pull(controller) {
          pulls += 1;
          if (pulls % 10 === 0) {
            forceGc();
            const now = process.memoryUsage();
            livePeak = Math.max(
              livePeak,
              now.arrayBuffers + now.heapUsed - liveBase,
            );
          }
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel: (reason) => reader.cancel(reason),
      }),
    });
    try {
      await confluencePost(
        configFor(peer.base),
        "/wiki/rest/api/content/1/child/attachment",
        upload,
      );
    } finally {
      upload.retire();
    }
    state = upload.state;
    return new WeakRef(source.buffer);
  })();

  expect(state).toBe("completed");
  // The answer is written after the peer's line, so the line is in.
  await new Promise((resolve) => setImmediate(resolve));
  expect(peer.uploads).toEqual([
    {
      length: String(contentLength),
      chunked: false,
      digest: expected,
      closed: true,
      received: contentLength,
    },
  ]);
  expect(livePeak).toBeLessThanOrEqual(16 * MIB);
  await settleGc();
  expect(target.deref()).toBeUndefined();
  expect(arrayBuffersNow() - baseline).toBeLessThanOrEqual(2 * MIB);
}, 120_000);

// ---------------------------------------------------------------------------
// W1's scenarios through the shared executor.

const SIZE = 64 * MIB;

interface Scenario {
  name: string;
  handler: (peer: PeerLog) => UploadHandler;
  deadlineMs?: number;
  outcome: (error: unknown) => void;
  /** Whether the peer stopped reading and must see the end after resuming. */
  paused: boolean;
}

/** What the peer saw of one upload. */
interface PeerLog {
  request?: IncomingMessage;
  response?: ServerResponse;
  contentType: string;
  bytes: Buffer[];
}

/** Answers `status` after the headers and 1 MiB, then stops reading. */
const answersEarly =
  (status: number) =>
  (log: PeerLog): UploadHandler =>
  (request, response) => {
    log.request = request;
    log.contentType = request.headers["content-type"] ?? "";
    let seen = 0;
    const onData = (chunk: Buffer) => {
      log.bytes.push(chunk);
      seen += chunk.byteLength;
      if (seen < MIB) return;
      request.off("data", onData);
      request.pause();
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          status === 200 ? { results: [{ id: "att9" }] } : { message: "no" },
        ),
      );
    };
    request.on("data", onData);
  };

const SCENARIOS: Scenario[] = [
  {
    name: "(a) normal",
    paused: false,
    handler: (log) => (request, response) => {
      log.contentType = request.headers["content-type"] ?? "";
      request.on("data", (chunk: Buffer) => {
        if (log.bytes.length === 0) log.bytes.push(chunk);
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ results: [{ id: "att9", version: { number: 1 } }] }),
        );
      });
    },
    outcome: (error) => expect(error).toBeUndefined(),
  },
  {
    name: "(b) an early 200",
    paused: true,
    handler: answersEarly(200),
    outcome: (error) => {
      expect(error).toBeInstanceOf(ConfluenceMutationError);
      expect((error as Error).message).toBe(BODY_NOT_COMPLETED);
    },
  },
  {
    name: "(c) an early 400",
    paused: true,
    handler: answersEarly(400),
    outcome: (error) => {
      expect(error).toBeInstanceOf(AtlassianHttpError);
      expect((error as AtlassianHttpError).status).toBe(400);
    },
  },
  {
    name: "(d) a paused peer under a 2 s deadline",
    paused: true,
    deadlineMs: 2_000,
    handler: (log) => (request) => {
      log.request = request;
      log.contentType = request.headers["content-type"] ?? "";
      request.pause();
    },
    outcome: (error) => {
      expect((error as Error).name).toMatch(/AbortError|TimeoutError/);
    },
  },
  {
    name: "(e) a close after 50 MiB",
    paused: false,
    handler: (log) => (request) => {
      log.contentType = request.headers["content-type"] ?? "";
      let seen = 0;
      request.on("data", (chunk: Buffer) => {
        seen += chunk.byteLength;
        if (seen >= 50 * MIB) request.socket.destroy();
      });
    },
    outcome: (error) => {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ConfluenceMutationError);
      expect(error).not.toBeInstanceOf(AtlassianHttpError);
    },
  },
];

describe("the shared executor's upload against a local peer", () => {
  test.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
    "%s",
    async (_name, scenario) => {
      const log: PeerLog = { contentType: "", bytes: [] };
      const peer = await uploadPeer(scenario.handler(log));
      peers.push(peer);
      built.length = 0;
      await settleGc();
      const baseline = arrayBuffersNow();
      const deadline = new AbortController();
      const timer =
        scenario.deadlineMs === undefined
          ? undefined
          : setTimeout(() => deadline.abort(), scenario.deadlineMs);
      let stateAtSettlement: string | undefined;
      let failure: unknown;
      const target = await (async () => {
        const source = randomSource(SIZE);
        const item: ConfluencePageMutationItemDisplay = {
          clientId: "cfl_0",
          operation: "uploadAttachment",
          pageId: "123",
          attachment: {
            fileName: "big.bin",
            mediaType: "application/octet-stream",
            size: SIZE,
            sha256: sha256(source),
            stagedAttachmentId: "staged-1",
          },
        };
        let bytes: Uint8Array | undefined = source;
        const running = executeAttachmentChange(configFor(peer.base), item, {
          ...(scenario.deadlineMs === undefined
            ? {}
            : { signal: deadline.signal }),
          stagedBytes: async () => {
            const handed = bytes!;
            bytes = undefined;
            return handed;
          },
        });
        // The first reaction to the executor's settlement reads the state.
        await running.then(
          () => {
            stateAtSettlement = built[0]?.state;
          },
          (error: unknown) => {
            stateAtSettlement = built[0]?.state;
            failure = error;
          },
        );
        return new WeakRef(source.buffer);
      })();
      clearTimeout(timer);

      scenario.outcome(failure);
      // Terminal before the executor settled: completed only when normal.
      if (scenario.name.startsWith("(a)"))
        expect(stateAtSettlement).toBe("completed");
      else expect(["errored", "cancelled"]).toContain(stateAtSettlement);

      if (scenario.paused) {
        // Resumed, the peer sees its connection end within 2 s and never a
        // closing boundary.
        const request = log.request!;
        const ended = new Promise<void>((resolve) => {
          request.socket.once("close", () => resolve());
          request.once("end", () => resolve());
          request.once("aborted", () => resolve());
          request.once("error", () => resolve());
        });
        request.on("data", (chunk: Buffer) => log.bytes.push(chunk));
        request.resume();
        await expect(
          Promise.race([
            ended.then(() => "ended"),
            new Promise((resolve) => setTimeout(() => resolve("open"), 2_000)),
          ]),
        ).resolves.toBe("ended");
        expect(
          hasClosingBoundary(Buffer.concat(log.bytes), log.contentType),
        ).toBe(false);
      }
      log.bytes.length = 0;
      await settleGc();
      expect(target.deref()).toBeUndefined();
      expect(arrayBuffersNow() - baseline).toBeLessThanOrEqual(2 * MIB);
      built.length = 0;
    },
    60_000,
  );
});
