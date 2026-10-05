// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DocumentNavigationActions,
  DocumentNavigationMarker,
  DocumentNavigationShell,
  documentCloseFallback,
  useDocumentNavigationRegistration,
  type DocumentNavigationRegistration,
} from "./DocumentNavigationShell.tsx";
import {
  initHistoryNav,
  pushDocumentEntryAndAnnounce,
  resetHistoryNavForTests,
} from "../lib/historyNav.ts";
import { DocumentZoomSection } from "./DocumentZoom.tsx";
import {
  CommentActuationProvider,
  usePublishCommentActuation,
} from "./review/CommentActuation.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  resetHistoryNavForTests();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/sessions/s1#m-9");
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

it("registers mobile Back, Forward and origin-aware Close without a header toolbar", () => {
  let registration: DocumentNavigationRegistration | null = null;
  function Probe() {
    registration = useDocumentNavigationRegistration();
    return null;
  }
  act(() => {
    root!.render(
      <>
        <Probe />
        <DocumentNavigationShell
          target={{ kind: "hostFile", path: "/tmp/example/report.md" }}
          title="report.md"
          sourceActions={[
            {
              id: "reload",
              label: "Reload",
              icon: <span>R</span>,
              onRun: vi.fn(),
            },
          ]}
        >
          <p>body</p>
        </DocumentNavigationShell>
      </>,
    );
  });

  expect(container!.textContent).toContain("report.md");
  expect(registration).toMatchObject({
    title: "report.md",
    canBack: false,
    canForward: false,
  });
  expect(registration).toHaveProperty("back");
  expect(registration).toHaveProperty("forward");
  expect(registration).toHaveProperty("close");
  expect(registration).toHaveProperty("zoom.reset");
  const published = registration as DocumentNavigationRegistration | null;
  expect(published?.sourceActions.map((action) => action.label)).toEqual([
    "Reload",
  ]);
});

it("scopes zoom to document content and resets it for a new target", () => {
  let registration: DocumentNavigationRegistration | null = null;
  function Probe() {
    registration = useDocumentNavigationRegistration();
    return null;
  }
  const renderTarget = (path: string) =>
    root!.render(
      <>
        <Probe />
        <DocumentNavigationShell
          target={{ kind: "hostFile", path }}
          title={path}
          zoomMode="text"
        >
          <div data-document-scroll>body</div>
        </DocumentNavigationShell>
      </>,
    );
  act(() => renderTarget("/tmp/example/one.md"));
  const first = container!.querySelector<HTMLElement>(
    "[data-document-scroll]",
  )!;
  expect(first.dataset.documentZoomMode).toBe("text");
  expect(first.style.getPropertyValue("--document-zoom")).toBe("1");
  // Zoom is variables and controls only: no touch gesture is claimed here, so
  // the browser's own pinch keeps working over the whole document.
  expect(first.style.touchAction).toBe("");

  act(() =>
    (registration as DocumentNavigationRegistration | null)?.zoom?.increase(),
  );
  expect(
    (registration as DocumentNavigationRegistration | null)?.zoom?.scale,
  ).toBe(1.25);
  expect(first.style.getPropertyValue("--document-zoom")).toBe("1.25");

  act(() => renderTarget("/tmp/example/two.md"));
  expect(
    (registration as DocumentNavigationRegistration | null)?.zoom?.scale,
  ).toBe(1);
  expect(
    document.documentElement.style.getPropertyValue("--document-zoom"),
  ).toBe("");
});

