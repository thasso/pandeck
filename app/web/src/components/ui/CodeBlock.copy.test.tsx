// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodeBlock } from "./CodeBlock.tsx";

/**
 * The copy affordance under a code block: opt-in (`copyable`), and it copies the
 * WHOLE source — a truncated block would otherwise hand out a silently clipped
 * snippet, which is worse than no button.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function copyButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    'button[aria-label^="Copy"], button[aria-label="Copied"]',
  );
}

it("renders no copy button unless asked", () => {
  act(() => root.render(<CodeBlock code="const a = 1;" language="ts" />));
  expect(copyButton()).toBeNull();
});

it("copies the full source of a truncated block and confirms", async () => {
  const code = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  act(() =>
    root.render(
      <CodeBlock code={code} language="ts" copyable collapsedLines={5} />,
    ),
  );
  // The body is truncated: the reveal controls and the copy button share one
  // footer row.
  expect(container.textContent).toContain("5 of 30 lines");

  const button = copyButton();
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
  expect(writeText).toHaveBeenCalledWith(code);
  expect(copyButton()?.getAttribute("aria-label")).toBe("Copied");
});

it("copies the whole file from a block windowed on a huge line range", async () => {
  const code = Array.from({ length: 4_000 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  act(() =>
    root.render(
      <CodeBlock
        code={code}
        language="ts"
        copyable
        collapsedLines={10}
        lineAnchor={{ start: 2_000, end: 500_000 }}
      />,
    ),
  );
  // A window, not the range: ten lines from the first addressed one.
  expect(container.textContent).toContain("lines 2000–2009 of 4000");
  expect(container.textContent).toContain(
    "only lines 2000–2009 of the requested L2000–L500000 are shown",
  );

  await act(async () => {
    copyButton()!.click();
  });
  expect(writeText).toHaveBeenCalledWith(code);
});
