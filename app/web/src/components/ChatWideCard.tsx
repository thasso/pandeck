import type { CSSProperties, ReactNode } from "react";

/**
 * @component ChatWideCard
 * @purpose Shared breakout card shell for rich chat widgets that need more width than the normal message column.
 * @useWhen Rendering custom tool/output cards, approval widgets, wide tables, timelines, or dashboards inside chat.
 * @avoidWhen Plain assistant prose or narrow inline cards fit comfortably in the normal max-w-3xl chat column.
 * @intent Centers in the full chat area while clamping to the shell's --shell-main-width; children own internal overflow.
 */
type ChatWideCardProps = {
  children: ReactNode;
  className?: string;
  maxWidth?: number;
  as?: "section" | "div";
};

export function ChatWideCard({
  children,
  className = "",
  maxWidth = 1120,
  as: Component = "section",
}: ChatWideCardProps) {
  return (
    <Component
      style={
        {
          "--chat-wide-max": `${maxWidth}px`,
          // Wide widgets are rendered inside assistant messages. Shift the
          // breakout shell back by half its own width so it centers in the chat
          // area rather than the text flow.
          transform: "translateX(-50%)",
        } as CSSProperties
      }
      className={`relative left-1/2 my-3 w-[min(var(--chat-wide-max),calc(var(--shell-main-width,100vw)_-_2rem))] max-w-none overflow-hidden rounded-2xl border border-line bg-panel shadow-sm ${className}`}
    >
      {children}
    </Component>
  );
}
