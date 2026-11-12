import { useEffect, useRef, useState } from "react";
import type {
  AccountLoginClientMessage,
  AccountLoginDevice,
  AccountLoginIntent,
  AccountLoginServerMessage,
  AccountLoginStatus,
} from "@assistant/shared";
import { serverHttpOrigin, withToken } from "../lib/serverOrigin.ts";

function accountLoginSocketUrl(
  profileId: string,
  intent: AccountLoginIntent,
): string {
  const url = new URL("/ws/account-login", serverHttpOrigin());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("profileId", profileId);
  url.searchParams.set("intent", intent);
  return withToken(url.toString());
}

/**
 * Owns the login dialog's short-lived socket for one account's login. The
 * first socket of a mount starts (or joins) the login; a reconnect after an
 * unexpected close while it still runs only rejoins it (`attach`), so a
 * dropped connection never starts a second login.
 *
 * Cancel is latched to the run it was pressed for, by the server's `runId`:
 * pressed while a socket opens or reconnects, it goes out once that socket's
 * snapshot shows the same run still connecting, and again after every later
 * reconnect, until the run reports a terminal status. A snapshot of another
 * run (a later login of the account) or of a finished one drops it unsent.
 * Pressed before any snapshot, it binds to the first run this mount sees.
 */
export function useAccountLogin(profileId: string, onFinished: () => void) {
  const [status, setStatus] = useState<AccountLoginStatus>("connecting");
  const [output, setOutput] = useState("");
  const [device, setDevice] = useState<AccountLoginDevice | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [reconnect, setReconnect] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<AccountLoginStatus>("connecting");
  // The run this mount's latest snapshot showed, and whether the current
  // socket has delivered its snapshot yet.
  const runIdRef = useRef<string | undefined>(undefined);
  const snapshotSeenRef = useRef(false);
  // The user's Cancel: the run it is for (unknown until a first snapshot),
  // or null. A terminal status or another run's snapshot drops it.
  const cancelRef = useRef<{ runId: string | undefined } | null>(null);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    const socket = new WebSocket(
      accountLoginSocketUrl(profileId, reconnect === 0 ? "start" : "attach"),
    );
    socketRef.current = socket;
    snapshotSeenRef.current = false;
    const updateStatus = (next: AccountLoginStatus, nextError?: string) => {
      statusRef.current = next;
      if (next !== "connecting") cancelRef.current = null;
      setStatus(next);
      setError(nextError);
      if (next === "ready") onFinishedRef.current();
    };
    socket.onmessage = (event) => {
      let message: AccountLoginServerMessage;
      try {
        message = JSON.parse(String(event.data)) as AccountLoginServerMessage;
      } catch {
        return;
      }
      if (message.type === "snapshot") {
        runIdRef.current = message.runId;
        snapshotSeenRef.current = true;
        setOutput(message.output);
        setDevice(message.device);
        updateStatus(message.status, message.error);
        // Replay a latched Cancel only onto the run it was pressed for.
        const latched = cancelRef.current;
        if (latched) {
          latched.runId ??= message.runId;
          if (latched.runId === message.runId)
            socket.send(
              JSON.stringify({ type: "cancel", runId: message.runId }),
            );
          else cancelRef.current = null;
        }
      } else if (message.type === "output") {
        setOutput((current) => current + message.chunk);
      } else if (message.type === "device") {
        setDevice(message.device);
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

  const send = (message: AccountLoginClientMessage) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return false;
    socketRef.current.send(JSON.stringify(message));
    return true;
  };

  return {
    status,
    output,
    device,
    error,
    submit: (data: string) => send({ type: "input", data }),
    cancel: () => {
      if (statusRef.current !== "connecting") return;
      // Before this socket's snapshot, the snapshot sends it.
      const runId = snapshotSeenRef.current ? runIdRef.current : undefined;
      cancelRef.current = { runId: runIdRef.current };
      if (runId !== undefined) send({ type: "cancel", runId });
    },
  };
}
