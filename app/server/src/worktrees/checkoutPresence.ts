/**
 * Whether a checkout folder is there, as its side last answered it: the one
 * source of synchronous checkout presence (`docs/workers.md`, "Checkout
 * presence"). The server never stats a checkout to answer it.
 *
 * Keys are a side and a registry-derived path only: an active spawned row's
 * path, a project's resolved main root, or a project's repo/workspace local
 * path. No caller passes a path from a client, agent or tool argument, so the
 * map is bounded by the registry and nothing is evicted; an entry leaves only
 * through {@link forgetPresence}. The Knowledge Base row never reaches a
 * Worker and never enters this cache.
 *
 * Two readers:
 *
 * - {@link presenceNow} answers synchronously from the last answer, or
 *   `unverified`, and queues one background probe (refresh on read). A
 *   failed probe writes nothing: the last verified answer stays, and
 *   never-verified is not absence.
 * - {@link checkPresence} awaits its OWN probe, requested after it was
 *   called, and resolves with that answer. It never adopts an older probe,
 *   and a Worker failure rejects.
 *
 * Every probe takes a ticket from its entry; a completion writes only into
 * the entry it was issued for, and only when no newer probe has written, so
 * a forgotten entry drops late completions and an older answer never
 * overwrites a newer one.
 */
import { checkoutFilesOn } from "../checkoutFileAccess.ts";
import { checkoutSideKey, type CheckoutSide } from "../workers/placement.ts";

/** A synchronous presence answer; `unverified` is never absence. */
export type PresenceAnswer = "present" | "absent" | "unverified";

/**
 * One changed answer: a presence key with its new answer, or a main-checkout
 * key (`main:<projectId>`) whose candidate state moved, without one.
 */
export interface PresenceChange {
  key: string;
  answer?: "present" | "absent";
}

type PresenceListener = (changes: readonly PresenceChange[]) => void;

interface Entry {
  readonly key: string;
  readonly side: CheckoutSide;
  readonly path: string;
  answer: { state: "present" | "absent"; answeredAt: number } | undefined;
  issued: number;
  applied: number;
  backgroundInFlight: boolean;
  lastReadAt: number;
  /** A background failure was logged since the last answer. */
  failing: boolean;
}

/** Background probes running at once, at most. */
const MAX_BACKGROUND_PROBES = 8;

const entries = new Map<string, Entry>();
/** Insertion-ordered; membership is the queued state. */
const queue = new Set<Entry>();
const running = new Set<Promise<void>>();
const background = new Set<Promise<unknown>>();
const listeners = new Set<PresenceListener>();
let pumpScheduled = false;
let probesIssued = 0;
let coalesced = 0;
let droppedLate = 0;

/** The cache key of `path` on `side`. */
export function presenceKey(side: CheckoutSide, path: string): string {
  return `${checkoutSideKey(side)}\0${path}`;
}

function entryFor(side: CheckoutSide, path: string): Entry {
  const key = presenceKey(side, path);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      key,
      side: side === "server" ? "server" : { workerId: side.workerId },
      path,
      answer: undefined,
      issued: 0,
      applied: 0,
      backgroundInFlight: false,
      lastReadAt: 0,
      failing: false,
    };
    entries.set(key, entry);
  }
  return entry;
}

/**
 * Calls every listener with `changes`, in registration order. A listener's
 * failure is logged; it never reaches the probe that wrote.
 */
export function notifyPresenceChange(changes: readonly PresenceChange[]): void {
  for (const listener of listeners)
    try {
      listener(changes);
    } catch (error) {
      console.warn("[checkout-presence] change listener failed:", error);
    }
}

/**
 * Registers `listener` for changed answers: none → absent and present ↔
 * absent, and every main-checkout candidate transition. None → present
 * changes nothing a reader shows, so it is not reported. Answers the
 * unregistration.
 */