it("clamps the remembered scale when the active renderer changes mode", () => {
  let registration: DocumentNavigationRegistration | null = null;
  function Probe() {
    registration = useDocumentNavigationRegistration();
    return null;
  }
  const renderMode = (zoomMode: "text" | "visual") =>
    root!.render(
      <>
        <Probe />
        <DocumentNavigationShell
          target={{ kind: "hostFile", path: "/tmp/example/page.svg" }}
          title="page.svg"
          zoomMode={zoomMode}
        >
          <div data-document-scroll>body</div>
        </DocumentNavigationShell>
      </>,
    );
  act(() => renderMode("visual"));
  act(() =>
    (registration as DocumentNavigationRegistration | null)?.zoom?.setScale(4),
  );
  expect(
    (registration as DocumentNavigationRegistration | null)?.zoom?.scale,
  ).toBe(4);
  act(() => renderMode("text"));
  expect(
    (registration as DocumentNavigationRegistration | null)?.zoom?.scale,
  ).toBe(2);
  act(() => renderMode("visual"));
  expect(
    (registration as DocumentNavigationRegistration | null)?.zoom?.scale,
  ).toBe(2);
});

it("preserves zoom across same-document anchor Back and Forward", async () => {
  let registration: DocumentNavigationRegistration | null = null;
  function Probe() {
    registration = useDocumentNavigationRegistration();
    return null;
  }
  function AnchorHarness() {
    const [start, setStart] = useState(40);
    useEffect(() => {
      const update = () =>
        setStart(Number(/^#L(\d+)/.exec(window.location.hash)?.[1] ?? 40));
      window.addEventListener("popstate", update);
      return () => window.removeEventListener("popstate", update);
    }, []);
    return (
      <DocumentNavigationShell
        target={{
          kind: "hostFile",
          path: "/tmp/example/one.md",
          anchor: { start },
        }}
        title="one.md"
      >
        <div data-document-scroll>body</div>
      </DocumentNavigationShell>
    );
  }
  pushDocumentEntryAndAnnounce("/files/tmp/example/one.md#L10");
  pushDocumentEntryAndAnnounce("/files/tmp/example/one.md#L40");
  act(() =>
    root!.render(
      <>
        <Probe />
        <AnchorHarness />
      </>,
    ),
  );
  act(() =>
    (registration as DocumentNavigationRegistration | null)?.zoom?.increase(),
  );

  await act(async () => {
    await new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
      window.history.back();
    });
  });
  expect((registration as DocumentNavigationRegistration | null)?.id).toBe(
    "/files/tmp/example/one.md#L10",
  );
  expect(
    (registration as DocumentNavigationRegistration | null)?.zoom?.scale,
  ).toBe(1.25);

  await act(async () => {
    await new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
      window.history.forward();
    });
  });
  expect((registration as DocumentNavigationRegistration | null)?.id).toBe(
    "/files/tmp/example/one.md#L40",
  );
  expect(
    (registration as DocumentNavigationRegistration | null)?.zoom?.scale,
  ).toBe(1.25);
});

it("does not publish disposable zoom controls from route-only markers", () => {
  let registration: DocumentNavigationRegistration | null = null;
  function Probe() {
    registration = useDocumentNavigationRegistration();
    return null;
  }
  act(() => {
    root!.render(
      <>
        <Probe />
        <DocumentNavigationMarker
          target={{ kind: "hostFile", path: "/tmp/example/lazy.svg" }}
          title="lazy.svg"
          zoomMode="visual"
        />
      </>,
    );
  });
  expect(
    (registration as DocumentNavigationRegistration | null)?.zoom,
  ).toBeUndefined();
});

it("renders accessible zoom controls in the expanded sheet's own section", () => {
  const decrease = vi.fn();
  const reset = vi.fn();
  const increase = vi.fn();
  act(() => {
    root!.render(
      <DocumentZoomSection
        zoom={{
          mode: "visual",
          scale: 1.25,
          canDecrease: true,
          canIncrease: true,
          decrease,
          reset,
          increase,
          setScale: vi.fn(),
        }}
      />,
    );
  });
  // The section's own disclosure button, then the three zoom controls: every
  // one of them named, so an exact scale is reachable without a gesture.
  const buttons = [...container!.querySelectorAll("button")];
  expect(
    buttons
      .map((button) => button.getAttribute("aria-label"))
      .filter((label): label is string => label !== null),
  ).toEqual(["Zoom out", "Zoom in", "Reset zoom to 100%"]);
  expect(container!.textContent).toContain("125%");
  act(() =>
    container!
      .querySelector<HTMLButtonElement>('[aria-label="Reset zoom to 100%"]')!
      .click(),
  );
  expect(reset).toHaveBeenCalledOnce();
  act(() =>
    container!
      .querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!
      .click(),
  );
  expect(increase).toHaveBeenCalledOnce();
  act(() =>
    container!
      .querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!
      .click(),
  );
  expect(decrease).toHaveBeenCalledOnce();
});

