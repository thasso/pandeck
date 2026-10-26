import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { handleDirectFileRequest } from "./directFileHttp.ts";
import {
  handleFileGrantRequest,
  mintDocumentGrant,
  resetFileGrantsForTest,
} from "./directFileGrants.ts";
import { mintDocumentTargetGrant } from "./documentGrantTargets.ts";
import {
  failFileForTests,
  fileFaultArmedForTests,
  fileReadsCountsForTests,
  holdFileForTests,
  openFile,
  statFile,
} from "./fileReads.ts";
import { openServedFile } from "./servedFileAccess.ts";
import { FILE_METHODS } from "./workerProtocol/fileMethods.ts";
import {
  ensureInProcessWorker,
  inProcessWorkerEpochForTests,
  inProcessWorkerFileHandlesForTests,
  inProcessWorkerServedForTests,
  inProcessWorkerServedMethodForTests,
  writeAsInProcessWorkerForTests,
} from "./workers/inProcessWorker.ts";

// The real module, its reads watched: the in-process Worker runs this same
// module, so a server-side read shows as a call beyond the Worker's.
vi.mock("./fileReads.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fileReads.ts")>();
  return {
    ...actual,
    statFile: vi.fn(actual.statFile),
    realpathFile: vi.fn(actual.realpathFile),
    openFile: vi.fn(actual.openFile),
  };
});

/**
 * The two handlers over a real socket: what a browser actually receives when an
 * agent points at a file. The delivery decisions are unit-tested next door;
 * this covers the parts only a live request shows — streaming, ranges, the
 * grant's containment, and that a document under a grant needs no token.
 */

let server: Server;
let origin: string;
let dir: string;
let port: number;
let elsewhere: string;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pa-served-files-")));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "assets", "index.html"),
    "<script src=app.js></script>",
  );
  writeFileSync(join(dir, "report.md"), "# Title\n\nBody text.\n");
  writeFileSync(join(dir, "page.html"), "<h1>hi</h1>\n");
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1);\n");
  writeFileSync(join(dir, "assets", "app.mjs"), "export {};\n");
  writeFileSync(join(dir, "assets", "app.css"), "body { color: red; }\n");
  writeFileSync(join(dir, "assets", "data.json"), '{"ok":true}\n');
  writeFileSync(join(dir, "assets", "app.js.map"), '{"version":3}\n');
  writeFileSync(join(dir, "assets", "font.woff"), "font");
  writeFileSync(join(dir, "assets", "font.woff2"), "font");
  writeFileSync(join(dir, "assets", "font.ttf"), "font");
  writeFileSync(join(dir, "assets", "module.wasm"), "wasm");
  writeFileSync(join(dir, "assets", "plot.bmp"), "bmp");
  writeFileSync(join(dir, "assets", "recording.ogg"), "OggS");
  writeFileSync(join(dir, "plot.bmp"), "bmp");
  writeFileSync(join(dir, "report.pdf"), "%PDF-1.7\n");
  writeFileSync(join(dir, "recording.ogg"), "OggS");
  writeFileSync(join(dir, "track.aac"), "aac");
  writeFileSync(join(dir, "track.flac"), "flac");
  writeFileSync(join(dir, "clip.mov"), "mov");
  writeFileSync(join(dir, "clip.m4v"), "m4v");
  writeFileSync(join(dir, "clip.ogv"), "ogv");
  writeFileSync(join(dir, "active.svg"), "<svg/>");
  symlinkSync(join(dir, "active.svg"), join(dir, "pretend.pdf"));
  writeFileSync(join(dir, "script.py"), "print('hi')\n");
  writeFileSync(join(dir, "archive.bin"), "binary");
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(5000, 7));
  writeFileSync(join(dir, "empty.txt"), "");
  writeFileSync(join(dir, "accented.txt"), "café\n");
  // A symlink INSIDE the served directory pointing at a file OUTSIDE it (a
  // separate temp tree, not a subdirectory): the escape that no amount of `..`
  // handling catches.
  elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "pa-served-secret-")));
  writeFileSync(join(elsewhere, "token"), "SECRET");
  symlinkSync(join(elsewhere, "token"), join(dir, "escape.txt"));

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/file-grants/")) {
      track(res, handleFileGrantRequest(req, res, url));
      return;
    }
    track(res, handleDirectFileRequest(req, res, url, {}));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  resetFileGrantsForTest();
  await new Promise<void>((done) => server.close(() => done()));
});

const filesUrl = (path: string) => `${origin}/api/files${path}`;

/** Each request the server is still answering: its response and handler. */
const answering = new Set<{ res: ServerResponse; handled: Promise<void> }>();
let lastResponse: ServerResponse | undefined;

function track(res: ServerResponse, handled: Promise<void>): void {
  const request = { res, handled };
  answering.add(request);
  lastResponse = res;
  void Promise.all([
    res.closed ? undefined : once(res, "close"),
    handled.catch(() => undefined),
  ]).then(() => answering.delete(request));
}

/** Every response has closed and every handler has settled. */
async function answered(): Promise<void> {
  for (const { res, handled } of answering) {
    if (!res.closed) await once(res, "close");
    await handled;
  }
}

