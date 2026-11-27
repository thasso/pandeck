import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether the surface around this point is actually on screen, as the shell
 * frames that own it decide: the right panel open (a phone's dock expanded),
 * and within it the active tab. Those frames keep their content MOUNTED while
 * it is hidden, so mounting says nothing about visibility; a surface that
 * claims failures as their home (`docs/messaging.md`) reads this instead.
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
