# Web app shell components — implementation reference

Relocated from `app/web/src/components/shell/CLAUDE.md` (Task-274) so it stops
costing agent context on every visit. This is a descriptive snapshot of what the
modules in that subtree own; the rules an agent must not violate stay in that
folder's `CLAUDE.md`. Correct or delete a section here when the code moves on.
Relative paths in the body are relative to the original subtree.

## Purpose

Generic app shell frame per `app/web/docs/ui-shell.md`: the three-pane layout
(header, left sidebar, main pane, right panel) and its layout behavior.

## Module ownership

- `AppShell.tsx` owns pane composition, panel presence animation, resize
  handles, mobile presentation, and the `--shell-main-width` CSS variable. On
  mobile a panel presents per `ShellPanel.mobilePresentation`: an `overlay`
  (default) animates in and Escape dismisses it; a `screen` (the route-driven
  browser screen, ui-shell.md Small Screens) does neither — it has no user-owned
  open state to close, and animating a route transition as a slide-over is a lie
  about what happened; a `dock` (the object panel) rests showing its header and
  treats `open` as EXPANDED. The shell marks the main pane `inert` only while
  something actually covers it — a full-screen screen/overlay or an expanded
  dock, never a resting peek, which is non-modal by design. It also reserves
  `dockPeekInset` as main-pane bottom padding for as long as the screen HAS a
  resting dock, expanded or not: releasing it on expand would re-lay out the
  page behind the sheet and hand it back on collapse.
- `PrimaryNav.tsx` owns the sidebar's config-driven primary navigation: a
  compact icon bar with an icon + label pill for the active section, icon-only
  slots for the rest, and no counts/badges/dots. Slots arrive already ordered
  and mix sections with the app-level ACTIONS (the host dispatches by kind — see
  `../CLAUDE.md`); on mobile it is the navigation of the browser screen, so
  selecting navigates rather than only re-selecting. It measures its own width
  with a `ResizeObserver` (never `prefs.sidebarWidth` — that misses the live
  resize drag, the shell clamp, the full-width mobile screen, and rotation).
  - Where the folded slots live is the one thing that differs by viewport. Wide:
    the bar is a row at the bottom of the sidebar's column and the tail sits
    behind `SectionOverflow.tsx`'s trailing More `Popover`. Phone: the bar IS a
    `BottomCard` header, its grabber opens the same list (`OverflowList`,
    shared), and there is no trigger — so `planNavSlots` is called with
    `reserveMore: false`. The bottom edge then behaves identically on every
    phone screen: same card, same gesture, same chrome as the object dock, and
    no `ui/Sheet` modal with a title row and an X for what is really just more
    navigation.
  - The card's open state is local: nothing outside navigation needs to know the
    folded slots are showing. Selecting from the ROW while it is open closes it,
    like acting inside any bottom card. `NAV_CARD_INSET` is what
    `../Sidebar.tsx` reserves under its browser, since the bar stops being a row
    in the column and becomes an overlay over it.
  - The card's side gutter costs about what the removed More trigger gave back,
    so the row shows the same number of slots as before — pinned in
    `navOverflow.test.ts`. What the card buys is the gesture and the
    consistency, not a slot.
- `navOverflow.ts` owns the pure fold math (`planNavSlots`, unit-tested in
  `navOverflow.test.ts`). Slot/pill/More widths are CONSTANTS mirroring the
  bar's Tailwind classes and the active pill has a fixed reserve: nothing
  measures a child, since measuring an element whose size depends on the
  computed layout invites ResizeObserver loops and would make the fold point
  drift with label length and `--text-scale`. `floor()` over fixed slots has no
  oscillation band, so a live drag needs no hysteresis. The active section is
  always kept visible.
