import type { WebSocket } from "ws";

/** How often a session socket is pinged; one that misses a ping is closed at the next. */
const SOCKET_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Ping `ws` every `intervalMs` and terminate it once a ping went a whole
 * interval unanswered. A phone that suspends its browser leaves the socket
 * half-open, and until TCP gives up the server would keep it registered as a
 * viewer, serializing every broadcast for nobody. Browsers answer protocol
 * pings without page code, so this only cleans up the server's side: it cannot
 * tell the client that its socket died.
 */
export function startSocketHeartbeat(
  ws: WebSocket,
  intervalMs = SOCKET_HEARTBEAT_INTERVAL_MS,
): void {
  let answered = true;
  ws.on("pong", () => {
    answered = true;
  });
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(timer);
      return;
    }
    if (!answered) {
      clearInterval(timer);
      ws.terminate();
      return;
    }
    answered = false;
    ws.ping();
  }, intervalMs);
  timer.unref();
  ws.once("close", () => clearInterval(timer));
}