describe("serving a file by absolute path", () => {
  test("streams the bytes with a length and range support", async () => {
    const res = await fetch(filesUrl(`${dir}/report.md`));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), "# Title\n\nBody text.\n");
  });

  test("answers a range with 206 and only those bytes", async () => {
    const res = await fetch(filesUrl(`${dir}/big.bin`), {
      headers: { range: "bytes=100-199" },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 100-199/5000");
    assert.equal((await res.arrayBuffer()).byteLength, 100);
  });

  test("refuses an unsatisfiable range", async () => {
    const res = await fetch(filesUrl(`${dir}/big.bin`), {
      headers: { range: "bytes=9000-" },
    });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get("content-range"), "bytes */5000");
  });

  test("serves an empty file as an empty 200", async () => {
    const res = await fetch(filesUrl(`${dir}/empty.txt`));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), "0");
    assert.equal(await res.text(), "");
  });

  test("answers any range over an empty file as unsatisfiable", async () => {
    // Not `bytes 0--1/0`: a suffix range against zero bytes has no answer.
    const res = await fetch(filesUrl(`${dir}/empty.txt`), {
      headers: { range: "bytes=-1" },
    });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get("content-range"), "bytes */0");
  });

  test("follows a symlink, since a direct path has nothing to contain", async () => {
    // The opposite of the grant rule below, and deliberate: this route serves
    // any path the token holder names, so a symlink is just a file.
    const res = await fetch(filesUrl(`${dir}/escape.txt`));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "SECRET");
  });

  test("hands HTML over as a download, never as a document", async () => {
    const res = await fetch(filesUrl(`${dir}/page.html`));
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.match(
      res.headers.get("content-disposition") ?? "",
      /^attachment; filename="page\.html"/,
    );
  });

  test("answers metadata without the bytes", async () => {
    const res = await fetch(`${filesUrl(`${dir}/report.md`)}?meta=1`);
    const meta = (await res.json()) as Record<string, unknown>;
    assert.equal(meta.name, "report.md");
    assert.equal(meta.sizeBytes, 20);
    assert.equal(meta.disposition, "text");
  });

  test("reports a missing file and a directory distinctly", async () => {
    const missing = await fetch(filesUrl(`${dir}/nope.md`));
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /No such file/);

    const directory = await fetch(filesUrl(dir));
    assert.equal(directory.status, 400);
    assert.match(await directory.text(), /Not a file/);
  });

  test("refuses a write method", async () => {
    const res = await fetch(filesUrl(`${dir}/report.md`), { method: "DELETE" });
    assert.equal(res.status, 405);
  });
});

