// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ShortcutsProvider } from "./shortcuts.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The `?` help is a full-screen takeover: popup and backdrop both sit in band
// 100 (`docs/ui-shell.md` Layers), above every modal in band 70, and the
// dialog still holds focus.
it("opens the shortcuts help in band 100 with focus inside it", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ShortcutsProvider>
          <button type="button">Page</button>
        </ShortcutsProvider>,
      ),
    );
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }));
    });
    const popup = document.querySelector<HTMLElement>(
      '[data-slot="dialog-content"]',
    )!;
    const backdrop = document.querySelector<HTMLElement>(
      '[data-slot="dialog-overlay"]',
    )!;
    expect(popup.textContent).toContain("Keyboard shortcuts");
    expect(popup.classList).toContain("z-100");
    expect(popup.classList).not.toContain("z-[70]");
    expect(backdrop.classList).toContain("z-100");
    expect(backdrop.classList).not.toContain("z-[70]");
    expect(popup.contains(document.activeElement)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
