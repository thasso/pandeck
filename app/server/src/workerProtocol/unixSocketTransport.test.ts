import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "vitest";
import { MAX_FRAME_PAYLOAD_BYTES } from "./codec.ts";
import { WorkerConnection } from "./connection.ts";
import type { ByteEndpoint } from "./inProcessTransport.ts";
import { dialUnixSocket, listenUnixSocket } from "./unixSocketTransport.ts";
import { leaveStaleUnixSocket } from "../test/staleSocket.ts";

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

function fileClaim(path: string): { identity: string; directory: string } {
  const canonical = join(realpathSync(dirname(path)), basename(path));
  const identity = createHash("sha256").update(canonical).digest("hex");
  return {
    identity,
    directory: join(dirname(canonical), `.pandeck-socket-${identity}`),
  };
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

test("listening refuses a socket another process answers on and replaces a real stale socket", async () => {
  const path = socketPath();
  const first = await listenUnixSocket(path, () => {});
  await assert.rejects(
    listenUnixSocket(path, () => {}),
    /Another process listens on/,
  );
  await first.close();

  // A killed process leaves a socket inode; an arbitrary file is not stale.
  await leaveStaleUnixSocket(path);
  const second = await listenUnixSocket(path, () => {});
  const dialed = await dialUnixSocket(path);
  dialed.close();
  await second.close();
});

test("overlapping stale recovery has one owner even through a path alias", async () => {
  const path = socketPath();
  await leaveStaleUnixSocket(path);
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

test("distinct socket paths do not share ownership claims", async () => {
  const firstPath = socketPath();
  const secondPath = join(firstPath, "..", "preview.sock");
  const first = await listenUnixSocket(firstPath, () => {});
  const second = await listenUnixSocket(secondPath, () => {});
  try {
    (await dialUnixSocket(firstPath)).close();
    (await dialUnixSocket(secondPath)).close();
  } finally {
    await first.close();
    await second.close();
  }
});

test("non-Linux development retains stale replacement, live refusal and close", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const path = socketPath();
    await leaveStaleUnixSocket(path);
    const first = await listenUnixSocket(path, () => {});
    try {
      (await dialUnixSocket(path)).close();
      await assert.rejects(
        listenUnixSocket(path, () => {}),
        /Another process listens on/,
      );
    } finally {
      await first.close();
    }
    assert.equal(existsSync(path), false);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("Darwin release retains a tombstone and successors never reset the generation", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const path = socketPath();
  const claim = fileClaim(path);
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    for (let generation = 1; generation <= 3; generation += 1) {
      const owner = await listenUnixSocket(path, () => {});
      try {
        assert.deepEqual(readdirSync(claim.directory), [`claim.${generation}`]);
      } finally {
        await owner.close();
      }
      assert.deepEqual(
        readdirSync(claim.directory),
        [`claim.${generation}`],
        "release must not create an empty-directory reset race",
      );
      const record = JSON.parse(
        readFileSync(join(claim.directory, `claim.${generation}`), "utf8"),
      ) as { v: number; identity: string; port: number };
      assert.equal(record.v, 2);
      assert.equal(record.identity, claim.identity);
      assert.ok(Number.isInteger(record.port) && record.port > 0);
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test.each([0, 80, 1023, 65536, 12.5])(
  "Darwin refuses an invalid reservation port %s without probing or changing the claim",
  async (port) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const path = socketPath();
    const claim = fileClaim(path);
    mkdirSync(claim.directory, { mode: 0o700 });
    const recordPath = join(claim.directory, "claim.1");
    const body = JSON.stringify({ v: 2, identity: claim.identity, port });
    writeFileSync(recordPath, body, { mode: 0o600 });
    let unexpected: Awaited<ReturnType<typeof listenUnixSocket>> | undefined;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      await assert.rejects(
        async () => {
          unexpected = await listenUnixSocket(path, () => {});
        },
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Invalid socket ownership claim/);
          assert.ok(error.message.includes(recordPath));
          return true;
        },
      );
      assert.equal(existsSync(path), false);
      assert.equal(readFileSync(recordPath, "utf8"), body);
    } finally {
      await unexpected?.close();
      Object.defineProperty(process, "platform", platform);
    }
  },
);

test("a stale listing cannot publish below a live higher generation or touch the control socket", async () => {
  const path = socketPath();
  await leaveStaleUnixSocket(path);
  const claim = fileClaim(path);
  const module = new URL("./unixSocketTransport.ts", import.meta.url).href;
  // Confine the one-shot stale directory read and builtin-export sync to a
  // child. No parent/global mock, production seam, or fake kernel reservation.
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import fs from 'node:fs';
    import net from 'node:net';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { listenUnixSocket } from ${JSON.stringify(module)};
    const [path, dir, identity] = process.argv.slice(1);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalScan = fs.readdirSync;
    const held = [];
    const reserve = async () => {
      const server = net.createServer(socket => socket.destroy());
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({host: '127.0.0.1', port: 0, exclusive: true}, resolve);
      });
      return server;
    };
    let unexpected;
    try {
      const stale = await reserve();
      held.push(stale);
      const stalePort = stale.address().port;
      const active = await reserve();
      held.push(active);
      await new Promise(resolve => stale.close(resolve));
      fs.mkdirSync(dir, {mode: 0o700});
      for (const [generation, port] of [[5, stalePort], [7, active.address().port]]) {
        fs.writeFileSync(join(dir, 'claim.' + generation), JSON.stringify({v: 2, identity, port}), {flag: 'wx', mode: 0o600});
      }
      const before = fs.lstatSync(path, {bigint: true});
      let injected = false;
      fs.readdirSync = (target, ...options) => {
        if (target === dir && !injected) {
          injected = true;
          return ['claim.5'];
        }
        return Reflect.apply(originalScan, fs, [target, ...options]);
      };
      syncBuiltinESMExports();
      // Import/tsx initialization happened on the real platform already.
      Object.defineProperty(process, 'platform', {value: 'darwin'});
      let error = '';
      try { unexpected = await listenUnixSocket(path, () => {}); }
      catch (caught) { error = String(caught); }
      const after = fs.lstatSync(path, {bigint: true});
      process.stdout.write(JSON.stringify({accepted: !!unexpected, error, injected,
        sameControl: before.dev === after.dev && before.ino === after.ino,
        names: originalScan(dir).sort()}) + '\\n');
    } finally {
      fs.readdirSync = originalScan;
      syncBuiltinESMExports();
      Object.defineProperty(process, 'platform', platform);
      await unexpected?.close();
      for (const server of held) await new Promise(resolve => server.close(resolve));
    }
  `,
      path,
      claim.directory,
      claim.identity,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  let output = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  deadline.unref();
  try {
    const [code] = await exited;
    assert.equal(
      code,
      0,
      `stale-listing fixture failed or timed out: ${stderr}`,
    );
    const result = JSON.parse(output) as {
      accepted: boolean;
      error: string;
      injected: boolean;
      sameControl: boolean;
      names: string[];
    };
    assert.equal(result.injected, true);
    assert.equal(result.accepted, false);
    assert.match(result.error, /ownership claim was superseded/);
    assert.equal(result.sameControl, true);
    assert.deepEqual(result.names, ["claim.5", "claim.7"]);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  }
});

test.each(["immediate", "ancestor"] as const)(
  "Darwin refuses a non-sticky shared %s parent before creating a claim",
  async (kind) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    let path = socketPath();
    const shared = dirname(path);
    if (kind === "ancestor") {
      const nested = join(shared, "private");
      mkdirSync(nested, { mode: 0o700 });
      path = join(nested, basename(path));
    }
    const claim = fileClaim(path);
    chmodSync(shared, 0o777);
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      await assert.rejects(
        listenUnixSocket(path, () => {}),
        /Unsafe control socket parent/,
      );
      assert.equal(existsSync(path), false);
      assert.equal(existsSync(claim.directory), false);
    } finally {
      Object.defineProperty(process, "platform", platform);
      chmodSync(shared, 0o700);
    }
  },
);

test("a paused Darwin owner retains its reservation despite queued connections", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const path = socketPath();
  const claim = fileClaim(path);
  // Native fixture follows the publication contract but never imports tsx or
  // changes the child's platform. This exercises Darwin's backend on Linux too.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import net from 'node:net';
    import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [path, dir, identity] = process.argv.slice(1);
    mkdirSync(dir, {mode: 0o700});
    const reservation = net.createServer(socket => socket.destroy());
    await new Promise(resolve => reservation.listen({host: '127.0.0.1', port: 0, exclusive: true}, resolve));
    writeFileSync(join(dir, 'claim.1'), JSON.stringify({v: 2, identity, port: reservation.address().port}), {flag: 'wx', mode: 0o600});
    const control = net.createServer(socket => socket.destroy());
    await new Promise(resolve => control.listen(path, resolve));
    chmodSync(path, 0o600);
    process.stdout.write('ready\\n');
    process.stdin.once('data', () => {
      process.stdout.write('blocked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
    });
  `,
      path,
      claim.directory,
      claim.identity,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  let output = "";
  let stderr = "";
  const waiters = new Set<() => void>();
  child.stdout.on("data", (chunk: Buffer) => {
    output += String(chunk);
    for (const notify of waiters) notify();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });
  const waitFor = (marker: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(
          new Error(`reservation fixture did not reach ${marker}: ${stderr}`),
        );
      }, 10_000);
      const check = (): void => {
        if (output.includes(marker)) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve();
        }
      };
      waiters.add(check);
      check();
    });
  const clients: net.Socket[] = [];
  let unexpected: Awaited<ReturnType<typeof listenUnixSocket>> | undefined;
  try {
    await waitFor("ready\n");
    const before = lstatSync(path);
    const record = JSON.parse(
      readFileSync(join(claim.directory, "claim.1"), "utf8"),
    ) as { port: number };
    child.stdin.write("block\n");
    await waitFor("blocked\n");
    for (let n = 0; n < 192; n += 1) {
      const socket = net.createConnection({
        host: "127.0.0.1",
        port: record.port,
      });
      socket.on("error", () => {});
      clients.push(socket);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    Object.defineProperty(process, "platform", { value: "darwin" });
    await assert.rejects(async () => {
      unexpected = await listenUnixSocket(path, () => {});
    }, /Another process listens on/);
    assert.equal(
      lstatSync(path).ino,
      before.ino,
      "the paused owner's control socket must remain unchanged",
    );
    assert.deepEqual(readdirSync(claim.directory), ["claim.1"]);
  } finally {
    await unexpected?.close();
    Object.defineProperty(process, "platform", platform);
    for (const socket of clients) socket.destroy();
    child.kill("SIGKILL");
    await exited;
  }
});