- `Inspector.tsx` owns the generic Details/inspector frame (summary, actions,
  related-object links, then object content via children), shared
  `InspectorSection` chrome, and `InspectorFacts` — the ONE way a section states
  flat label/value metadata. The panel is the card: a section is a heading and
  its rows, never a bordered box inside a bordered panel. Nested cards had grown
  in every section (frontmatter, checkout, working tree, viewing, asset/history
  lists, Task links, local paths) until scanning the panel meant scanning
  frames; rows are now flush, and a border is reserved for things that genuinely
  need an edge — an input, or an alert. A comment thread carries a subtle LEFT
  EDGE instead (`../diff/comments.tsx`), the shape the worktree review's line
  threads use. Its identity header is chrome the HOST may take over:
  `InspectorChromeProvider` (context, so the per-object assemblies stay
  untouched) drops it for a host that already states what the object is — today
  the mobile object dock. The same context carries `onAct`, which the frame
  calls after a relation row or an action runs: acting on an object almost
  always changes the surface underneath, so a dock sheet collapses to reveal it.
  An action with no visible effect there (Copy entry link) sets
  `InspectorAction.keepOpen` and leaves the sheet as it was. Hoisting is NOT in
  that context: the frame drops every `InspectorAction.primary` exactly while
  `RoutePrimaryAction.tsx` publishes one, because publishing it IS what puts the
  action in the chrome outside the panel (the wide page header, the dock's
  action row). The old flag claimed "the row has some actions", which is a
  different thing and would have made the primary vanish from both places the
  moment the row's slot swapped to Submit review. The right panel is
  Details-only (no embedded agent); per-object inspector assemblies live in
  `../objectInspectors.tsx`, and each object's "Start a new session" action
  routes through the new-session page rather than an inline composer.
