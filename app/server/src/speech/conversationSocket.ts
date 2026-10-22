import type { WebSocket } from "ws";
import {
  applySpeechVocabulary,
  SPEECH_SEND_WATERMARK_BYTES,
  type ConversationClientMessage,
  type ConversationServerMessage,
  type SpeechConversationSettings,
} from "@assistant/shared";
import { getSettings } from "../settings.ts";
import { errorText } from "../errors.ts";
import { streamingSttEngine } from "./streamingSttEngine.ts";
import type {
  StreamingSttConnection,
  StreamingTranscript,
} from "./streamingSttClient.ts";

/** Separate trust boundary from both session messages and offline dictation. */
export function validateConversationClientMessage(
  raw: unknown,
):
  { ok: true; msg: ConversationClientMessage } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, reason: "not an object" };
  if (Object.keys(raw).some((key) => key !== "type"))
    return { ok: false, reason: "unexpected conversation frame field" };
  const type = (raw as Record<string, unknown>).type;
  if (type === "start" || type === "stop" || type === "cancel")
    return { ok: true, msg: { type } };
  return { ok: false, reason: "unknown conversation frame type" };
}

interface ConversationStream {
  sendPcm16: StreamingSttConnection["sendPcm16"];
  finish: StreamingSttConnection["finish"];
  close: StreamingSttConnection["close"];
}
interface ConversationRecognizer {
  open(
    settings: SpeechConversationSettings,
    onTranscript: (result: StreamingTranscript) => void,
    onError: (error: Error) => void,
    onDone: () => void,
    signal?: AbortSignal,
  ): Promise<ConversationStream>;
}

const PCM_BYTES_PER_SECOND = 32_000;
// Round the web send watermark up to a whole second, plus one maximum frame.
// At 16 kHz Int16 this is 10 s, so a permitted socket backlog can catch up.
const MAX_AUDIO_CREDIT =
  (Math.ceil(SPEECH_SEND_WATERMARK_BYTES / PCM_BYTES_PER_SECOND) + 1) *
  PCM_BYTES_PER_SECOND;

/** Audio is forwarded immediately. No retry buffer or utterance state is retained. */
export function attachConversationSocket(
  ws: WebSocket,
  recognizer: ConversationRecognizer = streamingSttEngine,
  settings = getSettings,
): void {
  let state: "idle" | "starting" | "listening" | "stopping" | "closed" = "idle";
  let stream: ConversationStream | undefined;
  let opening: AbortController | undefined;
  let generation = 0;
  let timer: NodeJS.Timeout | undefined;
  let audioBudgetAt = 0;
  let audioCredit = 0;
  const reset = () => {
    generation++;
    clearTimeout(timer);
    opening?.abort();
    opening = undefined;
    stream?.close();
    stream = undefined;
  };
  const send = (message: ConversationServerMessage) => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > 1_048_576) {
      state = "closed";
      reset();
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(message));
  };
  const fail = (message: string, code = 1008) => {
    if (state === "closed") return;
    state = "closed";
    reset();
    send({ type: "error", message });
    ws.close(code, "Conversation stopped");
  };
  const armTimeout = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => fail("Conversation audio timed out."), ms);
    timer.unref();
  };
  const start = async () => {
    if (state !== "idle") return fail("A conversation is already in progress.");
    const current = settings();
    if (!current.speechConversation.enabled)
      return fail("Conversation is disabled in settings.");
    state = "starting";
    const controller = new AbortController();
    opening = controller;
    const token = ++generation;
    armTimeout(65_000);
    try {
      const opened = await recognizer.open(
        current.speechConversation,
        (result) => {
          if (token !== generation) return;
          send({
            type: "transcript",
            ...result,
            text: applySpeechVocabulary(
              result.text.trim(),
              current.speechToText.vocabulary,
            ),
          });
        },
        (error) => {
          if (token === generation) fail(errorText(error), 1011);
        },
        () => {
          if (token !== generation) return;
          reset();
          state = "idle";
          send({ type: "stopped" });
        },
        controller.signal,
      );
      if (token !== generation) {
        opened.close();
        return;
      }
      stream = opened;
      state = "listening";
      audioBudgetAt = performance.now();
      audioCredit = MAX_AUDIO_CREDIT;
      armTimeout(30_000);
      send({ type: "accepted", sampleRate: 16000 });
    } catch (error) {
      if (token === generation) fail(errorText(error), 1011);
    } finally {
      if (opening === controller) opening = undefined;
    }
  };
  ws.on("message", (raw, isBinary) => {
    if (state === "closed") return;
    if (isBinary) {
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (state !== "listening" || !stream)
        return fail("Wait for accepted before sending conversation audio.");
      if (
        data.length === 0 ||
        data.length % 2 ||
        data.length > PCM_BYTES_PER_SECOND
      )
        return fail(
          "Audio must be Int16 LE frames of at most one second at 16 kHz.",
        );
      // Refill at real time, but never bank more than the bounded catch-up cap.
      // A monotonic clock keeps wall-clock adjustments out of admission.
      const now = performance.now();
      audioCredit = Math.min(
        MAX_AUDIO_CREDIT,
        audioCredit + ((now - audioBudgetAt) / 1000) * PCM_BYTES_PER_SECOND,
      );
      audioBudgetAt = now;
      if (data.length > audioCredit)
        return fail("Conversation audio exceeded real-time rate.");
      audioCredit -= data.length;
      armTimeout(30_000);
      try {
        stream.sendPcm16(data);
      } catch (error) {
        fail(errorText(error), 1011);
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return fail("Invalid conversation JSON.");
    }
    const validated = validateConversationClientMessage(parsed);
    if (!validated.ok) return fail(validated.reason);
    switch (validated.msg.type) {
      case "start":
        void start();
        break;
      case "cancel":
        reset();
        state = "idle";
        send({ type: "stopped" });
        break;
      case "stop":
        if (state !== "listening" || !stream)
          return fail("No active conversation to stop.");
        state = "stopping";
        armTimeout(15_000);
        try {
          stream.finish();
        } catch (error) {
          fail(errorText(error), 1011);
        }
        break;
    }
  });
  const dispose = () => {
    state = "closed";
    reset();
  };
  ws.on("close", dispose);
  ws.on("error", dispose);
}
