/**
 * One end of a worker protocol connection. Both ends are the same peer: either
 * may send requests and serve them. The server sends checkout (and later
 * engine) operations to the Worker; the Worker sends app tools (and later
 * approvals and hooks) the other way.
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
  type AssemblyLimits,
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
/** The error code of a request over a bounded connection's serving cap. */
const BUSY = "busy";

/**
 * Why a connection ended, as a closed set a log line may hold; the reason
 * text may carry the peer's words.
 */
export type ConnectionEndCause =
  "local" | "peer-closed" | "protocol" | "handshake-timeout" | "refused";

/**
 * Opt-in bounds for a connection whose peer is held to small messages: what
 * it may make this side buffer, how many of its requests run at once (more
 * are answered `busy`), and no peer text reflected in a reply.
 */
export interface ConnectionLimits extends AssemblyLimits {
  maxServing: number;
}

/**
 * What a handler may ask of its request's response (Task-1441 P7a, H1).
 * Only a handler that calls `onSettled` changes how its request is counted:
 * its id stays in `serving`, and so under `maxServing`, until the response
 * has settled. Every other request is counted only while its handler runs.
 */
export interface MethodContext {
  /**
   * Calls `fn` once when this request's response has settled: every frame
   * written for it was flushed or discarded by the transport, or, when the
   * connection had ended before the handler finished, at that finish, with
   * no frame written. Never at the connection's end alone.
   */
  onSettled(fn: () => void): void;
  /**
   * Ends the connection with `reason` unless the response settles within
   * `ms` of its last frame being written: a peer that stops reading cannot
   * hold the response's bytes here for ever.
   */
  drainWithin(ms: number, reason: string): void;
}

