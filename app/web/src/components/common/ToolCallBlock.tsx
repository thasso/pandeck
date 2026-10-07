import {
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Badge } from "../ui/badge.tsx";
import { useViewportProximity } from "./useNearViewport.ts";
import { Spinner } from "./load.tsx";
import { ChevronDown, CircleDashed, TriangleAlert, Wrench } from "lucide-react";

/**
 * Lifecycle of a tool call. `incomplete` is a terminal "result unknown" state —
 * a call whose result never reached the client (e.g. dropped by history
 * compaction, or an aborted turn) — rendered statically, never spinning.
 */
export type ToolStatus = "running" | "success" | "error" | "incomplete";

export interface ToolCallBlockProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  /** Tool name, e.g. `"read"`, `"bash"`, or an MCP tool id. */
  name: string;
  /**
   * Lifecycle status. `running` shows a spinner; `success` a wrench; `error`
   * an alert icon with danger styling.
   */
  status: ToolStatus;
  /**
   * The rendered tool body — output, input, a diff, a JSON tree, … Shown only
   * while expanded. A FUNCTION is called only once the body is expanded and
   * has been near the viewport, so the work behind it (JSON parsing, diffing,
   * highlighting) is never done for a body nobody sees.
   */
  children?: ReactNode | (() => ReactNode);
  /**
   * The body became (`true`) or stopped being (`false`) VISIBLE: expanded and
   * currently near the viewport. This is the moment to fetch a withheld body
   * or subscribe to a live one, and the moment to stop. Also called with
   * `false` on unmount after a `true`.
   */
  onBodyVisibilityChange?: (visible: boolean) => void;
  /**
   * A compact one-line summary shown in the header next to the name — e.g. the
   * file path a `read` touched, or the `bash` command.
   */
  summary?: ReactNode;
  /** Output line count, surfaced as a muted "N lines" hint in the header. */
  lineCount?: number | undefined;
  /** Seconds the call took, shown once complete. */
  durationSec?: number;
  /**
   * Whether the body is expanded. Pass it (with `onOpenChange`) to control the
   * block from the outside — e.g. the chat header's expand/collapse-all. Leave
   * unset to manage it from {@link ToolCallBlockProps.defaultOpen}.
   */
  open?: boolean;
  /**
   * Expanded state when uncontrolled. Defaults to `false`. Changing it re-syncs
   * the block (the transcript's expand-all / collapse-all control), after which
   * the header toggle keeps working locally.
   */
  defaultOpen?: boolean;
  /** Called with the next expanded state when the header is toggled. */
  onOpenChange?: (open: boolean) => void;
  /** Extra classes on the outer container. */
  className?: string;
}

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Format a whole number of seconds as `Ns` or `Nm Ns`. */
function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  if (sec < 60) {
    return `${sec}s`;
  }
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/**
 * A collapsible disclosure for a single tool call, kept visually consistent with
 * `ThinkingBlock`: a header with a status affordance (spinner while `running`,
 * wrench when done, alert on `error`), the tool name, an optional summary, line
 * count, and duration; the body (output / diff / JSON / …) shows when expanded.
 *
 * Works controlled (`open` + `onOpenChange`, e.g. driven by the chat header's
 * expand/collapse-all) or uncontrolled (`defaultOpen`). The body is a slot — the
 * caller decides how the tool's output renders.
 */
export function ToolCallBlock({
  name,
  status,
  children,
  onBodyVisibilityChange,
  summary,
  lineCount,
  durationSec,
  open,
  defaultOpen = false,
  onOpenChange,
  className,
  ...props
}: ToolCallBlockProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [lastDefault, setLastDefault] = useState(defaultOpen);
  const bodyId = useId();
  // Expand-all opens every block in the transcript at once; building all those
  // bodies (highlighting, diffs, JSON trees, DOM) in one commit is what froze
  // the main thread on long chats. Only bodies at or near the viewport are
  // built, and stay built (`everNear`); the rest follow as they scroll in. Live
  // delivery follows the block only while it can be seen (`near`).
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

  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const bodyVisible = Boolean(isOpen && children != null && near);
  const notifyVisibility = useRef(onBodyVisibilityChange);
  notifyVisibility.current = onBodyVisibilityChange;
  useEffect(() => {
    if (!bodyVisible) return;
    notifyVisibility.current?.(true);
    return () => notifyVisibility.current?.(false);
  }, [bodyVisible]);
  const isError = status === "error";
  // The status is conveyed by icon/color; expose it to assistive tech too.
  const statusLabel: Record<ToolStatus, string> = {
    running: "Running",
    success: "Completed",
    error: "Failed",
    incomplete: "Result unavailable",
  };

  function toggle() {
    const next = !isOpen;
    if (!isControlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  }

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
          "flex w-full min-w-0 items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-sm transition-colors",
          "outline-none hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          isError
            ? "border-destructive/30 text-destructive"
            : "text-foreground",
          isOpen && "rounded-b-none",
        )}
      >
        {status === "running" ? (
          <Spinner size="sm" variant="ring" />
        ) : isError ? (
          <TriangleAlert aria-hidden="true" size={14} className="shrink-0" />
        ) : status === "incomplete" ? (
          <CircleDashed
            aria-hidden="true"
            size={14}
            className="shrink-0 text-faint"
          />
        ) : (
          <Wrench
            aria-hidden="true"
            size={14}
            className="shrink-0 text-muted-foreground"
          />
        )}
        <span className="sr-only">{statusLabel[status]} tool call: </span>
        <span className="shrink-0 font-medium">{name}</span>
        {summary != null && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {summary}
          </span>
        )}
        {lineCount != null && (
          <Badge variant="secondary" className="ml-auto shrink-0">
            {lineCount} {lineCount === 1 ? "line" : "lines"}
          </Badge>
        )}
        {durationSec != null && status !== "running" && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatDuration(durationSec)}
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          size={14}
          className={cx(
            "shrink-0 text-muted-foreground transition-transform",
            lineCount == null && "ml-auto",
            isOpen ? "rotate-0" : "-rotate-90",
          )}
        />
      </button>
      {isOpen && children != null && (
        // The body element stays mounted across the viewport gate, so it is the
        // one that carries `aria-busy` and clears it in place when the body
        // lands (R6); the placeholder inside only holds the height.
        <div
          id={bodyId}
          aria-busy={!everNear || undefined}
          className={cx(
            "rounded-b-lg border border-t-0 bg-muted/30 p-3 text-sm",
            isError && "border-destructive/30",
          )}
        >
          {!everNear ? (
            <div className="min-h-8" />
          ) : typeof children === "function" ? (
            children()
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}
