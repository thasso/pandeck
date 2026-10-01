// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KnowledgeFileViewer } from "./KnowledgeFileViewer.tsx";
import {
  useDocumentNavigationRegistration,
  type DocumentNavigationRegistration,
} from "./DocumentNavigationShell.tsx";
import { initHistoryNav, resetHistoryNavForTests } from "../lib/historyNav.ts";

/**
 * Zoom follows the renderer ON SCREEN (`docs/document-presentation.md`). A PDF
 * is a picture to scale where the engine frames it, and nothing at all where it
 * degrades to the open-in-your-browser panel: publishing `visual` there would
 * leave the header and dock controls enabled over a scale nothing reads.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const escape = CSS.escape.bind(CSS);

/**
 * The engine, as `lib/embeddedPdf.ts` asks about it: the real predicate runs
 * here, so the renderer the viewer draws and the zoom it registers cannot drift
 * apart. `-webkit-touch-callout` is the iOS/iPadOS-only feature it tests, and
 * `escape` stays real because the zoom behaviour finds its scroller with it.
 */
function stubEngine(scrollsEmbeddedPdf: boolean): void {
  vi.stubGlobal("CSS", {
    escape,
    supports: (property: string, value: string) =>
      !scrollsEmbeddedPdf &&
      property === "-webkit-touch-callout" &&
      value === "none",
  });
}

vi.mock("../lib/knowledgeBaseApi.ts", () => ({
  fetchKnowledgeEntry: () => new Promise(() => {}),
  fetchKnowledgeEntryByPath: () => new Promise(() => {}),
  fetchKnowledgeFileText: () => new Promise(() => {}),
  knowledgeAssetUrl: (entryId: string, path: string) =>
    `asset:${entryId}/${path}`,
  knowledgeFileUrl: (path: string) => `file:${path}`,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  stubEngine(true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            url: "/api/file-grants/g1/report.pdf",
            expiresAt: Date.now() + 10 * 60_000,
            delivery: "inline",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
  resetHistoryNavForTests();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/knowledge/~file/notes/report.pdf");
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

async function renderPdfViewer(): Promise<DocumentNavigationRegistration | null> {
  let registration: DocumentNavigationRegistration | null = null;
  function Probe() {
    registration = useDocumentNavigationRegistration();
    return null;
  }
  await act(async () => {
    root!.render(
      <>
        <Probe />
        <KnowledgeFileViewer path="notes/report.pdf" />
      </>,
    );
  });
  return registration;
}

it("registers visual zoom for a PDF the engine can frame", async () => {
  const registration = await renderPdfViewer();
  expect(registration?.zoom?.mode).toBe("visual");
  expect(container!.querySelector("iframe")).not.toBeNull();
});

it("registers no zoom for a PDF that falls back to a browser tab", async () => {
  stubEngine(false);
  const registration = await renderPdfViewer();
  expect(registration?.zoom).toBeUndefined();
  expect(container!.querySelector("iframe")).toBeNull();
  expect(container!.textContent).toContain("Open PDF");
});
