import type { ReactNode } from "react";
import { UnreadDot } from "../UnreadDot.tsx";
import { BottomCard, bottomCardInset } from "./BottomCard.tsx";
import { InspectorChromeProvider } from "./Inspector.tsx";

/**
 * The dock's resting header. ONE type, shared by the host that builds it
 * (`App.tsx`), the shell that carries it (`AppShell`'s `ShellPanel`) and this
 * component that renders it — declared separately in each, the flags the ends
 * agreed on were invisible to the middle and went unchecked.
 */
export interface DockPeek {
  /**
   * Leading side, FIXED: the screen's back control and anything that belongs
   * beside it (a document's Forward). It never scrolls, so a row that overflows
   * cannot take it away.
   */
  back?: ReactNode;
  /** Trailing side: the object's actions (`DockAction`s). This is what scrolls. */
  actions?: ReactNode;
  /**
   * The far-right end, FIXED like `back`: one control the row may never scroll
   * out of reach — a document's Close. Everything else belongs in `actions`.
   */
  trailing?: ReactNode;
  /** The host owns the row (a session recording) and opening is refused. */
  expandBlocked?: boolean;
  /** The actions ARE the row: no spacer, so they grow into its full width. */
  fill?: boolean;
}

/** Whether this dock has an action row at all: something in it, any slot. */
export function dockHasActionRow(peek?: DockPeek): boolean {
  return (
    peek != null &&
    (peek.back != null || peek.actions != null || peek.trailing != null)
  );
}

/** Space the main pane reserves while the dock rests over it. */
export function dockPeekInset(hasActionRow: boolean): string {
  return bottomCardInset(hasActionRow);
}

/**
 * @component ObjectDock
 * @purpose Small-screen form of the right object panel: the shell's `BottomCard`
 * with the object's actions in its header and Details as its body
 * (app/web/docs/ui-shell.md, Small Screens).
 * @useWhen The shell is in mobile layout and the main pane holds an object.
 * @avoidWhen Desktop (the inline resizable panel), or a transient modal surface —
 * that is `ui/Sheet`. This one RESTS on screen and must not be modal at peek.
 * @intent Everything about the card — one element in two positions, the continuous
 * drag, the entrance, the click guard — belongs to `BottomCard`, which the browser
 * screen's navigation bar shares. What is left here is what makes it the OBJECT
 * panel: the row's back/actions arrangement, and a body whose own identity header is
 * suppressed (the screen underneath already says what object this is) and whose
 * `primary` action is hoisted out of its Actions list, because the header row shows
 * that action at both ends of the travel and twice is once too many.
 */
export function ObjectDock({
  mode,
  peek,
  onExpand,
  onCollapse,
  animate = true,
  children,
}: {
  /** Presentation decided by `dockState.dockMode`. */
  mode: "hidden" | "peek" | "expanded";
  /**
   * Resting header. Its PRESENCE enables the resting card; `back` takes the leading
   * side of the action row, `actions` the trailing side, and `trailing` the far
   * right end beyond them. All are `DockAction` controls — the row is the object's
   * action home on a phone, and on screens that have one it is also where the
   * screen's back control lives, because the bottom edge is where a thumb is.
   * `expandBlocked` lets a host claim the row outright (a session recording), and
   * `fill` says those actions ARE the row rather than a cluster at its end — a
   * session's composer field and its dictation trace both have to be as wide as
   * the card.
   */
  peek?: DockPeek | undefined;
  onExpand: () => void;
  onCollapse: () => void;
  /** Subject to prefers-reduced-motion, like the shell's panel presence. */
  animate?: boolean;
  /** Expanded body — normally the `Inspector`, rendered without its own header. */
  children: ReactNode;
}) {
  return (
    <BottomCard
      mode={mode}
      animate={animate}
      onExpand={onExpand}
      onCollapse={onCollapse}
      expandBlocked={Boolean(peek?.expandBlocked)}
      blockedReason="Finish dictating first"
      openLabel="Open details"
      collapseLabel="Collapse details"
      header={
        dockHasActionRow(peek) ? (
          // Back leads, the object's actions trail, and the gap between them is the
          // widest part of the drag target. A `fill` row has no such gap: its
          // content grows into the whole width instead, since a spacer that also
          // grows would split the row with it and leave a `DockComposerField` or a
          // dictation trace half a card wide.
          //
          // Only the actions cluster scrolls. `back` and `trailing` sit outside
          // it at the two ends, so a row with more actions than fit loses none
          // of them to a scroll the reader has no reason to suspect.
          //
          // `px-2` doubles the card's own 8px gutter (`common/bottomSheet`) at both ends,
          // so the control at each end sits 16px off the screen rather than 12px.
          // It is the same inset on both sides — the row's symmetry is what puts the
          // field on the grabber's axis — and it costs the field 8px, which is the
          // cheapest width in the row.
          <div className="flex items-center gap-1 px-2 pb-1">
            {peek?.back}
            {peek?.fill ? null : <div className="min-w-0 flex-1" />}
            {peek?.fill ? (
              peek.actions
            ) : (
              <div className="flex min-w-0 shrink overflow-x-auto">
                {peek?.actions}
              </div>
            )}
            {peek?.trailing}
          </div>
        ) : null
      }
      renderBody={(collapse) => (
        <InspectorChromeProvider header={false} onAct={collapse}>
          {children}
        </InspectorChromeProvider>
      )}
    />
  );
}

