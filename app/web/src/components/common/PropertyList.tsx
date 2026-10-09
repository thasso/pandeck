import type { ReactNode } from "react";

/**
 * @component PropertyList
 * @purpose An object's fields as a property list: one line per field, the
 *   label in a fixed column on the left and the value on the right — as its own
 *   quiet control (`PROPERTY_TRIGGER`) when it can be changed, as text when not.
 * @useWhen An inspector or detail section showing a handful of named fields:
 *   the Task inspector's Details, the Project page's Repository.
 * @intent One label column for every list, so labels and values line up the
 *   same wherever a list appears. Children alternate `PropertyLabel` and value.
 *   `align="start"` is for values that WRAP (a path, a remote): each label sits
 *   on its value's first line instead of floating at its middle.
 */
export function PropertyList({
  align = "center",
  children,
}: {
  align?: "center" | "start";
  children: ReactNode;
}) {
  return (
    <div
      className={`grid grid-cols-[5.5rem_minmax(0,1fr)] gap-y-0.5 px-1 ${align === "start" ? "items-start" : "items-center"}`}
    >
      {children}
    </div>
  );
}

/** A field's name in a `PropertyList`: one 28px line, the value's height. */
export function PropertyLabel({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-h-7 items-center text-sm text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * A value in a `PropertyList` that is read, not changed: inset like a
 * trigger's text, on the same 28px first line, wrapping below it.
 */
export function PropertyText({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={`min-w-0 px-2 py-1 text-sm leading-5 ${className}`}>
      {children}
    </span>
  );
}

/** A value control in the property list: borderless, filled on hover, the
 *  width of its column so every value starts at the same x. */
export const PROPERTY_TRIGGER =
  "h-7 w-full justify-between border-transparent bg-transparent px-2 font-normal shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted/50";
