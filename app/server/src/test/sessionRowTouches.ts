/**
 * Records every session-row touch (`db/sessionListChanges.ts`) while still
 * forwarding it to the observer it replaced, so a test can assert WHICH rows a
 * write reported; the touch itself still stamps and reports to the topic.
 */
import { setSessionListSink } from "../db/sessionListChanges.ts";

export interface SessionRowTouchRecorder {
  /** One entry per touch call, ids sorted. */
  readonly touches: string[][];
  readonly touchAlls: string[];
  /** Every id touched so far. */
  ids(): Set<string>;
  /** Touch calls that named `id`. */
  countFor(id: string): number;
  clear(): void;
  stop(): void;
}

/** `onTouch` runs inside the writer's call, before the touch is forwarded. */
export function recordSessionRowTouches(
  onTouch?: (ids: ReadonlySet<string>) => void,
): SessionRowTouchRecorder {
  const touches: string[][] = [];
  const touchAlls: string[] = [];
  const previous = setSessionListSink({
    touch: (ids) => {
      touches.push([...ids].sort());
      onTouch?.(ids);
      previous?.touch(ids);
    },
    touchAll: (reason) => {
      touchAlls.push(reason);
      previous?.touchAll(reason);
    },
  });
  return {
    touches,
    touchAlls,
    ids: () => new Set(touches.flat()),
    countFor: (id) => touches.filter((ids) => ids.includes(id)).length,
    clear: () => {
      touches.length = 0;
      touchAlls.length = 0;
    },
    stop: () => {
      setSessionListSink(previous);
    },
  };
}
