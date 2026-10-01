import assert from "node:assert/strict";
import { test } from "vitest";
import { authTokenStartupMessage } from "./authToken.ts";

test("startup status names authentication and its token file without logging the token", () => {
  const sentinel = "api-token-value-must-not-be-logged";
  const previous = process.env.ASSISTANT_TOKEN;
  process.env.ASSISTANT_TOKEN = sentinel;
  try {
    const message = authTokenStartupMessage();

    assert.match(message, /API\/WS token authentication enabled/);
    assert.match(message, /\.assistant-token/);
    assert.doesNotMatch(message, new RegExp(sentinel));
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_TOKEN;
    else process.env.ASSISTANT_TOKEN = previous;
  }
});
