import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import {
  isNearBottom,
  nextRowEstimate,
  nextScrollMode,
  positionToRemember,
  restorableTranscriptPosition,
  ROW_ESTIMATE_DEFAULT_PX,
  rowHeightSample,
  shouldPublishRowEstimate,
  transcriptScrollMemory,
  type TranscriptScrollAnchor,
  type TranscriptScrollMode,
  type TranscriptScrollPosition,
} from "../lib/transcriptScroll.ts";

/** How often a restore looks again for a row the transcript has not delivered yet. */
const RESTORE_RETRY_MS = 100;
/**
 * How long a hold keeps correcting. It is released by the READER or by this
 * deadline — never by the layout going briefly quiet, which is what a 250ms
 * quiet period used to do. Measured on a transcript of ~600px rows: a "load
 * earlier" prepend applies correctly, the container goes quiet, and then the rows
 * mounted above the reader resolve their `content-visibility` estimates in one go
 * — +19,966px in a single resize, a few ms after a quiet-based release would have
 * fired. Holding to a deadline keeps the correction OURS for as long as the
 * layout is likely to still move; what covers the resize that lands after even
 * this deadline is the sticky anchor below.
 */
const RESTORE_DEADLINE_MS = 2000;
/** Quiet period after scrolling before the reading position is written down. */
const RECORD_IDLE_MS = 150;
/**
 * How long after a size change a scroll still counts as the LAYOUT's rather than
 * the reader's. A phone submit closes the keyboard, collapses the composer and
 * re-mounts the dock row over several frames, and the browser clamps the scroll
 * position on the way — long enough to cover that, short enough that a real
 * gesture right after it is still the reader's.
 */
const LAYOUT_SETTLE_MS = 400;
/**
 * How long a wheel, touch, key or pointer drag keeps owning the scrolls that
 * follow it. It has to outlast a fling: the finger leaves the glass and the
 * scroll events keep coming for about a second, and every one of them is the
 * reader's.
 */
const READER_INPUT_MS = 1200;
/** The keys that scroll a container, as opposed to typing into one. */
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);
/**
 * How far the reader's row may drift MID-GESTURE before it is worth a
 * correction. Outside a gesture the threshold is a pixel; inside one the write
 * is not free — a programmatic `scrollTop` during an iOS momentum fling stops
 * the fling — so a row resolving a little taller than its estimate is left
 * alone, and only a jump that loses the reader's place is bought. Measured on a
 * phone-width transcript with anchoring off: the mid-gesture jumps are 200 to
 * 2,900px, an order of magnitude clear of this.
 */
const GESTURE_DRIFT_PX = 64;
/**
 * Where to look for the row at the top edge. The second probe clears the margins
 * BETWEEN rows — 20px at a turn boundary, 12px between consecutive assistant
 * rows (`MessageList.tsx`) — where a point hits the content column, which is no
 * row and, at a fling's frame rate, would drop the hold for those frames.
 */
const TOP_EDGE_PROBES_PX = [1, 24] as const;
/** Extra rows a stalled restore may mount at a time, and how often it may do so. */
const ROW_GROWTH_STEP = 240;
const ROW_GROWTH_LIMIT = 3;
/**
 * Rows below the reader's the hold may fall back to. A view toggle can unmount
 * the very row it was captured from — "show tool calls" off takes every
 * tool-only turn out of the list — and the first row still there below it is
 * the same answer `scanRows` gives for a viewport that falls between two rows.
 * Enough of them to cross a RUN of vanishing rows, since a turn that is nothing
 * but tool calls rarely comes alone; each one past the viewport costs one rect
 * read on a walk that already reads every row above it.
 */
const HOLD_FALLBACK_ROWS = 12;
/**
 * Rows one warm-up batch renders for real, and how long after the transcript
 * goes quiet the next batch runs. Small and often rather than one sweep: each
 * batch lays out rows the browser has been skipping — measured on a 120-row
 * window, 4,481px and 5,961px rows next to 116px ones — and the reader must be
 * able to start scrolling in the gap between two of them.
 */
const WARM_BATCH_ROWS = 2;
const WARM_IDLE_MS = 100;
/**
 * How far a warm-up reaches past the viewport. Rows beyond it stay on the
 * estimate: the window mounts 120 rows, the reader is unlikely to cross all of
 * them in one read, and rendering every one of them for a frame is the layout
 * cost `content-visibility` exists to avoid.
 */
const WARM_REACH_PX = 40_000;
/**
 * The `contain-intrinsic-size` every unrendered row reads in `MessageList.tsx`.
 * This controller writes it (starting from `ROW_ESTIMATE_DEFAULT_PX` per
 * session), so the value in the class is only the first paint's fallback; the
 * rules for what to put here are policy (`lib/transcriptScroll.ts`).
 */
const ROW_ESTIMATE_PROPERTY = "--transcript-row-estimate";

interface PendingRestore {
  messageId: string;
  /** Offset from the container's top edge, or `center` for a jump-to-row. */
  offset: number | "center";
  /**
   * Rows to hold instead, in order, when the row above is not in the transcript
   * any more. Only a hold captured from the rows ON SCREEN has these; a
   * remembered position or a cross-pane jump names one row and means it.
   */
  fallbacks?: { messageId: string; offset: number }[];
  expiresAt: number;
  /** Rows the window has been asked to mount, and how far it may still grow. */
  rowsRequired: number;
  growthLeft: number;
  /**
   * Whether to rest at the END while the row is still missing. A remembered
   * position does (an unfound row means the newest content is the best answer,
   * and it is where the view would otherwise be opening: the top of the
   * window); a jump to a row the transcript already lists does not, since that
   * row is one render away and a detour to the bottom would just flash.
   */
  restAtEnd: boolean;
  applied: boolean;
}

export interface UseTranscriptScrollOptions {
  sessionId: string | undefined;
  /** Identity of the last two projected rows; versions persisted anchors. */
  tailKey?: string;
  /**
   * False while a boot-cache preview is on screen. Persistent restoration waits
   * for the authoritative transcript, but a reader who moves the preview keeps
   * the position they took instead.
   */
  restoreReady?: boolean;
  /**
   * Bumped by the host whenever THIS browser submits something. A submit
   * follows its own answer wherever the reader happened to be.
   */
  pinToken?: number;
  /** Widen the render window so a row `count` rows from the newest is mounted. */
  onRequireRows: (count: number) => void;
}

export interface TranscriptScrollController {
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  /** Re-run the controller after a committed render (new rows, a wider window). */
  syncAfterRender: () => void;
  /** Keep the row at the top edge where it is across a render that prepends rows. */
  holdVisibleRow: () => void;
  /**
   * Measure the reading position for a display preference that reshapes the
   * rows. Call it in the EVENT that changes the preference, before the state
   * that renders it (see the implementation for why nothing else works).
   */
  holdViewChange: () => void;
  /**
   * The other half: call it from the committed render that reshaped the rows,
   * in place of `syncAfterRender`. The hold starts here, so its deadline runs
   * against the layout it is actually holding.
   */
  commitViewChange: () => void;
  /** Bring a specific row into view and keep it there while the layout settles. */
  holdRow: (
    messageId: string,
    options: { rowsFromEnd: number; center?: boolean },
  ) => void;
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
    container.querySelectorAll<HTMLElement>("[data-message-id]"),
  );
}

