import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  ConversationServerMessage,
  DisplayMessage,
  SpeechToTextStatus,
} from "@assistant/shared";
import { serverHttpOrigin } from "../lib/serverOrigin.ts";
import {
  captureUnavailableReason,
  socketAcceptsMore,
  speechSocketUrl,
} from "../lib/speechCapture.ts";
import { startConversationCapture } from "../lib/conversationCapture.ts";
import { microphoneOwner } from "../lib/microphoneOwner.ts";
import { SpeechPlayer } from "../lib/speechPlayer.ts";
import { isPlaybackEcho, speechSegments } from "../lib/conversationText.ts";

export interface ConversationOptions {
  instanceId: string;
  sessionId: string | undefined;
  disabled: boolean;
  settings:
    Pick<AppSettings, "speechConversation" | "speechSynthesis"> | undefined;
  status: SpeechToTextStatus | null;
  messages: readonly DisplayMessage[];
  getMessages?: () => readonly DisplayMessage[];
  streaming: boolean;
  queuedMessages?: readonly { id: string }[];
  onFinal: (text: string) => boolean;
}

interface ConversationRun {
  abort: AbortController;
  socket: WebSocket;
  player: SpeechPlayer;
  stopCapture?: () => void;
  timer: ReturnType<typeof setTimeout>;
  accepted: boolean;
  finalSegment: number;
  segmentEcho: string;
  tailId: string | undefined;
  cursors: Map<string, number>;
  liveMessages: Map<string, DisplayMessage>;
  suppressed: Set<string>;
  speaking: boolean;
  agentRunning: boolean;
  hasSpoken: boolean;
  waitingForReply: boolean;
  mutedTurn: {
    messageIds: Set<string>;
    queuedIds: Set<string>;
    durableTailId: string | undefined;
    latestMessageAt: number;
  } | null;
}

function parseConversationResponse(data: string): ConversationServerMessage {
  const value: unknown = JSON.parse(data);
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid response");
  const message = value as Record<string, unknown>;
  if (
    (message.type === "accepted" && message.sampleRate === 16000) ||
    message.type === "stopped" ||
    (message.type === "error" && typeof message.message === "string") ||
    (message.type === "transcript" &&
      typeof message.text === "string" &&
      typeof message.isFinal === "boolean" &&
      typeof message.segment === "number" &&
      Number.isSafeInteger(message.segment) &&
      message.segment >= 0)
  ) {
    return value as ConversationServerMessage;
  }
  throw new Error("Invalid response");
}

type Phase =
  "off" | "starting" | "listening" | "hearing you" | "thinking" | "speaking";

function conversationUnavailable(
  options: Pick<
    ConversationOptions,
    "sessionId" | "disabled" | "settings" | "status"
  >,
): string | undefined {
  if (!options.settings?.speechConversation.enabled)
    return "Enable conversation in Dictation settings.";
  if (!options.settings.speechSynthesis.enabled)
    return "Enable spoken replies in Dictation settings.";
  if (!options.status?.conversation?.configured)
    return (
      options.status?.conversation?.reason ??
      "Streaming recognition is unavailable."
    );
  if (!options.status.tts?.configured)
    return options.status.tts?.reason ?? "Spoken replies are unavailable.";
  if (!options.sessionId) return "Open a session to start a conversation.";
  if (options.disabled)
    return "Conversation is unavailable while sending is disabled.";
  return captureUnavailableReason();
}

