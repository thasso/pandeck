/**
 * When a response has left this side (Task-1441 P7a, H1): each endpoint
 * calls a write's `onFlushed` exactly once, flushed, destroyed while pending
 * or written after close (t5), and a connection settles a handler's
 * `onSettled` only when every frame of its response did, never at the
 * connection's end alone. Only a handler that registered stays counted in
 * `serving` meanwhile (P7A-R3); `drainWithin` ends a connection whose
 * response stops draining (t4).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  WorkerConnection,
  WorkerRequestError,
  type ConnectionLimits,
  type MethodHandlers,
} from "./connection.ts";
import {
  createInProcessTransport,
  type ByteEndpoint,
} from "./inProcessTransport.ts";
import { socketEndpoint } from "./unixSocketTransport.ts";

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// --- endpoints (t5) -------------------------------------------------------

test("in process: onFlushed once after delivery, even when the listener throws, and once after close", async () => {
  const [a, b] = createInProcessTransport();
  const got: string[] = [];
  b.onData((bytes) => {
    got.push(Buffer.from(bytes).toString());
    if (got.length === 2) throw new Error("listener failure");
  });
  const calls: string[] = [];
  const onError = (err: unknown) => {
    if (!(err instanceof Error && err.message === "listener failure"))
      throw err;
  };
  process.on("uncaughtException", onError);
  cleanups.push(() => process.off("uncaughtException", onError));
  a.write(Buffer.from("one"), () => calls.push(`one after ${got.length}`));
  a.write(Buffer.from("two"), () => calls.push(`two after ${got.length}`));
  assert.equal(calls.length, 0, "never synchronously");
  await tick();
  assert.deepEqual(calls, ["one after 1", "two after 2"]);
  a.close();
  a.write(Buffer.from("late"), () => calls.push("late"));
  assert.equal(calls.length, 2);
  await tick();
  assert.deepEqual(calls, ["one after 1", "two after 2", "late"]);
  assert.deepEqual(got, ["one", "two"]);
});

/** A connected socket pair over a Unix socket; `server` is the endpoint's. */
async function socketPair(): Promise<{
  server: net.Socket;
  client: net.Socket;
}> {
  const dir = mkdtempSync(join(tmpdir(), "rs-"));
  dirs.push(dir);
  const path = join(dir, "s.sock");
  const listener = net.createServer();
  const accepted = new Promise<net.Socket>((resolve) =>
    listener.once("connection", resolve),
  );
  await new Promise<void>((resolve) => listener.listen(path, resolve));
  const client = net.createConnection(path);
  const server = await accepted;
  listener.close();
  cleanups.push(() => {
    client.destroy();
    server.destroy();
  });
  return { server, client };
}

