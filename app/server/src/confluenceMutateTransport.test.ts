/**
 * The shared Confluence mutation core (Task-1463 P5a) over the REAL transport:
 * real `confluenceClient.ts` → `atlassianFetch` → `fetchWithRetry`, with only
 * the global `fetch` faked. These tests see what reaches the network: the
 * order of requests, `init.signal`, and how many requests are made.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ConfluenceAttachmentMutationDisplay,
  ConfluencePageMutationItemDisplay,
} from "@assistant/shared/confluenceMutation";
import { AtlassianHttpError } from "./atlassian/atlassianFetch.ts";
import type { ConfluenceConfig } from "./atlassian/confluenceClient.ts";
import type { FrozenUpload } from "./confluenceAttachmentChange.ts";
import {
  buildConfluenceMutationItems,
  type ConfluenceMutateItemParams,
  type ConfluenceMutationDeps,
} from "./confluenceMutate.ts";
import {
  applyConfluenceMutationItems,
  type ConfluenceApplyDeps,
} from "./confluenceMutateApply.ts";
import {
  ConfluenceMutationError,
  ConfluenceWriteHttpError,
} from "./confluenceMutationErrors.ts";
import { errorText } from "./errors.ts";
import { setRetrySleepForTests } from "./httpRetry.ts";

const config: ConfluenceConfig = {
  host: "example.atlassian.net",
  atlassianEmail: "a@b.c",
  atlassianToken: "t",
};
const originalFetch = globalThis.fetch;

type Seen = {
  method: string;
  /** `METHOD class`, the class naming what was asked for. */
  event: string;
  url: URL;
  signal: AbortSignal | undefined;
};

/** Every request and seam call, in order. */
let events: string[] = [];
let seen: Seen[] = [];
/** Answers a request before the default site does; `undefined` falls through. */
let override: (request: Seen) => Response | undefined = () => undefined;
let attachments: Array<Record<string, unknown>> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const PAGE_ADF = JSON.stringify({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
});

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    id: "att1",
    title: "diagram.png",
    pageId: "123",
    status: "current",
    mediaType: "image/png",
    fileSize: 4,
    version: { number: 2 },
    ...overrides,
  };
}

function classify(method: string, url: URL): string {
  const path = url.pathname.replace(/^\/ex\/confluence\/[^/]+/, "");
  if (/^\/wiki\/api\/v2\/pages\/\d+$/.test(path)) return `${method} page`;
  if (/^\/wiki\/api\/v2\/pages\/\d+\/attachments$/.test(path))
    return `${method} attachments by name ${url.searchParams.get("filename")}`;
  if (/^\/wiki\/api\/v2\/attachments\/[^/]+$/.test(path))
    return `${method} attachment`;
  if (/^\/wiki\/api\/v2\/spaces\/\d+$/.test(path)) return `${method} space`;
  if (path === "/wiki/api/v2/spaces") return `${method} spaces by key`;
  if (path.endsWith("/data")) return `${method} …/data`;
  if (path.endsWith("/child/attachment")) return `${method} …/child/attachment`;
  if (/\/label(\/[^/]+)?$/.test(path)) return `${method} label`;
  return `${method} ${path}`;
}

