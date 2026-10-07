import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChevronUp, Minus, X } from "lucide-react";

interface ChatDockPanelProps {
  open: boolean;
  title: string;
  icon?: ReactNode;
  /** Compact contextual actions shown in the title bar before the close button. */
  actions?: ReactNode;
  /** Whether the panel can collapse to a small restore pill. Defaults to true. */
  minimizable?: boolean;
  /**
   * Whether opening takes focus. Defaults to true, which is right for a panel
   * that IS the thing just opened. A panel opened as context FOR the composer
   * below it passes false: the caret belongs in that field, and taking it a
   * frame later drops the phone's keyboard the field just raised.
   */
  focusOnOpen?: boolean;
  onClose: () => void;
  children: ReactNode;
}

/**
 * @component ChatDockPanel
 * @purpose Composer-width panel that quickly slides up from the chat box for transient chat/session controls.
 * @useWhen A composer control needs more room than a popover, but should remain local to the chat surface.
 * @avoidWhen The content is a global alert, full settings page, or narrow menu that fits in a regular Popover.
 * @intent Slightly inset and visually joined behind the composer’s lower card:
 * a connected context extension, not a competing floating card. It retains
 * title-bar close/minimize buttons plus optional compact title actions and Escape
 * dismissal.
 */
export function ChatDockPanel({
  open,
  title,
  icon,
  actions,
  minimizable = true,
  focusOnOpen = true,
  onClose,
  children,
}: ChatDockPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setMinimized(false);
      return;
    }
    if (!minimized && focusOnOpen)
      requestAnimationFrame(() =>
        panelRef.current?.focus({ preventScroll: true }),
      );
  }, [open, minimized, focusOnOpen]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="chat-dock-panel absolute inset-x-0 bottom-full z-0 -mb-px overflow-hidden rounded-t-[1.25rem] border border-b-0 border-line bg-panel outline-none"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        {icon ? (
          <div className="flex size-5 items-center justify-center rounded-md bg-accent text-primary">
            {icon}
          </div>
        ) : null}
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
          {title}
        </div>
        {actions ? (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {actions}
          </div>
        ) : null}
        {minimizable ? (
          <button
            type="button"
            onClick={() => setMinimized((value) => !value)}
            title={minimized ? `Restore ${title}` : "Minimize panel"}
            aria-label={minimized ? `Restore ${title}` : "Minimize panel"}
            className="flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
          >
            {minimized ? <ChevronUp size={14} /> : <Minus size={14} />}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          title="Close panel"
          aria-label="Close panel"
          className="flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
      <div
        className={`grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-150 motion-safe:ease-out ${minimized ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="max-h-[45vh] overflow-y-auto p-2">{children}</div>
        </div>
      </div>
    </div>
  );
}