- `BottomCard.tsx` owns the app's small-screen bottom surface: ONE card that
  rests showing its header and slides up into a sheet, shared by every host that
  needs that shape (the object dock; the browser screen's navigation bar). Not
  two surfaces handing over — that split is what made the gesture feel clunky,
  because a resting row and a portaled sheet are different elements and neither
  can be grown live. What hosts share here is not a LOOK (`../ui/bottomSheet.ts`
  tokens already give every bottom surface that) but the MECHANICS:
  - The header (grabber + the host's row) is the card's top edge in both
    positions and ALL of it drags, in both directions: the target is the full
    card width and every row of it. Never the body below it — that scrolls, and
    a pull-to-dismiss competing with an inner scroll is how a sheet ends up
    feeling stuck. `transform` is written straight to the DOM, since a React
    state update per `pointermove` would re-render the body every frame, and a
    release rides the remaining distance out (`SETTLE_MS`).
  - The card is anchored to the bottom edge, so mounting the body makes it grow
    UPWARD: a resting card whose body is mounted MUST be held down by exactly
    the body's height (one layout effect owns that, `travelPx()` measured from
    the header). Getting this wrong does not just look wrong — the header jumps
    out from under the finger and the tap is swallowed, because the click target
    moved before the release.
  - The body is mounted while the card is open or while a finger rests on the
    header (`warm`), not at rest: the card can only travel once it HAS its open
    height, but mounting a body that fetches (an inspector) for a panel nobody
    opened is waste. Warming on `pointerdown` puts that render in the gap before
    the finger moves rather than on the drag's first frame; the drag threshold
    keeps a `flushSync` fallback for a drag that beats React to it. A press that
    lands on a CONTROL does not warm on `pointerdown` — it warms only once it
    moves the right way — because a body that grows as its fetch lands is not
    followed by the parked card, so warming under a finger that is about to lift
    moves the header out from under it for nothing.
  - A `draggedRef` guard swallows the click a finished drag leaves behind
    (capture phase, on the header), since `preventDefault` on `pointerup` does
    not reliably suppress it, and the drag takes pointer capture so a gesture
    that began on a header control cannot run it. That guard is only as good as
    the threshold in front of it, so the threshold depends on WHERE the press
    landed. The grabber and the bare header are the drag surface and give in
    early (a few px for a mouse, roughly the platform's touch slop otherwise). A
    press on one of the row's CONTROLS is a tap until it is unmistakably not: it
    needs most of the button's height AND must move towards the reachable rest
    position (up from peek, down from expanded), since the other direction is
    only overshoot. Dragging is always available from the grabber and the space
    between the controls, so there is nothing to win by claiming a button press
    and a working button to lose — at a uniform small threshold those buttons
    simply did nothing while the card twitched. Tap on the grabber toggles; the
    backdrop and Escape close. No close button — every route out exists and the
    grabber is a labelled, focusable button. `expandBlocked` lets a host refuse
    opening while it owns the row (a session recording).
  - It is positioned inside its host's box, NOT portaled: `position: fixed`
    resolves against the layout viewport, so a fixed card bleeds behind iOS
    Safari's floating address bar — correct for a transient sheet's background,
    wrong for a header you must be able to hit. Only the BACKDROP is fixed, and
    it stays inside this box so no ancestor's stacking context can paint it over
    the card. Its opacity is constant: with the card tracking the finger there
    is nothing left for a drag-linked fade to communicate. The home-indicator
    inset below the card is a strip of the card's own background
    (`../ui/bottomSheet.ts`'s skirt), not empty space: the content has to stay
    out of the inset, but a bar with the page scrolling past underneath it is
    not docked. It is a sibling rather than padding on the card so the inset
    never enters the heights the gesture measures, and it is positioned so the
    expanded backdrop cannot dim it.
  - `bottomCardRestingPx` → `bottomCardInset` is the ONE source for the resting
    height, in px rather than a Tailwind class (a class assembled at runtime is
    invisible to Tailwind); it must match the header's classes, and it is what
    the surface behind reserves. Motion is gated by the host's animate flag
    (`prefs.animateRightDrawer`) and `prefers-reduced-motion`.
  - It is deliberately NOT `ui/Sheet.tsx` — that primitive is modal by
    construction (backdrop, `aria-modal`, dismiss-on-outside-click, a title row
    and a close button) and a resting card must let the surface behind it
    scroll; this one is modal only at the top of its travel.
- `ObjectDock.tsx` is the object-panel HOST of that card (ui-shell.md, Small
  Screens) and now holds only what makes it the object panel: the action row's
  back/actions arrangement, the ONE `DockPeek` type for that row (declared here
  and used by `App.tsx` which builds it and `AppShell` which carries it — as
  three separate inline types, the flags the ends agreed on were unchecked in
  the middle), `dockHasActionRow`/`dockPeekInset` for the shell's reservation,
  the exported control shapes for that row — `DockAction` (ONE muted tone for
  every control in it — Stop was red, which made interrupting a turn look
  destructive) and the pair a session screen rests as — `DockComposerField`, the
  composer's own bordered BOX grown into the row's width, and
  `DockComposerFace`, the tappable text inside it (a button, never an input: the
  real textarea has to be focused inside the opening tap for iOS to raise the
  keyboard). The field is a container, not a control — the mic, the recording
  trace and the mid-turn Stop all sit INSIDE it, which is also why it cannot
  itself be a button — so the row's own controls are only back and navigation
  and the interior is the only thing that changes between composing, dictating
  and waiting. All of it lives here because the row's height is `BottomCard`'s
  `BOTTOM_CARD_ROW_PX`: a control taller than 36px silently breaks the
  reservation the surface behind makes, and that same 36px is the cap on
  everything inside the field (hence `DictationControls`' `dense`) — and a body
  wrapped in `Inspector`'s `InspectorChromeProvider` — no identity header (the
  screen underneath already says what object this is) and hoisting through the
  primary-action channel, since the header row shows that action at both ends of
  the travel and twice is once too many. `../SessionDockActions.tsx` fills the
  row on a session screen, dictation included. `DockPeek.fill` drops the spacer
  that right-aligns the actions so they grow into the whole card instead — a
  session row is a field or a waveform, and against a spacer that also grows
  either would only ever get half the width. A session screen therefore fills at
  ALL times, not just while recording: a row whose width changed between those
  states would read as a different bar.
- `dockDrag.ts` owns the pure drag math (unit-tested in `dockDrag.test.ts`). The
  card's travel is ONE continuous quantity — `offset` 0 is open,
  `offset === travel` is resting — so there is one convention for both
  directions instead of two mirrored gestures with opposite signs:
  `resolveDockDrag` picks the end a release belongs to (half the travel, or the
  direction of a flick, since a fast throw travels little before the finger
  leaves the glass and refusing it feels broken) and `clampDockDragOffset`
  follows the finger 1:1 between the ends and damps past them.
- `usePrefersReducedMotion.ts` owns the OS reduce-motion flag, read by both the
  panel presence animation and the dock's drag spring-back: a user animation
  preference never overrides the platform accessibility choice.
- `dockState.ts` owns the pure `dockMode` decision (`hidden | peek | expanded`,
  unit-tested in `dockState.test.ts`): expansion outranks a missing peek row,
  and a screen with no main-pane object gets no dock at all.
- `panelSizing.ts` owns pure panel width clamp math (unit-tested in
  `panelSizing.test.ts`).
- `edgeSwipe.ts` owns the pure math of the edge-swipe back gesture (unit-tested
  in `edgeSwipe.test.ts`): the leading strip a touch may start in, the CLAIM
  that takes the touch from the scroller, the engage/yield cone, the travel it
  draws (1:1, then rubber-banded near the far edge), whether a release commits
  (a third of the viewport, or a flick fast enough to have said the direction on
  its own), and the parallax that brings the destination home exactly as the
  leaving screen goes.
  - The claim (`edgeSwipeClaimsTouch`) is answered several px before the gesture
    engages, on the raw rightward lean rather than the cone, because a browser
    decides whether a touch scrolls within its first moves and a started scroll
    takes the pointer with it. Once claimed, `classifyEdgeSwipeMove` stops
    consulting the vertical entirely: there is no scroll left for it to become,
    so a thumb may arc as much as it likes on its way across. That trade is
    deliberate — a claimed touch that turns out to be a scroll does nothing at
    all, since scrolling cannot be handed back.
  - Deliberately NOT shared with `lib/swipeGesture.ts`: the row swipe is the
    mirror gesture — the one that keeps off the edges because this one owns them
    — and one set of thresholds cannot be right for both.
- `useEdgeSwipeBack.ts` owns the DOM half: the element the gesture listens on,
  which pointer it holds (touch only, captured on engage), the non-passive
  `touchmove` veto that makes the claim real (pointer events are not cancelable,
  and only the FIRST cancelable `touchmove` can keep a sequence from ever
  scrolling), the release velocity, the click the finished gesture has to
  swallow, and the ordering that hides the navigation — the leaving screen
  finishes its run first, and `onBack` fires in the same React batch that drops
  the transform, so the destination is never painted at an offset. Its endings
  are timed rather than driven by `transitionend`: an interrupted transition
  never fires one, and a screen stranded off-frame is the one failure this
  gesture must not have. `AppShell` arms it only in the mobile layout, only when
  the host says this screen has a back action and owns the edge
  (`lib/nativeShell.ts`'s `ownsScreenEdgeGestures`), and never under a shell
  surface stacked over the screen (a mobile overlay, an expanded dock).
  - Everything ELSE stacked over the screen — every modal sheet, dialog and
    popover in `components/` — is refused by `startsOnTheScreen`, which asks
    what the touch landed on instead of asking those surfaces to declare
    themselves. Two facts carry it: such a layer is portaled to `document.body`,
    so it is not in the DOM subtree the listeners are bound to, and/or it is
    `position: fixed`, which the walk from the touch target up to the host
    finds. The listeners are on the DOM for exactly this reason — React
    synthetic events climb the REACT tree, which a `document.body` portal is
    still inside, so a capture handler on the shell root saw touches that landed
    on a modal. Both endings are covered by `appShellEdgeSwipe.test.tsx`, along
    with the case that keeps the guard honest: ordinary screen content under an
    open layer still drags.
- `useMobileLayout.ts` owns the single mobile-layout breakpoint flag.

## Contract notes and rationale

- Keep the shell content-agnostic: panels are controlled via `ShellPanel` props
  (open/width/callbacks); no feature or route knowledge in this folder.
- Width-clamped content anywhere in the main pane must read `--shell-main-width`
  (with a `100vw` fallback), never measure the shell.
- All layout/gesture math that can be pure belongs in `panelSizing.ts` (panel
  widths), `navOverflow.ts` (nav slots), `dockState.ts` (mobile dock
  presentation), `dockDrag.ts` (drag travel and release), or `edgeSwipe.ts`
  (edge-swipe back), with tests.
- The shell root carries a transform ONLY while an edge-swipe is in flight. A
  standing one would make it the containing block of every fixed descendant —
  the dock's backdrop among them — so the resting style has no `transform` key
  at all rather than `none`.

## Working notes

- New shell surfaces (navigation zones, inspector) live here and follow the
  ui-shell.md concept.
- Right Inspector content should use `InspectorSection` for compact section
  headers with an icon, optional right-aligned summary/header actions,
  separator, and consistent collapse behavior rather than ad hoc uppercase
  headings.
- The Actions section renders FIRST and carries no count: a section of labelled
  buttons already shows how many there are. A relation group with
  `maxVisibleItems` renders that many TOP-LEVEL rows and a "Show N more" button;
  a shown row always brings its whole subtree, since hiding children would
  misreport the object while deferring roots only postpones them.

## Verification commands

- Run `pnpm --filter @assistant/web test` for the panel-sizing and nav-overflow
  tests.
- Run `pnpm --filter @assistant/web build` for this subtree.