function site(request: Seen): Response {
  const { method, event, url } = request;
  if (event === "GET page") {
    const id = url.pathname.split("/").at(-1);
    return json({
      id,
      title: `Page ${id}`,
      status: "current",
      spaceId: "900",
      version: { number: 7 },
      body: { atlas_doc_format: { value: PAGE_ADF } },
      _links: { webui: `/spaces/ENG/pages/${id}` },
    });
  }
  if (event === "GET space")
    return json({ id: "900", key: "ENG", name: "Engineering" });
  if (event === "GET spaces by key")
    return json({ results: [{ id: "900", key: "ENG", name: "Engineering" }] });
  if (event.startsWith("GET attachments by name"))
    return json({
      results: attachments.filter(
        (row) => row["title"] === url.searchParams.get("filename"),
      ),
    });
  if (event === "GET attachment") {
    const id = url.pathname.split("/").at(-1);
    const found = attachments.find((row) => row["id"] === id);
    return found ? json(found) : json({ message: "Not found" }, 404);
  }
  if (event === "POST /wiki/api/v2/pages")
    return json({
      id: "456",
      title: "New page",
      version: { number: 1 },
      _links: { webui: "/spaces/ENG/pages/456/New+page" },
    });
  if (event === "POST /wiki/api/v2/footer-comments")
    return json({ id: "c1", _links: { webui: "/spaces/ENG/pages/123?c1" } });
  if (event === "POST …/data")
    return json({ id: "att1", version: { number: 3 } });
  if (event === "POST …/child/attachment")
    return json({ results: [{ id: "att9", version: { number: 1 } }] });
  if (method === "DELETE") return new Response(null, { status: 204 });
  if (method === "PUT" || event === "POST label") return json({});
  return json({ message: `unexpected ${event}` }, 500);
}

beforeEach(() => {
  events = [];
  seen = [];
  override = () => undefined;
  attachments = [attachment()];
  setRetrySleepForTests(async () => {});
  globalThis.fetch = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const request: Seen = {
      method,
      event: classify(method, url),
      url,
      signal: init?.signal ?? undefined,
    };
    seen.push(request);
    events.push(request.event);
    return override(request) ?? site(request);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRetrySleepForTests(null);
});

/** What fetch does when its signal aborts mid-request. */
const abortedFetch = () =>
  new DOMException("This operation was aborted", "AbortError");

const FROZEN: FrozenUpload = {
  name: "frozen.txt",
  mimeType: "text/plain",
  size: 3,
  sha256: "a".repeat(64),
  source: "/tmp/frozen.txt",
  stagedAttachmentId: "staged-1",
};

/** Prepare deps whose seams append to the event log. */
function prepareDeps(
  overrides: Partial<ConfluenceMutationDeps> = {},
): ConfluenceMutationDeps {
  return {
    freezeUpload: async () => {
      events.push("freeze");
      return FROZEN;
    },
    ...overrides,
  };
}

/** Apply deps whose seams append to the event log; `errors` records what describeError saw. */
function applyDeps(
  overrides: Partial<ConfluenceApplyDeps> = {},
): ConfluenceApplyDeps & { errors: unknown[] } {
  const errors: unknown[] = [];
  return {
    errors,
    describeError: (err) => {
      errors.push(err);
      return errorText(err);
    },
    stagedBytes: async () => {
      events.push("stagedBytes");
      return new TextEncoder().encode("abc");
    },
    ...overrides,
  };
}

const prepare = (
  items: ConfluenceMutateItemParams[],
  deps: ConfluenceMutationDeps = prepareDeps(),
) => buildConfluenceMutationItems(config, items, deps);

function editItem(
  overrides: Partial<ConfluencePageMutationItemDisplay> = {},
): ConfluencePageMutationItemDisplay {
  return {
    clientId: "cfl_0",
    operation: "edit",
    pageId: "123",
    pageUrl: "https://example.atlassian.net/wiki/spaces/ENG/pages/123",
    title: "Page 123",
    baseVersion: 7,
    body: "Added",
    placement: "append",
    ...overrides,
  };
}

function attachmentItem(
  operation: "uploadAttachment" | "deleteAttachment",
  attachment: ConfluenceAttachmentMutationDisplay,
): ConfluencePageMutationItemDisplay {
  return {
    clientId: "cfl_0",
    operation,
    pageId: "123",
    pageUrl: "https://example.atlassian.net/wiki/spaces/ENG/pages/123",
    title: "Page 123",
    attachment,
  };
}

const existingUpload = (): ConfluenceAttachmentMutationDisplay => ({
  fileName: "diagram.png",
  existingId: "att1",
  baseVersion: 2,
  mediaType: "image/png",
  size: 3,
  stagedAttachmentId: "staged-1",
  sha256: "a".repeat(64),
});

