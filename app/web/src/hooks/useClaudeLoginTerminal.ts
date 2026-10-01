import { useEffect, useRef, useState } from "react";
import type {
  ClaudeLoginClientMessage,
  ClaudeLoginServerMessage,
  ClaudeLoginTerminalStatus,
} from "@assistant/shared";
import { serverHttpOrigin, withToken } from "../lib/serverOrigin.ts";

function claudeLoginSocketUrl(profileId: string): string {
  const url = new URL("/ws/claude-login", serverHttpOrigin());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("profileId", profileId);
  return withToken(url.toString());
}

/** Owns the short-lived dedicated socket for one reconnectable official Claude CLI login. */
export function useClaudeLoginTerminal(
  profileId: string,
  onFinished: () => void,
) {
  const [status, setStatus] = useState<ClaudeLoginTerminalStatus>("connecting");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [reconnect, setReconnect] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<ClaudeLoginTerminalStatus>("connecting");
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    const socket = new WebSocket(claudeLoginSocketUrl(profileId));
    socketRef.current = socket;
    const updateStatus = (
      next: ClaudeLoginTerminalStatus,
      nextError?: string,
    ) => {
      statusRef.current = next;
      setStatus(next);
      setError(nextError);
      if (next === "ready") onFinishedRef.current();
    };
    socket.onmessage = (event) => {
      let message: ClaudeLoginServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ClaudeLoginServerMessage;
      } catch {
        return;
      }
      if (message.type === "snapshot") {
        setOutput(message.output);
        updateStatus(message.status, message.error);
      } else if (message.type === "output") {
        setOutput((current) => current + message.chunk);
      } else {
        updateStatus(message.status, message.error);
      }
    };
    socket.onerror = () => {
      if (!disposed)
        setError("The login connection was interrupted. Reconnecting…");
    };
    socket.onclose = () => {
      if (socketRef.current === socket) socketRef.current = null;
      if (disposed || statusRef.current !== "connecting") return;
      reconnectTimer = window.setTimeout(
        () => setReconnect((value) => value + 1),
        800,
      );
    };
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket.close();
    };
  }, [profileId, reconnect]);

  const send = (message: ClaudeLoginClientMessage) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return false;
    socketRef.current.send(JSON.stringify(message));
    return true;
  };

  return {
    status,
    output,
    error,
    submit: (data: string) => send({ type: "input", data }),
    cancel: () => send({ type: "cancel" }),
  };
}