function findRow(
  container: HTMLElement,
  messageId: string,
): HTMLElement | null {
  // A scan rather than a selector: message ids come from the wire, and this runs
  // only while a restore is in flight.
  for (const row of rowElements(container)) {
    if (row.dataset.messageId === messageId) return row;
  }
  return null;
}

interface RowScan {
  /** The row the reader's eye is on: the first one still visible at the top edge. */
  anchor: TranscriptScrollAnchor | null;
  /** That row's element, so re-asserting it later costs one rect read, not a walk. */
  anchorRow: HTMLElement | null;
  /** The next rows on screen and where they sit, for a hold whose row may vanish. */
  fallbacks: { messageId: string; offset: number }[];
  /** Heights of the rows on screen — the only ones the browser has laid out. */
  visibleHeights: number[];
}

/**
 * One walk for the three things a caller wants from the rows: where the reader
 * is, what a row around them actually measures, and which rows below could
 * stand in for theirs. All three cost a `getBoundingClientRect` per mounted row,
 * so they are never walked twice.
 */
function scanRows(container: HTMLElement): RowScan {
  const rows = rowElements(container);
  const containerTop = container.getBoundingClientRect().top;
  const containerBottom = containerTop + container.clientHeight;
  let anchor: TranscriptScrollAnchor | null = null;
  let anchorRow: HTMLElement | null = null;
  const fallbacks: { messageId: string; offset: number }[] = [];
  const visibleHeights: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= containerTop + 1) continue;
    // A viewport can sit between two rows (a short container, the load-earlier
    // button alone on screen), so the first row BELOW it is still the reader's
    // anchor — it just contributes no measurement.
    const past = rect.top >= containerBottom;
    // Past the viewport the walk keeps going only for the fallbacks — the rows
    // that would stand in for the reader's if a toggle takes it away, and a run
    // of those can be longer than a screen.
    if (past && anchor && fallbacks.length >= HOLD_FALLBACK_ROWS) break;
    const messageId = row.dataset.messageId;
    if (!anchor && messageId) {
      anchor = {
        messageId,
        offset: rect.top - containerTop,
        rowsFromEnd: rows.length - index,
      };
      anchorRow = row;
    } else if (messageId && fallbacks.length < HOLD_FALLBACK_ROWS) {
      fallbacks.push({ messageId, offset: rect.top - containerTop });
    }
    if (past) continue;
    if (rect.height > 0) visibleHeights.push(rect.height);
  }
  return { anchor, anchorRow, fallbacks, visibleHeights };
}

/**
 * The first row at or below the column block a hit landed in. Bounded in
 * practice: the blocks between rows come one or two at a time.
 */
function nextRowBelow(content: HTMLElement, hit: Element): HTMLElement | null {
  let block: Element | null = hit;
  while (block && block.parentElement !== content) block = block.parentElement;
  for (
    let next = block?.nextElementSibling ?? null;
    next;
    next = next.nextElementSibling
  ) {
    if (next.matches("[data-message-id]")) return next as HTMLElement;
    const nested = next.querySelector<HTMLElement>("[data-message-id]");
    if (nested) return nested;
  }
  return null;
}

/**
 * The row at the container's top edge, by hit test instead of by walking the
 * mounted rows: one `elementFromPoint` and one `closest`, which is what makes it
 * affordable on EVERY scroll event a gesture produces (`scanRows` costs a
 * `getBoundingClientRect` per mounted row and runs only once scrolling goes
 * quiet). The optional call is for jsdom, which has no hit testing at all.
 *
 * Not every hit is in a row, and the ones that are not recur constantly: a
 * turn-end separator with its stats row, the "load earlier" button, the
 * standalone Thinking indicator (all siblings of the rows in `MessageList.tsx`),
 * or the column itself where the point falls in a margin between rows. The first
 * three answer with the row BELOW them, which is the reader's row by the same
 * rule `scanRows` uses; the margin is what the second probe is for, since a hit
 * on the column says nothing about where in it the point was.
 */
function rowAtTopEdge(
  content: HTMLElement,
  bounds: DOMRect,
): HTMLElement | null {
  const x = bounds.left + bounds.width / 2;
  for (const probe of TOP_EDGE_PROBES_PX) {
    const hit = document.elementFromPoint?.(x, bounds.top + probe);
    // Popovers are portaled to the body, so a hit inside one is in no row of
    // ours — and the transcript is not always the topmost thing at that point.
    if (!hit || hit === content || !content.contains(hit)) continue;
    const row = hit.closest<HTMLElement>("[data-message-id]");
    if (row) return row;
    const below = nextRowBelow(content, hit);
    if (below) return below;
  }
  return null;
}

/**
 * The transcript's scroll controller: the single owner of the chat container's
 * scroll position (policy and persistence in `lib/transcriptScroll.ts`).
 *
 * Two rules keep this affordable. Nothing in here may call `setState` on a
 * scroll or a resize — rows are memoized and the list re-renders as fast as
 * tokens arrive, so a render per frame of scrolling would undo that work
 * (`src/CLAUDE.md`); the one exception is widening the render window, which
 * happens once per restore. And the row WALK (a `getBoundingClientRect` per
 * mounted row) runs only once scrolling goes quiet, and not at all while the
 * view is pinned to the bottom, where the position is a single boolean. What
 * runs per scroll event is the O(1) hit test, not the walk.
 *
 * The browser's own `overflow-anchor` stays ON in every mode. Measured: with it
 * enabled, scrolling up through rows whose `content-visibility` estimate has
 * never been checked holds the content still to the pixel, while the scroll
 * OFFSET moves by hundreds of px per frame as those estimates resolve. Turning
 * it off during a restore removed the one mechanism that was already doing the
 * job, and left this controller correcting a drift it only samples between
 * frames.
 *
 * Which of the two owns `free` mode changes exactly once per episode, and the
 * order matters. Until the first correction, the BROWSER owns it: anchoring
 * holds the reader's content and this controller's checks are residuals that come
 * out at zero. The first `holdSticky` write is a programmatic scroll, which
 * suppresses anchoring from then on — so after it the STICKY ANCHOR owns the
 * position, alone. That is why the sticky path cannot be deleted as redundant
 * with anchoring: it is what replaces the mechanism its own first write switches
 * off.
 *
 * On WebKit there is no first owner to inherit from: `overflow-anchor` is
 * unsupported in every iOS browser (Safari 26.2). The sticky anchor still holds
 * ordinary late height changes there, but it is no longer asked to race an
 * intrinsic estimate resolving under the reader's finger: `index.css` disables
 * `content-visibility` for the bounded transcript window on iOS. Chromium with
 * anchoring disabled let this controller buy back nine simulated jumps of
 * ±200–2,900px, but that does not guarantee WebKit delivers its resize before
 * painting it. The row is still refreshed on every scroll event of a gesture
 * rather than dropped by the input that starts it, and a correction while that
 * gesture runs is priced (`GESTURE_DRIFT_PX`): a
 * `scrollTop` write during an iOS momentum fling stops the fling, so small drift
 * is left to the reader's momentum and only a place-losing jump is bought back.
 * One clock (`lastReaderScroll`) decides both, which is what keeps the row from
 * being stale at the moment a correction gets cheap.
 */
