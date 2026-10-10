import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { describe, test } from "vitest";
import { handleSessionAttachmentRequest } from "./sessionAttachmentHttp.ts";
import { persistUploadedAttachment } from "./sessionAttachments.ts";

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

async function request(path: string): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: Buffer.alloc(0) };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) captured.body = Buffer.from(chunk);
      return this;
    },
  } as unknown as ServerResponse;
  await handleSessionAttachmentRequest(
    res,
    new URL(`http://localhost${path}`),
    { "access-control-allow-origin": "http://localhost" },
  );
  return captured;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("session attachment route", () => {
  test("serves a stored image by attachment id with sniffing off", async () => {
    persistUploadedAttachment("s-attach-http", {
      id: "1700000000000-abc",
      name: "shot.png",
      mimeType: "image/png",
      data: PNG.toString("base64"),
    });
    const res = await request(
      "/api/session-attachment/s-attach-http/1700000000000-abc",
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "image/png");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["content-security-policy"], undefined);
    assert.equal(
      res.headers["access-control-allow-origin"],
      "http://localhost",
    );
    assert.deepEqual(res.body, PNG);
  });

  test("sandboxes an SVG against direct navigation", async () => {
    persistUploadedAttachment("s-attach-http", {
      id: "att-svg",
      name: "icon.svg",
      mimeType: "image/svg+xml",
      data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString(
        "base64",
      ),
    });
    const res = await request("/api/session-attachment/s-attach-http/att-svg");
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-security-policy"], "sandbox");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  });

  test("never serves a non-image attachment", async () => {
    persistUploadedAttachment("s-attach-http", {
      id: "att-html",
      name: "page.html",
      mimeType: "text/html",
      data: Buffer.from("<script>alert(1)</script>").toString("base64"),
    });
    const res = await request("/api/session-attachment/s-attach-http/att-html");
    assert.equal(res.status, 404);
    assert.match(res.headers["content-type"] ?? "", /^text\/plain/);
    assert.doesNotMatch(res.body.toString("utf8"), /script/);
  });

  test("refuses a client MIME that is not a plain image type", async () => {
    persistUploadedAttachment("s-attach-http", {
      id: "att-odd",
      name: "odd.png",
      mimeType: "image/png\u0000x",
      data: PNG.toString("base64"),
    });
    const res = await request("/api/session-attachment/s-attach-http/att-odd");
    assert.equal(res.status, 404);
  });

  test("answers 404 for an unknown attachment", async () => {
    const res = await request("/api/session-attachment/s-attach-http/missing");
    assert.equal(res.status, 404);
  });

  test("rejects unsafe or malformed ids before touching the store", async () => {
    for (const path of [
      "/api/session-attachment/s-attach-http/..",
      "/api/session-attachment/s-attach-http/%2e%2e",
      "/api/session-attachment/s-attach-http/a%2Fb",
      "/api/session-attachment/s-attach-http/a/b",
      "/api/session-attachment/s-attach-http/",
      "/api/session-attachment/s-attach-http",
      "/api/session-attachment/s-attach-http/%E0%A4%A",
    ]) {
      const res = await request(path);
      assert.equal(res.status, 400, path);
    }
  });
});
