import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  directFileDeliveryHeaders,
  directFileDisposition,
  directFilePath,
  directFileUrlPath,
  parseByteRange,
} from "./directFileHttp.ts";

const url = (path: string) => new URL(`http://localhost${path}`);

describe("direct file paths", () => {
  test("reads the absolute path out of the route path", () => {
    assert.equal(
      directFilePath("/api/files/tmp/example/notes/report.md"),
      "/tmp/example/notes/report.md",
    );
  });

  test("decodes percent-escaped segments", () => {
    assert.equal(
      directFilePath("/api/files/tmp/example/My%20Docs/a%2Bb.png"),
      "/tmp/example/My Docs/a+b.png",
    );
  });

  test("normalizes traversal and duplicate separators to one spelling", () => {
    assert.equal(
      directFilePath("/api/files/tmp/example/../user//x/./y.txt"),
      "/tmp/user/x/y.txt",
    );
  });

  test("rejects a non-file route, an empty path and a NUL byte", () => {
    assert.equal(directFilePath("/api/session-artifacts/s/x.png"), undefined);
    assert.equal(directFilePath("/api/files/"), undefined);
    assert.equal(directFilePath("/api/files/etc/pass%00wd"), undefined);
  });

  test("round-trips a path with spaces through the URL builder", () => {
    const path = "/tmp/example/My Docs/a b.png";
    assert.equal(directFilePath(directFileUrlPath(path)), path);
  });
});

describe("direct file disposition", () => {
  test("classifies by extension", () => {
    assert.equal(directFileDisposition("/x/a.png"), "image");
    assert.equal(directFileDisposition("/x/a.LOG"), "text");
    assert.equal(directFileDisposition("/x/a.mp4"), "media");
    assert.equal(directFileDisposition("/x/a.html"), "download");
    assert.equal(directFileDisposition("/x/a.sqlite"), "download");
  });
});

describe("direct file delivery headers", () => {
  test("serves an image inline with MIME sniffing disabled", () => {
    const headers = directFileDeliveryHeaders(
      "/tmp/example/shot.png",
      url("/api/files/tmp/example/shot.png"),
    );
    assert.equal(headers["content-type"], "image/png");
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(headers["content-disposition"], undefined);
  });

  test("sandboxes SVG, which runs script on a direct navigation", () => {
    const headers = directFileDeliveryHeaders(
      "/tmp/example/chart.svg",
      url("/api/files/tmp/example/chart.svg"),
    );
    assert.equal(headers["content-type"], "image/svg+xml");
    assert.equal(headers["content-security-policy"], "sandbox");
  });

  test("shows text-ish files as text/plain, the one inert document type", () => {
    for (const path of ["/x/app.js", "/x/notes.md", "/x/style.css"]) {
      const headers = directFileDeliveryHeaders(path, url("/api/files/x"));
      assert.equal(headers["content-type"], "text/plain; charset=utf-8");
      assert.equal(headers["content-disposition"], undefined);
    }
  });

  test("force-downloads HTML so it never executes on the API origin", () => {
    const headers = directFileDeliveryHeaders(
      "/tmp/example/report.html",
      url("/api/files/tmp/example/report.html"),
    );
    assert.equal(headers["content-type"], "application/octet-stream");
    assert.equal(
      headers["content-security-policy"],
      "sandbox; default-src 'none'",
    );
    assert.match(
      headers["content-disposition"] ?? "",
      /^attachment; filename="report\.html";/,
    );
  });

  test("honors an explicit download for an image and sanitizes the name", () => {
    const headers = directFileDeliveryHeaders(
      "/tmp/example/shot.png",
      url(
        "/api/files/tmp/example/shot.png?download=1&name=bad%22%0D%0Aname.png",
      ),
    );
    assert.match(
      headers["content-disposition"] ?? "",
      /^attachment; filename="bad___name\.png";/,
    );
    assert.doesNotMatch(headers["content-disposition"] ?? "", /\r|\n/);
  });
});

describe("byte ranges", () => {
  test("parses a closed, open and suffix range", () => {
    assert.deepEqual(parseByteRange("bytes=0-99", 500), { start: 0, end: 99 });
    assert.deepEqual(parseByteRange("bytes=100-", 500), {
      start: 100,
      end: 499,
    });
    assert.deepEqual(parseByteRange("bytes=-100", 500), {
      start: 400,
      end: 499,
    });
  });

  test("clamps an end past the file and reports unsatisfiable starts", () => {
    assert.deepEqual(parseByteRange("bytes=0-999", 500), {
      start: 0,
      end: 499,
    });
    assert.equal(parseByteRange("bytes=500-", 500), "unsatisfiable");
    assert.equal(parseByteRange("bytes=300-200", 500), "unsatisfiable");
  });

  test("ignores a missing or unsupported header", () => {
    assert.equal(parseByteRange(undefined, 500), undefined);
    assert.equal(parseByteRange("bytes=0-1,5-6", 500), undefined);
    assert.equal(parseByteRange("items=0-1", 500), undefined);
  });
});
