import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";

let gatewayOn = true;
vi.mock("../config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.ts")>();
  return {
    ...actual,
    get GATEWAY_ENABLED() {
      return gatewayOn;
    },
  };
});

const { guardServerRuntime } = await import("./serverCredentialPairing.ts");

const COMPAT = "openai-compatible";
const COMPAT_BASE = "https://compat.example.invalid/v1";

/** A runtime whose own `getAuth` counts and answers a resolution. */
function fakeRuntime() {
  const asked: string[] = [];
  const runtime = {
    getAuth: (model: { provider: string; baseUrl: string }) => {
      asked.push(model.provider);
      return Promise.resolve({ auth: { apiKey: "resolved" } });
    },
    getRegisteredProviderConfig: (provider: string) =>
      provider === COMPAT
        ? { baseUrl: COMPAT_BASE, apiKey: "compat-key" }
        : undefined,
  };
  guardServerRuntime(runtime as unknown as ModelRuntime);
  return { runtime, asked };
}

const codex = {
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
};
const compat = { provider: COMPAT, baseUrl: COMPAT_BASE };

test("AC3: with the gateway on, a Codex model gets no auth and pi is never asked", async () => {
  gatewayOn = true;
  const { runtime, asked } = fakeRuntime();
  assert.equal(await runtime.getAuth(codex), undefined);
  assert.deepEqual(asked, []);
  // The compatible pairing is unchanged.
  assert.ok(await runtime.getAuth(compat));
  assert.equal(
    await runtime.getAuth({ provider: COMPAT, baseUrl: "https://elsewhere" }),
    undefined,
  );
  assert.deepEqual(asked, [COMPAT]);
});

test("AC3: with the gateway off, a Codex model resolves as pi resolves it", async () => {
  gatewayOn = false;
  try {
    const { runtime, asked } = fakeRuntime();
    assert.ok(await runtime.getAuth(codex));
    assert.deepEqual(asked, ["openai-codex"]);
  } finally {
    gatewayOn = true;
  }
});
