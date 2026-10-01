// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  KnowledgeEntryDocument,
  KnowledgeEntryResponse,
} from "@assistant/shared/knowledgeBase";
import { KnowledgePage } from "./KnowledgePage.tsx";

/**
 * How the Knowledge route draws the five states
 * (`app/web/docs/loading-states.md`). The rule this file exists for is R3:
 * entry A's document may never appear under entry B's URL, so a target change
 * renders B's own placeholder while a same-entry invalidation keeps A on
 * screen.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Pending {
  ref: string;
  resolve: (value: KnowledgeEntryResponse) => void;
  reject: (error: unknown) => void;
}

/** Every entry request, handed its answer by the test. */
const requests: Pending[] = [];

function request(ref: string): Promise<KnowledgeEntryResponse> {
  return new Promise((resolve, reject) => {
    requests.push({ ref, resolve, reject });
  });
}

vi.mock("../lib/knowledgeBaseApi.ts", () => ({
  fetchKnowledgeEntry: (id: string) => request(`id:${id}`),
  fetchKnowledgeEntryByPath: (path: string) => request(`path:${path}`),
  fetchKnowledgeFileText: () => new Promise<string>(() => {}),
  knowledgeAssetUrl: (entryId: string, path: string) =>
    `asset:${entryId}/${path}`,
  knowledgeFileUrl: (path: string) => `file:${path}`,
}));

