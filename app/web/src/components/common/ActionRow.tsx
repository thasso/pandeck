import type { ReactNode } from "react";

/**
 * @component ActionRow
 * @purpose The small action row closing a block on a detail page: a hairline
 *   above, the actions right-aligned as quiet `xs` buttons with a glyph and a
 *   word ("Edit", "New worktree").
 * @useWhen Under a detail page's description and under each of its sections,
 *   so every block ends the same way and its actions are where you finish
 *   reading it rather than up in its heading.
 */
export function ActionRow({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex items-center justify-end gap-2 border-t pt-2">
      {children}
    </div>
  );
}
