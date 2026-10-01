// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DisplayBlock } from "@assistant/shared";
import { GoogleWorkspaceToolCard } from "./GoogleWorkspaceToolCard.tsx";

/**
 * The card's in-card lazy loads (`app/web/docs/loading-states.md`, Task-361
 * Phase 3d). Expanding a Gmail thread fetches its body in the browser, and
 * while it is in flight the row must say so with the shared primitives — and
 * still degrade gracefully, which is the card contract in `CLAUDE.md`: a
 * malformed answer becomes a visible failure, never a silent one.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

const searchBlock = {
  kind: "tool",
  id: "tool-1",
  name: "google_gmail_read",
  done: true,
  isError: false,
  args: { render: true },
  output: JSON.stringify({
    mode: "search",
    query: "from:someone",
    returned: 1,
    threads: [
      {
        id: "thread-1",
        subject: "Quarterly plan",
        snippet: "The plan for next quarter",
        messageCount: 3,
        localLatestDate: "2026-08-01 09:30",
      },
    ],
  }),
} as unknown as ToolBlock;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let resolveFetch: ((value: unknown) => void) | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  resolveFetch = null;
  vi.unstubAllGlobals();
});

it("reserves the thread body while it loads, from the shared primitives", async () => {
  await act(async () => {
    root!.render(<GoogleWorkspaceToolCard block={searchBlock} />);
  });
  expect(container!.textContent).toContain("Quarterly plan");

  const expand = [...container!.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "Read thread",
  );
  expect(expand).toBeTruthy();
  await act(async () => {
    expand!.click();
  });

  const region = container!.querySelector(
    '[aria-label="Loading Gmail thread"]',
  );
  expect(region).toBeTruthy();
  expect(
    region!.querySelectorAll(".motion-safe\\:animate-pulse").length,
  ).toBeGreaterThan(0);
  expect(container!.textContent).not.toContain("Loading Gmail thread…");
  // The row it expands from keeps its place in the table.
  expect(container!.textContent).toContain("Quarterly plan");

  await act(async () => {
    resolveFetch?.({
      ok: false,
      status: 500,
      json: async () => ({ error: "Gmail is unavailable" }),
    });
  });
  expect(container!.textContent).toContain("Gmail is unavailable");
  expect(
    container!.querySelector('[aria-label="Loading Gmail thread"]'),
  ).toBeFalsy();
});