describe("serving a document under a grant", () => {
  test("serves the document and its subresources with no token", async () => {
    const grant = await mintDocumentGrant(join(dir, "page.html"));
    const document = await fetch(
      `${origin}/api/file-grants/${grant.grantId}/page.html`,
    );
    assert.equal(document.status, 200);
    assert.equal(
      document.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    const csp = document.headers.get("content-security-policy") ?? "";
    assert.match(csp, /^sandbox allow-scripts/);
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.equal(await document.text(), "<h1>hi</h1>\n");

    const script = await fetch(
      `${origin}/api/file-grants/${grant.grantId}/assets/app.js`,
    );
    assert.equal(script.status, 200);
    assert.equal(
      script.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    const stylesheet = await fetch(
      `${origin}/api/file-grants/${grant.grantId}/assets/app.css`,
    );
    assert.equal(
      stylesheet.headers.get("content-type"),
      "text/css; charset=utf-8",
    );
  });

  test("serves every runnable directory subresource with a loadable MIME", async () => {
    const grant = await mintDocumentGrant(join(dir, "page.html"));
    const examples = [
      ["assets/app.mjs", "text/javascript; charset=utf-8"],
      ["assets/data.json", "application/json; charset=utf-8"],
      ["assets/app.js.map", "application/json; charset=utf-8"],
      ["assets/font.woff", "font/woff"],
      ["assets/font.woff2", "font/woff2"],
      ["assets/font.ttf", "font/ttf"],
      ["assets/module.wasm", "application/wasm"],
      ["assets/plot.bmp", "image/bmp"],
      ["assets/recording.ogg", "audio/ogg"],
    ] as const;
    for (const [path, expected] of examples) {
      const response = await fetch(
        `${origin}/api/file-grants/${grant.grantId}/${path}`,
      );
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("content-type"), expected, path);
      assert.equal(
        response.headers.get("x-content-type-options"),
        "nosniff",
        path,
      );
    }
  });

  test("preserves shared inline MIME behavior for file-scoped Open grants", async () => {
    const examples = [
      ["plot.bmp", "image/bmp"],
      ["report.md", "text/plain; charset=utf-8"],
      ["script.py", "text/plain; charset=utf-8"],
      ["report.pdf", "application/pdf"],
      ["recording.ogg", "audio/ogg"],
      ["track.aac", "audio/aac"],
      ["track.flac", "audio/flac"],
      ["clip.mov", "video/quicktime"],
      ["clip.m4v", "video/x-m4v"],
      ["clip.ogv", "video/ogg"],
      ["archive.bin", "application/octet-stream"],
    ] as const;
    for (const [name, expected] of examples) {
      const grant = await mintDocumentGrant(join(dir, name), "file", "inline");
      const response = await fetch(`${origin}${grant.url}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get("content-type"), expected, name);
      assert.equal(response.headers.get("content-disposition"), null, name);
      if (name === "report.pdf")
        assert.equal(response.headers.get("content-security-policy"), null);
    }
    const svg = await mintDocumentGrant(
      join(dir, "active.svg"),
      "file",
      "inline",
    );
    const active = await fetch(`${origin}${svg.url}`);
    assert.match(
      active.headers.get("content-security-policy") ?? "",
      /^sandbox/,
    );
    const disguisedSvg = await mintDocumentGrant(
      join(dir, "pretend.pdf"),
      "file",
      "inline",
    );
    const disguised = await fetch(`${origin}${disguisedSvg.url}`);
    assert.equal(disguised.headers.get("content-type"), "image/svg+xml");
    assert.match(
      disguised.headers.get("content-security-policy") ?? "",
      /^sandbox/,
    );
  });

  test("serves grant ranges for media and PDF viewers", async () => {
    const grant = await mintDocumentGrant(
      join(dir, "big.bin"),
      "file",
      "inline",
    );
    const response = await fetch(`${origin}${grant.url}`, {
      headers: { range: "bytes=100-199" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-range"), "bytes 100-199/5000");
    assert.equal((await response.arrayBuffer()).byteLength, 100);
  });

  test("serves a download grant as an attachment without a URL toggle", async () => {
    const grant = await mintDocumentGrant(
      join(dir, "report.md"),
      "file",
      "attachment",
    );
    // Untrusted query text cannot change the delivery bound to the grant.
    const response = await fetch(`${origin}${grant.url}?delivery=inline`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.equal(
      response.headers.get("content-disposition"),
      "attachment; filename=\"report.md\"; filename*=UTF-8''report.md",
    );
    assert.equal(new URL(`${origin}${grant.url}`).search, "");
  });

  test("cannot be walked out of the granted directory", async () => {
    const grant = await mintDocumentGrant(join(dir, "assets", "index.html"));
    // The grant covers `<dir>/assets`, so the document one level up is out.
    // `..` has to travel ENCODED: `fetch` normalizes a literal `../` away
    // before the request leaves, so a literal spelling proves nothing here.
    for (const escape of ["..%2Fpage.html", "%2E%2E%2Fpage.html"]) {
      const res = await fetch(
        `${origin}/api/file-grants/${grant.grantId}/${escape}`,
      );
      assert.equal(res.status, 404, escape);
    }
  });

  test("cannot follow a symlink out of the granted directory", async () => {
    const grant = await mintDocumentGrant(join(dir, "page.html"));
    const res = await fetch(
      `${origin}/api/file-grants/${grant.grantId}/escape.txt`,
    );
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /SECRET/);
  });

  test("never streams more than the content-length it declared", async () => {
    // A file appended to WHILE it is read. This has to be measured on the raw
    // socket: `fetch` stops at `content-length` and would report a correct body
    // no matter how many extra bytes arrived — while on a keep-alive connection
    // those extra bytes are the next response's framing.
    const size = 8 * 1024 * 1024;
    const growing = join(dir, "growing.html");
    writeFileSync(growing, Buffer.alloc(size, 0x78));
    const grant = await mintDocumentGrant(growing);

    const received = await new Promise<Buffer>((done, fail) => {
      const chunks: Buffer[] = [];
      let grew = false;
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `GET ${grant.url} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
        );
      });
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (grew) return;
        // The headers are out and the body is mid-flight: grow it now.
        grew = true;
        appendFileSync(growing, Buffer.alloc(2 * 1024 * 1024, 0x79));
      });
      socket.on("error", fail);
      socket.on("end", () => done(Buffer.concat(chunks)));
    });

    const split = received.indexOf("\r\n\r\n");
    const headers = received.subarray(0, split).toString();
    const body = received.subarray(split + 4);
    const declared = Number(
      /content-length: (\d+)/i.exec(headers)?.[1] ?? Number.NaN,
    );
    assert.equal(declared, size);
    assert.equal(
      body.byteLength,
      declared,
      "wrote past its own content-length",
    );
    assert.equal(body.includes(0x79), false, "sent bytes appended after stat");
  });

  test("rejects an unknown grant id", async () => {
    const res = await fetch(`${origin}/api/file-grants/not-a-grant/page.html`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /expired/);
  });
});

/**
 * What a client receives over a raw socket, as bytes: `fetch` would hide a
 * short body or extra bytes behind its own framing.
 */
interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * GET `path` on a raw socket. `midBody` runs once the first body byte has
 * arrived, with the socket paused, so the server is mid-stream while it runs.
 */
function rawGet(
  path: string,
  midBody?: () => void | Promise<void>,
): Promise<RawResponse> {
  return new Promise<RawResponse>((done, fail) => {
    const chunks: Buffer[] = [];
    let fired = false;
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (fired || !midBody) return;
      const received = Buffer.concat(chunks);
      const split = received.indexOf("\r\n\r\n");
      if (split < 0 || received.byteLength <= split + 4) return;
      fired = true;
      socket.pause();
      void Promise.resolve(midBody()).then(() => socket.resume(), fail);
    });
    socket.on("error", fail);
    socket.on("close", () => {
      const received = Buffer.concat(chunks);
      const split = received.indexOf("\r\n\r\n");
      const lines = received
        .subarray(0, split)
        .toString("latin1")
        .split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        headers[line.slice(0, colon).toLowerCase()] = line
          .slice(colon + 1)
          .trim();
      }
      done({
        status: Number(lines[0]?.split(" ")[1]),
        headers,
        body: received.subarray(split + 4),
      });
    });
  });
}

