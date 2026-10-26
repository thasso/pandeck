/**
 * One end of a worker protocol connection. Both ends are the same peer: either
 * may send requests and serve them. The server sends checkout (and later
 * engine) operations to the Worker; the Worker will send app tools, approvals
 * and hooks the other way.
 *
 * The Worker dials and opens with `hello`; the server answers `welcome` or
 * `refused`. Requests made before the handshake completes wait for it, for at
 * most {@link HANDSHAKE_TIMEOUT_MS}.
 *
 * When a connection ends — either side closing it, a refusal, or any protocol
 * error — requests not yet sent reject at once. Requests the peer already
 * received reject only once the `quiescence` the owner supplied resolves: for
 * checkout git, after every child the Worker started has exited, so a caller
 * holding a repo lock never releases it beside a running git
 * (`docs/workers.md`).
 */
import { errorText } from "../errors.ts";
import {
  FrameDecoder,
  MessageAssembler,
  WorkerProtocolError,
  encodeControlFrame,
  encodeMessage,
  type Frame,
  type Payload,
} from "./codec.ts";
import type { ByteEndpoint } from "./inProcessTransport.ts";
import {
  WORKER_PROTOCOL_VERSION,
  compatibleProtocolVersion,
} from "./version.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;

/** The error code of a request for a method the peer does not serve. */
export const UNKNOWN_METHOD = "unknown_method";

export type MethodHandler = (
  payload: Payload,
  signal: AbortSignal,
) => Promise<Payload>;

export type MethodHandlers = Readonly<Record<string, MethodHandler>>;

/** A handler's failure with a code the requester can tell apart. */
export class WorkerMethodError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The peer answered the request with an error. */
export class WorkerRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The request was cancelled before it was sent: the peer never saw it. */
export class WorkerRequestNotSentError extends Error {}

/** The connection ended before the request was answered. */
class WorkerConnectionEndedError extends Error {}

interface Hello {
  workerId: string;
  version: string;
}

type Handshake =
  /** This side is the Worker: it sends `hello` and waits for `welcome`. */
  | { role: "worker"; workerId: string }
  /** This side is the server; `admit` answers a refusal reason, or nothing. */
  | { role: "server"; admit: (hello: Hello) => string | undefined };

interface ConnectionOptions {
  handshake: Handshake;
  handlers?: MethodHandlers;
  /**
   * Resolves once nothing the peer started for this side's requests still
   * runs. Requests the peer received are rejected only after it, on end;
   * without it, at once.
   */
  quiescence?: () => Promise<void>;
  /** Called once, synchronously, when the connection ends. */
  onEnd?: (reason: string) => void;
}

interface Outgoing {
  id: number;
  method: string;
  payload: Payload;
  resolve: (payload: Payload) => void;
  reject: (err: Error) => void;
}

