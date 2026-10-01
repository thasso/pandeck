import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveWebStatic } from "./webStatic.ts";

const SHELL = '<script>window.__TOKEN__ = "%ASSISTANT_TOKEN%";</script>';
const SERVED_SHELL = '<script>window.__TOKEN__ = "tok-123";</script>';
const SERVICE_WORKER = 'self.addEventListener("fetch", () => {});';
/** Placed BESIDE the dist root: no request may ever answer with it. */
const SENTINEL = "outside-the-dist-root";

let server: Server;
let rawServer: Server;
let base: string;
let rawPort: number;

async function listen(
  toPathname: (url: string) => string,
  webDist: string,
): Promise<Server> {
  const listening = createServer((req, res) => {
    void serveWebStatic(toPathname(req.url ?? "/"), res, {
      webDist,
      authToken: "tok-123",
    });
  });
  await new Promise<void>((resolve) =>
    listening.listen(0, "127.0.0.1", resolve),
  );
  return listening;
}

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-web-static-"));
  const webDist = join(root, "dist");
  mkdirSync(join(webDist, "assets"), { recursive: true });
  writeFileSync(join(root, "secret.txt"), SENTINEL);
  writeFileSync(join(webDist, "index.html"), SHELL);
  writeFileSync(join(webDist, "sw.js"), SERVICE_WORKER);
  writeFileSync(join(webDist, "manifest.webmanifest"), "{}");
  writeFileSync(join(webDist, "assets", "index-abc.js"), "export {};");
  // The production front end: `index.ts` hands over the parsed URL pathname.
  server = await listen(
    (url) => new URL(url, "http://localhost").pathname,
    webDist,
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The module alone, given the unparsed request path, must confine too.
  rawServer = await listen((url) => url.split("?")[0] ?? "/", webDist);
  rawPort = (rawServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await Promise.all(
    [server, rawServer].map(
      (listening) => new Promise((resolve) => listening.close(resolve)),
    ),
  );
});

/** Send `path` byte for byte; `fetch` would normalize it first. */
function rawGet(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function expectShell(path: string): Promise<void> {
  const res = await fetch(`${base}${path}`);
  expect(res.status, path).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(await res.text()).toBe(SERVED_SHELL);
}

async function expectNotFound(path: string): Promise<void> {
  const res = await fetch(`${base}${path}`);
  expect(res.status, path).toBe(404);
  expect(await res.text()).toBe("Not found");
}

describe("serveWebStatic", () => {
  it("answers a direct load of a document route ending in an extension with the shell", async () => {
    await expectShell("/files/tmp/notes/plan.md");
    await expectShell("/artifacts/session-1/out/chart.png");
    await expectShell("/knowledge/~file/projects/data.json");
    await expectShell("/knowledge/entry.v2");
    await expectShell("/tasks/abc.def");
  });

  it("answers encoded names in a client route with the shell", async () => {
    await expectShell("/files/tmp/my%20notes/%C3%BCber.md");
    await expectShell("/artifacts/s%201/%E2%9C%93%20chart.png");
    await expectShell("/knowledge/~file/%E6%97%A5%E6%9C%AC/notes%2Bplan.json");
  });

  it("keeps the extensionless history fallback", async () => {
    await expectShell("/");
    await expectShell("/tasks");
    await expectShell("/sessions/abc");
  });

  it("serves the shell itself and the service worker byte for byte", async () => {
    await expectShell("/index.html");
    const worker = await fetch(`${base}/sw.js`);
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(worker.headers.get("cache-control")).toBe("no-cache");
    expect(await worker.text()).toBe(SERVICE_WORKER);
  });

  it("serves real files from the build", async () => {
    const asset = await fetch(`${base}/assets/index-abc.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe(
      "application/manifest+json; charset=utf-8",
    );
  });

  it("404s a missing static file instead of returning HTML", async () => {
    await expectNotFound("/assets/index-missing.js");
    await expectNotFound("/assets/nested/chunk");
    await expectNotFound("/favicon.xyz");
  });

  it("404s a miss in a server-owned namespace", async () => {
    await expectNotFound("/api/unknown");
    await expectNotFound("/api/unknown/data.json");
    await expectNotFound("/mcp/unknown");
    await expectNotFound("/.well-known/appspecific/com.chrome.devtools.json");
  });

  // [raw request path, status via the parsed pathname, status given unparsed].
  // A 200 is always the shell: nothing escapes the dist root, and a miss in a
  // server-owned namespace never turns into a served file.
  const traversals: [string, number, number][] = [
    ["/assets/%2e%2e/%2e%2e/secret.txt", 404, 404],
    ["/%2E%2E/secret.txt", 404, 200],
    ["/files/%2e%2e/%2e%2e/%2e%2e/secret.txt", 404, 200],
    ["/assets/..%2fsecret.txt", 404, 404],
    ["/..%2f..%2fsecret.txt", 404, 404],
    ["/files/..%2f..%2fsecret.txt", 200, 200],
    ["/api/..%2f..%2fsecret.txt", 404, 404],
    ["/assets/..\\..\\secret.txt", 404, 404],
    ["/mcp\\..\\..\\secret.txt", 404, 404],
    ["/files\\..\\..\\secret.txt", 404, 404],
    ["/assets/../../secret.txt", 404, 404],
    ["/.well-known/../../secret.txt", 404, 404],
    ["/../secret.txt", 404, 404],
    ["/assets//..//..//secret.txt", 404, 404],
    ["/files//..//..//secret.txt", 200, 404],
    ["/assets/x%00.js", 404, 404],
    ["/secret.txt%00.html", 404, 404],
    ["/files/a%00.md", 200, 200],
  ];

  it.each(traversals)(
    "never reads outside the dist root for %s",
    async (path, parsedStatus, rawStatus) => {
      const serverPort = (server.address() as AddressInfo).port;
      for (const [port, status] of [
        [serverPort, parsedStatus],
        [rawPort, rawStatus],
      ] as const) {
        const res = await rawGet(port, path);
        expect(res.status, `${path} on ${port}`).toBe(status);
        expect(res.body).not.toContain(SENTINEL);
        expect(res.body).toBe(status === 200 ? SERVED_SHELL : "Not found");
      }
    },
  );
});

describe("web public directory", () => {
  it("stays flat, which the nested-path fallback depends on", () => {
    const publicDir = new URL("../../web/public/", import.meta.url);
    const nested = readdirSync(publicDir, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory(),
    );
    expect(nested.map((entry) => entry.name)).toEqual([]);
  });
});
