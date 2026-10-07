import { type ReactNode, useState } from "react";
import { ChevronRight } from "lucide-react";

interface DisclosureProps {
  header: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  tone?: "neutral" | "accent" | "danger";
}

const toneRing: Record<NonNullable<DisclosureProps["tone"]>, string> = {
  neutral: "border-line",
  accent: "border-line",
  danger: "border-danger/40",
};

export function Disclosure({
  header,
  children,
  defaultOpen = false,
  tone = "neutral",
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={`my-1.5 overflow-hidden rounded-lg border bg-panel/60 ${toneRing[tone]}`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-raised/60"
      >
        <ChevronRight
          size={13}
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1">{header}</span>
      </button>
      {open && (
        <div className="border-t border-line px-2.5 py-2">{children}</div>
      )}
    </div>
  );
}
