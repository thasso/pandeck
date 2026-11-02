/**
 * The server's side of Worker connections. A Worker dials; the registry runs
 * the handshake on the stream it accepted — `welcome` on the same protocol
 * major (a higher minor included), `refused` and closed on any other — and
 * keeps each open connection by Worker id with a connection epoch, which
 * counts that Worker's admitted connections.
 */
import {
  WorkerConnection,
  type MethodHandlers,
} from "../workerProtocol/connection.ts";
import type { ByteEndpoint } from "../workerProtocol/inProcessTransport.ts";
import {
  WORKER_PROTOCOL_VERSION,
  compatibleProtocolVersion,
} from "../workerProtocol/version.ts";

/** How much of a peer's string a refusal reason quotes, in UTF-16 code units. */
const QUOTED_PEER_TEXT = 128;

/**
 * `text` as JSON, cut to its first {@link QUOTED_PEER_TEXT} code units with
 * `…` after the closing quote, so a refusal stays small whatever the peer sent.
 */
function quoted(text: string): string {
  return text.length > QUOTED_PEER_TEXT
    ? `${JSON.stringify(text.slice(0, QUOTED_PEER_TEXT))}…`
    : JSON.stringify(text);
}

export class WorkerRegistry {
  private readonly connections = new Map<
    string,
    { connection: WorkerConnection; epoch: number }
  >();
  private readonly epochs = new Map<string, number>();

  /**
   * Serve a Worker that dialed in over `transport`. `quiescence` resolves once
   * nothing that Worker started still runs; requests it received are rejected
   * only after it when the connection ends.
   */
  accept(
    transport: ByteEndpoint,
    options: { quiescence: () => Promise<void>; handlers?: MethodHandlers },
  ): WorkerConnection {
    let admitted: string | undefined;
    const connection: WorkerConnection = new WorkerConnection(transport, {
      handshake: {
        role: "server",
        admit: (hello) => {
          if (!compatibleProtocolVersion(hello.version))
            return `Worker protocol ${quoted(hello.version)} cannot talk to ${WORKER_PROTOCOL_VERSION}.`;
          if (this.connections.has(hello.workerId))
            return `Worker ${quoted(hello.workerId)} is already connected.`;
          const epoch = (this.epochs.get(hello.workerId) ?? 0) + 1;
          this.epochs.set(hello.workerId, epoch);
          this.connections.set(hello.workerId, { connection, epoch });
          admitted = hello.workerId;
          return undefined;
        },
      },
      ...(options.handlers ? { handlers: options.handlers } : {}),
      quiescence: options.quiescence,
      onEnd: () => {
        if (
          admitted !== undefined &&
          this.connections.get(admitted)?.connection === connection
        )
          this.connections.delete(admitted);
      },
    });
    return connection;
  }

  /** The open connection of `workerId`, if it is connected. */
  connection(workerId: string): WorkerConnection | undefined {
    return this.connections.get(workerId)?.connection;
  }

  /** The Worker id `connection` was admitted as, while it is open. */
  admittedAs(connection: WorkerConnection): string | undefined {
    for (const [workerId, entry] of this.connections)
      if (entry.connection === connection) return workerId;
    return undefined;
  }

  /** The epoch of `workerId`'s open connection. */
  epoch(workerId: string): number | undefined {
    return this.connections.get(workerId)?.epoch;
  }
}

export const workerRegistry = new WorkerRegistry();