const CHUNK = 1024 * 1024;

/** Every byte value, invalid UTF-8 and runs of NUL, in a fixed pseudo-random order. */
function binaryFixture(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let seed = 0x2545f491;
  for (let at = 0; at < size; at += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    bytes[at] = at < 256 ? at : seed >>> 24;
  }
  // A run of NULs straddling the first chunk boundary, and UTF-8 that is not.
  bytes.fill(0, CHUNK - 4096, CHUNK + 4096);
  Buffer.from([0xc3, 0x28, 0xff, 0xed, 0xa0, 0x80, 0xf0, 0x28]).copy(
    bytes,
    2 * CHUNK - 3,
  );
  return bytes;
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Characterization: written against the behavior of base 2190c21, before served
 * files read through the Worker, and expected to pass unchanged after it.
 */
describe("served bytes are exact (characterization)", () => {
  const size = 5 * CHUNK + 3;
  let fixture: Buffer;
  let path: string;

  beforeAll(() => {
    fixture = binaryFixture(size);
    path = join(dir, "lossless.bin");
    writeFileSync(path, fixture);
  });

  const ranges = (): [string, number, number][] => [
    ["bytes=0-0", 0, 0],
    ["bytes=-1", size - 1, size - 1],
    [`bytes=${CHUNK - 1}-${CHUNK}`, CHUNK - 1, CHUNK],
    [`bytes=${CHUNK}-`, CHUNK, size - 1],
    [`bytes=${size - 1}-`, size - 1, size - 1],
    [`bytes=${CHUNK - 576}-${2 * CHUNK + 848}`, CHUNK - 576, 2 * CHUNK + 848],
  ];

  async function expectExact(url: string): Promise<void> {
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-length"), String(size));
    assert.equal(
      sha256(Buffer.from(await full.arrayBuffer())),
      sha256(fixture),
    );
    for (const [range, start, end] of ranges()) {
      const res = await fetch(url, { headers: { range } });
      assert.equal(res.status, 206, range);
      assert.equal(
        res.headers.get("content-range"),
        `bytes ${start}-${end}/${size}`,
        range,
      );
      assert.equal(
        res.headers.get("content-length"),
        String(end - start + 1),
        range,
      );
      assert.ok(
        Buffer.from(await res.arrayBuffer()).equals(
          fixture.subarray(start, end + 1),
        ),
        range,
      );
    }
  }

  test("by absolute path, whole and in ranges across chunk edges", async () => {
    await expectExact(filesUrl(path));
  });

  test("under a grant, whole and in ranges across chunk edges", async () => {
    const grant = await mintDocumentGrant(path, "file", "inline");
    await expectExact(`${origin}${grant.url}`);
  });
});

describe("a file changed mid-body (characterization)", () => {
  const size = 32 * CHUNK;
  let serial = 0;

  /** A fresh fixture per case, since each case mutates it. */
  function fixtureFile(): { path: string; bytes: Buffer } {
    serial += 1;
    const bytes = binaryFixture(size);
    const path = join(dir, `racing-${serial}.bin`);
    writeFileSync(path, bytes);
    return { path, bytes };
  }

  const routes = {
    "by absolute path": async (path: string) => `/api/files${path}`,
    "under a grant": async (path: string) =>
      (await mintDocumentGrant(path, "file", "inline")).url,
  };

  for (const [route, urlFor] of Object.entries(routes)) {
    test(`${route}: a file renamed over mid-body still sends the old bytes, complete`, async () => {
      const { path, bytes } = fixtureFile();
      const res = await rawGet(await urlFor(path), () => {
        const next = `${path}.next`;
        writeFileSync(next, Buffer.alloc(size, 0x5a));
        renameSync(next, path);
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-length"], String(size));
      assert.equal(sha256(res.body), sha256(bytes));
    });

    test(`${route}: a file unlinked mid-body still sends every byte`, async () => {
      const { path, bytes } = fixtureFile();
      const res = await rawGet(await urlFor(path), () => unlinkSync(path));
      assert.equal(res.status, 200);
      assert.equal(sha256(res.body), sha256(bytes));
    });

    test(`${route}: a file truncated mid-body ends the body early, as a prefix`, async () => {
      const { path, bytes } = fixtureFile();
      const res = await rawGet(await urlFor(path), () => truncateSync(path, 0));
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-length"], String(size));
      assert.ok(res.body.byteLength > 0);
      assert.ok(
        res.body.byteLength < size,
        "sent bytes the file no longer has",
      );
      assert.ok(res.body.equals(bytes.subarray(0, res.body.byteLength)));
    });
  }
});

describe("failures answer from the same branch (characterization)", () => {
  let locked: string;

  beforeAll(() => {
    locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "inside.txt"), "x");
    chmodSync(locked, 0o000);
  });
  afterAll(() => chmodSync(locked, 0o700));

  async function answer(path: string): Promise<[number, string]> {
    const res = await fetch(filesUrl(path));
    return [res.status, await res.text()];
  }

  test("by absolute path: missing, directory, FIFO and not-a-directory", async () => {
    const missing = join(dir, "nope.bin");
    assert.deepEqual(await answer(missing), [404, `No such file: ${missing}`]);
    assert.deepEqual(await answer(dir), [400, `Not a file: ${dir}`]);
    const fifo = join(dir, "pipe.fifo");
    execFileSync("mkfifo", [fifo]);
    assert.deepEqual(await answer(fifo), [400, `Not a regular file: ${fifo}`]);
    const under = join(dir, "report.md", "child");
    assert.deepEqual(await answer(under), [
      404,
      `Cannot read ${under}: ENOTDIR: not a directory, stat '${under}'`,
    ]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "by absolute path: a path the service may not read",
    async () => {
      const inside = join(locked, "inside.txt");
      assert.deepEqual(await answer(inside), [
        404,
        `Cannot read ${inside}: EACCES: permission denied, stat '${inside}'`,
      ]);
    },
  );

  test("a grant whose file is gone after minting has expired", async () => {
    const path = join(dir, "short-lived.md");
    writeFileSync(path, "soon gone");
    const grant = await mintDocumentGrant(path, "file", "inline");
    unlinkSync(path);
    const res = await fetch(`${origin}${grant.url}`);
    assert.equal(res.status, 404);
    assert.equal(
      await res.text(),
      "This document link has expired. Open the file again from chat.",
    );
  });

  test("minting names what is wrong, in the words the route classifies", async () => {
    const missing = join(dir, "never.html");
    await assert.rejects(mintDocumentGrant(missing), {
      message: `ENOENT: no such file or directory, realpath '${missing}'`,
    });
    await assert.rejects(mintDocumentGrant(dir, "file"), {
      message: `Not a file: ${dir}`,
    });
    await assert.rejects(mintDocumentGrant(join(dir, "report.md")), {
      message: "Directory grants require a canonical HTML document.",
    });
    await assert.rejects(
      mintDocumentGrant(join(dir, "page.html"), "directory", "inline", {
        root: join(dir, "assets"),
        sourceKey: "elsewhere",
      }),
      { message: "Document is outside its source authority." },
    );
  });
});

const INVALID_FRAME = new Uint8Array(8);

/** Nothing is held, once every response has closed and its handler settled. */
async function assertNothingLeaked(): Promise<void> {
  await answered();
  assert.equal(inProcessWorkerFileHandlesForTests(), 0, "handles held");
  assert.equal(
    fileReadsCountsForTests().liveDescriptors,
    0,
    "descriptors open",
  );
}

const served = () => inProcessWorkerServedForTests();
const servedOf = (method: string) =>
  inProcessWorkerServedMethodForTests(method);
const fileMethodCounts = () => ({
  open: servedOf(FILE_METHODS.open),
  read: servedOf(FILE_METHODS.read),
  close: servedOf(FILE_METHODS.close),
});

/** Ends the in-process Worker connection, and resolves once it is quiescent. */
async function endWorkerConnection(probe: string): Promise<void> {
  // An open held on the connection settles only after its quiescence, so
  // after the Worker has swept its handles.
  const connection = ensureInProcessWorker();
  const held = holdFileForTests(probe, "after-open");
  const settled = openServedFile(probe, { stat: false }).catch(
    (error: Error) => error,
  );
  await held.reached;
  writeAsInProcessWorkerForTests(INVALID_FRAME);
  await connection.ended;
  held.release();
  assert.match(String(await settled), /The Worker connection ended/);
}

/** A raw request whose socket the test ends; resolves with what it received. */
function rawRequest(
  path: string,
  to = port,
): {
  socket: Socket;
  received: Promise<Buffer>;
} {
  const chunks: Buffer[] = [];
  const socket = connect(to, "127.0.0.1", () => {
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    );
  });
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const received = new Promise<Buffer>((done) => {
    socket.on("error", () => undefined);
    socket.on("close", () => done(Buffer.concat(chunks)));
  });
  return { socket, received };
}

describe("served files are read through the Worker", () => {
  let dataFile: string;

  beforeAll(() => {
    mkdirSync(join(DATA_DIR, "served-http"), { recursive: true });
    dataFile = join(DATA_DIR, "served-http", "local.md");
    writeFileSync(dataFile, "# Local\n");
  });

  async function tally(run: () => Promise<void>): Promise<number> {
    const before = served();
    await run();
    await answered();
    return served() - before;
  }

  test("a file outside DATA_DIR: every route reads it on the Worker", async () => {
    const path = `${dir}/report.md`;
    const reads = [
      async () =>
        assert.equal(
          await (await fetch(filesUrl(path))).text(),
          "# Title\n\nBody text.\n",
        ),
      async () => {
        const res = await fetch(filesUrl(`${dir}/big.bin`), {
          headers: { range: "bytes=100-199" },
        });
        assert.ok(
          Buffer.from(await res.arrayBuffer()).equals(Buffer.alloc(100, 7)),
        );
      },
      async () => {
        const res = await fetch(filesUrl(path), { method: "HEAD" });
        assert.equal(res.headers.get("content-length"), "20");
      },
      async () => {
        const res = await fetch(`${filesUrl(path)}?meta=1`);
        assert.equal(
          ((await res.json()) as { sizeBytes: number }).sizeBytes,
          20,
        );
      },
    ];
    for (const read of reads) assert.ok((await tally(read)) > 0);

    let url = "";
    assert.ok(
      (await tally(async () => {
        url = (await mintDocumentGrant(path, "file", "inline")).url;
      })) > 0,
      "the mint",
    );
    assert.ok(
      (await tally(async () =>
        assert.equal(
          await (await fetch(`${origin}${url}`)).text(),
          "# Title\n\nBody text.\n",
        ),
      )) > 0,
      "the serve",
    );
  });

  test("a file under DATA_DIR is read on the server", async () => {
    assert.equal(
      await tally(async () =>
        assert.equal(
          await (await fetch(filesUrl(dataFile))).text(),
          "# Local\n",
        ),
      ),
      0,
    );
    assert.equal(
      await tally(async () => {
        const { url } = await mintDocumentGrant(dataFile, "file", "inline");
        assert.equal(
          await (await fetch(`${origin}${url}`)).text(),
          "# Local\n",
        );
      }),
      0,
    );
  });
});

describe("no descriptor outlives its request", () => {
  test("by absolute path: each answer leaves nothing open", async () => {
    for (const [path, range, status] of [
      [`${dir}/report.md`, undefined, 200],
      [`${dir}/big.bin`, "bytes=10-19", 206],
      [`${dir}/empty.txt`, undefined, 200],
      [`${dir}/big.bin`, "bytes=9000-", 416],
    ] as const) {
      const res = await fetch(filesUrl(path), {
        headers: range ? { range } : {},
      });
      assert.equal(res.status, status, path);
      await res.arrayBuffer();
      await assertNothingLeaked();
    }
  });

  test("by absolute path: HEAD and metadata open nothing", async () => {
    const opens = servedOf(FILE_METHODS.open);
    await (
      await fetch(filesUrl(`${dir}/report.md`), { method: "HEAD" })
    ).text();
    await (await fetch(`${filesUrl(`${dir}/report.md`)}?meta=1`)).text();
    await assertNothingLeaked();
    assert.equal(servedOf(FILE_METHODS.open), opens);
  });

  test("under a grant: HEAD opens, checks and closes; GET and 416 leave nothing open", async () => {
    const { url } = await mintDocumentGrant(`${dir}/big.bin`, "file", "inline");
    const opens = servedOf(FILE_METHODS.open);
    const head = await fetch(`${origin}${url}`, { method: "HEAD" });
    assert.equal(head.headers.get("content-length"), "5000");
    await assertNothingLeaked();
    assert.equal(servedOf(FILE_METHODS.open) - opens, 1);

    for (const [range, status] of [
      [undefined, 200],
      ["bytes=9000-", 416],
    ] as const) {
      const res = await fetch(`${origin}${url}`, {
        headers: range ? { range } : {},
      });
      assert.equal(res.status, status);
      await res.arrayBuffer();
      await assertNothingLeaked();
    }
  });

  test("under a grant: a file swapped before the open is refused", async () => {
    const path = join(dir, "swapped.md");
    writeFileSync(path, "original");
    const { url } = await mintDocumentGrant(path, "file", "inline");
    const held = holdFileForTests(path, "before-open");
    const answer = fetch(`${origin}${url}`);
    await held.reached;
    writeFileSync(`${path}.next`, "impostor");
    renameSync(`${path}.next`, path);
    held.release();
    const res = await answer;
    assert.equal(res.status, 404);
    assert.equal(
      await res.text(),
      "This document link no longer resolves to the same file.",
    );
    await held.disposed;
    await assertNothingLeaked();
  });

  const big = 32 * CHUNK;
  let bigFile: string;
  beforeAll(() => {
    bigFile = join(dir, "abandoned.bin");
    writeFileSync(bigFile, binaryFixture(big));
  });

  const routes = {
    "by absolute path": async (path: string) => `/api/files${path}`,
    "under a grant": async (path: string) =>
      (await mintDocumentGrant(path, "file", "inline")).url,
  };

  for (const [route, urlFor] of Object.entries(routes)) {
    test(`${route}: a client gone mid-body leaves nothing open`, async () => {
      const { socket, received } = rawRequest(await urlFor(bigFile));
      await new Promise<void>((done) =>
        socket.once("data", () => {
          socket.destroy();
          done();
        }),
      );
      assert.ok((await received).byteLength < big);
      await assertNothingLeaked();
    });

    test(`${route}: a Worker connection ended mid-body ends the response, and the next request is served`, async () => {
      const epoch = inProcessWorkerEpochForTests();
      const res = await rawGet(await urlFor(bigFile), () =>
        endWorkerConnection(join(dir, "report.md")),
      );
      assert.equal(res.status, 200);
      assert.ok(res.body.byteLength < big, "the response was cut short");
      await assertNothingLeaked();

      const next = await fetch(filesUrl(`${dir}/report.md`));
      assert.equal(await next.text(), "# Title\n\nBody text.\n");
      assert.notEqual(inProcessWorkerEpochForTests(), epoch);
      await assertNothingLeaked();
    });
  }
});

describe("open failures answer from the base branch", () => {
  /** A grant on each side, for a fresh file. */
  const sides = {
    "on the Worker": async (name: string) => {
      const path = join(dir, name);
      writeFileSync(path, "granted");
      return { path, url: (await mintDocumentGrant(path, "file")).url };
    },
    "on the server": async (name: string) => {
      const dataDir = join(dir, "injected-data");
      const artifacts = join(dataDir, "session-artifacts", "s-faults");
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, name), "granted");
      const { url } = await mintDocumentTargetGrant(
        {
          target: {
            kind: "sessionArtifact",
            sessionId: "s-faults",
            path: name,
          },
          scope: "file",
          delivery: "inline",
        },
        { dataDir, resolveWorktree: async () => undefined },
      );
      return { path: join(artifacts, name), url };
    },
  };

  for (const [side, grantFor] of Object.entries(sides)) {
    for (const [phase, code, body] of [
      ["open", "EACCES", (path: string) => `No such file: ${path}`],
      [
        "stat",
        "EIO",
        () => "This document link no longer resolves to the same file.",
      ],
    ] as const) {
      test(`a grant ${side}: an ${phase} failure answers its own 404`, async () => {
        const { path, url } = await grantFor(`${phase}-fault.html`);
        failFileForTests(path, { phase, code });
        const before = { counts: fileMethodCounts(), served: served() };
        const res = await fetch(`${origin}${url}`);
        assert.equal(res.status, 404);
        assert.equal(await res.text(), body(path));
        await assertNothingLeaked();
        assert.equal(fileFaultArmedForTests(path), false);
        const counts = fileMethodCounts();
        if (side === "on the Worker")
          assert.deepEqual(
            {
              open: counts.open - before.counts.open,
              read: counts.read - before.counts.read,
              close: counts.close - before.counts.close,
            },
            { open: 1, read: 0, close: 0 },
          );
        else assert.equal(served(), before.served);
      });
    }
  }

  const direct = {
    "on the Worker": () => join(dir, "lossless-direct.bin"),
    "on the server": () => join(DATA_DIR, "served-http", "lossless-direct.bin"),
  };
  const bytes = binaryFixture(2 * CHUNK + 9);

  for (const [side, pathOf] of Object.entries(direct)) {
    test(`by absolute path ${side}: the descriptor is never stat'ed`, async () => {
      const path = pathOf();
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, bytes);
      failFileForTests(path, { phase: "stat", code: "EIO" });
      const stats = fileReadsCountsForTests().descriptorStats;

      const full = await fetch(filesUrl(path));
      assert.equal(full.status, 200);
      assert.equal(full.headers.get("content-length"), String(bytes.length));
      assert.equal(full.headers.get("accept-ranges"), "bytes");
      assert.equal(
        sha256(Buffer.from(await full.arrayBuffer())),
        sha256(bytes),
      );
      const start = CHUNK - 3;
      const end = CHUNK + 5;
      const part = await fetch(filesUrl(path), {
        headers: { range: `bytes=${start}-${end}` },
      });
      assert.equal(part.status, 206);
      assert.equal(
        part.headers.get("content-range"),
        `bytes ${start}-${end}/${bytes.length}`,
      );
      assert.ok(
        Buffer.from(await part.arrayBuffer()).equals(
          bytes.subarray(start, end + 1),
        ),
      );
      await assertNothingLeaked();
      assert.equal(fileReadsCountsForTests().descriptorStats, stats);
      assert.equal(fileFaultArmedForTests(path), true, "never consumed");
    });
  }

  test("by absolute path: an open failure after the headers ends the response with no body", async () => {
    const path = join(dir, "unopenable.bin");
    writeFileSync(path, bytes);
    failFileForTests(path, { phase: "open", code: "EACCES" });
    const { received } = rawRequest(`/api/files${path}`);
    assert.equal((await received).byteLength, 0);
    await assertNothingLeaked();
    assert.equal(fileFaultArmedForTests(path), false);
  });
});