test("socket: onFlushed once on flush, once at close while pending, once after close", async () => {
  const { server, client } = await socketPair();
  const endpoint = socketEndpoint(server);
  endpoint.onData(() => {});
  let flushedSmall = 0;
  endpoint.write(Buffer.from("small"), () => flushedSmall++);
  await until(() => flushedSmall === 1);

  // The reader stops: a large write cannot drain.
  client.pause();
  let flushedLarge = 0;
  endpoint.write(Buffer.alloc(64 * 1024 * 1024), () => flushedLarge++);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(flushedLarge, 0, "a paused reader keeps the write pending");
  let closed = false;
  endpoint.onClose(() => {
    closed = true;
  });
  // A logical close: end, then destroy at the grace's end, then `close`.
  endpoint.close();
  await until(() => closed, 3_000);
  assert.equal(flushedLarge, 1);

  let flushedLate = 0;
  endpoint.write(Buffer.from("late"), () => flushedLate++);
  assert.equal(flushedLate, 0, "never synchronously");
  await tick();
  assert.equal(flushedLate, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual([flushedSmall, flushedLarge, flushedLate], [1, 1, 1]);
});

test("socket: the peer going away settles a pending write once", async () => {
  const { server, client } = await socketPair();
  const endpoint = socketEndpoint(server);
  endpoint.onData(() => {});
  client.pause();
  let flushed = 0;
  endpoint.write(Buffer.alloc(64 * 1024 * 1024), () => flushed++);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(flushed, 0);
  client.destroy();
  await until(() => flushed === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(flushed, 1);
});

// --- connections ----------------------------------------------------------

/**
 * An in-process pair whose server end holds every `onFlushed` until the test
 * releases it, as a socket whose reader stopped would.
 */
function heldPair(): {
  server: ByteEndpoint;
  worker: ByteEndpoint;
  held: (() => void)[];
  release(): void;
} {
  const [server, worker] = createInProcessTransport();
  const held: (() => void)[] = [];
  return {
    server: {
      ...server,
      write(bytes, onFlushed) {
        server.write(bytes);
        if (onFlushed) held.push(onFlushed);
      },
    },
    worker,
    held,
    release() {
      for (const fn of held.splice(0)) fn();
    },
  };
}

function connect(
  pair: { server: ByteEndpoint; worker: ByteEndpoint },
  handlers: MethodHandlers,
  limits?: ConnectionLimits,
): { server: WorkerConnection; worker: WorkerConnection } {
  const server = new WorkerConnection(pair.server, {
    handshake: { role: "server", admit: () => undefined },
    handlers,
    ...(limits ? { limits } : {}),
  });
  const worker = new WorkerConnection(pair.worker, {
    handshake: { role: "worker", workerId: "w" },
  });
  cleanups.push(() => {
    server.end("test over");
    worker.end("test over");
  });
  return { server, worker };
}

const LIMITS: ConnectionLimits = {
  maxMessageBytes: 64 * 1024 * 1024,
  maxBufferedBytes: 64 * 1024 * 1024,
  maxPartialMessages: 8,
  maxServing: 1,
};

test("onSettled fires once every frame of the response flushed, not when the handler finished", async () => {
  const pair = heldPair();
  const events: string[] = [];
  const { worker } = connect(pair, {
    big: (_payload, _signal, context) => {
      context?.onSettled(() => events.push("settled"));
      return Promise.resolve({
        bytes: { file: new Uint8Array(3 * 1024 * 1024 + 5) },
      });
    },
  });
  const answer = await worker.request("big", {});
  assert.equal(answer.bytes?.file?.byteLength, 3 * 1024 * 1024 + 5);
  assert.equal(events.length, 0, "the answer arrived; nothing flushed yet");
  assert.ok(pair.held.length >= 4, "one callback per frame");
  // Releasing all but the last frame does not settle.
  const last = pair.held.pop()!;
  pair.release();
  assert.equal(events.length, 0);
  last();
  assert.deepEqual(events, ["settled"]);
  last();
  assert.deepEqual(events, ["settled"], "settles once");
});

test("a registered request stays counted under maxServing until its response settles; an unregistered one does not (R3)", async () => {
  const pair = heldPair();
  const { worker } = connect(
    pair,
    {
      registered: (_payload, _signal, context) => {
        context?.onSettled(() => {});
        return Promise.resolve({ json: "r" });
      },
      plain: () => Promise.resolve({ json: "p" }),
    },
    LIMITS,
  );
  assert.equal((await worker.request("plain", {})).json, "p");
  assert.equal(
    (await worker.request("plain", {})).json,
    "p",
    "an unregistered answer frees its slot when its handler finishes",
  );
  pair.release();
  assert.equal((await worker.request("registered", {})).json, "r");
  await assert.rejects(
    worker.request("plain", {}),
    (err: unknown) => err instanceof WorkerRequestError && err.code === "busy",
    "the registered response has not flushed: still counted",
  );
  pair.release();
  assert.equal((await worker.request("plain", {})).json, "p");
});

test("a handler that finishes after the connection ended settles at that finish, writing nothing (t3)", async () => {
  const pair = heldPair();
  let finish = (): void => {};
  const events: string[] = [];
  const { server, worker } = connect(pair, {
    slow: (_payload, _signal, context) => {
      context?.onSettled(() => events.push("settled"));
      return new Promise((resolve) => {
        finish = () => resolve({ bytes: { file: new Uint8Array(10) } });
      });
    },
  });
  const pending = worker.request("slow", {}).catch(() => "ended");
  await until(() => events.length === 0 && finish.toString() !== "() => {}");
  await tick();
  server.end("gone");
  assert.equal(await pending, "ended");
  assert.equal(events.length, 0, "the end alone does not settle");
  const heldBefore = pair.held.length;
  finish();
  await tick();
  assert.deepEqual(events, ["settled"]);
  assert.equal(pair.held.length, heldBefore, "no frame was written");
});

test("the connection's end does not settle a written response; its flush does", async () => {
  const pair = heldPair();
  const events: string[] = [];
  const { server, worker } = connect(pair, {
    big: (_payload, _signal, context) => {
      context?.onSettled(() => events.push("settled"));
      return Promise.resolve({ bytes: { file: new Uint8Array(10) } });
    },
  });
  await worker.request("big", {});
  server.end("logical end");
  await tick();
  assert.equal(events.length, 0);
  pair.release();
  assert.deepEqual(events, ["settled"]);
});

test("drainWithin ends the connection when the response does not flush in time (t4)", async () => {
  const pair = heldPair();
  const { server, worker } = connect(pair, {
    big: (_payload, _signal, context) => {
      context?.onSettled(() => {});
      context?.drainWithin(50, "a file answer did not drain");
      return Promise.resolve({ bytes: { file: new Uint8Array(10) } });
    },
    quick: (_payload, _signal, context) => {
      context?.onSettled(() => {});
      context?.drainWithin(50, "never");
      return Promise.resolve({ json: 1 });
    },
  });
  await worker.request("quick", {});
  pair.release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.isEnded, false, "a flushed response stops the bound");
  await worker.request("big", {});
  assert.equal(await server.ended, "a file answer did not drain");
});