export function useTranscriptScroll({
  sessionId,
  tailKey,
  restoreReady = true,
  pinToken,
  onRequireRows,
}: UseTranscriptScrollOptions): TranscriptScrollController {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const memory = transcriptScrollMemory();

  const mode = useRef<TranscriptScrollMode>("bottom");
  /**
   * Which stretch of one mode we are in. A remembered row describes the reader's
   * position in the episode that captured it and says nothing about the next one:
   * submitting pins to the bottom without any reader input to clear the row, and
   * a later unbacked scroll into `free` (find-in-page, a `focus()` from the
   * cross-pane jump) would otherwise let the first resize after it put the reader
   * back on a row hundreds of messages away — the failure this whole controller
   * exists to prevent, dealt by its own hand.
   */
  const episode = useRef(0);
  const pending = useRef<PendingRestore | null>(null);
  /** The scrollTop we last set ourselves; a matching scroll event is not the reader's. */
  const expected = useRef<number | null>(null);
  /** Holds either the settle timer or a restore's retry — the two never overlap. */
  const settleTimer = useRef<number | null>(null);
  /** When the container or its content last changed size (see `LAYOUT_SETTLE_MS`). */
  const lastLayoutShift = useRef(0);
  /** When the reader last touched the transcript (see `READER_INPUT_MS`). */
  const lastReaderInput = useRef(0);
  /**
   * When a scroll event was last attributed to the reader — the gesture's own
   * clock, rolled forward by each of those scrolls, which is what makes a fling
   * theirs for its whole length instead of for `READER_INPUT_MS` after the finger
   * left the glass.
   *
   * Two things read it, and that is the point: the row is refreshed on every
   * scroll while this window is open, and a correction is priced at
   * `GESTURE_DRIFT_PX` while it is open. One clock for both means the row can
   * never be stale at the moment corrections get cheap — a fling outliving the
   * INPUT window used to freeze the row where the window closed and then hand the
   * whole untracked distance to the next resize, which threw the reader back down
   * the transcript (measured at 900px for a 2s tail) and stopped the fling.
   *
   * Deliberately separate from `lastReaderInput`, which keeps meaning "hands on
   * the glass": widening THAT would also widen what `nextScrollMode` reads as the
   * reader's, and near the bottom a layout scroll arriving in the extended tail
   * would flip the mode to `bottom`.
   */
  const lastReaderScroll = useRef(0);
  /** The content height as of the last position we looked at. */
  const lastHeight = useRef(0);
  /**
   * The row the reader's eye is on, and where it sat — kept even after a hold is
   * released, and even while they are scrolling.
   *
   * `free` mode is hands-off about SCROLLING, not about content appearing above
   * the reader. Measured: a "load earlier" prepend's rows resolve their
   * `content-visibility` estimates ~2s later, in one +19,966px resize, long
   * after any hold can still be in flight — and the browser's own anchoring does
   * not absorb it, because our own correction a frame earlier was a programmatic
   * scroll. No deadline covers that; a remembered row does. It costs ONE rect
   * read per resize (never a walk: the element is kept, not looked up).
   *
   * Two things refresh it, and neither ever walks the rows twice: the full scan
   * at each of the reader's stops (`record`), and the O(1) hit test on every
   * scroll event of a gesture (`trackReaderRow`). The gesture half is what makes
   * the row survive the reader's own input rather than being dropped by it — it
   * has to, on WebKit: `overflow-anchor` is unsupported there (Safari 26.2), so
   * mid-gesture there is NO other mechanism holding the content still while the
   * rows scrolling into view above resolve their estimates.
   */
  const sticky = useRef<{
    row: HTMLElement;
    offset: number;
    episode: number;
  } | null>(null);
  const recordTimer = useRef<number | null>(null);
  /**
   * The reading position measured when a display preference was flipped, and
   * when — waiting for the render that reshapes the rows to commit. It carries
   * no deadline and no mode of its own: until that commit there is nothing to
   * hold the view against (`holdViewChange`).
   */
  const viewHold = useRef<{
    hold: Omit<PendingRestore, "expiresAt" | "growthLeft">;
    episode: number;
    at: number;
  } | null>(null);
  /**
   * The rows this controller has already had the browser lay out once, so a
   * warm-up never pays for the same row twice. A WeakSet, because the render
   * window drops rows and a session switch replaces every one of them.
   */
  const warmed = useRef(new WeakSet<HTMLElement>());
  const warmTimer = useRef<number | null>(null);
  /**
   * The batch that has been rendered and not handed back yet, with the frame
   * that will do it. Both halves matter: the rows are the ones still carrying an
   * inline `content-visibility`, and the frame is what a teardown has to cancel
   * so a callback cannot arrive in another session's transcript.
   */
  const warmInFlight = useRef<{ rows: HTMLElement[]; frame: number } | null>(
    null,
  );
  const warmBatchRef = useRef<() => void>(() => {});
  const generation = useRef(0);
  const lastSaved = useRef<string | null>(null);
  /** A preview-open restore waiting for the authoritative transcript. */
  const deferredRestore = useRef<string | null>(null);
  /** The converging estimate, and the value the CSS property currently holds. */
  const rowEstimate = useRef(ROW_ESTIMATE_DEFAULT_PX);
  const publishedRowEstimate = useRef(ROW_ESTIMATE_DEFAULT_PX);
  const sessionRef = useRef<string | undefined>(sessionId);
  const tailKeyRef = useRef(tailKey);
  tailKeyRef.current = tailKey;
  /** Tail whose committed render has already refreshed persistent memory. */
  const recordedTailKey = useRef(tailKey);
  const restoreReadyRef = useRef(restoreReady);
  restoreReadyRef.current = restoreReady;
  const requireRows = useRef(onRequireRows);
  requireRows.current = onRequireRows;

  const setMode = useCallback((next: TranscriptScrollMode) => {
    if (next === mode.current) return;
    mode.current = next;
    episode.current += 1;
  }, []);

  const setScrollTop = useCallback((element: HTMLElement, value: number) => {
    element.scrollTop = value;
    expected.current = element.scrollTop;
    lastHeight.current = element.scrollHeight;
  }, []);

  /**
   * Forget the input that ASKED for what we are about to do. Tapping "load
   * earlier" is a pointer event, submitting is a tap on the send button, and
   * opening a session is a click in the sidebar — each one is followed by the
   * layout churn the controller is being pointed at, and counting the tap as
   * "the reader is scrolling" would abandon the hold it just requested.
   */
  const takeReaderIntent = useCallback(() => {
    lastReaderInput.current = 0;
    // Including the gesture in flight: a fling still producing scroll events does
    // not get to keep tracking rows through the restore that was just asked for.
    lastReaderScroll.current = 0;
  }, []);

  /**
   * Put a row back at the offset it was measured at, after the content above it
   * changed size. The single write every hold in here goes through: the drift is
   * always measured against the ROW's offset and never against `scrollTop`,
   * which is what makes a correction cooperate with the browser's own anchoring
   * instead of doubling it — where anchoring already absorbed the change it
   * moved `scrollTop` by exactly the amount that leaves the offset alone, so the
   * residual is zero and nothing is written.
   *
   * The rect read forces the pending relayout, so the correction lands in the
   * same frame as the change that caused it.
   */
  const putRowBack = useCallback(
    (
      held: { row: HTMLElement; offset: number } | null,
      thresholdPx = 1,
    ): void => {
      const element = containerRef.current;
      if (!element || !held || !held.row.isConnected) return;
      const containerTop = element.getBoundingClientRect().top;
      const drift =
        held.row.getBoundingClientRect().top - containerTop - held.offset;
      if (Math.abs(drift) < thresholdPx) return;
      setScrollTop(element, element.scrollTop + drift);
    },
    [setScrollTop],
  );

  /**
   * Feed the row estimate a sample of rows the caller has already walked, and
   * write it out when it has moved far enough to be worth the relayout.
   *
   * EVERY sample moves the estimate; only the CSS write is gated. Gating the
   * estimate too would stall it inside the deadband — a sample within 50% of the
   * current value would leave the ref untouched and the estimate would settle
   * short of the transcript for good. Never `setState`, which is why this is a
   * CSS custom property the rows read rather than a prop they take.
   *
   * The write itself moves the reader: it relayouts every skipped row, so the
   * content under an unchanged scrollTop shifts by (Δestimate × skipped rows
   * above) — measured at +28,551px for one 240→464px publish mid-transcript,
   * and it runs in BOTH directions, because the estimate follows the rows on
   * screen (727→457→726px across three stops of one upward read). Nothing else
   * catches that: browser scroll anchoring does not cover
   * `contain-intrinsic-size` changes of skipped rows, and `holdSticky` would
   * hold this one to its mid-gesture threshold — a record runs 150ms after the
   * reader's last input, always inside that window. The shift is OURS, so `held`
   * (the reader's row, walked by the caller) is put back unconditionally in the
   * same frame: the rect read after the write forces the relayout, and the
   * correction lands before paint.
   */
  const feedRowEstimate = useCallback(
    (
      heights: readonly number[],
      held: { row: HTMLElement; offset: number } | null,
    ) => {
      const element = containerRef.current;
      if (!element) return;
      const sample = rowHeightSample(heights);
      if (sample === null) return;
      const estimate = nextRowEstimate(rowEstimate.current, sample);
      rowEstimate.current = estimate;
      if (!shouldPublishRowEstimate(publishedRowEstimate.current, estimate))
        return;
      const rounded = Math.round(estimate);
      publishedRowEstimate.current = rounded;
      element.style.setProperty(ROW_ESTIMATE_PROPERTY, `${rounded}px`);
      putRowBack(held);
    },
    [putRowBack],
  );

  /**
   * Refresh the reader's row from the container's top edge. Runs on every scroll
   * event a gesture produces, so it may cost no more than it does: one hit test
   * and one rect read, no walk over the mounted rows, and never a `setState`.
   *
   * The offset it stores is read BEFORE the frame's `content-visibility`
   * relevancy pass, which is what leaves the resize that follows measurable
   * against it (`holdSticky`, from the `ResizeObserver`) rather than already
   * absorbed into it. That ordering is read off the spec's rendering update —
   * the scroll steps run ahead of the intersection observations that
   * `content-visibility` relevancy rides, and ahead of the `ResizeObserver`
   * loop — not observed here directly; what the measurement shows is the result
   * (the emulated-WebKit jumps go to zero, which a post-resolution offset could
   * not do).
   */
  const trackReaderRow = useCallback((element: HTMLElement) => {
    const content = contentRef.current;
    if (!content) return;
    const bounds = element.getBoundingClientRect();
    const row = rowAtTopEdge(content, bounds);
    if (!row) {
      // Under a portaled popover, past the last row, or a container scrolled off
      // the viewport: an unknown row is worse than none, since the next resize
      // would put the reader back on a position nothing measured.
      sticky.current = null;
      return;
    }
    sticky.current = {
      row,
      offset: row.getBoundingClientRect().top - bounds.top,
      episode: episode.current,
    };
  }, []);

  /**
   * Put the reader's row back where it was, after content above it changed size
   * on its own. Never changes the mode: this is not a scroll policy, it is the
   * reading position holding still. Where there is no browser anchoring (WebKit)
   * the whole shift shows up here; where there is, only its residual does
   * (`putRowBack`).
   */
  const holdSticky = useCallback(() => {
    const held = sticky.current;
    if (!held) return;
    if (!held.row.isConnected || held.episode !== episode.current) {
      sticky.current = null;
      return;
    }
    // Mid-gesture a correction costs the fling it interrupts, so it is bought
    // only for a drift that actually loses the reader's place. The clock is the
    // gesture's, not the input's: it is open exactly while the scrolls that
    // refresh the row keep arriving, so the price is never charged against a row
    // nothing has re-measured. A finger resting on the glass produces no scrolls
    // and gets the pixel threshold, which is right — there is no fling to lose.
    putRowBack(
      held,
      Date.now() - lastReaderScroll.current < READER_INPUT_MS
        ? GESTURE_DRIFT_PX
        : 1,
    );
  }, [putRowBack]);

  /**
   * Ask for another warm-up batch once the transcript has been quiet for
   * `WARM_IDLE_MS`. Every caller schedules rather than runs: a batch is only
   * ever worth doing in a gap between the reader's gestures.
   */
  const scheduleWarm = useCallback((delayMs = WARM_IDLE_MS) => {
    if (warmTimer.current !== null) window.clearTimeout(warmTimer.current);
    warmTimer.current = window.setTimeout(() => {
      warmTimer.current = null;
      warmBatchRef.current();
    }, delayMs);
  }, []);

  /**
   * Stop warming and hand back whatever a batch left rendered. The rows are the
   * point: an in-flight batch owns an inline `content-visibility` that only its
   * frame removes, and a transcript being torn down or replaced is exactly the
   * case where that frame may never run.
   */
  const cancelWarm = useCallback(() => {
    if (warmTimer.current !== null) window.clearTimeout(warmTimer.current);
    warmTimer.current = null;
    const inFlight = warmInFlight.current;
    warmInFlight.current = null;
    if (!inFlight) return;
    window.cancelAnimationFrame(inFlight.frame);
    for (const row of inFlight.rows)
      row.style.removeProperty("content-visibility");
  }, []);

  const record = useCallback(() => {
    const element = containerRef.current;
    const id = sessionRef.current;
    // A detached or zero-height container measures as "at the bottom", which
    // would overwrite a good reading position on the way out.
    if (
      !element ||
      !id ||
      deferredRestore.current === id ||
      !element.isConnected ||
      element.clientHeight === 0
    )
      return;
    const metrics = metricsOf(element);
    // The row walk costs a layout read per mounted row, so it is only done where
    // its answer is actually stored — and the row estimate rides along on it,
    // since scrolling gone quiet in the middle of a transcript is exactly when
    // the rows on screen are a fair sample.
    const scan =
      mode.current === "free" && !isNearBottom(metrics)
        ? scanRows(element)
        : null;
    const anchor = scan?.anchor ?? null;
    if (scan?.anchorRow && anchor)
      sticky.current = {
        row: scan.anchorRow,
        offset: anchor.offset,
        episode: episode.current,
      };
    // After the sticky capture, so a publish corrects against the row the
    // reader is on right now, not the previous stop's.
    if (scan)
      feedRowEstimate(
        scan.visibleHeights,
        scan.anchorRow && anchor
          ? { row: scan.anchorRow, offset: anchor.offset }
          : null,
      );
    // The reader has stopped, which is the only moment a warm-up is free: it
    // relayouts rows above them, and a correction while they are stationary is
    // exact where one mid-gesture is held to `GESTURE_DRIFT_PX`.
    scheduleWarm();
    const candidate = positionToRemember(mode.current, metrics, anchor);
    if (!candidate) return;
    const position: TranscriptScrollPosition =
      !candidate.atBottom && tailKeyRef.current
        ? { ...candidate, tailKey: tailKeyRef.current }
        : candidate;
    const key = `${id}\0${position.atBottom ? "end" : `${position.anchor?.messageId}@${Math.round(position.anchor?.offset ?? 0)}:${position.tailKey ?? "no-tail"}`}`;
    if (key === lastSaved.current) return;
    lastSaved.current = key;
    memory.save(id, position);
  }, [feedRowEstimate, memory, scheduleWarm]);

  /**
   * The reader's row, for a correction the CONTROLLER is about to cause: the
   * sticky anchor when it holds one, and otherwise one walk for the row at the
   * top edge. Never leaves the sticky anchor behind it — that row is the
   * reader's own, refreshed by their scrolling, and a walk taken for a warm-up
   * has no claim on it.
   */
  const readerRow = useCallback(
    (element: HTMLElement): { row: HTMLElement; offset: number } | null => {
      const held = sticky.current;
      if (held && held.row.isConnected && held.episode === episode.current)
        return { row: held.row, offset: held.offset };
      const { anchor, anchorRow } = scanRows(element);
      return anchor && anchorRow
        ? { row: anchorRow, offset: anchor.offset }
        : null;
    },
    [],
  );

  /**
   * Render a few of the rows the browser is skipping, so that they are already
   * measured when the reader arrives at them.
   *
   * A `content-visibility: auto` row the browser has never laid out is worth
   * `--transcript-row-estimate` — one number for a transcript whose rows
   * measured 116px, 185px, 202px, 1,624px, 4,481px and 5,961px in one batch of
   * six. Every one of those rows corrects itself by thousands of px the moment
   * it becomes relevant, which is exactly when the reader is scrolling into it:
   * mid-gesture, where a correction is held to `GESTURE_DRIFT_PX` and costs the
   * fling it interrupts. Moving that first layout OFF the scroll path is the
   * only way to make it free, and it is a one-time cost per row — a row that has
   * been rendered once keeps its real height as its `contain-intrinsic-size`
   * (`auto` in `MessageList.tsx`) for as long as it stays mounted, measured: the
   * container kept the +8,206px the six rows above added after they went back to
   * being skipped.
   *
   * So a batch flips a couple of rows to `content-visibility: visible`, forces
   * the layout with the rect read the correction needs anyway, and hands them
   * back to the browser a frame later. On iOS the stylesheet already keeps every
   * row visible, so this loop is deliberately inert; avoiding its bounded scans
   * would duplicate the CSS platform decision in JavaScript. The reader is put
   * back both times: the
   * shift is the controller's own, and there is a hold for it that never fires
   * mid-gesture, because a batch only ever runs between gestures.
   *
   * Strictly ONE batch at a time, and the next one is scheduled by the hand-back
   * rather than alongside it. The two clocks come apart: frames stop in a
   * background tab (and stall behind a long task) while timers keep firing,
   * throttled, so a batch per timer would leave row after row rendered with
   * nothing handing any of them back — the whole window `visible` at once, which
   * is the hitch this exists to avoid, paid on the way back to the tab. A hidden
   * document is therefore not warmed at all; `visibilitychange` restarts it.
   */
  const warmBatch = useCallback(() => {
    const element = containerRef.current;
    if (!element || !element.isConnected || element.clientHeight === 0) return;
    // The last batch is still rendered until its frames run, and there is no
    // frame coming while the document is hidden.
    if (warmInFlight.current || document.visibilityState === "hidden") return;
    const now = Date.now();
    // Never against the reader, and never through a restore that is still
    // moving the view: both own the position while they run, and a batch can
    // wait.
    if (
      mode.current === "anchor" ||
      now - lastReaderInput.current < READER_INPUT_MS ||
      now - lastReaderScroll.current < READER_INPUT_MS
    ) {
      scheduleWarm(READER_INPUT_MS);
      return;
    }
    const containerTop = element.getBoundingClientRect().top;
    const viewportBottom = containerTop + element.clientHeight;
    const candidates: { row: HTMLElement; distance: number }[] = [];
    for (const row of rowElements(element)) {
      if (warmed.current.has(row)) continue;
      const rect = row.getBoundingClientRect();
      const distance =
        rect.bottom < containerTop
          ? containerTop - rect.bottom
          : rect.top > viewportBottom
            ? rect.top - viewportBottom
            : 0;
      // A row on screen is rendered already, and the browser remembers its size
      // when it leaves; there is nothing to warm and nothing to correct.
      if (distance === 0) {
        warmed.current.add(row);
        continue;
      }
      if (distance > WARM_REACH_PX) continue;
      candidates.push({ row, distance });
    }
    if (candidates.length === 0) return;
    candidates.sort((a, b) => a.distance - b.distance);
    const batch = candidates
      .slice(0, WARM_BATCH_ROWS)
      .map((candidate) => candidate.row);
    const held = readerRow(element);
    const flippedAt = now;
    for (const row of batch) {
      warmed.current.add(row);
      row.style.contentVisibility = "visible";
    }
    if (mode.current === "bottom") setScrollTop(element, element.scrollHeight);
    else putRowBack(held);
    // A frame LATER, not this one's `requestAnimationFrame`: the size a skipped
    // row keeps is recorded at the end of a rendering update it was rendered in,
    // and a batch handed back before that frame ever renders keeps nothing —
    // measured, the rows came straight back to the estimate.
    const first = window.requestAnimationFrame(() => {
      const second = window.requestAnimationFrame(() => {
        warmInFlight.current = null;
        for (const row of batch) row.style.removeProperty("content-visibility");
        const container = containerRef.current;
        if (!container) return;
        // Only now: a batch that has not been handed back yet is the reason not
        // to start another one.
        scheduleWarm();
        // The reader may have started scrolling in those two frames, and this
        // hold is older than that: putting a row back where it sat before their
        // gesture is the one thing this must never do.
        if (
          lastReaderInput.current > flippedAt ||
          lastReaderScroll.current > flippedAt
        )
          return;
        if (mode.current === "bottom")
          setScrollTop(container, container.scrollHeight);
        else putRowBack(held);
      });
      if (warmInFlight.current) warmInFlight.current.frame = second;
    });
    warmInFlight.current = { rows: batch, frame: first };
  }, [putRowBack, readerRow, scheduleWarm, setScrollTop]);
  warmBatchRef.current = warmBatch;

  /**
   * Deferred rather than per-event: the anchor costs a layout read per mounted
   * row, and where the reader stopped is only interesting once they stop. A
   * departure inside the quiet period is covered by the unmount capture.
   */
  const scheduleRecord = useCallback(() => {
    if (recordTimer.current !== null) window.clearTimeout(recordTimer.current);
    const at = generation.current;
    recordTimer.current = window.setTimeout(() => {
      recordTimer.current = null;
      // The transcript may have been replaced since this was scheduled;
      // measuring it now would file another session's position under this one.
      if (at !== generation.current) return;
      record();
    }, RECORD_IDLE_MS);
  }, [record]);

  const settle = useCallback(() => {
    if (mode.current !== "anchor") return;
    setMode(nextScrollMode(mode.current, { kind: "settled" }));
    // The hold's row IS the reading position, so it survives this one transition
    // — the only handover a sticky row is allowed to make.
    if (sticky.current)
      sticky.current = { ...sticky.current, episode: episode.current };
    pending.current = null;
    scheduleRecord();
  }, [scheduleRecord, setMode]);

  const applyRef = useRef<() => void>(() => {});
  const armRestoreTimer = useCallback((delayMs: number, run: () => void) => {
    if (mode.current !== "anchor") return;
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      run();
    }, delayMs);
  }, []);

  /** Put the view where the current mode says it belongs. Never renders. */
  const apply = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    if (mode.current === "bottom") {
      setScrollTop(element, element.scrollHeight);
      return;
    }
    if (mode.current !== "anchor") return;
    const target = pending.current;
    if (!target) {
      settle();
      return;
    }
    // The row the hold was captured from, or — once a view toggle has taken it
    // out of the transcript — the first row below it that is still there.
    let row = findRow(element, target.messageId);
    let offset = target.offset;
    if (!row) {
      for (const fallback of target.fallbacks ?? []) {
        const candidate = findRow(element, fallback.messageId);
        if (!candidate) continue;
        row = candidate;
        offset = fallback.offset;
        break;
      }
    }
    const expired = Date.now() >= target.expiresAt;
    if (!row) {
      // A missing row is not a failure yet: the transcript arrives in stages
      // (a widened render window and lazily loaded timeline blocks). Keep
      // looking until the deadline rather than dropping the reader at the bottom
      // on the first commit — that giving-up-early is what made the old restore
      // feel random.
      if (target.restAtEnd) setScrollTop(element, element.scrollHeight);
      if (!expired) {
        // A remembered row's distance from the end is measured when it is
        // SAVED, so messages that arrived while the reader was away can have
        // pushed it out of the window: widen a bounded number of times rather
        // than waiting out the deadline on a row the window simply stops short
        // of. Bounded, because mounting the whole session is the cost the
        // window exists to avoid.
        if (target.growthLeft > 0) {
          target.growthLeft -= 1;
          target.rowsRequired += ROW_GROWTH_STEP;
          requireRows.current(target.rowsRequired);
        }
        armRestoreTimer(RESTORE_RETRY_MS, () => applyRef.current());
        return;
      }
      // A row that never arrived (forked away, compacted): the end of the
      // transcript is the honest answer, not wherever the view happens to rest.
      pending.current = null;
      if (!target.applied && target.restAtEnd) {
        setMode("bottom");
        setScrollTop(element, element.scrollHeight);
        return;
      }
      settle();
      return;
    }
    target.applied = true;
    const containerTop = element.getBoundingClientRect().top;
    const rect = row.getBoundingClientRect();
    const wanted =
      offset === "center"
        ? Math.max(0, (element.clientHeight - rect.height) / 2)
        : offset;
    setScrollTop(
      element,
      element.scrollTop + (rect.top - containerTop - wanted),
    );
    // Hand the row straight to the sticky anchor, so the hold's release and the
    // reading position are never separated by a gap the layout could move in.
    sticky.current = { row, offset: wanted, episode: episode.current };
    // Held for as long as the layout may still move under it: an unrendered
    // `content-visibility` row is only an estimate, so the first application is
    // always approximate and converges over the resizes that follow — including
    // the one that lands after the container has already been quiet.
    if (expired) settle();
    else armRestoreTimer(Math.max(0, target.expiresAt - Date.now()), settle);
  }, [armRestoreTimer, setMode, setScrollTop, settle]);
  applyRef.current = apply;

  const startRestore = useCallback(
    (restore: Omit<PendingRestore, "expiresAt" | "growthLeft">) => {
      setMode(nextScrollMode(mode.current, { kind: "anchor-requested" }));
      takeReaderIntent();
      pending.current = {
        ...restore,
        expiresAt: Date.now() + RESTORE_DEADLINE_MS,
        growthLeft: ROW_GROWTH_LIMIT,
      };
      // The row may sit outside the render window, in which case it does not exist
      // to scroll to yet.
      requireRows.current(restore.rowsRequired);
      apply();
    },
    [apply, setMode, takeReaderIntent],
  );

  const restoreRemembered = useCallback(
    (id: string | undefined, currentTailKey: string | undefined) => {
      const remembered = restorableTranscriptPosition(
        id ? memory.read(id) : undefined,
        currentTailKey,
      );
      setMode(
        nextScrollMode(mode.current, {
          kind: "session-opened",
          ...(remembered !== undefined ? { remembered } : {}),
        }),
      );
      if (mode.current === "anchor" && remembered?.anchor) {
        startRestore({
          messageId: remembered.anchor.messageId,
          offset: remembered.anchor.offset,
          rowsRequired: remembered.anchor.rowsFromEnd,
          restAtEnd: true,
          applied: false,
        });
        return;
      }
      apply();
    },
    [apply, memory, setMode, startRestore],
  );

  // Opening a transcript: the remembered reading position, or its end. A boot
  // preview is not the transcript an anchor was measured against, so restoration
  // waits for its authoritative replacement below.
  useLayoutEffect(() => {
    const element = containerRef.current;
    generation.current += 1;
    sessionRef.current = sessionId;
    recordedTailKey.current = tailKeyRef.current;
    lastSaved.current = null;
    pending.current = null;
    // A position measured in the transcript being left names a row this one does
    // not have, and its offsets describe nothing here.
    viewHold.current = null;
    expected.current = null;
    takeReaderIntent();
    // The estimate describes THIS transcript's rows. Carrying a prose session's
    // 600px into the next session's tool-heavy one is the same one-constant
    // error, just with a number this controller chose. Written rather than
    // removed, so the default in force is the one the policy layer declares and
    // the CSS fallback is only the pre-effect first paint.
    sticky.current = null;
    rowEstimate.current = ROW_ESTIMATE_DEFAULT_PX;
    publishedRowEstimate.current = ROW_ESTIMATE_DEFAULT_PX;
    element?.style.setProperty(
      ROW_ESTIMATE_PROPERTY,
      `${ROW_ESTIMATE_DEFAULT_PX}px`,
    );
    // A batch measured in the transcript being left has nothing to hand back to
    // this one, and its frame would land in another session's rows.
    cancelWarm();
    warmed.current = new WeakSet();
    scheduleWarm();
    deferredRestore.current =
      sessionId && !restoreReadyRef.current ? sessionId : null;
    if (deferredRestore.current) {
      setMode(nextScrollMode(mode.current, { kind: "session-opened" }));
      apply();
      return;
    }
    restoreRemembered(sessionId, tailKeyRef.current);
  }, [
    apply,
    cancelWarm,
    restoreRemembered,
    scheduleWarm,
    sessionId,
    setMode,
    takeReaderIntent,
  ]);

  // The boot preview has been replaced by the authoritative transcript. Apply
  // memory only if the reader did not take the preview's position themselves.
  useLayoutEffect(() => {
    if (!restoreReady || !sessionId || deferredRestore.current !== sessionId)
      return;
    deferredRestore.current = null;
    restoreRemembered(sessionId, tailKey);
  }, [restoreReady, restoreRemembered, sessionId, tailKey]);

  // This browser submitted: follow the answer from wherever the reader was.
  const pinnedFor = useRef(pinToken);
  useLayoutEffect(() => {
    if (pinToken === pinnedFor.current) return;
    pinnedFor.current = pinToken;
    setMode(nextScrollMode(mode.current, { kind: "pin-requested" }));
    // The send tap and the keyboard closing under it are the same gesture; only
    // the second half reaches the container, as a scroll nobody asked for.
    takeReaderIntent();
    pending.current = null;
    apply();
  }, [apply, pinToken, setMode, takeReaderIntent]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const onScroll = () => {
      const ours =
        expected.current !== null &&
        Math.abs(element.scrollTop - expected.current) <= 1;
      if (!ours) {
        const now = Date.now();
        const fromReaderInput = now - lastReaderInput.current < READER_INPUT_MS;
        // Two kinds of evidence that the layout moved this, not the reader: the
        // content is a different height than when we last looked (the direct
        // one — an estimate resolved, a card mounted, rows were prepended), or a
        // size change is still settling within `LAYOUT_SETTLE_MS` (the phone
        // submit, where the container shrinks over several frames and the height
        // may be back where it started by the time the scroll lands).
        const duringLayoutShift =
          element.scrollHeight !== lastHeight.current ||
          now - lastLayoutShift.current < LAYOUT_SETTLE_MS;
        lastHeight.current = element.scrollHeight;
        // A write of ours the browser then adjusted (scroll anchoring, an
        // estimate resolving) no longer matches what we read back, so `expected`
        // is only ever evidence FOR "ours", never against.
        expected.current = null;
        const before = mode.current;
        setMode(
          nextScrollMode(mode.current, {
            kind: "user-scrolled",
            nearBottom: isNearBottom(metricsOf(element)),
            fromReaderInput,
            duringLayoutShift,
          }),
        );
        if (before !== mode.current && mode.current !== "anchor")
          pending.current = null;
        // The reader is moving: re-read the row under the top edge, so the resize
        // that lands later this frame is measured against where they are NOW and
        // not against the stop they left. After the mode setter above, whose
        // episode bump the row is stamped with. Skipped at the bottom, where the
        // position is a boolean and there is no row to hold.
        //
        // A gesture keeps itself alive here. An iOS fling outlives the INPUT
        // window (`lastReaderInput`) while still firing scroll events every
        // frame, and each of those is the reader's — so a tracked scroll rolls
        // the gesture's own clock forward, and the row stays refreshed for as
        // long as the momentum lasts. Only an INPUT opens a gesture, which is the
        // half that matters: while one is open the scrolls continuing it are not
        // re-attributed, the layout's own included, and that costs nothing —
        // a layout-driven scroll is dispatched a frame AFTER the resize that
        // caused it, so the shift has already been corrected and re-baselining
        // the row on it finds nothing left to put back.
        const duringGesture =
          fromReaderInput || now - lastReaderScroll.current < READER_INPUT_MS;
        if (duringGesture && mode.current !== "bottom") {
          trackReaderRow(element);
          lastReaderScroll.current = now;
        }
        // The layout moved the view; put it back where the mode says it belongs
        // — following the end, or holding the row a restore is still on. Only
        // here: a scroll the reader made leaves the mode alone or hands them the
        // position, and correcting that would be the controller fighting them.
        if (!fromReaderInput && duringLayoutShift && mode.current !== "free")
          apply();
      }
      scheduleRecord();
    };
    element.addEventListener("scroll", onScroll, { passive: true });

    // What the reader does with their hands. The scroll events these produce are
    // theirs, and so are the ones a fling keeps producing for about a second
    // after the finger leaves the glass (`READER_INPUT_MS`) — a scroll offset
    // alone cannot tell the two apart, which is the whole reason these exist.
    const onReaderInput = () => {
      lastReaderInput.current = Date.now();
      // Scrolling a boot preview is an explicit choice of position. Its
      // authoritative replacement may still arrive, but persistent memory must
      // not jump over a position the reader just took.
      deferredRestore.current = null;
      // The row is deliberately NOT dropped here. Nothing has moved yet at the
      // moment an input arrives, so the row from the reader's last stop is still
      // exactly where they are; from the first scroll of the gesture on, every
      // scroll event refreshes it. What the timestamp changes is the PRICE of a
      // correction (`holdSticky`), not who owns the position — the reader still
      // does, and only a jump the layout dealt them is put back.
    };
    // `mousedown` alongside `pointerdown` for the scrollbar DRAG, the desktop
    // analogue of a fling: it is a scroll with no input of its own, and it only
    // registers because the engine dispatches a press on the scrolling element
    // (Chromium does — the `offsetX > clientWidth` idiom exists for it).
    // Verified in Chromium only, so both press events are listened for.
    const inputEvents = [
      "wheel",
      "touchstart",
      "touchmove",
      "pointerdown",
      "mousedown",
    ] as const;
    for (const kind of inputEvents)
      element.addEventListener(kind, onReaderInput, { passive: true });
    // Keyboard scrolling (PageUp, Home, arrows) reaches the container without
    // focusing it, so the keys arrive at the document — where the composer's
    // typing is too, and a caret moving inside a text field is not a scroll.
    const onReaderKey = (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      onReaderInput();
    };
    document.addEventListener("keydown", onReaderKey, { passive: true });

    // Everything that changes height after the commit that caused it: lazily
    // imported tool cards, a commit card turning its dry run into a commit,
    // Shiki highlighting, images, an expanded output — and the container itself
    // shrinking under the mobile keyboard.
    const observer = new ResizeObserver(() => {
      // Recorded even in `free` mode, and before the early return: what it dates
      // is that the LAYOUT moved, which is what tells the scroll handler whose
      // scroll it is about to classify.
      lastLayoutShift.current = Date.now();
      if (mode.current === "free") {
        holdSticky();
        return;
      }
      apply();
    });
    observer.observe(element);
    if (contentRef.current) observer.observe(contentRef.current);

    const flush = () => memory.flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        flush();
        // A hidden document gets no frames, so a batch would sit rendered until
        // the tab came back — and warming stops entirely rather than queue up
        // work for that moment.
        cancelWarm();
        return;
      }
      scheduleWarm();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      element.removeEventListener("scroll", onScroll);
      for (const kind of inputEvents)
        element.removeEventListener(kind, onReaderInput);
      document.removeEventListener("keydown", onReaderKey);
      observer.disconnect();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      if (recordTimer.current !== null)
        window.clearTimeout(recordTimer.current);
      recordTimer.current = null;
      if (settleTimer.current !== null)
        window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
      cancelWarm();
      flush();
    };
  }, [
    apply,
    cancelWarm,
    holdSticky,
    memory,
    scheduleRecord,
    scheduleWarm,
    setMode,
    trackReaderRow,
  ]);

  // Leaving the conversation is exactly when the position matters, and the last
  // quiet period may not have elapsed. This has to be a LAYOUT cleanup: it runs
  // while the container is still in the document, where the passive cleanup
  // above (which only flushes the write) no longer is.
  useLayoutEffect(() => () => record(), [record]);

  const syncAfterRender = useCallback(() => {
    // Rows that arrived with this render are unrendered until something makes
    // them relevant, so the window that just grew is the next thing to warm.
    scheduleWarm();
    const tailChanged = recordedTailKey.current !== tailKeyRef.current;
    recordedTailKey.current = tailKeyRef.current;
    if (mode.current === "free") {
      // A turn may finish below a reader without moving their anchored row. The
      // position is now known-good against the new transcript, so refresh its
      // version immediately rather than invalidating it on the next open. Tail
      // ids change only at turn boundaries, not for every streamed token.
      if (tailChanged) record();
      return;
    }
    apply();
  }, [apply, record, scheduleWarm]);

  /**
   * The reader's row and where it sits, as a restore waiting to be started.
   *
   * Deliberately NOT the moment to re-measure the row estimate, though it is the
   * moment it matters most: publishing it here would relayout every skipped row
   * and move the offset just as the restore starts, and the scroll event for
   * that lands with the hold already in flight. The estimate the reader's last
   * stop measured (`record`) is at most a scroll away.
   */
  const visibleRowHold = useCallback(
    (
      element: HTMLElement,
    ): Omit<PendingRestore, "expiresAt" | "growthLeft"> | null => {
      const { anchor, fallbacks } = scanRows(element);
      if (!anchor) return null;
      return {
        messageId: anchor.messageId,
        offset: anchor.offset,
        fallbacks,
        rowsRequired: anchor.rowsFromEnd,
        restAtEnd: false,
        applied: true,
      };
    },
    [],
  );

  const holdVisibleRow = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const hold = visibleRowHold(element);
    if (hold) startRestore(hold);
  }, [startRestore, visibleRowHold]);

  /**
   * Capture the reading position for a change to WHAT the transcript renders: a
   * display preference from the chat menu, which mounts and unmounts whole rows
   * and re-measures the ones that stay.
   *
   * Called from the event that flips the preference, and it has to be: the menu
   * is portaled out of the container so no input of the reader's arrives here,
   * and the layout this measures — where their row sits with the tool calls
   * still hidden — is gone by the time the change has rendered. Nothing about it
   * belongs in a render, where React may abandon the work and leave a hold armed
   * for a preference that was never committed.
   *
   * It only MEASURES. The restore is started by `commitViewChange`, when the
   * reshaped rows are actually on screen, because the flip is scheduled as a
   * transition and React may defer or restart it for as long as urgent work
   * keeps arriving — a streaming turn is enough. A hold armed here would run its
   * deadline out against a view that had not changed yet, settle, and take the
   * fallback rows with it, which is exactly the case this exists for.
   */
  const holdViewChange = useCallback(() => {
    const element = containerRef.current;
    viewHold.current = null;
    // Never from the bottom, where the END is the reading position: anchoring a
    // row there would hold the view a few hundred px above it and, worse, leave
    // the mode in `free` afterwards — a live turn would stop being followed
    // because someone opened the menu.
    if (!element || mode.current === "bottom") return;
    const hold = visibleRowHold(element);
    if (!hold) return;
    viewHold.current = { hold, episode: episode.current, at: Date.now() };
  }, [visibleRowHold]);

  /**
   * The render that reshaped the rows has committed: start the hold captured
   * before it, and re-warm, since every skipped row's remembered size describes
   * the shape the transcript just left — tool calls it no longer renders,
   * thinking blocks it now does.
   *
   * The capture is dropped rather than applied when the position it describes
   * stopped being the reader's while the change waited to render: they scrolled,
   * or something moved the mode (a submit pinning to the bottom, a session
   * switch). Putting a row back where it sat before their own gesture is the one
   * thing a hold must never do.
   */
  const commitViewChange = useCallback(() => {
    warmed.current = new WeakSet();
    const captured = viewHold.current;
    viewHold.current = null;
    if (
      captured &&
      captured.episode === episode.current &&
      lastReaderInput.current <= captured.at &&
      lastReaderScroll.current <= captured.at
    )
      startRestore(captured.hold);
    syncAfterRender();
  }, [startRestore, syncAfterRender]);

  const holdRow = useCallback(
    (messageId: string, options: { rowsFromEnd: number; center?: boolean }) => {
      startRestore({
        messageId,
        offset: options.center ? "center" : 0,
        rowsRequired: options.rowsFromEnd,
        restAtEnd: false,
        applied: false,
      });
    },
    [startRestore],
  );

  return {
    containerRef,
    contentRef,
    syncAfterRender,
    holdVisibleRow,
    holdViewChange,
    commitViewChange,
    holdRow,
  };
}
