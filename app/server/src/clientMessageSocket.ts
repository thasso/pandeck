import type { WebSocket } from "ws";
import type { Connection } from "./connection.ts";
import { validateClientMessage } from "./validateClientMessage.ts";

/** The session socket's trust and error boundary, installed by `index.ts`. */
export function attachClientMessageSocket(
  ws: WebSocket,
  connection: Pick<Connection, "handle">,
): void {
  ws.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const result = validateClientMessage(parsed);
    if (!result.ok) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: `Rejected ${result.type} message: ${result.reason}`,
        }),
      );
      return;
    }
    connection.handle(result.msg).catch((err) => {
      ws.send(JSON.stringify({ type: "error", message: String(err) }));
    });
  });
}
