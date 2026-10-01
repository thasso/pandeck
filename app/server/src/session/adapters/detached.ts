/**
 * The adapter a session is rendered through while NO harness is open for it.
 *
 * Viewing a session needs the app-owned log and nothing else: the transcript,
 * its run state and its metadata all come from storage. Opening the provider's
 * own transcript — pi's `SessionManager.open` parses the whole native file, the
 * Claude SDK record is one large JSON document — costs seconds on a long
 * session and produces nothing the reader can see. So a session that is not
 * already resident is brought live DETACHED: the runtime session exists, the
 * log renders, and the first thing that actually needs the provider (a prompt,
 * an abort, a model change) opens the harness and
 * {@link LiveRuntimeSession.rebindAdapter}s it in.
 *
 * Every drive call therefore throws {@link DetachedSessionError} rather than
 * silently doing nothing: reaching one means a caller skipped that upgrade, and
 * a swallowed prompt is the worst possible failure here.
 */
import type { ProviderBinding } from "../log/identity.ts";
import type {
  AdapterEvent,
  AgentRunResult,
  ForkCapability,
  PromptableAdapter,
} from "./contract.ts";

/** A drive call reached a session whose harness was never opened. */
export class DetachedSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} has no open harness to drive.`);
    this.name = "DetachedSessionError";
  }
}

/**
 * A detached session can do nothing but render, so it advertises no capability.
 * The transport reads these to decide which affordances a viewer gets; once the
 * harness opens, the real adapter's capabilities replace them.
 */
const NO_CAPABILITIES: ForkCapability = {
  fork: "none",
  compact: false,
  steer: false,
  attachments: false,
};

/** Whether this adapter is the render-only placeholder (see {@link detachedAdapter}). */
export function isDetachedAdapter(adapter: PromptableAdapter): boolean {
  return adapter.provider === DETACHED_PROVIDER;
}

const DETACHED_PROVIDER = "detached";

export function detachedAdapter(sessionId: string): PromptableAdapter {
  const refuse = (): never => {
    throw new DetachedSessionError(sessionId);
  };
  return {
    provider: DETACHED_PROVIDER,
    capabilities: NO_CAPABILITIES,
    // Nothing ever emits: a detached session has no provider producing events.
    subscribe: (_listener: (event: AdapterEvent) => void) => () => {},
    getBinding: (): ProviderBinding => ({ provider: DETACHED_PROVIDER }),
    prompt: (): Promise<AgentRunResult> => refuse(),
    abort: () => refuse(),
    setModel: () => refuse(),
    setReasoning: () => refuse(),
    dispose: () => {},
  };
}
