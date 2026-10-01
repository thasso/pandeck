# App shell frame

The three-pane shell of `app/web/docs/ui-shell.md`.

- Width-clamped content anywhere in the main pane reads `--shell-main-width`
  (with a `100vw` fallback) and never measures the shell.
- Layout and gesture math that can be pure belongs in `panelSizing.ts`,
  `navOverflow.ts`, `dockState.ts`, `dockDrag.ts` or `edgeSwipe.ts`, with unit
  tests. Never measure a child whose size depends on the computed layout — that
  invites observer loops and makes the fold point drift with `--text-scale`.
- The edge-swipe back gesture arms only where the host says the app owns the
  screen edges (`lib/nativeShell.ts`; a browser's belong to its back/forward). A
  history Back holds off-canvas until `popstate`; at rest the shell transform
  stays `none`, or it becomes the containing block for every fixed descendant.
- It claims the touch from the scroller under it with a NON-PASSIVE `touchmove`
  `preventDefault`, before it engages and while the browser can still be told
  not to scroll; vertical movement decides nothing from then on.
- It listens on the DOM node it drags, never on React events (a `document.body`
  portal is still inside the React tree), and starts only on a touch that
  belongs to the screen: nothing portaled, nothing `position: fixed` over it. A
  modal must never be able to drag the screen out from under itself, and that
  stays a property of the gesture, not a flag each new surface remembers to set.
- `BottomCard` is anchored inside its host's box, not portaled: only the
  BACKDROP may be `position: fixed`, or the card's header ends up behind iOS
  Safari's address bar. A mounted body must be held down by exactly its measured
  height, and only the header drags — never the scrolling body.
- Everything in the dock's action row must fit `BOTTOM_CARD_ROW_PX`; a taller
  control silently breaks the inset the surface behind reserves.
