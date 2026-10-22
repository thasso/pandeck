import type {
  IncomingMessage,
  ServerResponse,
  OutgoingHttpHeaders,
} from "node:http";
import {
  KOKORO_ENGLISH_VOICES,
  SPEECH_SYNTHESIS_LIMITS,
  type SpeechSynthesizeRequest,
  type SpeechSynthesisSettings,
} from "@assistant/shared";
import { resolveTtsRuntime } from "./ttsConfig.ts";
import { ttsEngine, TtsBusyError } from "./ttsEngine.ts";
import { pcmToWav } from "./ttsProtocol.ts";

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function validateSynthesisRequest(
  value: unknown,
): SpeechSynthesizeRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new RequestError(400, "Expected a JSON object.");
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).some(
      (key) => !["text", "voice", "speed"].includes(key),
    )
  )
    throw new RequestError(400, "Unknown synthesis field.");
  if (
    typeof request.text !== "string" ||
    !request.text.trim() ||
    request.text.length > SPEECH_SYNTHESIS_LIMITS.maxTextChars
  )
    throw new RequestError(400, "text must contain 1 to 500 characters.");
  if (
    request.voice !== undefined &&
    !KOKORO_ENGLISH_VOICES.some((voice) => voice.name === request.voice)
  )
    throw new RequestError(400, "Unknown Kokoro voice.");
  if (
    request.speed !== undefined &&
    (typeof request.speed !== "number" ||
      !Number.isFinite(request.speed) ||
      request.speed < SPEECH_SYNTHESIS_LIMITS.speed.min ||
      request.speed > SPEECH_SYNTHESIS_LIMITS.speed.max)
  )
    throw new RequestError(400, "speed must be between 0.5 and 2.");
  return {
    text: request.text.trim(),
    ...(request.voice !== undefined ? { voice: request.voice as string } : {}),
    ...(request.speed !== undefined ? { speed: request.speed as number } : {}),
  };
}

function readBody(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const aborted = () =>
      failed(
        new RequestError(408, "Synthesis request cancelled or timed out."),
      );
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8192) {
        failed(new RequestError(413, "Synthesis request is too large."));
        req.resume();
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new RequestError(400, "Invalid JSON."));
      }
    };
    req.on("data", data);
    req.on("end", end);
    req.on("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
const dependencies = { runtime: resolveTtsRuntime, engine: ttsEngine };

/** Called only behind the API's token/origin gate. The response is never cached. */
export async function handleTtsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  settings: SpeechSynthesisSettings,
  headers: OutgoingHttpHeaders,
  deps = dependencies,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on("aborted", abort);
  res.on("close", abort);
  const timeout = setTimeout(abort, 95000);
  timeout.unref();
  try {
    if (req.method !== "POST")
      throw new RequestError(405, "Method not allowed.");
    if (!settings.enabled)
      throw new RequestError(403, "Speech synthesis is disabled in settings.");
    if (
      req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json"
    )
      throw new RequestError(415, "Expected application/json.");
    const request = validateSynthesisRequest(
      await readBody(req, controller.signal),
    );
    const runtime = deps.runtime();
    if (!runtime.ok) throw new RequestError(503, runtime.reason);
    const pcm = await deps.engine.synthesize(
      request.text,
      {
        ...settings,
        ...(request.voice ? { voice: request.voice } : {}),
        ...(request.speed !== undefined ? { speed: request.speed } : {}),
      },
      controller.signal,
    );
    if (controller.signal.aborted || res.destroyed) return;
    const wav = pcmToWav(pcm);
    res.writeHead(200, {
      ...headers,
      "Content-Type": "audio/wav",
      "Content-Length": wav.length,
      "Cache-Control": "no-store",
    });
    res.end(wav);
  } catch (error) {
    if (res.destroyed) return;
    const status =
      error instanceof RequestError
        ? error.status
        : error instanceof TtsBusyError
          ? 429
          : 503;
    const message =
      error instanceof Error ? error.message : "Speech synthesis failed.";
    res.writeHead(status, {
      ...headers,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: message }));
  } finally {
    clearTimeout(timeout);
    req.off("aborted", abort);
    res.off("close", abort);
  }
}
