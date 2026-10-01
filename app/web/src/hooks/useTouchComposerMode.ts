import { useEffect, useState } from "react";

/**
 * Whether a composer is being typed into with a THUMB rather than a keyboard.
 *
 * It decides one thing: whether plain Enter sends. On a physical keyboard it
 * does (Shift+Enter is the newline), because sending is what Enter means in a
 * chat; on a phone keyboard the return key is the only way to type a second
 * line, so there it inserts one and the send button is the way out. Every
 * composer that accepts Enter — the chat one and every comment one — asks this
 * same question, so the answer lives in one place.
 *
 * Coarse pointer AND a narrow window: a touchscreen laptop still has a keyboard,
 * and a tablet with one attached is the case the width test cannot see, which is
 * why the send button never goes away.
 */
export function useTouchComposerMode(): boolean {
  const [touch, setTouch] = useState(false);

  useEffect(() => {
    // `matchMedia` is optional here on purpose: a comment composer renders in
    // places with a bare DOM (jsdom, a markup render), and "is this a thumb"
    // must degrade to a keyboard rather than throw on the way to a textarea.
    const media = window.matchMedia?.(
      "(pointer: coarse) and (max-width: 767px)",
    );
    const update = () => {
      setTouch(
        Boolean(media?.matches) ||
          (navigator.maxTouchPoints > 0 && window.innerWidth < 768),
      );
    };

    update();
    media?.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      media?.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return touch;
}
