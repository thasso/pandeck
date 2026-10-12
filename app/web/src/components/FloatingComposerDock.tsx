import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * @component FloatingComposerDock
 * @purpose Lays the chat's composer dock (ledges, card, runtime line) OVER the
 * bottom of the transcript instead of below it, so the conversation scrolls on
 * underneath the card rather than ending at a hard edge above it.
 * @useWhen Hosting a transcript with the composer docked at its foot.
 * @intent Floating must never hide the end of the conversation. The dock's
 * height is measured here and published as `--chat-dock-height`; the
 * transcript ends in a spacer of exactly that height (`MessageList`), so its
 * last row can always be scrolled clear of the card — and because the spacer
 * sits inside the transcript content, the scroll controller's own
 * ResizeObserver sees the dock grow (a longer draft, an opened ledge or dock
 * panel) and keeps a bottom-pinned reader at the bottom.
 * Only the dock's own boxes take the pointer: the space beside the card is the
 * transcript's, so wheel, touch and clicks there reach it.
 * @related Composer, ComposerLedge, MessageList, useTranscriptScroll
 */
export function FloatingComposerDock({
  transcript,
  dock,
}: {
  transcript: ReactNode;
  dock: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const dockEl = dockRef.current;
    if (!root || !dockEl) return;
    // Written to the DOM, not to state: the dock resizes on every keystroke
    // that wraps a line, and none of that should re-render the transcript.
    const sync = () =>
      root.style.setProperty("--chat-dock-height", `${dockEl.offsetHeight}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(dockEl);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col">
      {transcript}
      <div
        ref={dockRef}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 transition-transform duration-150 ease-out *:pointer-events-auto"
        style={{
          transform:
            "translateY(calc(-1 * var(--app-keyboard-inset-bottom, 0px)))",
        }}
      >
        {/* Under the card's lower edge and the runtime line the transcript
            fades out, so text never runs behind them; above that it shows. */}
        <div
          aria-hidden
          className="pointer-events-none! absolute inset-x-0 bottom-0 -z-10 h-12 bg-linear-to-t from-background via-background/80 to-transparent"
        />
        {/* The fade continues solid below the dock for exactly the height the
            phone keyboard lifted it by, so the strip between the dock and the
            keyboard is covered too and the fade shows no edge. Zero tall
            whenever no keyboard is open — always, on desktop. */}
        <div
          aria-hidden
          className="pointer-events-none! absolute inset-x-0 top-full -z-10 bg-background"
          style={{ height: "var(--app-keyboard-inset-bottom, 0px)" }}
        />
        {dock}
      </div>
    </div>
  );
}
