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
  startToken: string,
): string {
  const url = new URL("/ws/account-login", serverHttpOrigin());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("profileId", profileId);
  url.searchParams.set("intent", intent);
  if (intent === "start") url.searchParams.set("startToken", startToken);
  return withToken(url.toString());
}

/** An opaque per-mount token; `getRandomValues` works without a secure context. */
function newStartToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
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
 *
 * Pressed before any snapshot, it is bound only to a run this mount's start
 * chose: the start socket's own snapshot (the run it created or joined), or
 * after a reconnect a snapshot echoing this mount's `startToken` (the run it
 * created). Any other run drops it unsent: an earlier Cancel never ends a
 * login this mount did not start or join. If that run is still running (a
 * start that joined another's login, whose snapshot was lost), the dialog
 * asks for Cancel again (`cancelUnconfirmed`); a finished run needs nothing.
 *
 * The dialog learns what its Cancel did per run, never per mount:
 * `cancelling` holds only while this mount's Cancel is latched or sent for the
 * shown run (a snapshot of another run clears it, so Cancel works there
 * again), and `cancelledHere` only once the shown run ended cancelled after
 * this mount's Cancel was sent for that same run. A login cancelled by anyone
 * else keeps its notice.
 */
export function useAccountLogin(profileId: string, onFinished: () => void) {
  const [status, setStatus] = useState<AccountLoginStatus>("connecting");
  const [output, setOutput] = useState("");
  const [device, setDevice] = useState<AccountLoginDevice | undefined>();
  const [error, setError] = useState<string | undefined>();
  // An early Cancel could not be tied to the shown run and was not sent.
  const [cancelUnconfirmed, setCancelUnconfirmed] = useState(false);
  // This mount's Cancel is latched or sent for the shown run.
  const [cancelling, setCancelling] = useState(false);
  // The shown run ended cancelled after this mount's Cancel was sent for it.
  const [cancelledHere, setCancelledHere] = useState(false);
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
  // Every run this mount actually sent a Cancel for: the proof that outlives
  // the latch, which a terminal status clears.
  const cancelSentRef = useRef(new Set<string>());
  const [startToken] = useState(newStartToken);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    const startSocket = reconnect === 0;
    const socket = new WebSocket(
      accountLoginSocketUrl(
        profileId,
        startSocket ? "start" : "attach",
        startToken,
      ),
    );
    socketRef.current = socket;
    snapshotSeenRef.current = false;
    const updateStatus = (
      next: AccountLoginStatus,
      runId: string | undefined,
      nextError?: string,
    ) => {
      statusRef.current = next;
      if (next !== "connecting") {
        cancelRef.current = null;
        setCancelUnconfirmed(false);
        setCancelling(false);
      }
      setCancelledHere(
        next === "cancelled" &&
          runId !== undefined &&
          cancelSentRef.current.has(runId),
      );
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
        updateStatus(message.status, message.runId, message.error);
        // Replay a latched Cancel only onto the run it was pressed for.
        const latched = cancelRef.current;
        if (latched) {
          if (
            latched.runId === undefined &&
            (startSocket || message.startToken === startToken)
          )
            latched.runId = message.runId;
          if (latched.runId === message.runId) {
            socket.send(
              JSON.stringify({ type: "cancel", runId: message.runId }),
            );
            cancelSentRef.current.add(message.runId);
          } else {
            // Never sent to a run not proven ours; a running one needs the
            // user's explicit Cancel.
            if (latched.runId === undefined) setCancelUnconfirmed(true);
            cancelRef.current = null;
            setCancelling(false);
          }
        }
      } else if (message.type === "output") {
        setOutput((current) => current + message.chunk);
      } else if (message.type === "device") {
        setDevice(message.device);
      } else {
        updateStatus(message.status, message.runId, message.error);
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
  }, [profileId, reconnect, startToken]);

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
    cancelUnconfirmed,
    cancelling,
    cancelledHere,
    submit: (data: string) => send({ type: "input", data }),
    cancel: () => {
      if (statusRef.current !== "connecting") return;
      setCancelUnconfirmed(false);
      // Before this socket's snapshot, the snapshot sends it.
      const runId = snapshotSeenRef.current ? runIdRef.current : undefined;
      cancelRef.current = { runId: runIdRef.current };
      setCancelling(true);
      if (runId !== undefined && send({ type: "cancel", runId }))
        cancelSentRef.current.add(runId);
    },
  };
}
