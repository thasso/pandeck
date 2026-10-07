import { useEffect, useId, useRef, useState, type HTMLAttributes } from "react";
import { Brain, ChevronDown } from "lucide-react";

import { Markdown } from "./Markdown.tsx";
import { Spinner } from "./common/load.tsx";
import { useViewportProximity } from "./common/useNearViewport.ts";

export interface ThinkingBlockProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  /**
   * The reasoning / thinking text, as markdown. May be a partial fragment that
   * grows while {@link ThinkingBlockProps.streaming} is `true`. It is only
   * rendered while the block is expanded.
   */
  children: string;
  /**
   * Whether the reasoning is still streaming in. Drives the live header: a
   * spinner plus an elapsed-time clock that counts up while running.
   */
  streaming?: boolean;
  /**
   * There is reasoning to show even when `children` is empty: the body was
   * withheld (a lazy or live ref) and arrives once the block is visible. The
   * header renders, and an expanded body shows a placeholder until the text
   * lands. Defaults to whether `children` has text.
   */
  bodyAvailable?: boolean;
  /**
   * The body became (`true`) or stopped being (`false`) VISIBLE: expanded and
   * currently near the viewport. This is the moment to fetch a withheld body
   * or subscribe to a live one, and the moment to stop. Also called with
   * `false` on unmount after a `true`.
   */
  onBodyVisibilityChange?: (visible: boolean) => void;
  /** Whether the reasoning body is expanded (controlled). */
  open?: boolean;
  /**
   * Expanded state when uncontrolled. Defaults to `false`. Changing it re-syncs
   * the block (the transcript's expand-all / collapse-all control), after which
   * the header toggle keeps working locally.
   */
  defaultOpen?: boolean;
  /** Called with the next expanded state when the header is toggled. */
  onOpenChange?: (open: boolean) => void;
  /**
   * Seconds spent reasoning, surfaced as "Thought for Ns" once complete. We have
   * no duration metric, so this is normally omitted — the header then shows just
   * the brain icon and "Thought process".
   */
  durationSec?: number;
  /** Extra classes on the outer container. */
  className?: string;
}

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Format a whole number of seconds as `Ns` or `Nm Ns`. */
function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/**
 * A collapsible disclosure for an agent's reasoning / "thinking" output, kept
 * visually distinct from (and secondary to) the final answer. While streaming,
 * the header shows a spinner and a clock that counts up; once complete it shows
 * a brain icon and (when known) the elapsed "Thought for Ns". The reasoning
 * markdown is only revealed when expanded.
 */
export function ThinkingBlock({
  children,
  streaming = false,
  bodyAvailable,
  onBodyVisibilityChange,
  open,
  defaultOpen = false,
  onOpenChange,
  durationSec,
  className,
  ...props
}: ThinkingBlockProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [lastDefault, setLastDefault] = useState(defaultOpen);
  // A live block opens itself so the reasoning is visible as it streams — until
  // the reader collapses it, which is also what stops its text being sent.
  const [collapsedWhileStreaming, setCollapsedWhileStreaming] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const bodyId = useId();
  // Expand-all opens every thinking block at once, and each body is its own
  // Markdown pipeline; build only the ones at or near the viewport, and keep
  // them built once they are (`everNear`); follow the live text only while the
  // block can actually be seen (`near`).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { near, everNear } = useViewportProximity(rootRef);

  // Follow `defaultOpen` whenever it CHANGES, so the transcript's
  // expand/collapse-all reaches blocks that are already mounted. Adjusted during
  // render (React's documented "adjusting state when a prop changes") rather than
  // in an effect: an effect commits, paints, then re-renders every block a second
  // time — on a chat with hundreds of blocks that doubled the work of one toggle.
  // Keyed on the CHANGE, not on the value, so a block the user opened by hand is
  // still reset by a later collapse-all that restores the original default.
  if (lastDefault !== defaultOpen) {
    setLastDefault(defaultOpen);
    setInternalOpen(defaultOpen);
  }

  // Count up while streaming so a collapsed block still shows live progress.
  useEffect(() => {
    if (!streaming) return;
    const start = Date.now();
    setElapsedSec(0);
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [streaming]);

  const text = children.trim();
  const hasBody = bodyAvailable ?? text.length > 0;

  const isControlled = open !== undefined;
  // While streaming, keep the body open so the reasoning is visible live (unless
  // the reader closed it); once it settles, fall back to the user's
  // (default-collapsed) state.
  const isOpen = isControlled
    ? open
    : (streaming && !collapsedWhileStreaming) || internalOpen;
  const bodyVisible = Boolean(isOpen && hasBody && near);
  const notifyVisibility = useRef(onBodyVisibilityChange);
  notifyVisibility.current = onBodyVisibilityChange;
  useEffect(() => {
    if (!bodyVisible) return;
    notifyVisibility.current?.(true);
    return () => notifyVisibility.current?.(false);
  }, [bodyVisible]);

  if (!hasBody && !streaming) return null;

  function toggle() {
    const next = !isOpen;
    if (!isControlled) {
      setInternalOpen(next);
      if (streaming) setCollapsedWhileStreaming(!next);
    }
    onOpenChange?.(next);
  }

  // While streaming, show the live clock; once done, the authoritative duration
  // (falling back to whatever we measured during the stream) when known.
  const finalSec = durationSec ?? (elapsedSec > 0 ? elapsedSec : undefined);
  const label = streaming
    ? `Thinking… ${formatDuration(elapsedSec)}`
    : finalSec != null
      ? `Thought for ${formatDuration(finalSec)}`
      : "Thought process";

  return (
    <div
      ref={rootRef}
      className={cx("flex w-full flex-col", className)}
      {...props}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-controls={bodyId}
        className={cx(
          "inline-flex w-fit items-center gap-1.5 rounded-md py-1 pr-2 text-sm font-medium text-muted-foreground transition-colors",
          "hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        )}
      >
        {streaming ? (
          <Spinner size="sm" variant="ring" />
        ) : (
          <Brain aria-hidden="true" size={14} className="shrink-0" />
        )}
        <span>{label}</span>
        <ChevronDown
          aria-hidden="true"
          size={14}
          className={cx(
            "shrink-0 transition-transform",
            isOpen ? "rotate-0" : "-rotate-90",
          )}
        />
      </button>
      {isOpen && hasBody && (
        // `aria-busy` sits on the body element, which survives the viewport
        // gate and clears the flag in place once the text renders (R6); the
        // placeholder inside only holds the height — also while a withheld
        // body is on its way.
        <div
          id={bodyId}
          aria-busy={!everNear || text.length === 0 || undefined}
          className="mt-1 border-l-2 border-line pl-3 text-muted-foreground"
        >
          {everNear && text.length > 0 ? (
            <Markdown text={text} />
          ) : (
            <div className="min-h-8" />
          )}
        </div>
      )}
    </div>
  );
}
