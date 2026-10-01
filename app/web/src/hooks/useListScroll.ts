import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  anchorScrollTop,
  canReach,
  fallbackScrollTop,
  isAtScrollTop,
  listScrollMemory,
  LIST_SCROLL_TOP_PX,
  positionToRemember,
  type ListScrollAnchor,
  type ListScrollPosition,
} from "../lib/listScroll.ts";

/**
 * The attribute a list row carries so a restore can find it again. It goes on
 * the row's outermost element and holds the object's id — the value only has to
 * be stable for that row across a re-render, not unique across lists. Read it
 * through this constant rather than `dataset.listRowId`, which is the same name
 * spelled differently and drifts silently.
 */
const LIST_ROW_ATTRIBUTE = "data-list-row-id";

/** Quiet period after scrolling before the position is written down. */
const RECORD_IDLE_MS = 150;
/** How often a restore looks again for a row the list has not delivered yet. */
const RESTORE_RETRY_MS = 100;
/**
 * How long a restore may keep correcting once its target is reachable at all.
 * Short, because from here on it is only chasing rows that are still settling.
 */
const RESTORE_SETTLE_MS = 1500;
/**
 * How long it may wait for the LIST itself. A cold socket on a slow phone is
 * exactly the case this feature exists for, so the wait for content that has
 * not arrived is not spent out of the settling budget. A reader scroll cancels
 * either way, so the longer window costs nothing they can feel.
 */
const RESTORE_ARRIVAL_MS = 8000;
/** Applications that changed nothing before a restore counts as settled. */
const ANCHORED_STABLE_HITS = 2;
const FALLBACK_STABLE_HITS = 1;

interface PendingRestore {
  position: ListScrollPosition;
  /** Ceiling on waiting for the list to exist at all. */
  arrivalDeadline: number;
  /** Ceiling on converging, armed once the target is reachable. */
  settleDeadline: number | null;
  /** Consecutive applications that did not move the view. */
  stable: number;
}

export interface UseListScrollOptions {
  /**
   * Stable identity of the list whose position is remembered — the sidebar
   * section, or the surface's route key. `null` records and restores nothing,
   * which is how a surface that is not showing its list opts out.
   */
  listKey: string | null;
}

function metricsOf(element: HTMLElement) {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

function rowElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(`[${LIST_ROW_ATTRIBUTE}]`),
  );
}

/** The row the reader's eye is on: the first one still visible at the top edge. */
function visibleAnchor(container: HTMLElement): ListScrollAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  for (const row of rowElements(container)) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= containerTop + 1) continue;
    const rowId = row.getAttribute(LIST_ROW_ATTRIBUTE);
    if (!rowId) continue;
    return { rowId, offset: rect.top - containerTop };
  }
  return null;
}

function findRow(container: HTMLElement, rowId: string): HTMLElement | null {
  // A scan rather than an attribute selector: row ids come from the wire (a
  // Knowledge tree path carries slashes and dots), and this runs only while a
  // restore is in flight.
  for (const row of rowElements(container)) {
    if (row.getAttribute(LIST_ROW_ATTRIBUTE) === rowId) return row;
  }
  return null;
}

/**
 * Remembers where the reader was in a list and puts them back on the way in.
 *
 * The one rule that keeps this affordable: nothing in here may call `setState`.
 * These are the sidebar's object browsers — the left pane of every screen, with
 * a memoized row per Task — so a render per frame of scrolling would undo the
 * work that keeps them cheap (`src/CLAUDE.md`). The anchor walk (a
 * `getBoundingClientRect` per row) runs only once scrolling goes quiet, and on
 * the one render where the container changes lists.
 *
 * Policy and persistence are pure in `lib/listScroll.ts`; this owns the
 * container, the listeners and the retry loop. Its own behaviour is covered in
 * `useListScroll.test.tsx`, which opts into jsdom.
 */