it("persists only the outer viewer scroll and flushes once on unmount", () => {
  act(() => {
    root!.render(
      <DocumentNavigationShell
        target={{ kind: "hostFile", path: "/tmp/example/report.md" }}
        title="report.md"
      >
        <div data-document-scroll>
          <pre data-nested-scroll />
        </div>
      </DocumentNavigationShell>,
    );
  });
  const outer = container!.querySelector<HTMLElement>(
    "[data-document-scroll]",
  )!;
  const nested = container!.querySelector<HTMLElement>("[data-nested-scroll]")!;
  const replace = vi.spyOn(window.history, "replaceState");

  nested.scrollTop = 900;
  for (let index = 0; index < 30; index += 1)
    nested.dispatchEvent(new Event("scroll", { bubbles: true }));
  expect(replace).not.toHaveBeenCalled();

  for (let index = 1; index <= 30; index += 1) {
    outer.scrollTop = index * 10;
    outer.dispatchEvent(new Event("scroll"));
  }
  expect(replace).not.toHaveBeenCalled();
  act(() => root!.render(null));
  expect(replace).toHaveBeenCalledOnce();
  expect(window.history.state).toMatchObject({
    documentScroll: { top: 300, left: 0 },
  });
});

it("waits for late content extent before restoring the outer viewer", async () => {
  window.history.replaceState(
    { navIndex: 0, documentScroll: { top: 400, left: 0 } },
    "",
    "/files/tmp/example/report.md",
  );
  act(() => {
    root!.render(
      <DocumentNavigationShell
        target={{ kind: "hostFile", path: "/tmp/example/report.md" }}
        title="report.md"
      >
        <div data-document-scroll />
      </DocumentNavigationShell>,
    );
  });
  const outer = container!.querySelector<HTMLElement>(
    "[data-document-scroll]",
  )!;
  Object.defineProperties(outer, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 700 },
  });
  expect(outer.scrollTop).toBe(0);

  await act(async () => {
    outer.append(document.createElement("p"));
    await Promise.resolve();
  });
  expect(outer.scrollTop).toBe(400);
});

it("lets a line anchor take precedence over saved outer scroll", () => {
  window.history.replaceState(
    { navIndex: 0, documentScroll: { top: 400, left: 0 } },
    "",
    "/files/tmp/example/report.md#L8",
  );
  act(() => {
    root!.render(
      <DocumentNavigationShell
        target={{
          kind: "hostFile",
          path: "/tmp/example/report.md",
          anchor: { start: 8 },
        }}
        title="report.md"
      >
        <div data-document-scroll />
      </DocumentNavigationShell>,
    );
  });
  expect(
    container!.querySelector<HTMLElement>("[data-document-scroll]")!.scrollTop,
  ).toBe(0);
});

it("keeps source actions above the route marker and falls back without a gap", () => {
  let registration: DocumentNavigationRegistration | null = null;
  function Probe() {
    registration = useDocumentNavigationRegistration();
    return null;
  }
  function Surface({ loaded }: { loaded: boolean }) {
    const target = {
      kind: "hostFile" as const,
      path: "/tmp/example/report.md",
    };
    return (
      <>
        <Probe />
        <DocumentNavigationMarker target={target} title="report.md" />
        {loaded ? (
          <DocumentNavigationShell
            target={target}
            title="report.md"
            sourceActions={[
              {
                id: "download",
                label: "Download",
                icon: <span>D</span>,
                onRun: vi.fn(),
              },
            ]}
          >
            body
          </DocumentNavigationShell>
        ) : null}
      </>
    );
  }

  act(() => root!.render(<Surface loaded />));
  const loadedRegistration =
    registration as DocumentNavigationRegistration | null;
  expect(loadedRegistration?.sourceActions.map((action) => action.id)).toEqual([
    "download",
  ]);

  act(() => root!.render(<Surface loaded={false} />));
  expect(registration).toMatchObject({ title: "report.md", sourceActions: [] });
});

