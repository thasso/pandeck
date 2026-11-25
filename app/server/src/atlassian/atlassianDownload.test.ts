/**
 * `atlassianDownload` against real local HTTP servers with the runtime's own
 * `fetch` (Task-1441 P7a): the cross-origin redirect drops `Authorization`
 * (G6 N2; run under the packaged Bun too, P7A-R1), retryable bodies are read
 * at most 2 KiB deep and cancelled (H2), every failure exit cancels the body
 * (H1), and the failures are typed (G3). Every value is fake.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "vitest";
import { fetchWithRetry, setRetrySleepForTests } from "../httpRetry.ts";
import { AtlassianDownloadError, atlassianDownload } from "./atlassianFetch.ts";

const servers: http.Server[] = [];

afterEach(async () => {
  setRetrySleepForTests(null);
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function serve(
  handler: http.RequestListener,
): Promise<{ origin: string; port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, port };
}

const config = (origin: string) => ({
  host: origin,
  atlassianEmail: "a@b.c",
  atlassianToken: "fake-token",
});
const BASIC = `Basic ${Buffer.from("a@b.c:fake-token").toString("base64")}`;

/**
 * A response that writes `chunk` every `everyMs` until `total` bytes or the
 * client goes away; resolves with the bytes written once it ends.
 */
function slowBody(
  res: http.ServerResponse,
  total: number,
  { chunk = 16 * 1024, everyMs = 5 } = {},
): Promise<{ written: number; closedEarly: boolean }> {
  return new Promise((resolve) => {
    let written = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = (closedEarly: boolean) => {
      clearInterval(timer);
      resolve({ written, closedEarly });
    };
    res.on("close", () => finish(written < total));
    timer = setInterval(() => {
      if (res.destroyed) return finish(true);
      const size = Math.min(chunk, total - written);
      res.write(Buffer.alloc(size, 0x61));
      written += size;
      if (written >= total) {
        res.end();
        finish(false);
      }
    }, everyMs);
  });
}

test("the cross-origin redirect drops Authorization; the API origin gets it (N2)", async () => {
  const seen: Record<string, string | null> = {};
  const media = await serve((req, res) => {
    seen.media = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "image/png" });
    res.end("media-bytes");
  });
  const api = await serve((req, res) => {
    seen.api = req.headers.authorization ?? null;
    res.writeHead(302, { location: `${media.origin}/signed/file?sig=x` });
    res.end();
  });
  const result = await atlassianDownload(
    config(api.origin),
    "Confluence",
    "/wiki/download/attachments/1/a.png",
    100,
  );
  assert.equal(new TextDecoder().decode(result.bytes), "media-bytes");
  assert.equal(result.contentType, "image/png");
  assert.equal(seen.api, BASIC);
  assert.equal(seen.media, null);
});

