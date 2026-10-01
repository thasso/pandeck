/**
 * What Enter does in the composer while a turn is running: steer the running
 * turn, or queue the message for after it. Remembered per device, like the
 * user's other composer habits, so a phone and a desktop can differ.
 */
export type BusySendMode = "steer" | "queue";

const STORAGE_KEY = "pa:composer-busy-send-mode";

export function readBusySendMode(): BusySendMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "queue"
      ? "queue"
      : "steer";
  } catch {
    return "steer";
  }
}

export function writeBusySendMode(mode: BusySendMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // A browser that refuses storage just forgets the choice.
  }
}
