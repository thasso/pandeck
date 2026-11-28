import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether the surface around this point is actually on screen, as the shell
 * frames that own it decide: the right panel open (a phone's dock expanded),
 * within it the active tab, and the main pane not covered by a phone's screen,
 * overlay or expanded sheet. Those frames keep their content MOUNTED while
 * it is hidden, so mounting says nothing about visibility; a surface that
 * claims failures as their home (`docs/messaging.md`) reads this instead.
 * Context crosses portals: a dialog portaled above a cover is on screen, so
 * its owner claims for it directly rather than through this.
 * Nested frames AND together, and outside any frame the surface is on screen.
 */
const OnScreenContext = createContext(true);

export function OnScreen({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const parent = useContext(OnScreenContext);
  return (
    <OnScreenContext.Provider value={parent && visible}>
      {children}
    </OnScreenContext.Provider>
  );
}

export function useOnScreen(): boolean {
  return useContext(OnScreenContext);
}
