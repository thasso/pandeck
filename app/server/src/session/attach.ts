/**
 * Runtime attachment assembly. Wires a hub-owned session to a connection through
 * the normalized runtime + transport without duplicating the session: the
 * adapter observes the same live hub session, while the transport renders from
 * the app-owned log/runtime.
 *
 * This is the render path for both harnesses: `connection.view` attaches a
 * runtime-backed view for every viewed session and routes prompt/abort/model
 * changes through the returned handle, detaching on session switch/close.
 */
import type {
  ContextInfo,
  PromptAttachment,
  SessionState,
  TimelineCacheDescriptor,
} from "@assistant/shared";
import type {
  LiveBodyKey,
  PromptOrigin,
  SessionConfigModel,
} from "@assistant/shared/session";
import type { SessionRuntime } from "./runtime/runtime.ts";
import {
  ensureRuntimeSessionWithRuntime,
  promptRuntimeSessionWithRuntime,
  type RuntimePromptDriver,
} from "./runtimePrompt.ts";
import { DetachedSessionError } from "./adapters/detached.ts";
import { RuntimeTransport, type RuntimeViewer } from "./transport/gateway.ts";

/** A live runtime-backed view bound to one connection viewer. */
export interface RuntimeBackedView {
  /** Drive a prompt through the runtime (gate + log + ingest). */
  prompt(
    text: string,
    options?: {
      clientRequestId?: string;
      hidden?: boolean;
      attachments?: PromptAttachment[];
      origin?: PromptOrigin;
    },
  ): Promise<void>;
  abort(): void | Promise<void>;
  setModel(model: SessionConfigModel): void | Promise<void>;
  setReasoning(level: string): void | Promise<void>;
  /** Replace the viewer's live-body demand (see `RuntimeTransport.setLiveBodySubscriptions`). */
  setLiveBodySubscriptions(keys: readonly LiveBodyKey[]): void;
  /** Stop relaying to this viewer (on session switch / connection close) and release its hold. */
  detach(): void;
}

export interface AttachDeps {
  buildState: () => SessionState;
  buildContextInfo?: () => ContextInfo;
  timelineCache?: TimelineCacheDescriptor;
}

/**
 * Attach a runtime-backed view for a hub session.
 *
 * `driver` is absent for a session nobody has opened a harness for: the view is
 * then DETACHED (`adapters/detached.ts`) — it renders the durable log and
 * refuses every drive call, because reaching one means the caller skipped
 * `Connection.ensureViewingDriver`.
 */
export function attachRuntimeView(
  runtime: SessionRuntime,
  sessionId: string,
  driver: RuntimePromptDriver | undefined,
  viewer: RuntimeViewer,
  deps: AttachDeps,
): RuntimeBackedView {
  // Reuse the live runtime session if one already exists (another viewer); only
  // build + register an adapter the FIRST time, so we never double-observe the
  // underlying hub session.
  const session = driver
    ? ensureRuntimeSessionWithRuntime(runtime, driver)
    : runtime.openForView(sessionId);
  // Held until detach: the last view of a detached session to let go releases
  // it (`SessionRuntime.retainView`).
  const releaseView = runtime.retainView(session);
  const transport = new RuntimeTransport(sessionId, session, viewer, {
    buildState: deps.buildState,
    buildContextInfo: deps.buildContextInfo ?? (() => session.contextInfo()),
    ...(deps.timelineCache !== undefined
      ? { timelineCache: deps.timelineCache }
      : {}),
  });
  transport.attach();
  const refuseDetached = (): never => {
    throw new DetachedSessionError(sessionId);
  };
  return {
    prompt: (text, options) =>
      driver
        ? promptRuntimeSessionWithRuntime(runtime, driver, text, options)
        : refuseDetached(),
    abort: () => session.abort(),
    setModel: (model) => session.setModel(model),
    setReasoning: (level) => session.setReasoning(level),
    setLiveBodySubscriptions: (keys) =>
      transport.setLiveBodySubscriptions(keys),
    detach: () => {
      transport.detach();
      releaseView();
    },
  };
}
