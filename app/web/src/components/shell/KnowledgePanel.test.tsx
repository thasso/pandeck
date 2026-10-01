// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  KnowledgeEntryDocument,
  KnowledgeEntryResponse,
  KnowledgeTreeResponse,
} from "@assistant/shared/knowledgeBase";
import { KnowledgePanel } from "./KnowledgePanel.tsx";

/**
 * The right panel's Knowledge tab: browse the tree, read one entry beside the
 * main pane, and hand that entry to the main Knowledge view. It is the SAME
 * document surface as the route, so what is pinned here is the panel's own
 * navigation and the live projection it passes straight through — a committed
 * change refetches the entry.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TREE: KnowledgeTreeResponse = {
  tree: [
    {
      path: "notes/alpha",
      name: "alpha",
      type: "entry",
      entryId: "kb-alpha",
      title: "Alpha Entry",
      children: [],
    },
  ],
  entriesCount: 1,
  invalidCount: 0,
  head: "abc1234",
};

interface Pending {
  ref: string;
  resolve: (value: KnowledgeEntryResponse) => void;
}

const requests: Pending[] = [];

vi.mock("../../lib/knowledgeBaseApi.ts", () => ({
  fetchKnowledgeTree: () => Promise.resolve(TREE),
  fetchKnowledgeEntry: (id: string) =>
    new Promise<KnowledgeEntryResponse>((resolve) => {
      requests.push({ ref: id, resolve });
    }),
  fetchKnowledgeEntryByPath: () =>
    new Promise<KnowledgeEntryResponse>(() => {}),
  fetchKnowledgeFileText: () => new Promise<string>(() => {}),
  knowledgeAssetUrl: (entryId: string, path: string) =>
    `asset:${entryId}/${path}`,
  knowledgeFileUrl: (path: string) => `file:${path}`,
}));

function entry(body: string): KnowledgeEntryDocument {
  return {
    kind: "entry",
    id: "kb-alpha",
    path: "notes/alpha/index.md",
    folder: "notes/alpha",
    slug: "alpha",
    uri: "pa://knowledge/kb-alpha",
    title: "Alpha Entry",
    type: "note",
    status: "active",
    summary: null,
    tags: [],
    aliases: [],
    links: [],
    sourceRefs: [],
    outline: [],
    assets: [],
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    markdown: body,
    paObjectReferences: [],
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const selected: (string | null)[] = [];
const openedInMain: string[] = [];
const dismissed: boolean[] = [];

beforeEach(() => {
  requests.length = 0;
  selected.length = 0;
  openedInMain.length = 0;
  dismissed.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function show(props: {
  entryId: string | null;
  changedAtByEntryId?: Record<string, number>;
  failure?: string;
}): Promise<void> {
  await act(async () => {
    root!.render(
      <KnowledgePanel
        entryId={props.entryId}
        onSelectEntry={(entryId) => selected.push(entryId)}
        onOpenInMain={(entryId) => openedInMain.push(entryId)}
        onOpenFile={() => {}}
        changedAtByEntryId={props.changedAtByEntryId}
        failure={props.failure}
        onDismissFailure={() => dismissed.push(true)}
      />,
    );
  });
}

function text(): string {
  return container!.textContent ?? "";
}

function byLabel(label: string): HTMLButtonElement {
  return [...container!.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.getAttribute("aria-label") === label,
  )!;
}

it("browses the tree, then reads the entry it was asked for", async () => {
  await show({ entryId: null });
  expect(text()).toContain("Alpha Entry");
  expect(text()).toContain("1 entry");

  const row = [...container!.querySelectorAll("[role='treeitem']")].at(-1)!;
  await act(async () => (row as HTMLElement).click());
  expect(selected).toEqual(["kb-alpha"]);

  await show({ entryId: "kb-alpha" });
  await act(async () => requests[0]!.resolve(entry("Alpha body")));
  expect(text()).toContain("Alpha body");

  // The panel reads an entry beside the main pane; handing it over is an
  // explicit action, and going back returns to the tree rather than the route.
  await act(async () => byLabel("Open in Knowledge").click());
  expect(openedInMain).toEqual(["kb-alpha"]);
  await act(async () => byLabel("Back to Knowledge").click());
  expect(selected).toEqual(["kb-alpha", null]);
});

it("follows the entry's committed changes while it is open", async () => {
  await show({ entryId: "kb-alpha" });
  await act(async () => requests[0]!.resolve(entry("Alpha body")));

  // A committed change to the SAME entry refetches it in place: the panel
  // never blanks what is being read (`app/web/docs/loading-states.md`, R2).
  await show({ entryId: "kb-alpha", changedAtByEntryId: { "kb-alpha": 42 } });
  expect(requests).toHaveLength(2);
  expect(text()).toContain("Alpha body");
  await act(async () => requests[1]!.resolve(entry("Alpha body v2")));
  expect(text()).toContain("Alpha body v2");
});

it("draws the entry's carried failure on the entry, not somewhere else", async () => {
  await show({ entryId: "kb-alpha", failure: "Could not add that comment." });
  await act(async () => requests[0]!.resolve(entry("Alpha body")));

  // The panel IS the entry's surface here, so a refused write about it belongs
  // in place, above the document it is still readable beside
  // (`docs/messaging.md`).
  expect(text()).toContain("Could not add that comment.");
  expect(text()).toContain("Alpha body");

  const dismiss = [...container!.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Dismiss",
  )!;
  await act(async () => dismiss.click());
  expect(dismissed).toEqual([true]);
});