describe("a Worker failure is a read failure, never a local read", () => {
  test("by absolute path: the stat fails with the connection", async () => {
    const path = join(dir, "never-local.md");
    writeFileSync(path, "x");
    const calls = () =>
      [statFile, openFile].map(
        (read) =>
          vi.mocked(read).mock.calls.filter(([named]) => named === path).length,
      );
    const before = calls();
    const connection = ensureInProcessWorker();
    const held = holdFileForTests(path, "stat");
    const answer = fetch(filesUrl(path));
    await held.reached;
    writeAsInProcessWorkerForTests(INVALID_FRAME);
    await connection.ended;
    held.release();
    const res = await answer;
    assert.equal(res.status, 404);
    assert.match(
      await res.text(),
      new RegExp(
        `^Cannot read ${path.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}: The Worker connection ended: `,
      ),
    );
    await assertNothingLeaked();
    const after = calls();
    // The Worker's one stat, and nothing else.
    assert.deepEqual([after[0]! - before[0]!, after[1]! - before[1]!], [1, 0]);
  });

  test("under a grant: an open held while the connection ends is No such file", async () => {
    const path = join(dir, "held-open.md");
    writeFileSync(path, "x");
    const { url } = await mintDocumentGrant(path, "file");
    const connection = ensureInProcessWorker();
    const held = holdFileForTests(path, "after-open");
    const answer = fetch(`${origin}${url}`);
    await held.reached;
    writeAsInProcessWorkerForTests(INVALID_FRAME);
    await connection.ended;
    held.release();
    await held.disposed;
    const res = await answer;
    assert.equal(res.status, 404);
    assert.equal(await res.text(), `No such file: ${path}`);
    await assertNothingLeaked();
  });
});

