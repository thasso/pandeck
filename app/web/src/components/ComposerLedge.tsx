import type { ReactNode } from "react";

export interface ComposerLedgeProps {
  /**
   * The composer card is on screen below this ledge, so the ledge tucks its
   * bottom edge behind the card and reads as one object with it. False while
   * the card is hidden (a phone resting on the dock's action row), where the
   * ledge is the bottom edge itself and sits flush on the row below.
   */
  joined: boolean;
  children: ReactNode;
}

/**
 * @component ComposerLedge
 * @purpose A RESTING strip on the composer's top edge: something that stays
 * put while the conversation goes on, and grows into a short list on a tap.
 * @useWhen A session-scoped state has to stay visible without opening a
 * sidebar — the peers this session spawned and its running background work
 * today. It takes them as one stack of strips, hairline-separated, so two
 * shelves never become two floating cards over the composer.
 * @avoidWhen The content is opened on demand and dismissed: that is
 * `ChatDockPanel`, which slides up behind the card and closes on Escape. A
 * ledge has no close button because it does not go away.
 * @intent Inset like the dock panels and joined to the card the same way
 * (drawn behind it, its bottom under the card's rounded top), so the composer
 * still reads as one object with a shelf on it rather than two stacked cards.
 * It is in normal flow, not absolute: it pushes the composer up so the
 * transcript's bottom inset accounts for it.
 * @related Composer, ChatDockPanel, BackgroundWorkLedge, SpawnedSessionsLedge
 */
export function ComposerLedge({ joined, children }: ComposerLedgeProps) {
  return (
    <div
      data-composer-ledge
      className={`relative z-1 mx-9 divide-y rounded-t-xl border border-b-0 bg-card ${joined ? "-mb-4 pb-4" : ""}`}
    >
      {children}
    </div>
  );
}
