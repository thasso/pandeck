// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionArtifactViewer } from "./SessionArtifactViewer.tsx";
import {
  useDocumentNavigationRegistration,
  type DocumentNavigationRegistration,
} from "./DocumentNavigationShell.tsx";
import { initHistoryNav, resetHistoryNavForTests } from "../lib/historyNav.ts";

/**
 * Captured artifact viewers use their typed source grant for browser-rendered
 * documents and defer media until Play. No iframe/player receives the app token.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let registration: DocumentNavigationRegistration | null = null;

function Probe() {
  registration = useDocumentNavigationRegistration();
  return null;
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  resetHistoryNavForTests();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/sessions/s1");
  initHistoryNav();
  registration = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

function show(path: string): void {
  act(() =>
    root!.render(
      <>
        <Probe />
        <SessionArtifactViewer sessionId="s1" path={path} />
      </>,
    ),
  );
}

function actionIds(): string[] {
  return (registration?.sourceActions ?? []).map((action) => action.id);
}

it("mounts captured PDF and HTML only from their source grants", async () => {
  const fetchSpy = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        target: { path: string };
        scope: string;
      };
      return new Response(
        JSON.stringify({
          url: `/api/file-grants/g/${request.target.path.split("/").pop()}`,
          expiresAt: Date.now() + 60_000,
          delivery: "inline",
        }),
        { status: 200 },
      );
    },
  );
  vi.stubGlobal("fetch", fetchSpy);
  show("tool-output/report.pdf");
  await act(async () => Promise.resolve());
  let frame = container!.querySelector("iframe")!;
  expect(frame.src).toContain("/api/file-grants/g/report.pdf");
  expect(frame.src).not.toContain("token=");
  expect(frame.hasAttribute("sandbox")).toBe(false);
  expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)).scope).toBe(
    "file",
  );

  act(() => root!.unmount());
  root = createRoot(container!);
  show("tool-output/page.html");
  await act(async () => Promise.resolve());
  frame = container!.querySelector("iframe")!;
  expect(frame.src).toContain("/api/file-grants/g/page.html");
  expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)).scope).toBe(
    "directory",
  );
  expect(actionIds()).toEqual(["open", "download"]);
});

it("says a file type it cannot preview is not a file it cannot run", () => {
  show("tool-output/archive.zip");
  expect(container!.textContent).toContain("can't be previewed here");
  expect(actionIds()).toEqual(["open", "download"]);
});

it("defers captured audio/video until Play and keeps images lazy", async () => {
  const fetchSpy = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          url: "/api/file-grants/media/clip",
          expiresAt: Date.now() + 60_000,
          delivery: "inline",
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchSpy);
  show("tool-output/clip.mp3");
  expect(container!.querySelector("audio")).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
  await act(async () => {
    container!
      .querySelector<HTMLButtonElement>('[aria-label="Play clip.mp3"]')!
      .click();
    await Promise.resolve();
  });
  expect(container!.querySelector("audio")?.src).toContain(
    "/api/file-grants/media/clip",
  );

  act(() => root!.unmount());
  root = createRoot(container!);
  show("tool-output/clip.mp4");
  expect(container!.querySelector("video")).toBeNull();
  expect(container!.textContent).toContain("Play clip.mp4");

  act(() => root!.unmount());
  root = createRoot(container!);
  show("browser/page.png");
  expect(container!.querySelector("img")?.getAttribute("alt")).toBe(
    "Captured artifact: page.png",
  );
});