export function useListScroll({ listKey }: UseListScrollOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const memory = listScrollMemory();

  const keyRef = useRef<string | null>(listKey);
  const pending = useRef<PendingRestore | null>(null);
  /** The scrollTop we last set ourselves; a matching scroll event is not the reader's. */
  const expected = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const recordTimer = useRef<number | null>(null);
  /** Bumped whenever the container changes lists, so a deferred write cannot land on the wrong key. */
  const generation = useRef(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedContent = useRef<Element | null>(null);

  const clearRetry = useCallback(() => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);

  /**
   * While a restore is correcting the position, the browser's own scroll
   * anchoring would be correcting it too — two mechanisms chasing the same
   * drift, and the browser's shows up here as a scroll we did not cause, which
   * hands the position back to the reader and abandons the restore.
   */
  const syncOverflowAnchor = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    element.style.overflowAnchor = pending.current ? "none" : "";
  }, []);

  const record = useCallback(
    (key: string | null) => {
      const element = containerRef.current;
      if (!key || !element) return;
      // A restore is still correcting the position; recording now would file its
      // intermediate offsets as the reader's.
      if (pending.current) return;
      // A detached or zero-height container measures as "at the top", which
      // would drop a good position on the way out.
      if (!element.isConnected || element.clientHeight === 0) return;
      const metrics = metricsOf(element);
      // The anchor costs a layout read per row, so it is only taken where the
      // position is worth keeping at all — the same threshold the policy applies.
      const position = positionToRemember(
        metrics,
        metrics.scrollTop > LIST_SCROLL_TOP_PX ? visibleAnchor(element) : null,
      );
      if (position) memory.save(key, position);
      else memory.forget(key);
    },
    [memory],
  );

  // The container is about to be handed to another list. React mutates a
  // fiber's host children BEFORE it runs that fiber's layout destroy, so by the
  // time any effect cleanup sees this container it already holds the INCOMING
  // list — measuring there files the new list's rows under the old key, and a
  // shorter incoming list clamps `scrollTop` to 0, which reads as "the reader
  // is at the top" and forgets a perfectly good position. The render phase is
  // the last moment the outgoing DOM is still there. Read-only: no state, no
  // mutation, and it costs one anchor walk per section switch.
  if (keyRef.current !== listKey) {
    record(keyRef.current);
    keyRef.current = listKey;
  }

  /**
   * Deferred rather than per-event: where the reader stopped is only
   * interesting once they stop. A departure inside the quiet period is covered
   * by the capture above (a section switch) and the unmount cleanup below.
   */
  const scheduleRecord = useCallback(() => {
    if (recordTimer.current !== null) window.clearTimeout(recordTimer.current);
    const at = generation.current;
    const key = keyRef.current;
    recordTimer.current = window.setTimeout(() => {
      recordTimer.current = null;
      // The container may have been handed to another list since this was
      // scheduled; measuring it now would file that list's position under this key.
      if (at !== generation.current) return;
      record(key);
    }, RECORD_IDLE_MS);
  }, [record]);

  /**
   * A list's content root is replaced whenever the container changes lists (and
   * when a browser swaps a placeholder for its rows), so the node to watch for
   * "the list arrived" is re-resolved rather than captured once.
   */
  const syncContentObservation = useCallback(() => {
    const element = containerRef.current;
    const observer = observerRef.current;
    if (!element || !observer) return;
    const content = element.firstElementChild;
    if (content === observedContent.current) return;
    if (observedContent.current) observer.unobserve(observedContent.current);
    observedContent.current = content;
    if (content) observer.observe(content);
  }, []);

  const applyRef = useRef<() => void>(() => {});

  /** Put the view where the pending restore says it belongs. Never renders. */
  const apply = useCallback(() => {
    const element = containerRef.current;
    const target = pending.current;
    if (!element || !target) return;
    clearRetry();
    syncContentObservation();
    const now = Date.now();
    const metrics = metricsOf(element);
    const anchor = target.position.anchor;
    const row = anchor ? findRow(element, anchor.rowId) : null;

    let wanted: number | null = null;
    if (row && anchor) {
      wanted = anchorScrollTop(
        metrics,
        element.getBoundingClientRect().top,
        row.getBoundingClientRect().top,
        anchor.offset,
      );
    } else if (canReach(target.position, metrics)) {
      // No anchor row (yet). A list fills in after its container mounts — the
      // Knowledge tree is fetched, a Backlog subscription answers — so a list
      // too short to hold the position is not a failure, it is a list that has
      // not arrived. The pixel offset stands in meanwhile, and is the whole
      // answer for a browser whose rows carry no id.
      wanted = fallbackScrollTop(target.position, metrics);
    }

    if (wanted !== null) {
      // The target exists, so from here the restore is only converging: start
      // the short clock and stop spending the long one.
      if (target.settleDeadline === null)
        target.settleDeadline = now + RESTORE_SETTLE_MS;
      if (isAtScrollTop(metrics, wanted)) target.stable += 1;
      else {
        element.scrollTop = wanted;
        expected.current = element.scrollTop;
        target.stable = 0;
      }
    }

    // Rows keep settling after the commit that mounted them (a status icon
    // resolves, a title wraps), so the first application is approximate and
    // converges over the next few passes.
    const settled =
      now >= target.arrivalDeadline ||
      (target.settleDeadline !== null && now >= target.settleDeadline) ||
      (row !== null && target.stable >= ANCHORED_STABLE_HITS) ||
      (anchor === undefined &&
        wanted !== null &&
        target.stable >= FALLBACK_STABLE_HITS);
    if (settled) {
      pending.current = null;
      syncOverflowAnchor();
      return;
    }
    retryTimer.current = window.setTimeout(
      () => applyRef.current(),
      RESTORE_RETRY_MS,
    );
  }, [clearRetry, syncContentObservation, syncOverflowAnchor]);
  applyRef.current = apply;

  // Opening a list: its remembered position, or its top. A LAYOUT effect,
  // because it has to land before the first paint.
  useLayoutEffect(() => {
    const element = containerRef.current;
    generation.current += 1;
    keyRef.current = listKey;
    pending.current = null;
    expected.current = null;
    clearRetry();
    syncOverflowAnchor();
    if (!element || !listKey) return;
    syncContentObservation();
    const remembered = memory.read(listKey);
    if (!remembered) {
      // The sidebar's browsers SHARE one scroll container, so a section that
      // remembers nothing has to be put at its top explicitly — otherwise it
      // opens at whatever offset the section before it was left at.
      element.scrollTop = 0;
      expected.current = element.scrollTop;
      return;
    }
    const now = Date.now();
    pending.current = {
      position: remembered,
      arrivalDeadline: now + RESTORE_ARRIVAL_MS,
      settleDeadline: null,
      stable: 0,
    };
    syncOverflowAnchor();
    apply();
    return () => clearRetry();
  }, [
    apply,
    clearRetry,
    listKey,
    memory,
    syncContentObservation,
    syncOverflowAnchor,
  ]);

  // Leaving for good. Unlike a key change, an unmount DOES still see its own
  // DOM: React runs layout destroys before it removes the host nodes. On a
  // phone this is the moment the whole feature turns on, since the browser is
  // unmounted — not hidden — as soon as an object screen opens.
  useLayoutEffect(() => () => record(keyRef.current), [record]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const onScroll = () => {
      const ours =
        expected.current !== null &&
        Math.abs(element.scrollTop - expected.current) <= 1;
      if (!ours) {
        expected.current = null;
        // The reader moved. A restore still correcting the position would now be
        // the controller fighting them, including through an iOS momentum fling
        // — which keeps firing scroll events with no finger on the glass.
        if (pending.current) {
          pending.current = null;
          clearRetry();
          syncOverflowAnchor();
        }
      }
      scheduleRecord();
    };
    element.addEventListener("scroll", onScroll, { passive: true });

    // Everything that changes height after the commit that caused it: a list
    // arriving, a shelf expanding, the container shrinking under the mobile
    // keyboard. Only a restore in flight cares — otherwise the reader owns the
    // position and a resize is no reason to move it.
    const observer = new ResizeObserver(() => {
      if (pending.current) apply();
    });
    observerRef.current = observer;
    observer.observe(element);
    syncContentObservation();

    const onPageHide = () => {
      // The page may never come back; take the position as it stands rather
      // than waiting out the quiet period.
      record(keyRef.current);
      memory.flush();
    };
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      onPageHide();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
      observerRef.current = null;
      observedContent.current = null;
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      if (recordTimer.current !== null)
        window.clearTimeout(recordTimer.current);
      recordTimer.current = null;
      clearRetry();
      memory.flush();
    };
  }, [
    apply,
    clearRetry,
    memory,
    record,
    scheduleRecord,
    syncContentObservation,
    syncOverflowAnchor,
  ]);

  return containerRef;
}
