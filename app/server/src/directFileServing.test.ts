import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { handleDirectFileRequest } from "./directFileHttp.ts";
import {
  handleFileGrantRequest,
  mintDocumentGrant,
  resetFileGrantsForTest,
} from "./directFileGrants.ts";

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
      void handleFileGrantRequest(req, res, url);
      return;
    }
    void handleDirectFileRequest(req, res, url, {});
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