describe("a client gone while its open is held", () => {
  async function abandon(url: string, path: string): Promise<void> {
    const connection = ensureInProcessWorker();
    const held = holdFileForTests(path, "after-open");
    const reads = servedOf(FILE_METHODS.read);
    const { socket, received } = rawRequest(url);
    await held.reached;
    const res = lastResponse!;
    socket.destroy();
    if (!res.closed) await once(res, "close");
    held.release();
    await held.disposed;
    assert.equal((await received).byteLength, 0);
    await assertNothingLeaked();
    assert.equal(servedOf(FILE_METHODS.read) - reads, 0, "nothing read");
    assert.equal(connection.isEnded, false);
    const next = await fetch(filesUrl(path));
    assert.equal(await next.text(), "held");
    await assertNothingLeaked();
  }

  test("by absolute path, after its headers", async () => {
    const path = join(dir, "abandoned-direct.md");
    writeFileSync(path, "held");
    await abandon(`/api/files${path}`, path);
  });

  test("under a grant, before any headers", async () => {
    const path = join(dir, "abandoned-grant.md");
    writeFileSync(path, "held");
    await abandon((await mintDocumentGrant(path, "file")).url, path);
  });
});

describe("a client gone before its file is opened", () => {
  let early: Server;
  let earlyPort: number;
  /** When this server's client leaves, relative to its handler. */
  let leave:
    | "before the handler"
    | "during the lookup"
    | "on its own, before the handler";
  /** Runs the waiting handler, when the client leaves on its own. */
  let arrived: (request: { req: IncomingMessage; run: () => void }) => void;
  let handled: Promise<{ res: ServerResponse; handled: Promise<void> }>;
  let started: (request: {
    res: ServerResponse;
    handled: Promise<void>;
  }) => void;
  let fixturePath: string;

  beforeAll(async () => {
    fixturePath = join(dir, "left-early.bin");
    writeFileSync(fixturePath, binaryFixture(8 * CHUNK));
    // The client leaves from the server's side, at a chosen point. A socket's
    // close is a next-tick event, so leaving "during the lookup" closes the
    // response before any filesystem answer the handler awaits can arrive.
    early = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const run = () =>
        started({
          res,
          handled: url.pathname.startsWith("/api/file-grants/")
            ? handleFileGrantRequest(req, res, url)
            : handleDirectFileRequest(req, res, url, {}),
        });
      if (leave === "on its own, before the handler") {
        arrived({ req, run });
      } else if (leave === "during the lookup") {
        run();
        req.socket.destroy();
      } else {
        req.socket.destroy();
        void once(res, "close").then(run);
      }
    });
    await new Promise<void>((done) => early.listen(0, "127.0.0.1", done));
    const address = early.address();
    earlyPort = typeof address === "object" && address ? address.port : 0;
  });
  afterAll(async () => {
    await new Promise<void>((done) => early.close(() => done()));
  });

  const routes = {
    "by absolute path": async (path: string) => `/api/files${path}`,
    "under a grant": async (path: string) =>
      (await mintDocumentGrant(path, "file", "inline")).url,
  };

  for (const [route, urlFor] of Object.entries(routes)) {
    for (const when of [
      "before the handler",
      "during the lookup",
      "on its own, before the handler",
    ] as const) {
      test(`${route}: a client gone ${when} leaves nothing open`, async () => {
        const url = await urlFor(fixturePath);
        leave = when;
        handled = new Promise((resolve) => (started = resolve));
        const opens = servedOf(FILE_METHODS.open);
        const reads = servedOf(FILE_METHODS.read);
        const waiting = new Promise<{ req: IncomingMessage; run: () => void }>(
          (resolve) => (arrived = resolve),
        );
        const { socket, received } = rawRequest(url, earlyPort);
        if (when === "on its own, before the handler") {
          // The real client ends its socket; the handler runs only once the
          // server has seen it go.
          const { req, run } = await waiting;
          // Not `once`: the request emits its `aborted` error first.
          const seen = new Promise((done) => req.once("close", done));
          socket.destroy();
          await seen;
          run();
        }
        const request = await handled;
        const settled = await Promise.race([
          request.handled.then(() => true),
          new Promise<false>((done) => setTimeout(() => done(false), 2000)),
        ]);
        assert.equal(settled, true, "the handler settled");
        assert.equal(request.res.closed, true);
        assert.equal((await received).byteLength, 0);
        assert.equal(servedOf(FILE_METHODS.open) - opens, 0, "nothing opened");
        assert.equal(servedOf(FILE_METHODS.read) - reads, 0, "nothing read");
        assert.equal(inProcessWorkerFileHandlesForTests(), 0, "handles held");
        assert.equal(
          fileReadsCountsForTests().liveDescriptors,
          0,
          "descriptors open",
        );
      });
    }
  }
});
