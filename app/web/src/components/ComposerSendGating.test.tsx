import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "./Composer.tsx";

describe("Composer send gating", () => {
  function renderComposer(sendBlockedReason?: string): string {
    return renderToStaticMarkup(
      <Composer
        onSend={() => {}}
        onAbort={() => {}}
        streaming={false}
        disabled={false}
        contextInfo={null}
        session={null}
        models={[]}
        slashCommands={[]}
        actions={{} as never}
        reserveHintSlot
        sendBlockedReason={sendBlockedReason}
      />,
    );
  }

  it("renders the worktree-required hint in the reserved slot above the composer", () => {
    const html = renderComposer(
      "Developer sessions run in a worktree — pick one to continue.",
    );
    expect(html).toContain("Developer sessions run in a worktree");
    expect(html).toContain('aria-live="polite"');
  });

  it("keeps the hint slot reserved on the new-session surface so toggling never shifts layout", () => {
    const html = renderComposer(undefined);
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("Developer sessions run in a worktree");
  });
});