test("a briefly refused foreign listener is rechecked before stale cleanup", async () => {
  const path = socketPath();
  await leaveStaleUnixSocket(path);
  const foreign = net.createServer((socket) => socket.destroy());
  let recovery: ReturnType<typeof setTimeout> | undefined;
  const resumed = new Promise<void>((resolve, reject) => {
    recovery = setTimeout(() => {
      try {
        unlinkSync(path);
        foreign.once("error", reject);
        foreign.listen(path, resolve);
      } catch (error) {
        reject(error);
      }
    }, 100);
  });
  void resumed.catch(() => {}); // Awaited below; keep early fixture failures handled.
  let unexpected: Awaited<ReturnType<typeof listenUnixSocket>> | undefined;
  try {
    await assert.rejects(async () => {
      unexpected = await listenUnixSocket(path, () => {});
    }, /Another process listens on/);
    await resumed;
    assert.equal(foreign.listening, true);
    assert.equal(lstatSync(path).isSocket(), true);
  } finally {
    clearTimeout(recovery);
    await unexpected?.close();
    if (foreign.listening)
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }
});

test("ownership survives cross-process contention and recovers after its owner crashes", async () => {
  const path = socketPath();
  const module = new URL("./unixSocketTransport.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { listenUnixSocket } from ${JSON.stringify(module)}; await listenUnixSocket(${JSON.stringify(path)}, () => {}); console.log('ready');`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`socket owner did not start: ${stderr}`)),
        10_000,
      );
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        if (String(chunk).includes("ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`socket owner exited: ${stderr}`));
      });
    });
    await assert.rejects(
      listenUnixSocket(path, () => {}),
      /Another process listens on/,
    );
    (await dialUnixSocket(path)).close();
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  const recovered = await listenUnixSocket(path, () => {});
  (await dialUnixSocket(path)).close();
  await recovered.close();
  assert.equal(existsSync(path), false);
});