export function onPresenceChange(listener: PresenceListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Writes `exists` for `ticket` under the write rule; answers whether it wrote. */
function apply(entry: Entry, ticket: number, exists: boolean): boolean {
  if (entries.get(entry.key) !== entry || ticket <= entry.applied) {
    droppedLate += 1;
    return false;
  }
  entry.applied = ticket;
  entry.failing = false;
  const state = exists ? "present" : "absent";
  const previous = entry.answer?.state;
  entry.answer = { state, answeredAt: Date.now() };
  if (previous !== state && (previous !== undefined || state === "absent"))
    notifyPresenceChange([{ key: entry.key, answer: state }]);
  return true;
}

function probe(entry: Entry): Promise<boolean> {
  probesIssued += 1;
  return checkoutFilesOn(entry.side).pathExists(entry.path, entry.path);
}

function schedulePump(): void {
  if (pumpScheduled) return;
  pumpScheduled = true;
  queueMicrotask(pump);
}

function pump(): void {
  pumpScheduled = false;
  while (running.size < MAX_BACKGROUND_PROBES) {
    const next = queue.values().next();
    if (next.done) return;
    const entry = next.value;
    queue.delete(entry);
    entry.backgroundInFlight = true;
    const ticket = ++entry.issued;
    const run: Promise<void> = probe(entry)
      .then(
        (exists) => {
          apply(entry, ticket, exists);
        },
        (error: unknown) => {
          // Writes nothing: the last verified answer stays (B15).
          if (entry.failing || entries.get(entry.key) !== entry) return;
          entry.failing = true;
          console.warn(
            `[checkout-presence] probe of ${entry.path} failed; keeping the last answer:`,
            error,
          );
        },
      )
      .finally(() => {
        entry.backgroundInFlight = false;
        running.delete(run);
        pump();
      });
    running.add(run);
  }
}

/**
 * The last answer for `path` on `side`, or `unverified`; queues one
 * background probe unless one is queued or running for it. Synchronous,
 * never throws, never touches the filesystem.
 */
export function presenceNow(side: CheckoutSide, path: string): PresenceAnswer {
  const entry = entryFor(side, path);
  entry.lastReadAt = Date.now();
  if (queue.has(entry) || entry.backgroundInFlight) coalesced += 1;
  else {
    queue.add(entry);
    schedulePump();
  }
  return entry.answer?.state ?? "unverified";
}

/**
 * Whether `path` exists on `side`, from a probe issued by this call: resolves
 * with its own answer, and records it under the write rule. Rejects on any
 * failure, writing nothing.
 */
export async function checkPresence(
  side: CheckoutSide,
  path: string,
): Promise<boolean> {
  const entry = entryFor(side, path);
  const ticket = ++entry.issued;
  const exists = await probe(entry);
  apply(entry, ticket, exists);
  return exists;
}

/** Seeds `path` as present: its creator's own success. */
export function notePresent(side: CheckoutSide, path: string): void {
  const entry = entryFor(side, path);
  apply(entry, ++entry.issued, true);
}

/** Drops `path`'s entry; a probe still running for it completes into nothing. */
export function forgetPresence(side: CheckoutSide, path: string): void {
  const key = presenceKey(side, path);
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  queue.delete(entry);
  // Forgetting a verified absence makes it unverified immediately, so list
  // readers lose worktreeMissing just as they do on a successful probe.
  if (entry.answer?.state === "absent") notifyPresenceChange([{ key }]);
}

/**
 * Keeps `work`, a background task of the presence family (a main-checkout
 * candidate rescan), visible to {@link flushPresenceForTests}.
 */
export function trackPresenceWork(work: Promise<unknown>): void {
  background.add(work);
  void work.finally(() => background.delete(work)).catch(() => {});
}

// --- Test seams -----------------------------------------------------------

/** Test seam: probe and cache counts. */
export function presenceCountsForTests(): {
  probesIssued: number;
  coalesced: number;
  droppedLate: number;
  entries: number;
  queued: number;
  backgroundInFlight: number;
} {
  return {
    probesIssued,
    coalesced,
    droppedLate,
    entries: entries.size,
    queued: queue.size,
    backgroundInFlight: running.size,
  };
}

/** Test seam: whether `path` on `side` is queued for a background probe. */
export function presenceQueuedForTests(
  side: CheckoutSide,
  path: string,
): boolean {
  const entry = entries.get(presenceKey(side, path));
  return entry !== undefined && queue.has(entry);
}

/** Test seam: forget every entry and zero the counts; listeners stay. */
export function resetPresenceForTests(): void {
  entries.clear();
  queue.clear();
  probesIssued = 0;
  coalesced = 0;
  droppedLate = 0;
}

/**
 * Test seam: resolves once no background probe or presence work is queued or
 * running. Held probes hold it.
 */
export async function flushPresenceForTests(): Promise<void> {
  for (;;) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    if (
      !pumpScheduled &&
      queue.size === 0 &&
      running.size === 0 &&
      background.size === 0
    )
      return;
    await Promise.allSettled([...running, ...background]);
  }
}