/**
 * One control in the dock's action row. Icon-only and ghost-styled, the app's
 * chrome-row icon button (`Topbar`, the composer's toolbar) rather than
 * `common/GhostIconButton`, which is sized for inline actions inside content.
 *
 * Icon-only because a labelled accent pill was the widest thing in the row and read
 * as the screen's call to action, which "Start session" on a task you are only
 * reading is not. The shell owns the SHAPE so back and the object's actions cannot
 * drift apart; the host supplies the icon and what it means. 36px, because this row
 * is a thumb target and one of these is now the screen's back control.
 *
 * ONE tone, deliberately: every control built from THIS is muted. Nothing in the row
 * is toned to alarm — Stop used to be red, which made the routine act of interrupting
 * a turn look destructive. The session row's send/stop is the one filled control in
 * any dock row (`../SessionDockActions.tsx`), and it earns that by not being an object
 * action at all: it is the composer's primary action, wearing the composer's tone.
 */
export function DockAction({
  icon,
  label,
  onRun,
  marked = false,
  badge,
  disabled = false,
  disabledReason,
  commentActuation = false,
}: {
  icon: ReactNode;
  label: string;
  onRun: () => void;
  /** Attention dot: an unsent draft behind compose, uncommitted changes behind the diff. */
  marked?: boolean | undefined;
  /** Compact pending count drawn over the action icon; ZERO draws nothing. */
  badge?: number;
  disabled?: boolean;
  /** Tooltip naming the gesture that enables an inert control. */
  disabledReason?: string;
  /** Preserve a comment surface's captured target while this control is pressed. */
  commentActuation?: boolean;
}) {
  return (
    <span title={disabled ? disabledReason : label} className="shrink-0">
      <button
        type="button"
        data-comment-actuation={commentActuation || undefined}
        onPointerDown={
          commentActuation ? (event) => event.preventDefault() : undefined
        }
        onClick={onRun}
        disabled={disabled}
        aria-label={label}
        className="relative flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
      >
        {icon}
        {/* A count is news; a zero is not. An action whose badge is 0 wears
            whatever it would wear without one. */}
        {badge ? (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground">
            {badge}
          </span>
        ) : marked ? (
          <UnreadDot title={label} />
        ) : null}
      </button>
    </span>
  );
}

/**
 * The other shape this row has: the composer's own BORDERED BOX, brought down to the
 * dock's row and grown into its width (so its host's peek must `fill`). Only a session
 * screen has one today — `../SessionDockActions.tsx` — and it exists because a chat
 * screen whose bottom edge is four bare glyphs says nothing about where a message
 * goes; the border is what makes it read as the input it stands in for, exactly as
 * the real composer's card does.
 *
 * It is a CONTAINER, not a control (so it cannot be a button — nested interactive
 * content — hence `DockComposerFace` for the tappable part). What goes inside is only
 * what belongs to the TEXT: the face, and while dictating the live trace with its
 * discard. Every actual control — mic, send/stop, the session's context jump — sits in
 * the row BESIDE this box, where it has the same 36px weight as back; a mic squeezed
 * inside was 32px against back's 36px and read as a detail of the field rather than a
 * control.
 *
 * Its geometry belongs here with `DockAction`'s for the same reason that one does:
 * the row's height is `BottomCard`'s `BOTTOM_CARD_ROW_PX`, so anything taller than
 * 36px silently breaks the reservation the surface behind makes — which is also the
 * cap on what this box can hold, and why `DictationControls`' trace and discard take
 * a `dense` flag. Padding is symmetric: this box sits between equal-width control
 * clusters (`../SessionDockActions.tsx`), and the whole point is that the row reads
 * centred under the card's grabber.
 */
export function DockComposerField({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-9 min-w-0 flex-1 items-center gap-1 rounded-[1.15rem] border border-line bg-raised/60 px-1 transition-colors focus-within:border-line-strong hover:border-line-strong">
      {children}
    </div>
  );
}

/**
 * The tappable part of that box: the text, and the whole width of it. It shows the
 * waiting draft (or the placeholder) but never says so to assistive tech — `label`
 * states what pressing it DOES, since the draft is content, not a name. A button
 * rather than an input, because the real textarea has to be focused inside the
 * opening tap for iOS to raise the keyboard, and that textarea lives in the composer
 * which then covers this row.
 */
export function DockComposerFace({
  text,
  label,
  disabled = false,
  onRun,
  commentActuation = false,
}: {
  /** What the face shows: the waiting draft, or a placeholder when `placeholder`. */
  text: { value: string; placeholder: boolean };
  /** What the control DOES, for assistive tech — never the draft text. */
  label: string;
  /** Nothing can be sent right now (a running turn); the face states why instead. */
  disabled?: boolean;
  onRun: () => void;
  /** Preserve a captured selection when this face hands it to comment mode. */
  commentActuation?: boolean;
}) {
  return (
    <button
      type="button"
      data-comment-actuation={commentActuation || undefined}
      onPointerDown={
        commentActuation ? (event) => event.preventDefault() : undefined
      }
      onClick={onRun}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-8 min-w-0 flex-1 items-center rounded-2xl px-2 text-left text-sm transition-colors disabled:cursor-default ${
        text.placeholder ? "text-faint" : "text-fg"
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{text.value}</span>
    </button>
  );
}