function entry(id: string, body: string): KnowledgeEntryDocument {
  return {
    kind: "entry",
    id,
    path: `${id}/index.md`,
    folder: id,
    slug: id,
    uri: `pa://knowledge/${id}`,
    title: id,
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

beforeEach(() => {
  requests.length = 0;
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
  entryId: string;
  changedAtByEntryId?: Record<string, number>;
  failure?: string;
}): Promise<void> {
  await act(async () => {
    root!.render(
      <KnowledgePage
        entryId={props.entryId}
        changedAtByEntryId={props.changedAtByEntryId}
        failure={props.failure}
        onDismissFailure={() => {}}
      />,
    );
  });
}

function text(): string {
  return container!.textContent ?? "";
}

it("shows the new entry's placeholder rather than the previous document", async () => {
  await show({ entryId: "kb-alpha" });
  expect(text()).toContain("Loading entry…");

  await act(async () => {
    requests[0]!.resolve(entry("kb-alpha", "Alpha body"));
  });
  expect(text()).toContain("Alpha body");

  // R3: a different entry drops the old answer during render — "Alpha body"
  // must not survive one frame under kb-beta's URL.
  await show({ entryId: "kb-beta" });
  expect(text()).not.toContain("Alpha body");
  expect(text()).toContain("Loading entry…");
  expect(requests.map((pending) => pending.ref)).toEqual([
    "id:kb-alpha",
    "id:kb-beta",
  ]);

  await act(async () => {
    requests[1]!.resolve(entry("kb-beta", "Beta body"));
  });
  expect(text()).toContain("Beta body");
});

it("keeps the document on screen while a committed change refetches it", async () => {
  await show({ entryId: "kb-alpha" });
  await act(async () => {
    requests[0]!.resolve(entry("kb-alpha", "Alpha body"));
  });

  // A `knowledgeChanged` bump for the SAME entry is a refresh (R2).
  await show({ entryId: "kb-alpha", changedAtByEntryId: { "kb-alpha": 42 } });
  expect(requests).toHaveLength(2);
  expect(text()).toContain("Alpha body");
  expect(text()).toContain("Refreshing entry");

  await act(async () => {
    requests[1]!.resolve(entry("kb-alpha", "Alpha body v2"));
  });
  expect(text()).toContain("Alpha body v2");
  expect(text()).not.toContain("Refreshing entry");
});

it("does not refetch an entry it has only just navigated to", async () => {
  await show({ entryId: "kb-alpha", changedAtByEntryId: { "kb-alpha": 7 } });
  await act(async () => {
    requests[0]!.resolve(entry("kb-alpha", "Alpha body"));
  });

  // kb-beta carries its own invalidation token; arriving at it is a first load,
  // not an invalidation of it.
  await show({
    entryId: "kb-beta",
    changedAtByEntryId: { "kb-alpha": 7, "kb-beta": 99 },
  });
  await act(async () => {
    requests[1]!.resolve(entry("kb-beta", "Beta body"));
  });
  expect(requests.map((pending) => pending.ref)).toEqual([
    "id:kb-alpha",
    "id:kb-beta",
  ]);
});

it("offers a retry when the entry cannot be loaded, and keeps a loaded one", async () => {
  await show({ entryId: "kb-alpha" });
  await act(async () => {
    requests[0]!.reject(new Error("Knowledge entry not found."));
  });
  expect(text()).toContain("Entry not available");
  expect(text()).toContain("Knowledge entry not found.");

  // R2: once the document is on screen, a failed refresh notes the failure and
  // leaves the entry readable.
  await act(async () => {
    container!
      .querySelector<HTMLButtonElement>("[role='alert'] button")!
      .click();
  });
  await act(async () => {
    requests[1]!.resolve(entry("kb-alpha", "Alpha body"));
  });
  await show({ entryId: "kb-alpha", changedAtByEntryId: { "kb-alpha": 3 } });
  const readingPane = container!.querySelector("main");
  await act(async () => {
    requests[2]!.reject(new Error("network down"));
  });
  expect(text()).toContain("Could not refresh this entry: network down");
  expect(text()).toContain("Alpha body");
  // Keeping the TEXT is not enough: the note may not remount the document, or
  // the scroll position and every draft inside it die with the failed refresh.
  expect(container!.querySelector("main")).toBe(readingPane);
});

// A write about the ENTRY that no control here tracks — a comment on it, a review
// handoff — is rendered on the entry (`docs/messaging.md`), which is what lets
// the announcer stay quiet while it is open. Like the refresh note above it, this
// one may not remount the document it belongs to.
it("renders the entry's own failure without disturbing the document", async () => {
  await show({ entryId: "kb-alpha" });
  await act(async () => {
    requests[0]!.resolve(entry("kb-alpha", "Alpha body"));
  });
  const readingPane = container!.querySelector("main");

  await show({ entryId: "kb-alpha", failure: "Failed to add comment: EIO" });
  expect(text()).toContain("Failed to add comment: EIO");
  expect(text()).toContain("Dismiss");
  expect(text()).toContain("Alpha body");
  expect(container!.querySelector("main")).toBe(readingPane);
  expect(requests).toHaveLength(1);

  await show({ entryId: "kb-alpha" });
  expect(text()).not.toContain("Failed to add comment");
  expect(container!.querySelector("main")).toBe(readingPane);
});

// The entry can be unreadable and still be the object a write was refused about,
// and this surface CLAIMS that object — so a note only the loaded branch drew
// would be suppressed into nothing.
it("renders the entry's own failure even with no document to show", async () => {
  await show({ entryId: "kb-alpha", failure: "Failed to add comment: EIO" });
  expect(text()).toContain("Failed to add comment: EIO");

  await act(async () => {
    requests[0]!.reject(new Error("Knowledge entry not found."));
  });
  expect(text()).toContain("Entry not available");
  expect(text()).toContain("Failed to add comment: EIO");
});

/**
 * The host's copy of "which entry is open" outlives the route, so the page has to
 * report the ADDRESS each document was loaded for. Without it a path→path
 * navigation leaves entry A's id standing while B loads, and the host would claim
 * A's failure home — suppressing A's announcement and drawing A's note over B's
 * loading surface (`docs/messaging.md`).
 */
it("reports which address each loaded entry answered", async () => {
  const loaded: Array<[string, string, string | null]> = [];
  const showPath = async (entryPath: string) => {
    await act(async () => {
      root!.render(
        <KnowledgePage
          entryPath={entryPath}
          onEntryLoaded={(id, title, addressedPath) =>
            loaded.push([id, title, addressedPath])
          }
        />,
      );
    });
  };

  await showPath("notes/alpha");
  await act(async () => {
    requests[0]!.resolve(entry("kb-alpha", "Alpha body"));
  });
  expect(loaded).toEqual([["kb-alpha", "kb-alpha", "notes/alpha"]]);

  // B is addressed and its document has NOT arrived: nothing new is reported, so
  // the host still holds A's id — stamped with A's path, which no longer matches
  // the route, which is exactly how it knows not to speak for A.
  await showPath("notes/beta");
  expect(text()).not.toContain("Alpha body");
  expect(loaded).toHaveLength(1);

  await act(async () => {
    requests[1]!.resolve(entry("kb-beta", "Beta body"));
  });
  expect(loaded[1]).toEqual(["kb-beta", "kb-beta", "notes/beta"]);

  // An id route addresses no path, and says so rather than reusing the last one.
  await act(async () => {
    root!.render(
      <KnowledgePage
        entryId="kb-gamma"
        onEntryLoaded={(id, title, addressedPath) =>
          loaded.push([id, title, addressedPath])
        }
      />,
    );
  });
  await act(async () => {
    requests[2]!.resolve(entry("kb-gamma", "Gamma body"));
  });
  expect(loaded[2]).toEqual(["kb-gamma", "kb-gamma", null]);
});
