/**
 * A Claude account's model listing through the gateway, against an injected
 * `fetch`: the exact request the server sends, the parsed ids, and every way a
 * read fails without shrinking an account. Fakes only; no token is real.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { refusalText, type Refusal } from "../gateway/refusals.ts";
import {
  CLAUDE_MODELS_INCOMPLETE_TEXT,
  CLAUDE_MODELS_MALFORMED_TEXT,
  CLAUDE_MODELS_TIMEOUT_TEXT,
  fetchClaudeModelIdsViaGateway,
} from "./modelsViaGateway.ts";

const LEASE = "lease-fixture";
const ACCESS = { baseUrl: "http://127.0.0.1:9", leaseToken: LEASE };

interface Sent {
  url: string;
  init: RequestInit;
}

function answering(
  status: number,
  body: unknown,
): { sent: Sent[]; read: Promise<string[]> } {
  const sent: Sent[] = [];
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    sent,
    read: fetchClaudeModelIdsViaGateway(ACCESS, 20_000, {
      fetch: async (url, init = {}) => {
        sent.push({ url: String(url), init });
        return new Response(text, { status });
      },
    }),
  };
}

test("one GET on the lease, with exactly the listing headers, parses data[].id", async () => {
  const { sent, read } = answering(200, {
    data: [
      { id: "claude-opus-5-5", type: "model" },
      { id: "claude-haiku-5-5" },
      { id: 7 },
      null,
    ],
    first_id: "claude-opus-5-5",
    last_id: "claude-haiku-5-5",
    has_more: false,
  });
  assert.deepEqual(await read, ["claude-opus-5-5", "claude-haiku-5-5"]);
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0]!.url,
    "http://127.0.0.1:9/anthropic/v1/models?limit=1000",
  );
  assert.equal(sent[0]!.init.method ?? "GET", "GET");
  assert.deepEqual(sent[0]!.init.headers, {
    Authorization: `Bearer ${LEASE}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
    Accept: "application/json",
  });
});

const REFUSALS: [string, Refusal, number][] = [
  ["forbidden", { case: "forbidden" }, 403],
  ["vault-locked", { case: "vault-locked" }, 503],
];

test.each(REFUSALS)(
  "a gateway %s throws its own marked text",
  async (_name, refusal, status) => {
    await assert.rejects(
      answering(status, {
        type: "error",
        error: { type: "permission_error", message: refusalText(refusal) },
      }).read,
      { message: refusalText(refusal) },
    );
  },
);

test("an upstream non-2xx throws a fixed text, never the upstream's prose", async () => {
  const prose = "upstream-secret-prose";
  for (const [status, text] of [
    [401, "Claude did not accept the model listing request."],
    [500, "Claude model listing failed (HTTP 500)."],
    [429, "Claude model listing failed (HTTP 429)."],
  ] as const) {
    await assert.rejects(
      answering(status, { error: { message: prose } }).read,
      (err: Error) => {
        assert.equal(err.message, text);
        assert.ok(!err.message.includes(prose));
        return true;
      },
    );
  }
});

test("a malformed or truncated body throws, never an empty listing", async () => {
  for (const body of ["not json", [], { data: "x" }, {}, null])
    await assert.rejects(answering(200, body).read, {
      message: CLAUDE_MODELS_MALFORMED_TEXT,
    });
  await assert.rejects(
    answering(200, { data: [{ id: "claude-opus-5-5" }], has_more: true }).read,
    { message: CLAUDE_MODELS_INCOMPLETE_TEXT },
  );
});

test("a read that outlives its timeout throws the timeout text", async () => {
  const started = Date.now();
  const hung: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    });
  await assert.rejects(
    fetchClaudeModelIdsViaGateway(ACCESS, 50, { fetch: hung }),
    { message: CLAUDE_MODELS_TIMEOUT_TEXT },
  );
  assert.ok(Date.now() - started < 5_000, "bounded");
});