describe("prepare: seam-level staging traces (B2, old-source literals)", () => {
  // Literals from tools/confluence/confluenceAttachments.ts at a11d514:
  // by id :201-207, page GET :226-231, freeze :254, name lookup :255-257,
  // delete branch :233-252. The space read is prepare's, after staging.
  test("upload by attachmentId: attachment, page, freeze; no name lookup", async () => {
    const { items } = await prepare([
      {
        operation: "uploadAttachment",
        attachmentId: "att1",
        sourcePath: "/x",
      },
    ]);
    expect(events).toEqual([
      "GET attachment",
      "GET page",
      "freeze",
      "GET space",
    ]);
    expect(items[0]?.attachment).toEqual({
      fileName: "diagram.png",
      existingId: "att1",
      baseVersion: 2,
      mediaType: "text/plain",
      size: 3,
      source: "/tmp/frozen.txt",
      stagedAttachmentId: "staged-1",
      sha256: "a".repeat(64),
    });
  });

  test("upload by page and fileName: page, freeze, then the name lookup", async () => {
    await prepare([
      {
        operation: "uploadAttachment",
        page: "123",
        fileName: "named.txt",
        sourcePath: "/x",
      },
    ]);
    expect(events).toEqual([
      "GET page",
      "freeze",
      "GET attachments by name named.txt",
      "GET space",
    ]);
  });

  test("upload by page without fileName looks up the frozen name", async () => {
    const { items } = await prepare([
      { operation: "uploadAttachment", page: "123", sourceAttachmentId: "s" },
    ]);
    expect(events).toEqual([
      "GET page",
      "freeze",
      "GET attachments by name frozen.txt",
      "GET space",
    ]);
    expect(items[0]?.attachment?.fileName).toBe("frozen.txt");
  });

  test("upload whose page read fails: the page only, never frozen", async () => {
    override = ({ event }) =>
      event === "GET page" ? json({ message: "Not found" }, 404) : undefined;
    await expect(
      prepare([
        { operation: "uploadAttachment", page: "404", sourcePath: "/x" },
      ]),
    ).rejects.toBeInstanceOf(AtlassianHttpError);
    expect(events).toEqual(["GET page"]);
  });

  test("upload by an attachmentId on another page: the attachment only", async () => {
    attachments = [attachment({ id: "att5", pageId: "555" })];
    await expect(
      prepare([
        {
          operation: "uploadAttachment",
          attachmentId: "att5",
          page: "123",
          sourcePath: "/x",
        },
      ]),
    ).rejects.toThrow(
      new ConfluenceMutationError(
        "Attachment att5 belongs to page 555, not 123.",
      ),
    );
    expect(events).toEqual(["GET attachment"]);
  });

  test("deleteAttachment by id and by name never freezes", async () => {
    await prepare([{ operation: "deleteAttachment", attachmentId: "att1" }]);
    expect(events).toEqual(["GET attachment", "GET page", "GET space"]);
    events = [];
    await prepare([
      { operation: "deleteAttachment", page: "123", fileName: "diagram.png" },
    ]);
    expect(events).toEqual([
      "GET page",
      "GET attachments by name diagram.png",
      "GET space",
    ]);
  });

  test("without freezeUpload an upload is refused before any request (AC3)", async () => {
    const refusal = prepare(
      [{ operation: "uploadAttachment", page: "123", sourcePath: "/x" }],
      {},
    );
    await expect(refusal).rejects.toBeInstanceOf(ConfluenceMutationError);
    await expect(refusal).rejects.toThrow(
      "uploadAttachment is not available here.",
    );
    expect(events).toEqual([]);
  });
});