export class WorkerConnection {
  /** Resolves with the reason once the connection has ended. */
  readonly ended: Promise<string>;
  private endReason: string | undefined;
  private resolveEnded!: (reason: string) => void;
  private open = false;
  private readonly decoder = new FrameDecoder();
  private readonly assembler = new MessageAssembler();
  private readonly handlers: MethodHandlers;
  private nextId = 1;
  private readonly unsent: Outgoing[] = [];
  private readonly sent = new Map<number, Outgoing>();
  private readonly serving = new Map<number, AbortController>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly handshakeTimer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly transport: ByteEndpoint,
    private readonly options: ConnectionOptions,
  ) {
    this.handlers = options.handlers ?? {};
    this.ended = new Promise((resolve) => {
      this.resolveEnded = resolve;
    });
    transport.onData((bytes) => this.receive(bytes));
    transport.onClose(() => {
      try {
        this.decoder.finish();
        this.end("the peer closed the connection");
      } catch (err) {
        this.end(`protocol error: ${errorText(err)}`);
      }
    });
    this.handshakeTimer = setTimeout(
      () => this.end("the handshake timed out"),
      HANDSHAKE_TIMEOUT_MS,
    );
    this.handshakeTimer.unref?.();
    if (options.handshake.role === "worker")
      transport.write(
        encodeControlFrame({
          type: "hello",
          workerId: options.handshake.workerId,
          version: WORKER_PROTOCOL_VERSION,
        }),
      );
  }

  get isEnded(): boolean {
    return this.endReason !== undefined;
  }

  /**
   * Ask the peer to run `method`. Aborting `signal` withdraws a request not
   * yet sent ({@link WorkerRequestNotSentError}) and asks the peer to cancel
   * one it has; the peer's answer still settles it.
   */
  request(
    method: string,
    payload: Payload,
    signal?: AbortSignal,
  ): Promise<Payload> {
    if (signal?.aborted)
      return Promise.reject(
        new WorkerRequestNotSentError(`${method} was cancelled.`),
      );
    if (this.endReason !== undefined) return Promise.reject(this.endedError());
    const id = this.nextId++;
    return new Promise<Payload>((resolve, reject) => {
      const onAbort = (): void => {
        const queued = this.unsent.indexOf(entry);
        if (queued >= 0) {
          this.unsent.splice(queued, 1);
          entry.reject(
            new WorkerRequestNotSentError(`${method} was cancelled.`),
          );
        } else if (this.sent.has(id) && this.endReason === undefined)
          this.transport.write(encodeControlFrame({ type: "cancel", id }));
      };
      const entry: Outgoing = {
        id,
        method,
        payload,
        resolve: (answer) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(answer);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.open) this.send(entry);
      else this.unsent.push(entry);
    });
  }

  /** Settles once every request this side was serving has finished. */
  async handlersSettled(): Promise<void> {
    await Promise.all(this.inflight);
  }

  /** End the connection; see the module comment for what happens to requests. */
  end(reason: string): void {
    if (this.endReason !== undefined) return;
    this.endReason = reason;
    clearTimeout(this.handshakeTimer);
    this.open = false;
    this.transport.close();
    const error = this.endedError();
    for (const entry of this.unsent.splice(0)) entry.reject(error);
    for (const controller of this.serving.values()) controller.abort();
    const received = [...this.sent.values()];
    this.sent.clear();
    const release = (): void => {
      for (const entry of received) entry.reject(error);
    };
    if (this.options.quiescence && received.length > 0)
      void this.options.quiescence().then(release, release);
    else release();
    this.options.onEnd?.(reason);
    this.resolveEnded(reason);
  }

  private endedError(): Error {
    return new WorkerConnectionEndedError(
      `The Worker connection ended: ${this.endReason}.`,
    );
  }

  private receive(bytes: Uint8Array): void {
    if (this.endReason !== undefined) return;
    try {
      this.decoder.push(bytes, (frame) => {
        if (this.endReason === undefined) this.onFrame(frame);
      });
    } catch (err) {
      if (!(err instanceof WorkerProtocolError)) throw err;
      this.end(`protocol error: ${err.message}`);
    }
  }

  private onFrame(frame: Frame): void {
    if (!this.open) {
      this.handshake(frame);
      return;
    }
    switch (frame.type) {
      case "data":
        if (frame.of === "response" && !this.sent.has(frame.id))
          throw new WorkerProtocolError(
            `Response data for request ${frame.id}, which is not waiting.`,
          );
        if (frame.of === "request" && this.serving.has(frame.id))
          throw new WorkerProtocolError(
            `Request data for request ${frame.id}, which is already running.`,
          );
        this.assembler.data(frame);
        return;
      case "request": {
        if (this.serving.has(frame.id))
          throw new WorkerProtocolError(`Request ${frame.id} was sent twice.`);
        this.serve(frame.id, frame.method, this.assembler.complete(frame));
        return;
      }
      case "response": {
        const entry = this.sent.get(frame.id);
        if (!entry)
          throw new WorkerProtocolError(
            `Response for request ${frame.id}, which is not waiting.`,
          );
        const payload = this.assembler.complete(frame);
        this.sent.delete(frame.id);
        if (frame.failure === undefined) entry.resolve(payload);
        else
          entry.reject(
            new WorkerRequestError(frame.failure, payload.text?.message ?? ""),
          );
        return;
      }
      case "cancel":
        // A request that already finished has nothing left to cancel.
        this.serving.get(frame.id)?.abort();
        return;
      default:
        throw new WorkerProtocolError(
          `A ${frame.type} frame after the handshake.`,
        );
    }
  }

  private handshake(frame: Frame): void {
    const { handshake } = this.options;
    if (handshake.role === "server") {
      if (frame.type !== "hello")
        throw new WorkerProtocolError(`Expected hello, got ${frame.type}.`);
      const refusal = handshake.admit(frame);
      if (refusal !== undefined) {
        this.transport.write(
          encodeControlFrame({
            type: "refused",
            version: WORKER_PROTOCOL_VERSION,
            reason: refusal,
          }),
        );
        this.end(`refused: ${refusal}`);
        return;
      }
      this.transport.write(
        encodeControlFrame({
          type: "welcome",
          version: WORKER_PROTOCOL_VERSION,
        }),
      );
    } else {
      if (frame.type === "refused") {
        this.end(`the server refused: ${frame.reason}`);
        return;
      }
      if (frame.type !== "welcome")
        throw new WorkerProtocolError(`Expected welcome, got ${frame.type}.`);
      if (!compatibleProtocolVersion(frame.version)) {
        this.end(`the server speaks protocol ${frame.version}`);
        return;
      }
    }
    this.open = true;
    clearTimeout(this.handshakeTimer);
    for (const entry of this.unsent.splice(0)) this.send(entry);
  }

  private send(entry: Outgoing): void {
    this.sent.set(entry.id, entry);
    for (const frame of encodeMessage(
      "request",
      entry.id,
      { method: entry.method },
      entry.payload,
    ))
      this.transport.write(frame);
  }

  private serve(id: number, method: string, payload: Payload): void {
    const handler = Object.hasOwn(this.handlers, method)
      ? this.handlers[method]
      : undefined;
    if (!handler) {
      this.respond(
        id,
        { failure: UNKNOWN_METHOD },
        {
          text: { message: `Unknown method ${JSON.stringify(method)}.` },
        },
      );
      return;
    }
    const controller = new AbortController();
    this.serving.set(id, controller);
    const run = (async () => {
      try {
        const result = await handler(payload, controller.signal);
        this.respond(id, {}, result);
      } catch (err) {
        this.respond(
          id,
          { failure: err instanceof WorkerMethodError ? err.code : "failed" },
          { text: { message: errorText(err) } },
        );
      } finally {
        this.serving.delete(id);
      }
    })();
    this.inflight.add(run);
    void run.then(() => this.inflight.delete(run));
  }

  private respond(id: number, head: { failure?: string }, payload: Payload) {
    if (this.endReason !== undefined) return;
    for (const frame of encodeMessage("response", id, head, payload))
      this.transport.write(frame);
  }
}