test.each(["file", "directory", "symlink"] as const)(
  "an existing %s at the control path is refused without changing it",
  async (kind) => {
    const path = socketPath();
    const target = join(dirname(path), "user-file.txt");
    writeFileSync(target, "User content\n");
    if (kind === "file") writeFileSync(path, "Not a socket\n");
    else if (kind === "directory") mkdirSync(path);
    else symlinkSync(target, path);
    const before = lstatSync(path);
    await assert.rejects(
      listenUnixSocket(path, () => {}),
      /exists and is not a socket/,
    );
    assert.equal(lstatSync(path).ino, before.ino);
    assert.equal(readFileSync(target, "utf8"), "User content\n");
    if (kind === "file")
      assert.equal(readFileSync(path, "utf8"), "Not a socket\n");
  },
);

test.each(["symlink", "world-writable"] as const)(
  "Darwin refuses a pre-planted %s claim directory",
  async (kind) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const path = socketPath();
    const claimDir = fileClaim(path).directory;
    const outside = mkdtempSync(join(tmpdir(), "foreign-claim-"));
    dirs.push(outside);
    writeFileSync(join(outside, "server.lock.1"), "Must not change\n");
    if (kind === "symlink") symlinkSync(outside, claimDir);
    else {
      mkdirSync(claimDir);
      chmodSync(claimDir, 0o777);
    }
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      await assert.rejects(
        listenUnixSocket(path, () => {}),
        /Unsafe socket claim directory/,
      );
      assert.equal(
        readFileSync(join(outside, "server.lock.1"), "utf8"),
        "Must not change\n",
      );
      assert.deepEqual(readdirSync(outside), ["server.lock.1"]);
      assert.equal(existsSync(path), false);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  },
);

test("a dial with no listener rejects", async () => {
  await assert.rejects(dialUnixSocket(socketPath()));
});
