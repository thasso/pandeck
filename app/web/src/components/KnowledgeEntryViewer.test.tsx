// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  KnowledgeEntryDocument,
  KnowledgeEntryResponse,
} from "@assistant/shared/knowledgeBase";
import type { PaObjectLinkResolution } from "@assistant/shared/objectLinks";
import { KnowledgeEntryViewer as BareKnowledgeEntryViewer } from "./KnowledgeEntryViewer.tsx";
import {
  CommentActuationProvider,
  useCommentActuation,
  type CommentActuation,
} from "./review/CommentActuation.tsx";
import {
  DocumentCommentHostProvider,
  type DocumentCommentHost,
} from "./DocumentComments.tsx";
import { DialogProvider } from "./ui/dialog.tsx";
import {
  readPendingComments,
  trayStorageKey,
  writePendingComments,
} from "../lib/pendingCommentStore.ts";
import type { PendingDocumentComment } from "../lib/chatCommentPrompt.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: vi.fn(() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })),
});

const TRAY = trayStorageKey("kb:kb-sample");

beforeEach(() => writePendingComments(TRAY, []));

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  writePendingComments(TRAY, []);
  actuation = null;
  vi.useRealTimers();
});

function entry(
  overrides: Partial<KnowledgeEntryDocument> = {},
): KnowledgeEntryDocument {
  return {
    kind: "entry",
    id: "kb-sample",
    path: "sample/index.md",
    folder: "sample",
    slug: "sample",
    uri: "pa://knowledge/kb-sample",
    title: "Sample Entry",
    type: "note",
    status: "active",
    summary: "A short summary.",
    tags: ["alpha", "beta"],
    aliases: [],
    links: [],
    sourceRefs: [],
    outline: [
      { text: "Sample Entry", level: 1 },
      { text: "Overview", level: 2 },
      { text: "Details", level: 3 },
    ],
    assets: [],
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    markdown: "## Overview\n\nBody prose.",
    paObjectReferences: [],
    ...overrides,
  };
}

const stubResolveAsset = (path: string) =>
  `/api/knowledge/asset?path=${encodeURIComponent(path)}`;

/** What the viewer last published to the shell (dock row, header, inspector). */
let actuation: CommentActuation | null = null;

function ActuationProbe() {
  actuation = useCommentActuation();
  return null;
}

function KnowledgeEntryViewer({
  host,
  ...props
}: ComponentProps<typeof BareKnowledgeEntryViewer> & {
  host?: DocumentCommentHost;
}) {
  const viewer = (
    <DialogProvider>
      <CommentActuationProvider>
        <ActuationProbe />
        <BareKnowledgeEntryViewer {...props} />
      </CommentActuationProvider>
    </DialogProvider>
  );
  return host ? (
    <DocumentCommentHostProvider host={host}>
      {viewer}
    </DocumentCommentHostProvider>
  ) : (
    viewer
  );
}

function host(
  overrides: Partial<DocumentCommentHost> = {},
): DocumentCommentHost {
  return {
    sessions: [
      { id: "s-current", title: "Current work", linked: true },
      { id: "s-other", title: "Other work" },
    ],
    send: vi.fn(async () => null),
    ...overrides,
  };
}

function type(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(textarea, value);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function submit(textarea: HTMLTextAreaElement) {
  textarea
    .closest("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function trayComments(): PendingDocumentComment[] {
  return readPendingComments(TRAY) as PendingDocumentComment[];
}

function pending(
  id: string,
  body: string,
  quote?: string,
): PendingDocumentComment {
  return {
    id,
    anchor: {
      kind: "document",
      document: {
        kind: "knowledgeEntry",
        entryId: "kb-sample",
        title: "Sample Entry",
      },
    },
    body,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...(quote !== undefined ? { quote } : {}),
  };
}

/** Click `target` with the caret reported at `offset` of its first text node. */
async function tapText(target: Element, offset: number): Promise<MouseEvent> {
  const text = target.firstChild!;
  const point = document.createRange();
  point.setStart(text, offset);
  point.collapse(true);
  const pointDocument = document as Document & {
    caretRangeFromPoint?: () => Range | null;
  };
  const original = pointDocument.caretRangeFromPoint;
  pointDocument.caretRangeFromPoint = () => point;
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    clientX: 1,
    clientY: 1,
  });
  await act(async () => target.dispatchEvent(event));
  if (original) pointDocument.caretRangeFromPoint = original;
  else Reflect.deleteProperty(pointDocument, "caretRangeFromPoint");
  return event;
}