describe("prepare honours a signal (AC5c)", () => {
  test.each<[string, ConfluenceMutateItemParams]>([
    [
      "create with a parent",
      {
        operation: "create",
        spaceKey: "ENG",
        title: "T",
        body: "B",
        parentPage: "124",
      },
    ],
    ["edit", { operation: "edit", page: "123", body: "B" }],
    ["comment", { operation: "comment", page: "123", body: "B" }],
    ["delete", { operation: "delete", page: "123" }],
    [
      "deleteAttachment by id",
      { operation: "deleteAttachment", attachmentId: "att1" },
    ],
    [
      "deleteAttachment by name",
      { operation: "deleteAttachment", page: "123", fileName: "diagram.png" },
    ],
    [
      "uploadAttachment",
      { operation: "uploadAttachment", page: "123", sourcePath: "/x" },
    ],
  ])("%s: every read carries the signal", async (_name, item) => {
    const { signal } = new AbortController();
    await prepare([item], prepareDeps({ signal }));
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen)
      expect(request.signal, request.event).toBe(signal);
  });

  test("an abort during item 1's page read rejects with the reason and sends nothing more", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    override = () => {
      controller.abort(reason);
      throw reason;
    };
    await expect(
      prepare(
        [
          { operation: "edit", page: "123", body: "B" },
          { operation: "edit", page: "124", body: "B" },
        ],
        prepareDeps({ signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
    expect(events).toEqual(["GET page"]);
  });

  test("an abort during the space read rejects instead of continuing with no space", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    override = ({ event }) => {
      if (event !== "GET space") return undefined;
      controller.abort(reason);
      throw reason;
    };
    await expect(
      prepare(
        // One item, so nothing after it would notice the abort instead.
        [{ operation: "edit", page: "123", body: "B" }],
        prepareDeps({ signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
    expect(events).toEqual(["GET page", "GET space"]);
  });
});

describe("prepare honours a signal on the attachment path (AC5c)", () => {
  test("an abort during the space read after staging rejects", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    override = ({ event }) => {
      if (event !== "GET space") return undefined;
      controller.abort(reason);
      throw reason;
    };
    await expect(
      prepare(
        [{ operation: "deleteAttachment", attachmentId: "att1" }],
        prepareDeps({ signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
    expect(events).toEqual(["GET attachment", "GET page", "GET space"]);
  });
});

describe("apply: seam-level attachment traces (B2, old-source literals)", () => {
  // Literals from tools/confluence/confluenceAttachments.ts at a11d514:
  // stagedBytes :400, verify :401-404, name check :405-411, upload
  // :423-425; delete :392-398.
  test("upload onto an existing attachment: stagedBytes, verify, POST …/data", async () => {
    const item = attachmentItem("uploadAttachment", existingUpload());
    await applyConfluenceMutationItems(config, [item], applyDeps());
    expect(events).toEqual(["stagedBytes", "GET attachment", "POST …/data"]);
    expect(item.attachment).toMatchObject({
      resultId: "att1",
      resultVersion: 3,
    });
  });

  test("upload as a new file: stagedBytes, name check, POST …/child/attachment", async () => {
    const { existingId: _id, baseVersion: _v, ...fresh } = existingUpload();
    const item = attachmentItem("uploadAttachment", {
      ...fresh,
      fileName: "new.txt",
    });
    await applyConfluenceMutationItems(config, [item], applyDeps());
    expect(events).toEqual([
      "stagedBytes",
      "GET attachments by name new.txt",
      "POST …/child/attachment",
    ]);
  });

  test("upload whose staged bytes fail: stagedBytes only", async () => {
    const item = attachmentItem("uploadAttachment", existingUpload());
    await expect(
      applyConfluenceMutationItems(
        config,
        [item],
        applyDeps({
          stagedBytes: async () => {
            events.push("stagedBytes");
            throw new Error("The file proposed for diagram.png changed.");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ConfluenceMutationError);
    expect(events).toEqual(["stagedBytes"]);
    expect(item.error).toBe("The file proposed for diagram.png changed.");
  });

  test("upload whose attachment moved on: stagedBytes, verify; no POST", async () => {
    attachments = [attachment({ version: { number: 3 } })];
    const item = attachmentItem("uploadAttachment", existingUpload());
    await expect(
      applyConfluenceMutationItems(config, [item], applyDeps()),
    ).rejects.toBeInstanceOf(ConfluenceMutationError);
    expect(events).toEqual(["stagedBytes", "GET attachment"]);
    expect(item.error).toMatch(/version 2 → 3/);
  });

  test("deleteAttachment: verify, then one DELETE; never stagedBytes", async () => {
    const item = attachmentItem("deleteAttachment", {
      fileName: "diagram.png",
      existingId: "att1",
      baseVersion: 2,
    });
    await applyConfluenceMutationItems(config, [item], applyDeps());
    expect(events).toEqual(["GET attachment", "DELETE attachment"]);
  });

  test("without stagedBytes an upload item is refused and sends nothing (AC3)", async () => {
    const upload = attachmentItem("uploadAttachment", existingUpload());
    const comment: ConfluencePageMutationItemDisplay = {
      clientId: "cfl_1",
      operation: "comment",
      pageId: "123",
      body: "Hi",
    };
    const deps = applyDeps();
    delete deps.stagedBytes;
    const result = await applyConfluenceMutationItems(
      config,
      [upload, comment],
      deps,
    );
    expect(upload.error).toBe(
      "uploadAttachment is not available here; nothing was uploaded.",
    );
    expect(deps.errors[0]).toBeInstanceOf(ConfluenceMutationError);
    expect(events).toEqual(["POST /wiki/api/v2/footer-comments"]);
    expect(result.resultSummary).toBe(
      "Applied 1 Confluence change(s); 1 failed",
    );
  });
});

describe("apply: typed errors keep today's texts (AC4)", () => {
  const rejectWith = (target: string, status: number) => {
    override = ({ event }) =>
      event === target
        ? json({ errors: [{ title: `refused ${status}` }] }, status)
        : undefined;
  };
  const body = (status: number) =>
    JSON.stringify({ errors: [{ title: `refused ${status}` }] });

  test.each([400, 409])("a %i on the page PUT", async (status) => {
    rejectWith("PUT page", status);
    const item = editItem();
    const deps = applyDeps();
    await expect(
      applyConfluenceMutationItems(config, [item], deps),
    ).rejects.toBeInstanceOf(ConfluenceMutationError);
    expect(item.error).toBe(
      `Confluence API returned HTTP ${status} for PUT /wiki/api/v2/pages/123: ${body(status)}`,
    );
    expect(deps.errors).toHaveLength(1);
    expect(deps.errors[0]).toBeInstanceOf(ConfluenceWriteHttpError);
    expect(deps.errors[0]).toMatchObject({ status });
  });

  test("a 403 on the attachment DELETE", async () => {
    rejectWith("DELETE attachment", 403);
    const item = attachmentItem("deleteAttachment", {
      fileName: "diagram.png",
      existingId: "att1",
      baseVersion: 2,
    });
    const deps = applyDeps();
    await expect(
      applyConfluenceMutationItems(config, [item], deps),
    ).rejects.toBeInstanceOf(ConfluenceMutationError);
    expect(item.error).toBe(
      `Confluence API returned HTTP 403 for DELETE /wiki/api/v2/attachments/att1: ${body(403)}`,
    );
    expect(deps.errors[0]).toBeInstanceOf(ConfluenceWriteHttpError);
    expect(deps.errors[0]).toMatchObject({ status: 403 });
  });

  test("a 400 on a label POST is a warning on a succeeded item", async () => {
    rejectWith("POST label", 400);
    const item = editItem({ labelsAdded: ["x"] });
    const deps = applyDeps();
    const result = await applyConfluenceMutationItems(config, [item], deps);
    expect(item.error).toBeUndefined();
    expect(item.warning).toBe(
      `label changes failed: add x: Confluence API returned HTTP 400 for POST /wiki/rest/api/content/123/label: ${body(400)}`,
    );
    expect(deps.errors[0]).toBeInstanceOf(ConfluenceWriteHttpError);
    expect(deps.errors[0]).toMatchObject({ status: 400 });
    expect(result.resultSummary).toBe(
      "Applied 1 Confluence change(s); 1 warning(s)",
    );
  });

  test("a 404 on the verify GET stays a plain AtlassianHttpError", async () => {
    rejectWith("GET page", 404);
    const item = editItem();
    const deps = applyDeps();
    await expect(
      applyConfluenceMutationItems(config, [item], deps),
    ).rejects.toBeInstanceOf(ConfluenceMutationError);
    expect(deps.errors[0]).toBeInstanceOf(AtlassianHttpError);
    expect(deps.errors[0]).not.toBeInstanceOf(ConfluenceWriteHttpError);
    expect(deps.errors[0]).toMatchObject({ status: 404 });
    expect(events).toEqual(["GET page"]);
  });

  test("when every item fails, the summary error is the core's own type and text", async () => {
    rejectWith("PUT page", 400);
    const item = editItem();
    const failure = await applyConfluenceMutationItems(
      config,
      [item],
      applyDeps(),
    ).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ConfluenceMutationError);
    expect((failure as Error).message).toBe(
      `All 1 Confluence change(s) failed: ${item.error}`,
    );
  });
});

describe("apply honours a signal (AC5b)", () => {
  test("an abort during an edit's page PUT starts no label request and records nothing", async () => {
    const controller = new AbortController();
    const thrown = abortedFetch();
    override = ({ event }) => {
      if (event !== "PUT page") return undefined;
      controller.abort();
      throw thrown;
    };
    const item = editItem({ labelsAdded: ["a"], labelsRemoved: ["b"] });
    await expect(
      applyConfluenceMutationItems(
        config,
        [item],
        applyDeps({ signal: controller.signal }),
      ),
    ).rejects.toBe(thrown);
    expect(events).toEqual(["GET page", "PUT page"]);
    expect(item.error).toBeUndefined();
    expect(item.warning).toBeUndefined();
  });

  test("an abort during label 1 of 3 sends no further label and no warning", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    override = ({ event }) => {
      if (event !== "POST label") return undefined;
      controller.abort(reason);
      throw reason;
    };
    const item = editItem({ labelsAdded: ["a", "b"], labelsRemoved: ["c"] });
    await expect(
      applyConfluenceMutationItems(
        config,
        [item],
        applyDeps({ signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
    expect(events).toEqual(["GET page", "PUT page", "POST label"]);
    expect(item.warning).toBeUndefined();
    expect(item.error).toBeUndefined();
  });

  test("an abort during item 1's verify read sends nothing for items 2 and 3", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    override = () => {
      controller.abort(reason);
      throw reason;
    };
    const items = [
      editItem(),
      editItem({ clientId: "cfl_1", pageId: "124" }),
      editItem({ clientId: "cfl_2", pageId: "125" }),
    ];
    await expect(
      applyConfluenceMutationItems(
        config,
        items,
        applyDeps({ signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
    expect(events).toEqual(["GET page"]);
    for (const item of items) expect(item.error).toBeUndefined();
  });

  test("every request of a mixed batch carries the signal", async () => {
    const { signal } = new AbortController();
    const items: ConfluencePageMutationItemDisplay[] = [
      {
        clientId: "cfl_0",
        operation: "create",
        spaceKey: "ENG",
        title: "New page",
        body: "# Hi",
        labelsAdded: ["a"],
      },
      { clientId: "cfl_1", operation: "comment", pageId: "123", body: "Hi" },
      editItem({
        clientId: "cfl_2",
        newTitle: "Renamed",
        labelsRemoved: ["b"],
      }),
      (({ body: _body, placement: _placement, ...rename }) => rename)(
        editItem({ clientId: "cfl_3", newTitle: "Renamed" }),
      ),
      { ...editItem({ clientId: "cfl_4" }), operation: "delete" },
      attachmentItem("uploadAttachment", existingUpload()),
      attachmentItem("uploadAttachment", {
        fileName: "new.txt",
        stagedAttachmentId: "s",
        sha256: "a".repeat(64),
      }),
      attachmentItem("deleteAttachment", {
        fileName: "diagram.png",
        existingId: "att1",
        baseVersion: 2,
      }),
    ];
    const result = await applyConfluenceMutationItems(
      config,
      items,
      applyDeps({ signal }),
    );
    expect(result.succeeded).toBe(items.length);
    expect(new Set(seen.map((request) => request.event))).toEqual(
      new Set([
        "GET spaces by key",
        "POST /wiki/api/v2/pages",
        "POST label",
        "POST /wiki/api/v2/footer-comments",
        "GET page",
        "PUT page",
        "PUT /wiki/api/v2/pages/123/title",
        "DELETE label",
        "DELETE page",
        "GET attachment",
        "POST …/data",
        "GET attachments by name new.txt",
        "POST …/child/attachment",
        "DELETE attachment",
      ]),
    );
    for (const request of seen)
      expect(request.signal, request.event).toBe(signal);
  });

  test("an already aborted signal sends nothing and records nothing", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    const item = editItem();
    await expect(
      applyConfluenceMutationItems(
        config,
        [item],
        applyDeps({ signal: controller.signal }),
      ),
    ).rejects.toThrow("gone");
    expect(seen).toEqual([]);
    expect(item.error).toBeUndefined();
  });
});

describe("apply's stop seam (AC6)", () => {
  test("text before item 2 stops it and every later item; nothing is sent for them", async () => {
    let checks = 0;
    const items: ConfluencePageMutationItemDisplay[] = [
      {
        clientId: "cfl_0",
        operation: "comment",
        pageId: "123",
        body: "1",
      },
      {
        clientId: "cfl_1",
        operation: "comment",
        pageId: "124",
        body: "2",
      },
      {
        clientId: "cfl_2",
        operation: "comment",
        pageId: "125",
        body: "3",
      },
    ];
    const result = await applyConfluenceMutationItems(
      config,
      items,
      applyDeps({
        stopBefore: () =>
          checks++ === 1 ? "Not applied: out of time." : undefined,
      }),
    );
    expect(events).toEqual(["POST /wiki/api/v2/footer-comments"]);
    expect(seen[0]?.url.pathname).toBe("/wiki/api/v2/footer-comments");
    expect(items[0]).not.toHaveProperty("error");
    expect(items[1]?.error).toBe("Not applied: out of time.");
    expect(items[2]?.error).toBe("Not applied: out of time.");
    expect(result.resultSummary).toBe(
      "Applied 1 Confluence change(s); 2 failed",
    );
  });
});

describe("a bearer config (AC9)", () => {
  test("a create goes to api.atlassian.com and its page URL names the site", async () => {
    const bearer: ConfluenceConfig = {
      host: "example.atlassian.net",
      cloudId: "11111111-2222-3333-4444-555555555555",
      bearerToken: "b",
    };
    const item: ConfluencePageMutationItemDisplay = {
      clientId: "cfl_0",
      operation: "create",
      spaceKey: "ENG",
      title: "New page",
      body: "# Hi",
    };
    const result = await applyConfluenceMutationItems(
      bearer,
      [item],
      applyDeps(),
    );
    expect(seen.map((request) => request.url.origin)).toEqual([
      "https://api.atlassian.com",
      "https://api.atlassian.com",
    ]);
    expect(seen[1]?.url.pathname).toBe(
      "/ex/confluence/11111111-2222-3333-4444-555555555555/wiki/api/v2/pages",
    );
    expect(item.resultPageUrl).toBe(
      "https://example.atlassian.net/wiki/spaces/ENG/pages/456/New+page",
    );
    expect(result.resultUrl).toBe(item.resultPageUrl);
  });
});
