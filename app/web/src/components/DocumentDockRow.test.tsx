// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documentDockPeek } from "./DocumentDockRow.tsx";
import { DocumentZoomSection } from "./DocumentZoom.tsx";
import { DockAction, ObjectDock } from "./shell/ObjectDock.tsx";
import type { DocumentNavigationRegistration } from "./DocumentNavigationShell.tsx";
import type { DocumentTarget } from "@assistant/shared/documentTargets";

/**
 * The phone's document row, at the two widths that decide it, through the REAL
 * dock that lays it out. A 360px (and 320px) row cannot hold a worktree
 * document's Back, Forward, Open, Download, its review/session actions AND
 * Close: the middle cluster scrolls, and whatever is inside it can be off
 * screen. So the two ends are fixed — Back and Forward as one leading pair,
 * Close pinned at the far right — and only the source's and object's actions
 * scroll between them. Detailed zoom controls are in the expanded sheet.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
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

const zoom = {
  mode: "visual" as const,
  scale: 1.5,
  canDecrease: true,
  canIncrease: true,
  decrease: vi.fn(),
  increase: vi.fn(),
  reset: vi.fn(),
  setScale: vi.fn(),
};

function registration(
  target: DocumentTarget,
  sourceActions: DocumentNavigationRegistration["sourceActions"],
  withZoom = true,
): DocumentNavigationRegistration {
  return {
    historyVersion: 1,
    id: "doc",
    target,
    title: "doc",
    canBack: true,
    canForward: true,
    back: vi.fn(),
    forward: vi.fn(),
    close: vi.fn(),
    sourceActions,
    ...(withZoom ? { zoom } : {}),
  };
}

function action(id: string, label: string) {
  return { id, label, icon: <span>{id}</span>, onRun: vi.fn() };
}

/** The row inside the dock that actually arranges it. */
function renderRow(
  navigation: DocumentNavigationRegistration,
  objectActions: ReactNode = null,
): void {
  act(() =>
    root!.render(
      <ObjectDock
        mode="peek"
        peek={documentDockPeek(navigation, objectActions)}
        onExpand={vi.fn()}
        onCollapse={vi.fn()}
      >
        <div>details</div>
      </ObjectDock>,
    ),
  );
}

/** Every named control in the row, in the order the reader meets them. */
function labels(scope: Element | null = container): string[] {
  return (
    [...(scope?.querySelectorAll("button") ?? [])]
      .map((button) => button.getAttribute("aria-label") ?? "")
      // The card's own drag/open control is chrome, not one of the row's actions.
      .filter((label) => label !== "" && label !== "Open details")
  );
}

/** The controls inside the middle cluster — the ones that can scroll away. */
function scrollingLabels(): string[] {
  return labels(container!.querySelector(".overflow-x-auto"));
}

const REVIEW_ACTIONS = (
  <>
    <DockAction icon={<span>c</span>} label="Add comment" onRun={vi.fn()} />
    <DockAction icon={<span>r</span>} label="Submit review" onRun={vi.fn()} />
    <DockAction icon={<span>s</span>} label="Start session" onRun={vi.fn()} />
  </>
);

describe.each([320, 360])("at %ipx", (width) => {
  beforeEach(() => setViewport(width));

  it("puts a host file's actions between Back/Forward and Close", () => {
    renderRow(
      registration({ kind: "hostFile", path: "/tmp/example/a.md" }, [
        action("reload", "Reload from disk"),
        action("download", "Download this file"),
        action("raw", "Open the raw file"),
      ]),
    );
    expect(labels()).toEqual([
      "Back",
      "Forward",
      "Reload from disk",
      "Download this file",
      "Open the raw file",
      "Close document",
    ]);
    expect(scrollingLabels()).toEqual([
      "Reload from disk",
      "Download this file",
      "Open the raw file",
    ]);
    expect(labels().some((label) => label.startsWith("Zoom"))).toBe(false);
  });

  it("arranges a Knowledge file row the same way", () => {
    renderRow(
      registration({ kind: "knowledgeFile", path: "notes/data.json" }, [
        action("open", "Open raw file"),
        action("download", "Download file"),
      ]),
    );
    expect(labels()).toEqual([
      "Back",
      "Forward",
      "Open raw file",
      "Download file",
      "Close document",
    ]);
    expect(scrollingLabels()).toEqual(["Open raw file", "Download file"]);
  });

  it("arranges an artifact row the same way", () => {
    renderRow(
      registration(
        { kind: "sessionArtifact", sessionId: "s1", path: "out/report.pdf" },
        [
          action("open", "Open raw artifact"),
          action("download", "Download artifact"),
        ],
      ),
    );
    expect(labels()).toEqual([
      "Back",
      "Forward",
      "Open raw artifact",
      "Download artifact",
      "Close document",
    ]);
  });

  it("keeps both ends fixed in the densest worktree file and diff rows", () => {
    const sourceActions = [
      action("open", "Open worktree file"),
      action("download", "Download worktree file"),
    ];
    renderRow(
      registration(
        {
          kind: "worktreeFile",
          worktreeId: "w1",
          path: "src/a.ts",
          view: "file",
        },
        sourceActions,
      ),
      REVIEW_ACTIONS,
    );
    // Eight controls in a 360px row: five of them scroll, and neither the way
    // back nor the way out is among them.
    expect(labels()).toEqual([
      "Back",
      "Forward",
      "Open worktree file",
      "Download worktree file",
      "Add comment",
      "Submit review",
      "Start session",
      "Close document",
    ]);
    expect(scrollingLabels()).toEqual([
      "Open worktree file",
      "Download worktree file",
      "Add comment",
      "Submit review",
      "Start session",
    ]);
    expect(labels().some((label) => label.startsWith("Zoom"))).toBe(false);
    expect(labels().some((label) => label.startsWith("Reset zoom"))).toBe(
      false,
    );

    act(() => root!.unmount());
    root = createRoot(container!);
    renderRow(
      registration(
        {
          kind: "worktreeFile",
          worktreeId: "w1",
          path: "src/a.ts",
          view: "diff",
        },
        sourceActions,
      ),
      REVIEW_ACTIONS,
    );
    expect(labels().slice(0, 2)).toEqual(["Back", "Forward"]);
    expect(labels().at(-1)).toBe("Close document");
    expect(scrollingLabels()).not.toContain("Close document");
  });

  it("puts every zoom control in the expanded sheet instead", () => {
    act(() => root!.render(<DocumentZoomSection zoom={zoom} />));
    // The section's own disclosure control leads, then every zoom control,
    // each with a name a screen reader can announce.
    expect(
      [...container!.querySelectorAll("button")].map(
        (button) => button.getAttribute("aria-label") ?? "",
      ),
    ).toEqual(["", "Zoom out", "Zoom in", "Reset zoom to 100%"]);
    expect(container!.textContent).toContain("150%");
  });
});

it("still shows Back, Forward and Close for a document with no other action", () => {
  const navigation = registration(
    { kind: "hostFile", path: "/tmp/example/a.png" },
    [],
    false,
  );
  expect(navigation.zoom).toBeUndefined();
  renderRow(navigation);
  expect(labels()).toEqual(["Back", "Forward", "Close document"]);
  expect(scrollingLabels()).toEqual([]);
});