async function mount(
  resource: KnowledgeEntryResponse,
  commentHost?: DocumentCommentHost,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <KnowledgeEntryViewer
        resource={resource}
        resolveAssetUrl={stubResolveAsset}
        {...(commentHost ? { host: commentHost } : {})}
      />,
    ),
  );
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function render(resource: KnowledgeEntryResponse): string {
  return renderToStaticMarkup(
    <KnowledgeEntryViewer
      resource={resource}
      resolveAssetUrl={stubResolveAsset}
      onCopyLink={() => {}}
    />,
  );
}

describe("KnowledgeEntryViewer", () => {
  it("keeps the entry title visible in its compact header", () => {
    const html = render(entry());
    expect(html).toContain(">Sample Entry</h2>");
    expect(html).toContain("A short summary.");
    // Tags are frontmatter and belong to the inspector, not between the reader
    // and the document.
    expect(html).not.toContain("#alpha");
    // Body heading renders as a real heading element.
    expect(html).toContain("<h2");
    expect(html).toContain("Overview");
  });

  it("renders the contents as a nested tree without the title heading", () => {
    const html = render(entry());
    expect(html).toContain("Contents");
    expect(html).toContain("Overview");
    expect(html).toContain("Details");
    // The leading H1 repeats the entry title, so the outline drops it: the tree
    // starts at the first real section.
    const contents = html.slice(
      html.indexOf("Contents"),
      html.indexOf("Body prose."),
    );
    expect(contents).not.toContain("Sample Entry");
    // A deeper heading nests under the previous one rather than sitting beside it.
    expect(contents).toContain("border-l");
  });

  it("renders explicit link text and infers titles for empty pa links", () => {
    const refs: PaObjectLinkResolution[] = [
      {
        uri: "pa://task/257",
        objectType: "task",
        knownType: true,
        id: "257",
        href: "/tasks/257",
        title: "Linked Task",
        typeLabel: "Task",
        existence: "exists",
      },
    ];
    const explicit = render(
      entry({
        markdown: "See [my task](pa://task/257).",
        paObjectReferences: refs,
      }),
    );
    expect(explicit).toContain("my task");
    expect(explicit).toContain('href="/tasks/257"');

    const empty = render(
      entry({ markdown: "See [](pa://task/257).", paObjectReferences: refs }),
    );
    expect(empty).toContain("Linked Task");
    expect(empty).toContain('href="/tasks/257"');
  });

  it("autolinks bare pa text and marks unresolved links as broken", () => {
    const autolink = render(entry({ markdown: "Open pa://project/demo." }));
    expect(autolink).toContain('href="/projects/demo"');

    const broken = render(
      entry({
        markdown: "See <pa://task/missing>.",
        paObjectReferences: [
          {
            uri: "pa://task/missing",
            objectType: "task",
            knownType: true,
            id: "missing",
            href: "/tasks/missing",
            title: "Task missing",
            typeLabel: "Task",
            existence: "missing",
          },
        ],
      }),
    );
    expect(broken).toContain('href="#"');
    expect(broken).toContain("text-danger");
  });

  it("offers no comment controls outside a comment host", async () => {
    const view = await mount(entry());
    expect(actuation).toBeNull();
    await view.unmount();
  });

  it("collects a passage comment with its quote and source lines", async () => {
    vi.useFakeTimers();
    const view = await mount(entry(), host());
    const text = view.container.querySelector("article p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    const nativeSelection = window.getSelection()!;
    nativeSelection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await act(async () => vi.advanceTimersByTime(150));

    const comment = document.querySelector<HTMLButtonElement>(
      '[data-comment-actuation][aria-label="Add comment"]',
    )!;
    expect(comment.disabled).toBe(false);
    // The native selection may collapse before the click lands (iOS).
    nativeSelection.removeAllRanges();
    await act(async () => comment.click());

    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[placeholder="Comment on the selected passage…"]',
    )!;
    await act(async () => type(textarea, "Tighten this"));
    await act(async () => submit(textarea));

    expect(trayComments()).toEqual([
      expect.objectContaining({
        anchor: {
          kind: "document",
          document: {
            kind: "knowledgeEntry",
            entryId: "kb-sample",
            title: "Sample Entry",
          },
        },
        quote: "Body",
        lines: { start: 3, end: 3 },
        body: "Tighten this",
      }),
    ]);
    expect(actuation?.pendingCount).toBe(1);
    await view.unmount();
  });

  it("comments on the whole entry when nothing is selected", async () => {
    const view = await mount(entry(), host());
    await act(async () => actuation?.onComment?.());
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[placeholder="Comment on the whole document…"]',
    )!;
    await act(async () => type(textarea, "Split this entry"));
    await act(async () => submit(textarea));

    const [comment] = trayComments();
    expect(comment?.body).toBe("Split this entry");
    expect(comment?.quote).toBeUndefined();
    expect(comment?.lines).toBeUndefined();
    await view.unmount();
  });

  it("opens the next new comment empty after one was stored", async () => {
    const view = await mount(entry(), host());
    await act(async () => actuation?.onComment?.());
    let textarea = document.querySelector<HTMLTextAreaElement>(
      '[placeholder="Comment on the whole document…"]',
    )!;
    await act(async () => type(textarea, "First, filed"));
    await act(async () => submit(textarea));
    expect(trayComments().map((comment) => comment.body)).toEqual([
      "First, filed",
    ]);

    await act(async () => actuation?.onComment?.());
    textarea = document.querySelector<HTMLTextAreaElement>(
      '[placeholder="Comment on the whole document…"]',
    )!;
    expect(textarea.value).toBe("");
    expect(
      Object.keys(window.localStorage).filter((key) =>
        key.startsWith("pa.draft.document-comment:"),
      ),
    ).toEqual([]);
    await view.unmount();
  });

  it("keeps a refused first comment in the open composer", async () => {
    const view = await mount(entry(), host());
    await act(async () => actuation?.onComment?.());
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[placeholder="Comment on the whole document…"]',
    )!;
    await act(async () => type(textarea, "Do not lose me"));
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
    try {
      await act(async () => submit(textarea));
    } finally {
      setItem.mockRestore();
    }

    expect(trayComments()).toEqual([]);
    expect(textarea.isConnected).toBe(true);
    expect(textarea.value).toBe("Do not lose me");
    expect(document.body.textContent).toContain("couldn't store the comment");
    await view.unmount();
  });

  it("opens a collected passage's comment when its text is tapped", async () => {
    writePendingComments(TRAY, [
      {
        id: "c1",
        anchor: {
          kind: "document",
          document: {
            kind: "knowledgeEntry",
            entryId: "kb-sample",
            title: "Sample Entry",
          },
        },
        quote: "Body prose.",
        body: "Existing note",
        createdAt: "2026-06-01T10:00:00.000Z",
      },
    ]);
    const view = await mount(entry(), host());
    const paragraph = view.container.querySelector("article p")!;
    const point = document.createRange();
    point.setStart(paragraph.firstChild!, 2);
    point.collapse(true);
    const pointDocument = document as Document & {
      caretRangeFromPoint?: () => Range | null;
    };
    const original = pointDocument.caretRangeFromPoint;
    pointDocument.caretRangeFromPoint = () => point;
    await act(async () =>
      paragraph.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 1 }),
      ),
    );
    if (original) pointDocument.caretRangeFromPoint = original;
    else Reflect.deleteProperty(pointDocument, "caretRangeFromPoint");

    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Edit comment"]',
    )!;
    expect(textarea.value).toBe("Existing note");
    await act(async () => type(textarea, "Edited note"));
    await act(async () => submit(textarea));
    expect(trayComments().map((comment) => comment.body)).toEqual([
      "Edited note",
    ]);
    await view.unmount();
  });

  it("refuses to overwrite an edit another view saved, then overwrites on purpose", async () => {
    writePendingComments(TRAY, [pending("c1", "Original", "Body prose.")]);
    const view = await mount(entry(), host());
    await tapText(view.container.querySelector("article p")!, 2);
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Edit comment"]',
    )!;
    await act(async () => type(textarea, "Mine"));
    // The side panel on the same entry saves its own edit meanwhile.
    await act(async () =>
      writePendingComments(TRAY, [pending("c1", "Theirs", "Body prose.")]),
    );
    await act(async () => submit(textarea));
    expect(trayComments()[0]?.body).toBe("Theirs");
    expect(document.body.textContent).toContain("changed in another view");
    expect(textarea.value).toBe("Mine");

    await act(async () => submit(textarea));
    expect(trayComments()[0]?.body).toBe("Mine");
    await view.unmount();
  });

  it("keeps text typed while its own save waited on the lock", async () => {
    writePendingComments(TRAY, [pending("c1", "original", "Body prose.")]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, operation: () => unknown) => {
          await gate;
          return operation();
        },
      },
    });
    try {
      const view = await mount(entry(), host());
      await tapText(view.container.querySelector("article p")!, 2);
      const textarea = document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Edit comment"]',
      )!;
      await act(async () => type(textarea, "first version"));
      await act(async () => submit(textarea));
      await act(async () => type(textarea, "second version"));
      await act(async () => release());

      expect(trayComments()[0]?.body).toBe("first version");
      expect(
        document.querySelector<HTMLTextAreaElement>(
          '[aria-label="Edit comment"]',
        )?.value,
      ).toBe("second version");

      await act(async () => submit(textarea));
      expect(trayComments()[0]?.body).toBe("second version");
      await view.unmount();
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("keeps an edit's draft when another view sent its comment", async () => {
    writePendingComments(TRAY, [pending("c1", "Original", "Body prose.")]);
    const view = await mount(entry(), host());
    await tapText(view.container.querySelector("article p")!, 2);
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Edit comment"]',
    )!;
    await act(async () => type(textarea, "Unsaved thought"));
    await act(async () => writePendingComments(TRAY, []));
    await act(async () => submit(textarea));
    expect(document.body.textContent).toContain("sent or removed");
    expect(
      document.querySelector<HTMLTextAreaElement>('[aria-label="Edit comment"]')
        ?.value,
    ).toBe("Unsaved thought");
    await view.unmount();
  });

  it("opens a comment on linked text instead of following the link", async () => {
    writePendingComments(TRAY, [pending("c1", "About the link", "the guide")]);
    const view = await mount(
      entry({ markdown: "Read [the guide](https://example.com) first." }),
      host(),
    );
    const link = view.container.querySelector("article a")!;
    const onLink = vi.fn();
    view.container.addEventListener("click", onLink);
    const event = await tapText(link, 2);
    expect(event.defaultPrevented).toBe(true);
    expect(onLink).not.toHaveBeenCalled();
    expect(
      document.querySelector<HTMLTextAreaElement>('[aria-label="Edit comment"]')
        ?.value,
    ).toBe("About the link");
    await view.unmount();
  });

  it("reports a refused send on the tray and keeps its comments", async () => {
    writePendingComments(TRAY, [pending("c1", "Keep me")]);
    const view = await mount(
      entry(),
      host({ send: vi.fn(async () => "Storage is full.") }),
    );
    const send = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Send to session",
    )!;
    await act(async () => send.click());
    const move = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Move to composer",
    )!;
    await act(async () => move.click());
    expect(document.body.textContent).toContain("Storage is full.");
    expect(trayComments().map((comment) => comment.body)).toEqual(["Keep me"]);
    await view.unmount();
  });

  it("sends the tray to the session on screen by default", async () => {
    const commentHost = host();
    writePendingComments(TRAY, [
      {
        id: "c1",
        anchor: {
          kind: "document",
          document: {
            kind: "knowledgeEntry",
            entryId: "kb-sample",
            title: "Sample Entry",
          },
        },
        body: "Whole-entry note",
        createdAt: "2026-06-01T10:00:00.000Z",
      },
    ]);
    const view = await mount(entry(), commentHost);
    const send = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Send to session",
    )!;
    await act(async () => send.click());
    const move = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Move to composer",
    )!;
    await act(async () => move.click());
    expect(commentHost.send).toHaveBeenCalledWith(TRAY, {
      kind: "existing",
      sessionId: "s-current",
    });
    await view.unmount();
  });

  it("rewrites entry-local asset image and link URLs and lists assets", () => {
    const html = render(
      entry({
        markdown:
          "![diagram](assets/diagram.png)\n\n[report](assets/report.pdf)",
        assets: [
          {
            path: "assets/diagram.png",
            mimeType: "image/png",
            kind: "source",
            exists: true,
            sizeBytes: 2048,
            isImage: true,
          },
          {
            path: "assets/report.pdf",
            kind: "source",
            exists: true,
            sizeBytes: 4096,
            isImage: false,
          },
        ],
      }),
    );
    // Explicit image embeds load bytes from the typed asset identity; ordinary
    // links open that same identity in the Knowledge viewer.
    expect(html).toContain(
      "/api/knowledge/asset?id=kb-sample&amp;path=assets%2Fdiagram.png",
    );
    expect(html).toContain(
      'href="/knowledge/kb-sample?asset=assets%2Freport.pdf"',
    );
    // Assets section is present.
    expect(html).toContain("Assets");
  });

  it("degrades gracefully for invalid frontmatter", () => {
    const html = render({
      kind: "invalid",
      path: "broken/index.md",
      folder: "broken",
      slug: "broken",
      error: "Invalid KB entry: missing frontmatter.",
      markdown: "no frontmatter here",
    });
    expect(html).toContain("could not be parsed");
    expect(html).toContain("Invalid KB entry: missing frontmatter.");
    expect(html).toContain("no frontmatter here");
  });
});
