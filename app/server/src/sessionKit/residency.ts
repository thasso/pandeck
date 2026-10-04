/**
 * What keeps a resident harness session in memory: the viewers attached to it,
 * and the idle clock that releases it once nobody views it and nothing runs.
 * Both engine session classes compose one (`docs/agent-harnesses.md`); the
 * release itself stays with the store that holds the session.
 */
import type { ServerMessage } from "@assistant/shared";
import { HARNESS_IDLE_EVICT_MS, type Viewer } from "../harness.ts";

export class SessionResidency {
  readonly viewers = new Set<Viewer>();
  /**
   * Release the session from memory, answering whether it went. Unset — a
   * session no store holds — keeps the clock from ever running.
   */
  release: (() => boolean) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  /**
   * @param isIdle Nothing in flight that only this session holds. Asked when
   *   the clock runs out; a session busy then gets a full grace again.
   */
  constructor(private readonly isIdle: () => boolean) {}

  addViewer(viewer: Viewer): void {
    this.cancel();
    this.viewers.add(viewer);
  }

  removeViewer(viewer: Viewer): void {
    this.viewers.delete(viewer);
    this.arm();
  }

  broadcast(message: ServerMessage): void {
    for (const viewer of this.viewers) viewer.send(message);
  }

  /**
   * Start the clock if nobody views the session, restarting one that runs. A
   * session found busy, or one its store keeps, starts the clock again rather
   * than stopping it, so work that ends without a turn boundary is still
   * collected.
   */
  arm(): void {
    this.cancel();
    if (!this.release || this.closed || this.viewers.size > 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed || this.viewers.size > 0) return;
      if (!this.isIdle() || !this.release?.()) this.arm();
    }, HARNESS_IDLE_EVICT_MS);
    this.timer.unref?.();
  }

  /** Stop the clock: something runs, or someone views the session. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The session is disposed: the clock never runs again. */
  close(): void {
    this.closed = true;
    this.cancel();
  }
}
