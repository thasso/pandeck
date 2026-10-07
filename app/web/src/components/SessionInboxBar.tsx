import type { ReactNode } from "react";
import { Activity, CircleDashed, CircleHelp } from "lucide-react";
import { Spinner } from "./common/load.tsx";
import { Badge } from "@/components/ui/badge";

interface Props {
  /** Items in the `needs-you` tier — the same count the block used to state. */
  needsYou: number;
  /** Unarchived sessions currently running a turn. */
  working: number;
  /** Background work across every session, from the session summaries alone. */
  background: { activeCount: number; ownerCount: number };
  /** Move to the first waiting row; offered only while there is one. */
  onNeedsYou: () => void;
  /** Open the background-work registry. */
  onOpenBackgroundTasks: () => void;
}

/**
 * @component SessionInboxBar
 * @purpose The Sessions browser's STABLE header: three counts that are always
 * rendered, at a constant size, whatever the list underneath is doing.
 * @useWhen Heading the Sessions inbox. It is the browser's own chrome.
 * @avoidWhen Announcing anything — app-wide lifecycle state belongs to
 * `AppStatus` and an event belongs in a toast (`docs/messaging.md`). This bar
 * only states what the browser already holds.
 * @intent Background work starts and ends on its own schedule, with no act of
 * the user behind it, so the line that used to state it sat above the cards and
 * shoved the whole list down and up again several times a minute — in a
 * scrolling container, which moves the reading position too. The fix is not a
 * quieter line but a slot that is always there: a count that goes to zero DIMS
 * rather than unmounting, so nothing below it can ever move. The heading it
 * replaces keeps its label and gives up its count for the same reason.
 * Glyph plus number, never words: the sidebar is a user-resizable rail from
 * 220px and the type scale is a user preference, and "Needs you 1 · Working 2 ·
 * Background 3" does not survive either. The words travel as the accessible
 * name instead, the way every one-line indicator in this browser does. Each
 * glyph is the one the app already uses for that state — `CircleHelp` for a
 * session waiting on you, the spinner for a running turn, `Activity` for
 * background work, which is also the icon of the registry it opens.
 * @related SessionInbox, ActiveSessionCard, backgroundWork (lib), AppStatus
 */
export function SessionInboxBar({
  needsYou,
  working,
  background,
  onNeedsYou,
  onOpenBackgroundTasks,
}: Props) {
  const { activeCount, ownerCount } = background;
  return (
    // Sticky rather than a row of the list: the sidebar has ONE scroll
    // container for every browser, and a header that scrolls away is a header
    // the list can still push around. `-mx` bleeds it to the panel's side
    // edges; the TOP edge is the sidebar's to give, and it does
    // (`Sidebar.tsx`) — a sticky box cannot take it, because Chromium clamps
    // `top-0` to the scroll container's CONTENT box, which is below its
    // padding, and a negative margin does not move it (measured: the box
    // stayed at 44 with `margin-top: -8px` in effect). That padding would then
    // be a strip above a pinned bar for rows to scroll through, and at rest a
    // band the chips are not centred in — the whole complaint this bar exists
    // to answer. The height is a constant rather than padding around content
    // for the same reason the counts never unmount.
    <div className="sticky top-0 z-10 -mx-1 mb-1 flex h-9 items-center gap-1 border-b border-border bg-card px-2 sm:-mx-2 sm:px-3">
      <Chip
        label={
          needsYou === 0
            ? "Nothing is waiting for you"
            : `${needsYou} ${needsYou === 1 ? "session is" : "sessions are"} waiting for you`
        }
        count={needsYou}
        attention={needsYou > 0}
        onClick={needsYou > 0 ? onNeedsYou : undefined}
      >
        <CircleHelp aria-hidden />
      </Chip>
      <Chip
        label={
          working === 0
            ? "No sessions are running"
            : `${working} session${working === 1 ? "" : "s"} running`
        }
        count={working}
      >
        {/* The spinner is the running indicator everywhere in this browser, so
            it stays the glyph — and at zero it becomes the same circle standing
            still, which keeps the slot exactly as wide either way. */}
        {working > 0 ? <Spinner size="xs" /> : <CircleDashed aria-hidden />}
      </Chip>
      <Chip
        label={
          activeCount === 0
            ? "No background processes running"
            : `${activeCount} background process${activeCount === 1 ? "" : "es"} running${
                ownerCount > 1 ? ` in ${ownerCount} sessions` : ""
              }`
        }
        count={activeCount}
        onClick={onOpenBackgroundTasks}
      >
        <Activity aria-hidden />
      </Chip>
    </div>
  );
}

/**
 * One count. A chip with somewhere to go is a button and a chip without one is
 * a `<span>` — a control that does nothing when clicked is worse than a plain
 * number — but both are the same `Badge`, because the whole promise of this
 * bar is that its height and width do not move.
 */
function Chip({
  label,
  count,
  attention = false,
  onClick,
  children,
}: {
  label: string;
  count: number;
  /** Something here is waiting for the user. */
  attention?: boolean;
  onClick?: (() => void) | undefined;
  children: ReactNode;
}) {
  const variant = attention ? "secondary" : "ghost";
  const number = (
    <span aria-hidden className="tabular-nums">
      {count}
    </span>
  );
  if (!onClick)
    return (
      <Badge variant={variant} title={label}>
        {children}
        {/* The glyph carries the meaning visually and the number carries it in
            text, so the words go to assistive technology as content rather than
            as an `aria-label` — which a plain `span` has no role to attach it
            to. Deliberately NOT a live region: these counts change several
            times a minute and none of them is an announcement. */}
        <span className="sr-only">{label}</span>
        {number}
      </Badge>
    );
  return (
    <Badge
      variant={variant}
      render={<button type="button" />}
      onClick={onClick}
      title={label}
      aria-label={label}
      className="cursor-pointer"
    >
      {children}
      {number}
    </Badge>
  );
}
