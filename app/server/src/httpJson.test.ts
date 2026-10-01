import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import { readJsonBody } from "./httpJson.ts";

const BODY_CAP = 4_096;

function read(body: string): Promise<unknown> {
  const request = new PassThrough();
  const result = readJsonBody(request as unknown as IncomingMessage, BODY_CAP);
  request.end(body);
  return result;
}

test("readJsonBody accepts JSON at exactly the byte cap", async () => {
  const body = JSON.stringify("x".repeat(BODY_CAP - 2));
  assert.equal(Buffer.byteLength(body), BODY_CAP);
  assert.equal(await read(body), "x".repeat(BODY_CAP - 2));
});

test("readJsonBody rejects JSON one byte over the cap", async () => {
  const body = JSON.stringify("x".repeat(BODY_CAP - 1));
  assert.equal(Buffer.byteLength(body), BODY_CAP + 1);
  await assert.rejects(read(body), { message: "Request body is too large." });
});
