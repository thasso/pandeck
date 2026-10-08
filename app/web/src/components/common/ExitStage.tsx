import type { ReactNode } from "react";

/**
 * How long an exit runs before the host sends the command that removes the
 * row: the slide (200ms) plus the collapse that follows it (150ms, after a
 * 200ms delay), so the list update never cuts the animation short.
 */
export const EXIT_STAGE_MS = 350;

/**
 * The two nested stages a row leaves through, so the row leaves BEFORE the list
 * closes behind it: the inner box slides out to the left, then the grid row
 * collapses from 1fr to 0fr and everything below travels up. A row that is not
 * leaving carries no transition at all, so an ordinary list update (a new
 * session, a rename) still lands instantly.
 *
 * `data-session-leaving` is what keeps a row that has left out of keyboard
 * traversal while it is still mounted. Shared by the Sessions inbox (settle)
 * and the Backlog's Inbox (accept), so both lists let an item go the same way.
 */
export function ExitStage({
  leaving,
  children,
}: {
  leaving: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-session-leaving={leaving ? "true" : undefined}
      inert={leaving}
      className={`grid ${
        leaving
          ? "grid-rows-[0fr] motion-safe:transition-all motion-safe:delay-200 motion-safe:duration-150 motion-safe:ease-out"
          : "grid-rows-[1fr]"
      }`}
    >
      <div
        className={`min-h-0 overflow-hidden ${
          leaving
            ? "-translate-x-full opacity-0 motion-safe:transition motion-safe:duration-200 motion-safe:ease-in"
            : ""
        }`}
      >
        {children}
      </div>
    </div>
  );
}
