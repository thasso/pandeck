import { useEffect, useState } from "react";

/**
 * The OS "reduce motion" setting. Shell surfaces read this on top of the user's
 * own animation preferences: a panel may animate because the user wants it to,
 * but never against the platform accessibility choice.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reduced;
}
