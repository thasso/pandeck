import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { MAX_FRAME_PAYLOAD_BYTES } from "./codec.ts";
import { WorkerConnection } from "./connection.ts";
import type { ByteEndpoint } from "./inProcessTransport.ts";
import { dialUnixSocket, listenUnixSocket } from "./unixSocketTransport.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Socket paths must stay under 108 bytes: a short directory in TMPDIR. */
function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "us-"));
  dirs.push(dir);
  return join(dir, "s.sock");
}

test("a socket endpoint carries a connection both ways, a message over one frame included, and both ends see the close", async () => {
  const path = socketPath();
  let listenerEnd: Promise<string> | undefined;
  const listener = await listenUnixSocket(path, (endpoint: ByteEndpoint) => {
    const connection = new WorkerConnection(endpoint, {
      handshake: { role: "server", admit: () => undefined },
      handlers: {
        echo: (payload) => Promise.resolve(payload),
      },
    });
    listenerEnd = connection.ended;
  });
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const dialer = new WorkerConnection(await dialUnixSocket(path), {
      handshake: { role: "worker", workerId: "test" },
    });
    // Larger than one frame, so the codec splits it and the reader joins the
    // stream's chunks back together.
    const big = new Uint8Array(MAX_FRAME_PAYLOAD_BYTES * 2 + 17);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    const answer = await dialer.request("echo", {
      json: { hello: "socket" },
      bytes: { big },
    });
    assert.deepEqual(answer.json, { hello: "socket" });
    assert.ok(Buffer.from(big).equals(Buffer.from(answer.bytes?.big ?? [])));
    dialer.end("done");
    assert.equal(await dialer.ended, "done");
    assert.ok(listenerEnd);
    assert.equal(await listenerEnd, "the peer closed the connection");
  } finally {
    await listener.close();
  }
  assert.equal(existsSync(path), false, "close removes the socket file");
});

test("listening refuses a socket another process answers on and replaces a stale file", async () => {
  const path = socketPath();
  const first = await listenUnixSocket(path, () => {});
  await assert.rejects(
    listenUnixSocket(path, () => {}),
    /Another process listens on/,
  );
  await first.close();

  // A file no one answers on, as a killed process leaves it.
  writeFileSync(path, "");
  const second = await listenUnixSocket(path, () => {});
  const dialed = await dialUnixSocket(path);
  dialed.close();
  await second.close();
});

test("overlapping stale recovery has one owner even through a path alias", async () => {
  const path = socketPath();
  writeFileSync(path, "");
  const aliasDir = join(path, "..", "alias");
  symlinkSync(join(path, ".."), aliasDir);
  const alias = join(aliasDir, "s.sock");
  const starts = await Promise.allSettled([
    listenUnixSocket(path, () => {}),
    listenUnixSocket(alias, () => {}),
  ]);
  try {
    assert.equal(
      starts.filter((start) => start.status === "fulfilled").length,
      1,
    );
    (await dialUnixSocket(path)).close();
  } finally {
    for (const start of starts)
      if (start.status === "fulfilled") await start.value.close();
  }
  const restarted = await listenUnixSocket(path, () => {});
  await Promise.all([restarted.close(), restarted.close()]);
  assert.equal(existsSync(path), false);
});

test("an unclaimed foreign live listener is refused without changing its path or retaining the ownership claim", async () => {
  const path = socketPath();
  const foreign = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => foreign.listen(path, resolve));
  try {
    await assert.rejects(
      listenUnixSocket(path, () => {}),
      /Another process listens on/,
    );
    (await dialUnixSocket(path)).close();
  } finally {
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }
  const next = await listenUnixSocket(path, () => {});
  await next.close();
});

test("a dial with no listener rejects", async () => {
  await assert.rejects(dialUnixSocket(socketPath()));
});