it("chooses a deterministic fallback for every source", () => {
  expect(documentCloseFallback({ kind: "hostFile", path: "/a" })).toBe(
    "/sessions",
  );
  expect(
    documentCloseFallback({
      kind: "sessionArtifact",
      sessionId: "s 1",
      path: "a",
    }),
  ).toBe("/sessions/s%201");
  expect(
    documentCloseFallback({
      kind: "worktreeFile",
      worktreeId: "w 1",
      path: "a",
      view: "file",
    }),
  ).toBe("/worktrees/w%201/files");
  expect(
    documentCloseFallback({
      kind: "worktreeFile",
      worktreeId: "knowledge",
      path: "a",
      view: "file",
    }),
  ).toBe("/knowledge/files");
  expect(
    documentCloseFallback({
      kind: "worktreeFile",
      worktreeId: "w 1",
      path: "a",
      view: "diff",
    }),
  ).toBe("/worktrees/w%201/changes");
});

/** A wide layout: the identity header owns the document's controls. */
function desktop(): void {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function headerLabels(): string[] {
  return [...container!.querySelectorAll("button")].map(
    (button) => button.getAttribute("aria-label") ?? "",
  );
}

it("leads the wide header with Back and Forward and ends it with Close", () => {
  desktop();
  act(() => {
    root!.render(
      <DocumentNavigationShell
        target={{ kind: "hostFile", path: "/tmp/example/report.md" }}
        title="report.md"
        zoomMode="text"
        sourceActions={[
          {
            id: "reload",
            label: "Reload from disk",
            icon: <span>R</span>,
            onRun: vi.fn(),
          },
          {
            id: "download",
            label: "Download this file",
            icon: <span>D</span>,
            onRun: vi.fn(),
          },
        ]}
      >
        <div data-document-scroll />
      </DocumentNavigationShell>,
    );
  });
  // The same order as the phone's dock row: the navigation pair leads, the
  // source's actions and the zoom controls sit between, Close is last.
  expect(headerLabels()).toEqual([
    "Back",
    "Forward",
    "Reload from disk",
    "Download this file",
    "Zoom out",
    "Reset zoom (100%)",
    "Zoom in",
    "Close document",
  ]);
});

/** A document that collects comments, as `DocumentCommentLayer` publishes them. */
function CommentingDocument() {
  usePublishCommentActuation({
    canComment: true,
    onComment: () => {},
    pendingCount: 2,
    onSubmitReview: () => {},
    submitLabel: "Send comments",
  });
  return <div data-document-scroll />;
}

it("keeps Close last when the document publishes comment controls", () => {
  desktop();
  act(() => {
    root!.render(
      <CommentActuationProvider>
        <DocumentNavigationShell
          target={{ kind: "hostFile", path: "/tmp/example/report.md" }}
          title="report.md"
          zoomMode={null}
        >
          <CommentingDocument />
        </DocumentNavigationShell>
      </CommentActuationProvider>,
    );
  });
  expect(headerLabels()).toEqual([
    "Back",
    "Forward",
    "Add comment",
    "Send comments (2 pending)",
    "Close document",
  ]);
});

it("uses that order for a page that brings its own header too", () => {
  desktop();
  act(() => {
    root!.render(
      <>
        <DocumentNavigationActions className="flex" />
        <DocumentNavigationMarker
          target={{
            kind: "worktreeFile",
            worktreeId: "w1",
            path: "src/a.ts",
            view: "file",
          }}
          title="src/a.ts"
          manageZoom
        />
      </>,
    );
  });
  expect(headerLabels()).toEqual([
    "Back",
    "Forward",
    "Zoom out",
    "Reset zoom (100%)",
    "Zoom in",
    "Close document",
  ]);
});