export type MethodHandler = (
  payload: Payload,
  signal: AbortSignal,
  context?: MethodContext,
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

/** The version a connection's handshake speaks, and which peers it accepts. */
export interface ConnectionProtocol {
  version: string;
  compatible(version: string): boolean;
}

/** The worker protocol, every connection's default. */
const WORKER_PROTOCOL: ConnectionProtocol = {
  version: WORKER_PROTOCOL_VERSION,
  compatible: compatibleProtocolVersion,
};

interface ConnectionOptions {
  handshake: Handshake;
  /**
   * The protocol of the handshake, the worker protocol unless given. The
   * dialer sends its version and checks the welcome against it; the listener
   * answers with its version and leaves the check to `admit`.
   */
  protocol?: ConnectionProtocol;
  handlers?: MethodHandlers;
  /**
   * Resolves once nothing the peer started for this side's requests still
   * runs. Requests the peer received are rejected only after it, on end;
   * without it, at once.
   */
  quiescence?: () => Promise<void>;
  /**
   * Called once, synchronously, when the connection ends. `incompatible` is
   * true when the dialer's handshake was refused or the welcome named a
   * version it does not speak.
   */
  onEnd?: (
    reason: string,
    end: { incompatible: boolean; cause: ConnectionEndCause },
  ) => void;
  limits?: ConnectionLimits;
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
  private readonly assembler: MessageAssembler;
  private readonly handlers: MethodHandlers;
  private nextId = 1;
  private readonly unsent: Outgoing[] = [];
  private readonly sent = new Map<number, Outgoing>();
  private readonly serving = new Map<number, AbortController>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly handshakeTimer: ReturnType<typeof setTimeout>;
  private readonly protocol: ConnectionProtocol;

  constructor(
    private readonly transport: ByteEndpoint,
    private readonly options: ConnectionOptions,
  ) {
    this.handlers = options.handlers ?? {};
    this.assembler = new MessageAssembler(options.limits);
    this.protocol = options.protocol ?? WORKER_PROTOCOL;
    this.ended = new Promise((resolve) => {
      this.resolveEnded = resolve;
    });
    transport.onData((bytes) => this.receive(bytes));
    transport.onClose(() => {
      try {
        this.decoder.finish();
        this.finish("the peer closed the connection", false, "peer-closed");
      } catch (err) {
        this.finish(`protocol error: ${errorText(err)}`, false, "protocol");
      }
    });
    this.handshakeTimer = setTimeout(
      () => this.finish("the handshake timed out", false, "handshake-timeout"),
      HANDSHAKE_TIMEOUT_MS,
    );
    this.handshakeTimer.unref?.();
    if (options.handshake.role === "worker")
      transport.write(
        encodeControlFrame({
          type: "hello",
          workerId: options.handshake.workerId,
          version: this.protocol.version,
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
    this.finish(reason, false);
  }

  private finish(
    reason: string,
    incompatible: boolean,
    cause: ConnectionEndCause = "local",
  ): void {
    if (this.endReason !== undefined) return;
    this.endReason = reason;
    clearTimeout(this.handshakeTimer);
    // Unfinished messages are never completed now; release their bytes.
    this.assembler.clear();
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
    this.options.onEnd?.(reason, { incompatible, cause });
    this.resolveEnded(reason);
  }

  private endedError(): Error {
    return new WorkerConnectionEndedError(
      `The Worker connection ended: ${this.endReason}.`,
    );
  }

  /**
   * Nothing thrown while handling the peer's bytes leaves here: it ends this
   * connection only. Anything but a {@link WorkerProtocolError} is this side's
   * own defect, so it is logged as well.
   */
  private receive(bytes: Uint8Array): void {
    if (this.endReason !== undefined) return;
    try {
      this.decoder.push(bytes, (frame) => {
        if (this.endReason === undefined) this.onFrame(frame);
      });
    } catch (err) {
      if (!(err instanceof WorkerProtocolError))
        console.error("[worker-protocol] internal error on peer input:", err);
      this.finish(`protocol error: ${errorText(err)}`, false, "protocol");
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
            version: this.protocol.version,
            reason: refusal,
          }),
        );
        this.finish(`refused: ${refusal}`, false, "refused");
        return;
      }
      this.transport.write(
        encodeControlFrame({
          type: "welcome",
          version: this.protocol.version,
        }),
      );
    } else {
      if (frame.type === "refused") {
        this.finish(`the server refused: ${frame.reason}`, true, "refused");
        return;
      }
      if (frame.type !== "welcome")
        throw new WorkerProtocolError(`Expected welcome, got ${frame.type}.`);
      if (!this.protocol.compatible(frame.version)) {
        this.finish(
          `the server speaks protocol ${frame.version}`,
          true,
          "refused",
        );
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
    const { limits } = this.options;
    if (!handler) {
      this.respond(
        id,
        { failure: UNKNOWN_METHOD },
        {
          text: {
            message: limits
              ? "Unknown method."
              : `Unknown method ${JSON.stringify(method)}.`,
          },
        },
      );
      return;
    }
    if (limits && this.serving.size >= limits.maxServing) {
      this.respond(id, { failure: BUSY }, { text: { message: "Busy." } });
      return;
    }
    const controller = new AbortController();
    this.serving.set(id, controller);
    const output = new ResponseOutput(() => {
      if (this.serving.get(id) === controller) this.serving.delete(id);
    });
    const run = (async () => {
      try {
        const result = await handler(payload, controller.signal, output);
        this.respond(id, {}, result, output);
      } catch (err) {
        this.respond(
          id,
          { failure: err instanceof WorkerMethodError ? err.code : "failed" },
          { text: { message: errorText(err) } },
          output,
        );
      } finally {
        if (!output.registered) this.serving.delete(id);
      }
    })();
    this.inflight.add(run);
    void run.then(() => this.inflight.delete(run));
  }

  private respond(
    id: number,
    head: { failure?: string },
    payload: Payload,
    output?: ResponseOutput,
  ) {
    if (this.endReason !== undefined) {
      // Nothing is written: the response is unreachable once this returns.
      output?.settle();
      return;
    }
    if (!output?.registered) {
      for (const frame of encodeMessage("response", id, head, payload))
        this.transport.write(frame);
      output?.settle();
      return;
    }
    let pending = 0;
    let sealed = false;
    const flushed = (): void => {
      pending -= 1;
      if (sealed && pending === 0) output.settle();
    };
    for (const frame of encodeMessage("response", id, head, payload)) {
      pending += 1;
      this.transport.write(frame, flushed);
    }
    // Only now may the count reach zero: a callback for an early frame
    // cannot settle a batch still being written.
    sealed = true;
    if (pending === 0) output.settle();
    else output.armDrain((reason) => this.end(reason));
  }
}

/**
 * One request's response as its handler sees it (`MethodContext`): the
 * functions to call once it settles, and the drain bound. Settles once.
 */
class ResponseOutput implements MethodContext {
  registered = false;
  private settled = false;
  private readonly settledFns: (() => void)[] = [];
  private drain: { ms: number; reason: string } | undefined;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onSettledOnce: () => void) {}

  onSettled(fn: () => void): void {
    this.registered = true;
    if (this.settled) queueMicrotask(fn);
    else this.settledFns.push(fn);
  }

  drainWithin(ms: number, reason: string): void {
    this.drain = { ms, reason };
  }

  /** Starts the drain bound, if any, after the last frame was written. */
  armDrain(end: (reason: string) => void): void {
    const { drain } = this;
    if (!drain || this.settled) return;
    this.drainTimer = setTimeout(() => {
      if (!this.settled) end(drain.reason);
    }, drain.ms);
    this.drainTimer.unref?.();
  }

  settle(): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.drainTimer);
    if (this.registered) this.onSettledOnce();
    for (const fn of this.settledFns.splice(0))
      try {
        fn();
      } catch {
        // Fixed text: a callback's error may carry what it was working on.
        console.error("[worker-protocol] a settled callback failed");
      }
  }
}