test("a redirect's file is still held to maxBytes", async () => {
  const media = await serve((_req, res) => {
    res.end("x".repeat(50));
  });
  const api = await serve((_req, res) => {
    res.writeHead(302, { location: `${media.origin}/f` });
    res.end();
  });
  const err = await atlassianDownload(
    config(api.origin),
    "Confluence",
    "/wiki/download/x",
    10,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(err instanceof AtlassianDownloadError);
  assert.equal(err.reason, "declared_too_large");
});

for (const [status, headers] of [
  [503, {}],
  [429, { "retry-after": "0" }],
] as const)
  test(`a ${status} retry body is read at most 2 KiB deep and cancelled, then the retry succeeds (H2)`, async () => {
    setRetrySleepForTests(() => Promise.resolve());
    let attempt = 0;
    let first: Promise<{ written: number; closedEarly: boolean }> | undefined;
    const api = await serve((_req, res) => {
      attempt += 1;
      if (attempt === 1) {
        res.writeHead(status, headers);
        first = slowBody(res, 50 * 1024 * 1024);
        return;
      }
      res.end("file");
    });
    const result = await atlassianDownload(
      config(api.origin),
      "Confluence",
      "/wiki/download/x",
      100,
    );
    assert.equal(new TextDecoder().decode(result.bytes), "file");
    const observed = await first!;
    assert.equal(observed.closedEarly, true);
    assert.ok(observed.written < 1024 * 1024, `${observed.written} written`);
  });

test("an abort during the bounded retry read cancels it and throws the abort (H2)", async () => {
  setRetrySleepForTests(() => Promise.resolve());
  const controller = new AbortController();
  let first: Promise<{ written: number; closedEarly: boolean }> | undefined;
  const api = await serve((_req, res) => {
    res.writeHead(503);
    // One byte, then nothing for a while: the read waits on the stream.
    res.write("x");
    first = slowBody(res, 1024 * 1024, { chunk: 1, everyMs: 200 });
    setTimeout(() => controller.abort(), 50);
  });
  const err = await atlassianDownload(
    config(api.origin),
    "Confluence",
    "/wiki/download/x",
    100,
    { signal: controller.signal },
  ).then(
    () => new Error("resolved"),
    (error: unknown) => error as Error,
  );
  assert.equal(err.name, "AbortError");
  assert.equal((await first!).closedEarly, true);
});

test("a failure's body is read at most 2 KiB deep; the message keeps 400 characters (G2)", async () => {
  let observed: Promise<{ written: number; closedEarly: boolean }> | undefined;
  const api = await serve((_req, res) => {
    res.writeHead(500);
    observed = slowBody(res, 50 * 1024 * 1024);
  });
  const err = await atlassianDownload(
    config(api.origin),
    "Confluence",
    "/wiki/download/x",
    100,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(err instanceof AtlassianDownloadError);
  assert.equal(err.reason, "http");
  assert.equal(err.status, 500);
  assert.equal(
    err.message,
    `Confluence download returned HTTP 500 for /wiki/download/x: ${"a".repeat(400)}`,
  );
  const { written, closedEarly } = await observed!;
  assert.equal(closedEarly, true);
  assert.ok(written < 1024 * 1024, `${written} written`);
});

test("a streamed over-size download cancels its body (H1)", async () => {
  let observed: Promise<{ written: number; closedEarly: boolean }> | undefined;
  const api = await serve((_req, res) => {
    res.writeHead(200);
    observed = slowBody(res, 50 * 1024 * 1024);
  });
  const err = await atlassianDownload(
    config(api.origin),
    "Confluence",
    "/wiki/download/x",
    64 * 1024,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(err instanceof AtlassianDownloadError);
  assert.equal(err.reason, "streamed_too_large");
  assert.equal(err.status, undefined);
  assert.equal((await observed!).closedEarly, true);
});

test("an abort mid-download cancels the body and throws the abort (H1)", async () => {
  const controller = new AbortController();
  let observed: Promise<{ written: number; closedEarly: boolean }> | undefined;
  const api = await serve((_req, res) => {
    res.writeHead(200);
    observed = slowBody(res, 50 * 1024 * 1024);
    setTimeout(() => controller.abort(), 50);
  });
  const err = await atlassianDownload(
    config(api.origin),
    "Confluence",
    "/wiki/download/x",
    100 * 1024 * 1024,
    { signal: controller.signal },
  ).then(
    () => new Error("resolved"),
    (error: unknown) => error as Error,
  );
  assert.equal(err.name, "AbortError");
  assert.equal((await observed!).closedEarly, true);
});

test("the bounded retry read reports the retry's status to onRetry (H2)", async () => {
  setRetrySleepForTests(() => Promise.resolve());
  let attempt = 0;
  let first: Promise<{ written: number; closedEarly: boolean }> | undefined;
  const api = await serve((_req, res) => {
    attempt += 1;
    if (attempt === 1) {
      res.writeHead(503);
      first = slowBody(res, 50 * 1024 * 1024);
      return;
    }
    res.end("ok");
  });
  const retries: number[] = [];
  const res = await fetchWithRetry(
    `${api.origin}/x`,
    { method: "GET" },
    {
      retryBodyLimitBytes: 2048,
      onRetry: ({ status }) => retries.push(status),
    },
  );
  assert.equal(await res.text(), "ok");
  assert.deepEqual(retries, [503]);
  assert.equal((await first!).closedEarly, true);
});

test("a retry body that breaks off is ignored, as before (H2)", async () => {
  setRetrySleepForTests(() => Promise.resolve());
  let attempt = 0;
  const api = await serve((_req, res) => {
    attempt += 1;
    if (attempt === 1) {
      res.writeHead(503, { "content-length": "100000" });
      // The body breaks off. Node fails the body read; Bun 1.4.2 may fail
      // the fetch itself. Neither is an abort, so the call retries.
      res.write("partial", () => res.destroy());
      return;
    }
    res.end("ok");
  });
  const res = await fetchWithRetry(
    `${api.origin}/x`,
    { method: "GET" },
    { retryBodyLimitBytes: 2048 },
  );
  assert.equal(await res.text(), "ok");
  assert.equal(attempt, 2);
});
