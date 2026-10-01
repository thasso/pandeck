import { useEffect, useState, type RefObject } from "react";

/** How far outside the viewport still counts as "near" (pre-mount margin). */
const DEFAULT_ROOT_MARGIN = "600px 0px";

export interface ViewportProximity {
  /** At or near the viewport RIGHT NOW: what live delivery should follow. */
  near: boolean;
  /**
   * Latched: true once `near` has ever been true. What an expensive body
   * should mount on — it is never torn down and rebuilt while scrolling.
   */
  everNear: boolean;
}

/**
 * Two viewport facts about one element, from one observer. `everNear` keeps
 * an already-built body mounted (rebuilding is the expensive part); `near`
 * says whether the reader can currently see it, which is what a live-body
 * subscription follows — text for a block scrolled far off screen is work the
 * server, the wire and the browser all skip until it is scrolled back.
 *
 * With no `IntersectionObserver` (server rendering in tests, ancient browsers)
 * both report `true` from the first effect, so behaviour degrades to eager
 * rendering rather than to permanently blank content.
 */
export function useViewportProximity(
  ref: RefObject<HTMLElement | null>,
  rootMargin: string = DEFAULT_ROOT_MARGIN,
): ViewportProximity {
  const [near, setNear] = useState(false);
  const [everNear, setEverNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      setEverNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const intersecting = entries[entries.length - 1]?.isIntersecting;
        if (intersecting === undefined) return;
        setNear(intersecting);
        if (intersecting) setEverNear(true);
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin]);

  return { near, everNear };
}

/**
 * Latched "this element is at or near the viewport" flag, for deferring
 * expensive children until they can actually be seen. The caller owns the ref,
 * so an element that already has one (jump-to-file registration, focus) needs no
 * ref merging and the hook costs no extra render.
 *
 * Latched on purpose, and the observer is released once it fires: a caller
 * that only defers a build has nothing to learn from the element afterwards.
 */
export function useNearViewport(
  ref: RefObject<HTMLElement | null>,
  rootMargin: string = DEFAULT_ROOT_MARGIN,
): boolean {
  const [near, setNear] = useState(false);

  useEffect(() => {
    if (near) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref, rootMargin]);

  return near;
}
