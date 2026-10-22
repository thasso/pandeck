import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SPEECH_SYNTHESIS_SETTINGS } from "@assistant/shared";
import type { TtsEngine } from "./ttsEngine.ts";
import { TtsBusyError } from "./ttsEngine.ts";
import { handleTtsRequest, validateSynthesisRequest } from "./ttsHttp.ts";

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});
async function setup(settings = DEFAULT_SPEECH_SYNTHESIS_SETTINGS) {
  const synthesize = vi.fn(
    async (_text: string, _settings: unknown, _signal: AbortSignal) =>
      Buffer.alloc(4),
  );
  const runtime = vi.fn(() => ({
    ok: true as const,
    python: "/python",
    modelDir: "/model",
    modelId: "kokoro-v1-fp32",
  }));
  server = createServer((req, res) => {
    void handleTtsRequest(
      req,
      res,
      settings,
      {},
      { runtime, engine: { synthesize } as unknown as TtsEngine },
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/speech/synthesize`;
  const post = (body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { synthesize, runtime, post, url };
}

test.each([
  null,
  [],
  {},
  { text: " " },
  { text: "a".repeat(501) },
  { text: "ok", voice: "../model" },
  { text: "ok", speed: 0 },
  { text: "ok", speed: "1" },
  { text: "ok", modelDir: "/tmp" },
])("rejects invalid request %j", (value) => {
  expect(() => validateSynthesisRequest(value)).toThrow();
});

test("WAV endpoint applies preview overrides without changing saved settings", async () => {
  const s = await setup();
  const response = await s.post({
    text: " Hello. ",
    voice: "bf_emma",
    speed: 1.2,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("audio/wav");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const wav = Buffer.from(await response.arrayBuffer());
  expect(wav.length).toBe(48);
  expect(wav.readUInt32LE(24)).toBe(24000);
  expect(s.synthesize.mock.calls[0]![0]).toBe("Hello.");
  expect(s.synthesize.mock.calls[0]![1]).toMatchObject({
    voice: "bf_emma",
    speed: 1.2,
  });
  expect(DEFAULT_SPEECH_SYNTHESIS_SETTINGS.voice).toBe("af_heart");
});

test("HTTP rejects methods, malformed/oversized input, unsupported media and busy engines", async () => {
  const s = await setup();
  expect((await fetch(s.url)).status).toBe(405);
  expect((await fetch(s.url, { method: "POST", body: "{}" })).status).toBe(415);
  expect(
    (
      await fetch(s.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    ).status,
  ).toBe(400);
  expect((await s.post({ text: "a".repeat(9000) })).status).toBe(413);
  expect((await s.post({ text: "a".repeat(501) })).status).toBe(400);
  expect(s.synthesize).not.toHaveBeenCalled();
  s.synthesize.mockRejectedValueOnce(new TtsBusyError("busy"));
  expect((await s.post({ text: "Hi." })).status).toBe(429);
  s.runtime.mockReturnValueOnce({
    ok: false,
    reason: "missing runtime",
  } as never);
  const missing = await s.post({ text: "Hi." });
  expect(missing.status).toBe(503);
  expect(await missing.json()).toEqual({ error: "missing runtime" });
});

test("disabled synthesis has no effects", async () => {
  const s = await setup({
    ...DEFAULT_SPEECH_SYNTHESIS_SETTINGS,
    enabled: false,
  });
  expect((await s.post({ text: "Hi." })).status).toBe(403);
  expect(s.runtime).not.toHaveBeenCalled();
  expect(s.synthesize).not.toHaveBeenCalled();
});

test("browser abort propagates to the synthesis engine", async () => {
  const s = await setup();
  let signal: AbortSignal | undefined;
  s.synthesize.mockImplementationOnce((_text, _settings, abort) => {
    signal = abort;
    return new Promise((_resolve, reject) =>
      abort.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      }),
    );
  });
  const controller = new AbortController();
  const response = fetch(s.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Hi." }),
    signal: controller.signal,
  });
  const rejected = assert.rejects(response);
  await vi.waitFor(() => expect(signal).toBeDefined());
  controller.abort();
  await rejected;
  await vi.waitFor(() => expect(signal!.aborted).toBe(true));
});
