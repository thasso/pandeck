import { type ReactNode, useCallback, useState } from "react";
import { ChevronRight } from "lucide-react";

/**
 * @useWhen A titled content section that collapses/expands and whose open state
 *   should persist locally across reloads (e.g. Task Description / Plan / Result).
 * @avoidWhen Lightweight inline expandable detail that needs no persistence; use
 *   {@link ./Disclosure.tsx Disclosure} instead.
 * @prop storageKey Stable localStorage key for the remembered open state.
 * @prop trailing Right-aligned header content (e.g. a status badge) shown even
 *   when collapsed.
 */
export function CollapsibleSection({
  title,
  storageKey,
  defaultOpen = true,
  trailing,
  children,
}: {
  title: ReactNode;
  storageKey: string;
  defaultOpen?: boolean;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readOpen(storageKey, defaultOpen));
  const toggle = useCallback(() => {
    setOpen((o) => {
      const next = !o;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [storageKey]);
  return (
    <section className="mb-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={toggle}
          className="flex min-w-0 items-center gap-1 text-sm font-medium uppercase tracking-wide text-muted-foreground hover:text-muted-foreground"
          aria-expanded={open}
        >
          <ChevronRight
            size={12}
            className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
          <span className="truncate">{title}</span>
        </button>
        {trailing ? <div className="shrink-0">{trailing}</div> : null}
      </div>
      {open ? children : null}
    </section>
  );
}

function readOpen(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}
