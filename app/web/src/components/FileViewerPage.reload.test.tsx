// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DirectFileMeta } from "../lib/directFiles.ts";
import { FileViewerPage } from "./FileViewerPage.tsx";
import { initHistoryNav, resetHistoryNavForTests } from "../lib/historyNav.ts";

/**
 * "Reload from disk" means the file, not some of it. The header says the
 * document is LIVE, so every renderer it can use has to let go of what it
 * holds: an image and an HTML frame already did, and this pins the two that
 * did not — a passive PDF frame (re-mint, new src) and a granted media player,
 * which goes back to Play and, like a first visit, asks for nothing until the
 * reader presses it.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let mints = 0;

const meta = (path: string): DirectFileMeta => ({
  path,
  name: path.split("/").pop() ?? path,
  sizeBytes: 10,
  modifiedMs: 0,
  disposition: "media",
  contentType: "application/octet-stream",
});

vi.mock("../lib/directFiles.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/directFiles.ts")>();
  return {
    ...actual,
    fetchDirectFileMeta: (path: string) => Promise.resolve(meta(path)),
    fetchDirectFileText: () =>
      Promise.resolve({ text: "text", truncated: false }),
  };
});

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  mints = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      mints += 1;
      return new Response(
        JSON.stringify({
          url: `/api/file-grants/g${mints}/file`,
          expiresAt: Date.now() + 600_000,
          delivery: "inline",
        }),
        { status: 200 },
      );
    }),
  );
  resetHistoryNavForTests();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/files/tmp/example/report.pdf");
  initHistoryNav();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

async function show(path: string): Promise<void> {
  await act(async () => {
    root!.render(<FileViewerPage path={path} />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** The viewer's own Reload action, as the header publishes it. */
async function reload(): Promise<void> {
  const button = container!.querySelector<HTMLButtonElement>(
    '[aria-label="Reload from disk"]',
  );
  expect(button, "expected the Reload action").not.toBeNull();
  await act(async () => {
    button!.click();
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

it("re-mints a passive PDF frame on reload", async () => {
  await show("/tmp/example/report.pdf");
  const frame = () => container!.querySelector("iframe");
  expect(frame()?.getAttribute("src")).toContain("/api/file-grants/g1/file");
  expect(mints).toBe(1);

  await reload();

  expect(frame()?.getAttribute("src")).toContain("/api/file-grants/g2/file");
  expect(mints).toBe(2);
  // Still the file-scoped, token-free grant it was before.
  const body = JSON.parse(
    String((fetch as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]?.body),
  ) as { scope: string; target: { kind: string } };
  expect(body).toMatchObject({ scope: "file", target: { kind: "hostFile" } });
  expect(frame()?.getAttribute("src")).not.toContain("token=");
});

it("returns an activated media player to Play, and mints nothing until pressed", async () => {
  await show("/tmp/example/clip.mp3");
  const play = () =>
    container!.querySelector<HTMLButtonElement>('[aria-label="Play clip.mp3"]');
  expect(play()).not.toBeNull();
  expect(mints).toBe(0);

  await act(async () => {
    play()!.click();
    await Promise.resolve();
  });
  expect(container!.querySelector("audio")?.getAttribute("src")).toContain(
    "/api/file-grants/g1/file",
  );
  expect(mints).toBe(1);

  await reload();

  // The granted player is gone: no element, no src, and no request — exactly
  // the state a first visit is in.
  expect(container!.querySelector("audio")).toBeNull();
  expect(play()).not.toBeNull();
  expect(mints).toBe(1);

  await act(async () => {
    play()!.click();
    await Promise.resolve();
  });
  expect(mints).toBe(2);
  expect(container!.querySelector("audio")?.getAttribute("src")).toContain(
    "/api/file-grants/g2/file",
  );
});

it("keeps re-keying the image and HTML renderers it already reloaded", async () => {
  await show("/tmp/example/plot.png");
  const src = () => container!.querySelector("img")?.getAttribute("src") ?? "";
  const before = src();
  expect(before).toContain("v=0");
  await reload();
  expect(src()).toContain("v=1");
  expect(src()).not.toBe(before);
});