export function useConversation(options: ConversationOptions) {
  const latest = useRef(options);
  latest.current = options;
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<Phase>("off");
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState(microphoneOwner.id);
  const live = useRef<ConversationRun | null>(null);
  const instanceId = options.instanceId;

  useEffect(() => {
    const listener = () => setOwnerId(microphoneOwner.id);
    microphoneOwner.listeners.add(listener);
    return () => {
      microphoneOwner.listeners.delete(listener);
    };
  }, []);

  const stop = useCallback(
    (message?: string) => {
      const run = live.current;
      live.current = null;
      if (run) {
        clearTimeout(run.timer);
        run.abort.abort();
        run.stopCapture?.();
        run.player.dispose();
        if (run.socket.readyState === WebSocket.OPEN)
          run.socket.send(JSON.stringify({ type: "cancel" }));
        run.socket.close();
      }
      microphoneOwner.release(instanceId);
      setActive(false);
      setPhase("off");
      setPartial("");
      if (message) setError(message);
    },
    [instanceId],
  );

  const userMessageSent = useCallback(() => {
    if (live.current) live.current.mutedTurn = null;
  }, []);

  const reason =
    conversationUnavailable(options) ??
    (ownerId !== null && ownerId !== instanceId
      ? "The microphone is in use in another composer."
      : undefined);

  const toggle = useCallback(() => {
    if (live.current) {
      stop();
      return;
    }
    const current = latest.current;
    const unavailable = conversationUnavailable(current);
    if (unavailable) {
      setError(unavailable);
      return;
    }
    if (!microphoneOwner.claim(instanceId)) {
      setError("The microphone is in use in another composer.");
      return;
    }
    setError(null);
    setActive(true);
    setPhase("starting");
    const abort = new AbortController();
    let pendingSocket: WebSocket | undefined;
    let pendingPlayer: SpeechPlayer | undefined;
    try {
      const url = new URL(speechSocketUrl(serverHttpOrigin()));
      url.pathname = "/ws/speech/conversation";
      const socket = new WebSocket(url);
      pendingSocket = socket;
      const player = new SpeechPlayer({
        onSpeaking: (speaking) => {
          if (live.current?.player !== player) return;
          live.current.speaking = speaking;
          if (speaking) live.current.hasSpoken = true;
          setPhase(
            speaking
              ? "speaking"
              : latest.current.streaming || live.current.waitingForReply
                ? "thinking"
                : "listening",
          );
        },
        onError: (message) => {
          if (live.current?.player === player) stop(message);
        },
      });
      pendingPlayer = player;
      const run: ConversationRun = {
        abort,
        socket,
        player,
        accepted: false,
        finalSegment: -1,
        segmentEcho: "",
        tailId: (current.getMessages?.() ?? current.messages).at(-1)?.id,
        cursors: new Map(),
        liveMessages: new Map(),
        suppressed: new Set(
          (current.getMessages?.() ?? current.messages).map(
            (message) => message.id,
          ),
        ),
        speaking: false,
        agentRunning: current.streaming,
        hasSpoken: false,
        waitingForReply: false,
        mutedTurn: null,
        timer: setTimeout(() => {
          if (live.current === run)
            stop("Conversation recognition did not become ready.");
        }, 65000),
      };
      live.current = run;
      socket.onopen = () => {
        if (live.current === run)
          socket.send(JSON.stringify({ type: "start" }));
      };
      socket.onerror = () => {
        if (live.current === run) stop("Conversation connection failed.");
      };
      socket.onclose = () => {
        if (live.current === run)
          stop(
            "Conversation connection closed. Toggle conversation to reconnect.",
          );
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        if (live.current !== run) return;
        let message: ConversationServerMessage;
        try {
          message = parseConversationResponse(event.data);
        } catch {
          stop("Invalid conversation response.");
          return;
        }
        if (message.type === "accepted") {
          run.accepted = true;
          clearTimeout(run.timer);
          if (run.stopCapture) setPhase("listening");
        } else if (message.type === "error") stop(message.message);
        else if (message.type === "stopped") stop();
        else if (message.type === "transcript") {
          if (message.segment <= run.finalSegment) return;
          const text = message.text.trim();
          // Sherpa reuses the segment number after an all-silence endpoint.
          // Only a nonempty final consumes it; otherwise the next utterance vanishes.
          if (message.isFinal && text) run.finalSegment = message.segment;
          const playback = player.echoText;
          if (playback && !run.segmentEcho.includes(playback))
            run.segmentEcho = `${run.segmentEcho} ${playback}`.slice(-8000);
          const echo =
            text && isPlaybackEcho(text, run.segmentEcho, !message.isFinal);
          if (message.isFinal) run.segmentEcho = "";
          if (echo) {
            if (message.isFinal) setPartial("");
            return;
          }
          if (
            text &&
            (player.pending || (latest.current.streaming && run.hasSpoken))
          ) {
            if (!run.mutedTurn) {
              const rows =
                latest.current.getMessages?.() ?? latest.current.messages;
              run.mutedTurn = {
                messageIds: new Set(rows.map((row) => row.id)),
                queuedIds: new Set(
                  latest.current.queuedMessages?.map((item) => item.id),
                ),
                durableTailId: rows.findLast((row) => !row.streaming)?.id,
                latestMessageAt: rows.reduce(
                  (time, row) =>
                    Math.max(time, Date.parse(row.createdAt ?? "") || 0),
                  0,
                ),
              };
            }
            for (const row of latest.current.messages)
              if (row.role === "assistant") run.suppressed.add(row.id);
            player.stop();
          }
          setPartial(text);
          if (message.isFinal) {
            if (text) {
              const sent = latest.current.onFinal(text);
              if (live.current !== run) return;
              if (!sent) {
                stop(
                  "Voice message could not be sent. Check the composer and try again.",
                );
                return;
              }
              run.mutedTurn = null;
              run.waitingForReply = true;
              setPartial("");
              setPhase("thinking");
            } else
              setPhase(
                run.speaking
                  ? "speaking"
                  : latest.current.streaming
                    ? "thinking"
                    : "listening",
              );
          } else if (text) setPhase("hearing you");
        }
      };
      // Capture begins on the gesture. No pre-accepted audio is buffered/replayed.
      void startConversationCapture(
        abort.signal,
        (frame) => {
          if (live.current !== run || !run.accepted) return;
          if (!socketAcceptsMore(socket)) {
            stop("Conversation upload fell behind. Please reconnect.");
            return;
          }
          socket.send(new Int16Array(frame).buffer);
        },
        (message) => {
          if (live.current === run) stop(message);
        },
      ).then(
        (release) => {
          if (live.current === run) {
            run.stopCapture = release;
            if (run.accepted) setPhase("listening");
          } else release();
        },
        (failure: unknown) => {
          if (live.current === run)
            stop(failure instanceof Error ? failure.message : String(failure));
        },
      );
    } catch (failure) {
      if (!live.current) {
        pendingSocket?.close();
        pendingPlayer?.dispose();
      }
      abort.abort();
      stop(failure instanceof Error ? failure.message : String(failure));
    }
  }, [instanceId, stop]);

  // The transcript is a projection of useAssistant, never a second socket reducer.
  useEffect(() => {
    const run = live.current;
    if (!run) return;
    // Speech in a tool gap interrupts this run only after it has spoken.
    // A new run must not inherit a previous run's playback history.
    if (options.streaming && !run.agentRunning) run.hasSpoken = false;
    run.agentRunning = options.streaming;
    // The durable user row may precede a still-live overlay. Compare identities
    // against the interruption, independently of assistant speech/history order.
    const interrupted = run.mutedTurn;
    if (interrupted) {
      const anchor = options.messages.findIndex(
        (row) => row.id === interrupted.durableTailId,
      );
      const sent = options.messages.some(
        (row, index) =>
          row.role === "user" &&
          (!row.promptOrigin || row.promptOrigin.kind === "human") &&
          !interrupted.messageIds.has(row.id) &&
          (anchor >= 0
            ? index > anchor
            : !row.createdAt ||
              Date.parse(row.createdAt) >= interrupted.latestMessageAt),
      );
      const queued = options.queuedMessages?.some(
        (item) => !interrupted.queuedIds.has(item.id),
      );
      if (sent || queued) run.mutedTurn = null;
    }
    const currentIds = new Set(options.messages.map((message) => message.id));
    const tailIndex = run.tailId
      ? options.messages.findIndex((message) => message.id === run.tailId)
      : 0;
    const firstNew =
      tailIndex < 0 ? Math.max(0, options.messages.length - 1) : tailIndex;
    for (const [messageIndex, message] of options.messages.entries()) {
      // Extending the window backwards is history, not a new spoken response.
      const known = message.blocks.some((_, index) =>
        run.cursors.has(`${message.id}:${index}`),
      );
      const previouslySeen = known || run.suppressed.has(message.id);
      if (messageIndex < firstNew && !known) run.suppressed.add(message.id);
      if (message.role !== "assistant") {
        run.suppressed.add(message.id);
        continue;
      }
      if (message.streaming) {
        run.liveMessages.set(message.id, message);
        // Only the active stream and a few pending durable handoffs are useful.
        if (run.liveMessages.size > 4)
          run.liveMessages.delete(run.liveMessages.keys().next().value!);
      } else if (!previouslySeen) {
        // A transient response is replaced by a new durable entry id. Transfer
        // its sentence cursors and barge-in suppression, not its already-spoken audio.
        for (const [id, previous] of run.liveMessages) {
          if (currentIds.has(id) && id !== message.id) continue;
          const textBlocks = previous.blocks.flatMap((block, index) =>
            block.kind === "text" && block.text
              ? [{ text: block.text, index }]
              : [],
          );
          if (
            !textBlocks.length ||
            !textBlocks.every(({ text, index }) => {
              const block = message.blocks[index];
              return block?.kind === "text" && block.text.startsWith(text);
            })
          )
            continue;
          for (const { index } of textBlocks) {
            const cursor = run.cursors.get(`${id}:${index}`);
            if (cursor !== undefined)
              run.cursors.set(`${message.id}:${index}`, cursor);
          }
          if (run.suppressed.has(id)) run.suppressed.add(message.id);
          else if (messageIndex < firstNew && !known)
            run.suppressed.delete(message.id);
          run.liveMessages.delete(id);
          break;
        }
      } else run.liveMessages.delete(message.id);
      if (run.mutedTurn) run.suppressed.add(message.id);
      if (run.suppressed.has(message.id)) continue;
      if (!known || message.streaming) run.waitingForReply = false;
      message.blocks.forEach((block, index) => {
        if (block.kind !== "text") return;
        const key = `${message.id}:${index}`;
        const cursor = run.cursors.get(key) ?? 0;
        const segments = speechSegments(
          block.text,
          !message.streaming || index < message.blocks.length - 1,
          cursor,
        );
        run.cursors.set(key, segments.at(-1)?.end ?? cursor);
        if (segments.length)
          run.player.enqueue(segments.map((segment) => segment.text));
      });
    }
    // This is the runtime run state, which stays running across tool steps.
    // Suppress its last projection before releasing the mute on completion.
    if (!options.streaming) run.mutedTurn = null;
    if (options.messages.length) run.tailId = options.messages.at(-1)?.id;
    if (!run.speaking && !partial)
      setPhase(
        options.streaming || run.waitingForReply ? "thinking" : "listening",
      );
  }, [options.messages, options.streaming, options.queuedMessages, partial]);

  useEffect(() => {
    if (reason && live.current) stop();
  }, [reason, stop]);

  useEffect(() => {
    setError(null);
    const hide = () => {
      if (document.hidden) stop();
    };
    const unload = () => stop();
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", unload);
    window.addEventListener("beforeunload", unload);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", unload);
      window.removeEventListener("beforeunload", unload);
      stop();
    };
  }, [options.sessionId, stop]);

  return {
    active,
    phase,
    partial,
    error,
    unavailableReason: reason,
    toggle,
    userMessageSent,
  };
}
