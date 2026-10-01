import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

// Stub the credential and HTTP seams so the tools run offline. importActual
// keeps the real normalizers, CQL builder and ADF splice under test.
vi.mock("../../confluenceSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../confluenceSettings.ts")>()),
  getConfluenceToolConfig: () => ({
    host: "example.atlassian.net",
    atlassianEmail: "a@b.c",
    atlassianToken: "t",
  }),
}));

/** ADF for a page carrying one paragraph and one macro Markdown cannot express. */
function pageAdf() {
  return JSON.stringify({
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: longPage ? "x".repeat(2_000) : "Existing body",
          },
        ],
      },
      { type: "extension", attrs: { extensionKey: "toc" } },
    ],
  });
}

/**
 * Stub the ONE HTTP seam rather than the client: `fetchPageWithBody` and the
 * normalizers call each other inside `confluenceClient.ts`, so mocking that
 * module's exports would leave the real functions running against the network.
 */
vi.mock("../../atlassian/atlassianFetch.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../atlassian/atlassianFetch.ts")>()),
  atlassianFetch: vi.fn(
    async (
      _config: unknown,
      _product: unknown,
      method: string,
      path: string,
      _body?: unknown,
      query?: Record<string, unknown>,
    ) => {
      if (method !== "GET") return writeResponse(path);
      if (path === "/wiki/rest/api/search")
        return {
          results: [
            {
              content: { id: "123", type: "page", title: "Runbook" },
              title: "@@@hl@@@Runbook@@@endhl@@@",
              excerpt: "deploy @@@hl@@@steps@@@endhl@@@",
              url: "/spaces/ENG/pages/123/Runbook",
              lastModified: "2026-01-02T03:04:05.000Z",
              resultGlobalContainer: { title: "Engineering" },
            },
          ],
          totalSize: 1,
        };
      if (path === "/wiki/api/v2/spaces")
        return { results: [{ id: "900", key: "ENG", name: "Engineering" }] };
      if (path === "/wiki/api/v2/spaces/900")
        return { id: "900", key: "ENG", name: "Engineering" };
      if (path.endsWith("/footer-comments"))
        return listing([comment("c1", "u1", "Top comment")]);
      if (path.includes("/footer-comments/") && path.endsWith("/children"))
        return listing([comment("c2", "u2", "A reply")]);
      if (path.endsWith("/labels")) return listing([{ name: "runbook" }]);
      if (path.endsWith("/children"))
        return listing([{ id: "124", title: "Child" }]);
      if (path === "/wiki/api/v2/attachments/att1") return attachmentResponse();
      if (path.endsWith("/attachments")) {
        const all = [attachmentResponse()];
        return listing(
          query?.["filename"]
            ? all.filter((row) => row.title === query["filename"])
            : all,
        );
      }
      if (/\/wiki\/api\/v2\/pages\/\d+$/.test(path)) return pageResponse(query);
      return { results: [] };
    },
  ),
  atlassianDownload: vi.fn(async () => ({
    bytes: new TextEncoder().encode("PNG!"),
    contentType: "image/png",
  })),
}));

/** The page's one attachment; `attachmentVersion` moves it like another uploader would. */
let attachmentVersion = 2;
function attachmentResponse() {
  return {
    id: "att1",
    title: "diagram.png",
    pageId: "123",
    mediaType: "image/png",
    fileSize: 4,
    version: { number: attachmentVersion },
    downloadLink: "/download/attachments/123/diagram.png?version=2&api=v2",
  };
}

/** The page every read resolves to; the flags let a test reshape it. */
let legacyPage = false;
let longPage = false;
let pageVersion: number | null = 7;
/** When set, every listing answers with a `_links.next` so paging is exercised. */
let moreResults = false;

function pageResponse(query?: Record<string, unknown>) {
  const base = {
    id: "123",
    title: legacyPage ? "Legacy" : "Runbook",
    status: "current",
    spaceId: "900",
    // A response can legitimately omit the version; nothing may be written
    // against one, which is what `pageVersion = null` exercises.
    ...(pageVersion === null
      ? {}
      : {
          version: {
            number: pageVersion,
            createdAt: "2026-01-02T03:04:05.000Z",
            authorId: "u1",
          },
        }),
    _links: { webui: "/spaces/ENG/pages/123/Runbook" },
  };
  if (!legacyPage)
    return {
      ...base,
      body: {
        atlas_doc_format: {
          value: pageAdf(),
          representation: "atlas_doc_format",
        },
      },
    };
  // A legacy page answers ADF with nothing and only fills the storage body.
  return {
    ...base,
    body:
      query?.["body-format"] === "storage"
        ? { storage: { value: "<p>old markup</p>", representation: "storage" } }
        : {},
  };
}

/** A v2 listing page, carrying a next link only when `moreResults` is set. */
function listing(results: unknown[]) {
  return {
    results,
    ...(moreResults
      ? { _links: { next: "/wiki/api/v2/pages/123/labels?cursor=CURSOR2" } }
      : {}),
  };
}

function comment(id: string, authorId: string, text: string) {
  return {
    id,
    version: { number: 1, authorId },
    body: {
      atlas_doc_format: {
        value: JSON.stringify({
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        }),
      },
    },
  };
}

function writeResponse(path: string) {
  if (path.endsWith("/child/attachment"))
    return { results: [{ id: "att9", version: { number: 1 } }] };
  if (path.endsWith("/data"))
    return { id: "att1", version: { number: attachmentVersion + 1 } };
  if (path === "/wiki/api/v2/pages")
    return {
      id: "456",
      title: "New page",
      version: { number: 1 },
      _links: { webui: "/spaces/ENG/pages/456/New+page" },
    };
  return {};
}

// Importing the tools also registers the "confluencePage" approval executor.
const {
  buildSearchCql,
  confluenceDownloadAttachmentTool,
  confluenceGetPageTool,
  confluenceLookupTool,
  confluenceMutatePageTool,
  confluenceSearchTool,
  normalizePageInput,
  spliceAdf,
} = await import("./confluenceTools.ts");
const {
  approvalsForSession,
  createApproval,
  resolveApproval,
  setApprovalBroadcastForTests,
} = await import("../../pendingApprovals.ts");
const { parseAdfBody } = await import("../../atlassian/confluenceClient.ts");
type AdfDocument = NonNullable<ReturnType<typeof parseAdfBody>>;
const { atlassianDownload, atlassianFetch } =
  await import("../../atlassian/atlassianFetch.ts");
const fetchMock = vi.mocked(atlassianFetch);
const downloadMock = vi.mocked(atlassianDownload);
const { resolveSessionAttachment, stageSessionAttachment } =
  await import("../../sessionAttachments.ts");
const { MAX_ATTACHMENT_BYTES } = await import("./confluenceAttachments.ts");

/** The query of the first GET whose path contains `fragment`. */
function queryFor(fragment: string) {
  const call = fetchMock.mock.calls.find(
    (entry) => entry[2] === "GET" && String(entry[3]).includes(fragment),
  );
  return call?.[5] as Record<string, unknown> | undefined;
}

/** Every write the stubbed transport saw, in order. */
function writes(method: "POST" | "PUT" | "DELETE") {
  return fetchMock.mock.calls
    .filter((call) => call[2] === method)
    .map((call) => ({ path: call[3] as string, body: call[4] }));
}

setApprovalBroadcastForTests(() => {});

/** The first comment of a get_page payload. */
function comments0(page: Record<string, unknown>) {
  return (page["comments"] as Array<Record<string, unknown>>)[0];
}

function parseText(result: ToolTextResult) {
  const block = result.content?.[0];
  return JSON.parse(
    block?.type === "text" ? (block.text ?? "{}") : "{}",
  ) as Record<string, unknown>;
}

type ToolTextResult = { content?: Array<{ type: string; text?: string }> };

function run(
  tool: { execute: (params: never, ctx: never) => Promise<ToolTextResult> },
  params: unknown,
): Promise<ToolTextResult> {
  return tool.execute(
    params as never,
    { session: { sessionId: "s" } } as never,
  );
}

let sessionCounter = 0;
async function stage(items: unknown[]): Promise<{
  sessionId: string;
  items: Array<Record<string, unknown>>;
}> {
  const sessionId = `cfl-${sessionCounter++}`;
  await confluenceMutatePageTool.execute(
    { items } as never,
    { session: { sessionId } } as never,
  );
  const card = approvalsForSession(sessionId).at(-1);
  if (!card || card.body.kind !== "confluencePage")
    throw new Error("no confluence approval staged");
  return {
    sessionId,
    items: card.body.items as unknown as Array<Record<string, unknown>>,
  };
}

describe("normalizePageInput", () => {
  test("accepts a bare id, both URL shapes, and rejects anything else", () => {
    expect(normalizePageInput("123")).toBe("123");
    expect(
      normalizePageInput(
        "https://x.atlassian.net/wiki/spaces/ENG/pages/456/Title",
      ),
    ).toBe("456");
    expect(
      normalizePageInput(
        "https://x.atlassian.net/wiki/pages/viewpage.action?pageId=789",
      ),
    ).toBe("789");
    expect(() => normalizePageInput("not a page")).toThrow(/page id/i);
    expect(() => normalizePageInput(undefined)).toThrow(/required/i);
  });
});

describe("buildSearchCql", () => {
  test("composes the named filters and orders by recency", () => {
    expect(
      buildSearchCql({
        text: "deploy",
        spaceKeys: ["ENG", "OPS"],
        label: "runbook",
        updatedSince: "2026-01-01",
      }),
    ).toBe(
      'type = "page" AND space in ("ENG", "OPS") AND label = "runbook" AND text ~ "deploy" AND lastmodified >= "2026-01-01" order by lastmodified desc',
    );
  });

  test("escapes quotes so a title cannot end the clause", () => {
    expect(buildSearchCql({ title: 'the "big" one' })).toContain(
      'title ~ "the \\"big\\" one"',
    );
  });

  test("raw cql wins and the filters are ignored", () => {
    expect(buildSearchCql({ cql: "id = 123", text: "ignored" })).toBe(
      "id = 123",
    );
  });

  test("refuses a query with no criterion, and a malformed date", () => {
    expect(() => buildSearchCql({})).toThrow(/at least one/i);
    expect(() =>
      buildSearchCql({ text: "x", updatedSince: "01/01/2026" }),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("confluence_search", () => {
  test("returns compact rows with absolute URLs and no highlight markers", async () => {
    const payload = parseText(
      await run(confluenceSearchTool, { text: "deploy" }),
    );
    expect(payload["resultCount"]).toBe(1);
    const rows = payload["results"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      id: "123",
      title: "Runbook",
      space: "Engineering",
      url: "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Runbook",
      excerpt: "deploy steps",
    });
    expect(JSON.stringify(rows)).not.toContain("@@@");
  });

  test("nextStart is null when the page was not full", async () => {
    const payload = parseText(
      await run(confluenceSearchTool, { text: "deploy", maxResults: 10 }),
    );
    expect(payload["nextStart"]).toBeNull();
  });
});

describe("confluence_get_page", () => {
  test("renders the body as Markdown and names what a rewrite would lose", async () => {
    const payload = parseText(
      await run(confluenceGetPageTool, { page: "123" }),
    );
    const page = payload["page"] as Record<string, unknown>;
    expect(page["markdown"]).toContain("Existing body");
    expect(page["markdown"]).toContain("[macro: toc]");
    expect(page["lossyNodes"]).toEqual(["extension"]);
    expect(page["version"]).toBe(7);
    expect(page["spaceKey"]).toBe("ENG");
    expect(page["bodySource"]).toBe("atlas_doc_format");
    expect(page["truncated"]).toBe(false);
  });

  test("maxChars truncates and says so", async () => {
    const whole = parseText(await run(confluenceGetPageTool, { page: "123" }));
    expect((whole["page"] as Record<string, unknown>)["truncated"]).toBe(false);
    longPage = true;
    try {
      // 1000 is the floor the tool clamps to, so a 2000-char page clips.
      const clipped = parseText(
        await run(confluenceGetPageTool, { page: "123", maxChars: 1000 }),
      );
      const page = clipped["page"] as Record<string, unknown>;
      expect(page["truncated"]).toBe(true);
      expect(page["charCount"]).toBe(1000);
      expect(String(page["markdown"])).toHaveLength(1001);
    } finally {
      longPage = false;
    }
  });

  test("comments carry their replies", async () => {
    const payload = parseText(
      await run(confluenceGetPageTool, { page: "123", includeComments: true }),
    );
    const page = payload["page"] as Record<string, unknown>;
    const comments = page["comments"] as Array<Record<string, unknown>>;
    expect(comments[0]?.["markdown"]).toBe("Top comment");
    const replies = comments[0]?.["replies"] as Array<Record<string, unknown>>;
    expect(replies[0]?.["markdown"]).toBe("A reply");
  });

  test("a section with more behind it reports a continuation cursor", async () => {
    moreResults = true;
    try {
      const payload = parseText(
        await run(confluenceGetPageTool, {
          page: "123",
          includeComments: true,
          includeLabels: true,
          includeChildren: true,
          includeAttachments: true,
        }),
      );
      const page = payload["page"] as Record<string, unknown>;
      expect(page["moreComments"]).toBe("CURSOR2");
      expect(comments0(page)?.["moreReplies"]).toBe("CURSOR2");
      expect(page["moreLabels"]).toBe("CURSOR2");
      expect(page["moreChildren"]).toBe("CURSOR2");
      expect(page["moreAttachments"]).toBe("CURSOR2");
    } finally {
      moreResults = false;
    }
  });

  test("a complete thread reports no reply continuation", async () => {
    const payload = parseText(
      await run(confluenceGetPageTool, { page: "123", includeComments: true }),
    );
    const page = payload["page"] as Record<string, unknown>;
    expect(comments0(page)?.["moreReplies"]).toBeNull();
  });

  test("a complete section reports no continuation", async () => {
    const payload = parseText(
      await run(confluenceGetPageTool, { page: "123", includeLabels: true }),
    );
    const page = payload["page"] as Record<string, unknown>;
    expect(page["labels"]).toEqual(["runbook"]);
    expect(page["moreLabels"]).toBeNull();
  });

  test("optional sections stay out unless asked for", async () => {
    const payload = parseText(
      await run(confluenceGetPageTool, { page: "123" }),
    );
    const page = payload["page"] as Record<string, unknown>;
    expect(page["comments"]).toBeUndefined();
    expect(page["labels"]).toBeUndefined();
    expect(page["attachments"]).toBeUndefined();
  });
});

describe("confluence_lookup", () => {
  test("kind=spaces normalizes rows", async () => {
    const payload = parseText(
      await run(confluenceLookupTool, { kind: "spaces" }),
    );
    expect(payload["kind"]).toBe("spaces");
    expect(
      (payload["spaces"] as Array<Record<string, unknown>>)[0],
    ).toMatchObject({
      key: "ENG",
      name: "Engineering",
    });
  });

  test("kind=pageTree needs a page or a space", async () => {
    await expect(
      run(confluenceLookupTool, { kind: "pageTree" }),
    ).rejects.toThrow(/page .*or spaceKey/i);
  });

  test("kind=comments and kind=replies continue from a cursor", async () => {
    // The cursor a get_page section reports must be accepted by a lookup kind,
    // or reporting it only names what the reader cannot reach.
    fetchMock.mockClear();
    const comments = parseText(
      await run(confluenceLookupTool, {
        kind: "comments",
        page: "123",
        cursor: "CURSOR2",
      }),
    );
    expect(comments["count"]).toBe(1);
    expect(
      (comments["comments"] as Array<Record<string, unknown>>)[0]?.["markdown"],
    ).toBe("Top comment");
    expect(queryFor("/footer-comments")?.["cursor"]).toBe("CURSOR2");

    fetchMock.mockClear();
    const replies = parseText(
      await run(confluenceLookupTool, {
        kind: "replies",
        commentId: "c1",
        cursor: "CURSOR2",
      }),
    );
    expect(
      (replies["replies"] as Array<Record<string, unknown>>)[0]?.["markdown"],
    ).toBe("A reply");
    expect(queryFor("/children")?.["cursor"]).toBe("CURSOR2");
  });

  test("kind=replies needs a comment id", async () => {
    await expect(
      run(confluenceLookupTool, { kind: "replies" }),
    ).rejects.toThrow(/commentId/);
  });

  test("kind=labels reads the page's labels", async () => {
    const payload = parseText(
      await run(confluenceLookupTool, { kind: "labels", page: "123" }),
    );
    expect(payload["labels"]).toEqual(["runbook"]);
  });
});

describe("spliceAdf", () => {
  const current: AdfDocument = {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: "old" }] }],
  };
  const addition: AdfDocument = {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: "new" }] }],
  };

  test("append keeps existing content first", () => {
    expect(spliceAdf(current, addition, "append").content).toEqual([
      current.content[0],
      addition.content[0],
    ]);
  });

  test("prepend puts the addition first", () => {
    expect(spliceAdf(current, addition, "prepend").content).toEqual([
      addition.content[0],
      current.content[0],
    ]);
  });
});

describe("parseAdfBody", () => {
  const body = (value: string) => ({
    body: { atlas_doc_format: { value } },
  });

  test("accepts a real document", () => {
    expect(
      parseAdfBody(body('{"type":"doc","version":1,"content":[]}')),
    ).toEqual({ type: "doc", version: 1, content: [] });
  });

  test("rejects JSON that parsed but is not a document", () => {
    // Each of these would otherwise reach spliceAdf with no blocks to splice
    // into, and an append would write the addition alone over the page.
    expect(parseAdfBody(body('"just text"'))).toBeNull();
    expect(parseAdfBody(body("{}"))).toBeNull();
    expect(parseAdfBody(body("[]"))).toBeNull();
    expect(parseAdfBody(body("123"))).toBeNull();
    expect(parseAdfBody(body('{"type":"doc"}'))).toBeNull();
    expect(parseAdfBody(body('{"type":"paragraph","content":[]}'))).toBeNull();
    expect(parseAdfBody(body("not json at all"))).toBeNull();
    expect(parseAdfBody(body("  "))).toBeNull();
    expect(parseAdfBody({})).toBeNull();
  });
});

describe("confluence_mutate_page staging", () => {
  test("an edit records the base version, the current body and the lossy nodes", async () => {
    const { items } = await stage([
      { operation: "edit", page: "123", body: "## Added", placement: "append" },
    ]);
    expect(items[0]).toMatchObject({
      operation: "edit",
      pageId: "123",
      placement: "append",
      baseVersion: 7,
      lossyNodes: ["extension"],
      spaceKey: "ENG",
    });
    expect(items[0]?.["currentBody"]).toContain("Existing body");
  });

  test("a create resolves the space and keeps the Markdown body", async () => {
    const { items } = await stage([
      {
        operation: "create",
        spaceKey: "ENG",
        title: "New page",
        body: "# Hello",
      },
    ]);
    expect(items[0]).toMatchObject({
      operation: "create",
      spaceKey: "ENG",
      spaceName: "Engineering",
      title: "New page",
      body: "# Hello",
    });
  });

  test("a page with no reported version cannot be proposed against", async () => {
    pageVersion = null;
    try {
      await expect(
        stage([{ operation: "edit", page: "123", body: "Added" }]),
      ).rejects.toThrow(/no version/i);
      await expect(
        stage([{ operation: "delete", page: "123" }]),
      ).rejects.toThrow(/no version/i);
    } finally {
      pageVersion = 7;
    }
  });

  test("incomplete proposals fail at staging rather than at approval", async () => {
    await expect(
      stage([{ operation: "create", title: "x", body: "y" }]),
    ).rejects.toThrow(/spaceKey/);
    await expect(
      stage([{ operation: "create", spaceKey: "ENG", body: "y" }]),
    ).rejects.toThrow(/title/);
    await expect(stage([{ operation: "edit", page: "123" }])).rejects.toThrow(
      /body, a newTitle, or a label change/,
    );
    await expect(
      stage([{ operation: "comment", page: "123" }]),
    ).rejects.toThrow(/body/);
    await expect(stage([])).rejects.toThrow(/at least one/i);
    await expect(
      stage(
        Array.from({ length: 11 }, () => ({
          operation: "comment",
          page: "123",
          body: "x",
        })),
      ),
    ).rejects.toThrow(/At most 10/);
  });

  test("nothing is written while the approval is pending", async () => {
    fetchMock.mockClear();
    await stage([{ operation: "edit", page: "123", body: "## Added" }]);
    expect(writes("POST")).toEqual([]);
    expect(writes("PUT")).toEqual([]);
  });
});

describe("confluence_mutate_page execution", () => {
  test("an approved append splices ADF and keeps the page's macro", async () => {
    const { sessionId } = await stage([
      {
        operation: "edit",
        page: "123",
        body: "Added line",
        placement: "append",
      },
    ]);
    fetchMock.mockClear();
    await resolveApproval(
      approvalsForSession(sessionId).at(-1)!.id,
      "approved",
    );
    const puts = writes("PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toBe("/wiki/api/v2/pages/123");
    const payload = puts[0]?.body as {
      version: { number: number };
      body: { representation: string; value: string };
    };
    expect(payload.version.number).toBe(8);
    expect(payload.body.representation).toBe("atlas_doc_format");
    // The body travels as a JSON STRING, and still contains the macro node.
    expect(typeof payload.body.value).toBe("string");
    const body = JSON.parse(payload.body.value) as {
      content: Array<{ type: string }>;
    };
    expect(body.content.map((node) => node.type)).toEqual([
      "paragraph",
      "extension",
      "paragraph",
    ]);
  });

  test("a replace sends only the new content", async () => {
    const { sessionId } = await stage([
      {
        operation: "edit",
        page: "123",
        body: "Only this",
        placement: "replace",
      },
    ]);
    fetchMock.mockClear();
    await resolveApproval(
      approvalsForSession(sessionId).at(-1)!.id,
      "approved",
    );
    const payload = writes("PUT")[0]?.body as { body: { value: string } };
    const body = JSON.parse(payload.body.value) as {
      content: Array<{ type: string }>;
    };
    expect(body.content.map((node) => node.type)).toEqual(["paragraph"]);
  });

  test("a create posts the ADF body and records the new page", async () => {
    const { sessionId } = await stage([
      {
        operation: "create",
        spaceKey: "ENG",
        title: "New page",
        body: "# Hello",
      },
    ]);
    fetchMock.mockClear();
    await resolveApproval(
      approvalsForSession(sessionId).at(-1)!.id,
      "approved",
    );
    const posts = writes("POST");
    expect(posts[0]?.path).toBe("/wiki/api/v2/pages");
    expect(posts[0]?.body).toMatchObject({ spaceId: "900", title: "New page" });
    const updated = approvalsForSession(sessionId).at(-1)!;
    if (updated.body.kind !== "confluencePage") throw new Error("wrong body");
    expect(updated.body.items[0]).toMatchObject({
      resultPageId: "456",
      resultPageUrl:
        "https://example.atlassian.net/wiki/spaces/ENG/pages/456/New+page",
    });
  });

  test("an append refuses a body that became unreadable after staging", async () => {
    const { sessionId } = await stage([
      {
        operation: "edit",
        page: "123",
        body: "Added line",
        placement: "append",
      },
    ]);
    // The page turns into legacy storage between staging and approval: there
    // is nothing to splice into, and writing the addition alone would wipe it.
    legacyPage = true;
    fetchMock.mockClear();
    try {
      const resolved = await resolveApproval(
        approvalsForSession(sessionId).at(-1)!.id,
        "approved",
      );
      expect(resolved?.card.status).toBe("failed");
      expect(resolved?.card.error).toMatch(/no readable body/i);
      expect(writes("PUT")).toEqual([]);
    } finally {
      legacyPage = false;
    }
  });

  test("a delete verifies the version too, and refuses a changed page", async () => {
    const { sessionId } = await stage([{ operation: "delete", page: "123" }]);
    pageVersion = 9;
    fetchMock.mockClear();
    try {
      const resolved = await resolveApproval(
        approvalsForSession(sessionId).at(-1)!.id,
        "approved",
      );
      expect(resolved?.card.status).toBe("failed");
      expect(resolved?.card.error).toMatch(/changed since this proposal/i);
      expect(writes("DELETE")).toEqual([]);
    } finally {
      pageVersion = 7;
    }
  });

  test("an approval carrying no base version is refused, not applied", async () => {
    // A card persisted before the staging guard existed: it reaches the
    // executor with nothing to compare, and must refuse rather than write.
    const card = createApproval({
      sessionId: "cfl-legacy",
      kind: "confluencePage",
      title: "Edit Runbook",
      body: {
        kind: "confluencePage",
        confluenceHost: "example.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "edit",
            pageId: "123",
            body: "Added line",
            placement: "append",
          },
        ],
      },
    });
    fetchMock.mockClear();
    const resolved = await resolveApproval(card.id, "approved");
    expect(resolved?.card.status).toBe("failed");
    expect(resolved?.card.error).toMatch(/no base version/i);
    expect(writes("PUT")).toEqual([]);
  });

  test("a comment posts a footer comment, not a page edit", async () => {
    const { sessionId } = await stage([
      { operation: "comment", page: "123", body: "Looks right" },
    ]);
    fetchMock.mockClear();
    await resolveApproval(
      approvalsForSession(sessionId).at(-1)!.id,
      "approved",
    );
    expect(writes("POST")[0]?.path).toBe("/wiki/api/v2/footer-comments");
    expect(writes("POST")[0]?.body).toMatchObject({ pageId: "123" });
    expect(writes("PUT")).toEqual([]);
  });

  test("a delete calls the page endpoint once", async () => {
    const { sessionId } = await stage([{ operation: "delete", page: "123" }]);
    fetchMock.mockClear();
    await resolveApproval(
      approvalsForSession(sessionId).at(-1)!.id,
      "approved",
    );
    expect(writes("DELETE")).toEqual([
      { path: "/wiki/api/v2/pages/123", body: undefined },
    ]);
  });

  test("an edit refuses to overwrite a page that changed since staging", async () => {
    const { sessionId } = await stage([
      { operation: "edit", page: "123", body: "Added line" },
    ]);
    const card = approvalsForSession(sessionId).at(-1)!;
    // Someone else saved the page between the proposal and the approval.
    pageVersion = 9;
    fetchMock.mockClear();
    try {
      // resolveApproval records the failure on the card rather than throwing.
      const resolved = await resolveApproval(card.id, "approved");
      expect(resolved?.card.status).toBe("failed");
      expect(resolved?.card.error).toMatch(/changed since this proposal/i);
      expect(writes("PUT")).toEqual([]);
    } finally {
      pageVersion = 7;
    }
  });

  test("a rejected proposal writes nothing", async () => {
    const { sessionId } = await stage([
      { operation: "edit", page: "123", body: "Added line" },
    ]);
    fetchMock.mockClear();
    await resolveApproval(
      approvalsForSession(sessionId).at(-1)!.id,
      "rejected",
    );
    expect(writes("PUT")).toEqual([]);
    expect(writes("POST")).toEqual([]);
  });
});

describe("legacy storage pages", () => {
  test("an append is refused rather than silently rewriting the page", async () => {
    legacyPage = true;
    try {
      await expect(
        stage([
          {
            operation: "edit",
            page: "123",
            body: "Added",
            placement: "append",
          },
        ]),
      ).rejects.toThrow(/legacy storage format/i);
      // The same page can still be rewritten wholesale once the user agrees.
      const { items } = await stage([
        { operation: "edit", page: "123", body: "Added", placement: "replace" },
      ]);
      expect(items[0]).toMatchObject({ placement: "replace" });
      expect(items[0]?.["currentBody"]).toContain("old markup");
    } finally {
      legacyPage = false;
    }
  });

  test("a read falls back to the storage body", async () => {
    legacyPage = true;
    try {
      const payload = parseText(
        await run(confluenceGetPageTool, { page: "123" }),
      );
      const page = payload["page"] as Record<string, unknown>;
      expect(page["bodySource"]).toBe("storage");
      expect(page["markdown"]).toContain("old markup");
    } finally {
      legacyPage = false;
    }
  });
});

describe("confluence_download_attachment", () => {
  test("stages the file as a session attachment, never inline", async () => {
    downloadMock.mockClear();
    const result = parseText(
      await run(confluenceDownloadAttachmentTool, { attachmentId: "att1" }),
    );
    // The v2 link is relative to /wiki; the transport gets it site-relative.
    expect(downloadMock.mock.calls[0]?.[2]).toBe(
      "/wiki/download/attachments/123/diagram.png?version=2&api=v2",
    );
    const staged = result["sessionAttachment"] as Record<string, unknown>;
    expect(staged).toMatchObject({
      name: "diagram.png",
      mimeType: "image/png",
      size: 4,
    });
    const record = resolveSessionAttachment("s", String(staged["id"]));
    expect(record?.source).toBe("confluence");
    expect(record?.path).toBe(staged["path"]);
    expect(JSON.stringify(result)).not.toContain("PNG!");
  });

  test("resolves a page and file name, and names a missing one", async () => {
    const result = parseText(
      await run(confluenceDownloadAttachmentTool, {
        page: "123",
        fileName: "diagram.png",
      }),
    );
    expect(result["attachment"]).toMatchObject({ id: "att1", version: 2 });
    await expect(
      run(confluenceDownloadAttachmentTool, {
        page: "123",
        fileName: "other.png",
      }),
    ).rejects.toThrow(/no attachment named "other.png"/);
  });

  test("a file over maxBytes is refused before it is fetched", async () => {
    downloadMock.mockClear();
    await expect(
      run(confluenceDownloadAttachmentTool, {
        attachmentId: "att1",
        maxBytes: 2,
      }),
    ).rejects.toThrow(/above the 2-byte limit/);
    expect(downloadMock).not.toHaveBeenCalled();
  });
});

describe("confluence_mutate_page attachments", () => {
  function hostFile(name: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "cfl-upload-"));
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  /** The multipart file part of the one upload the transport saw. */
  async function uploadedFile() {
    const [upload] = writes("POST");
    const file = (upload!.body as FormData).get("file") as File;
    return { path: upload?.path, name: file.name, text: await file.text() };
  }

  test("a new file freezes its bytes at staging and writes nothing yet", async () => {
    fetchMock.mockClear();
    const { items } = await stage([
      {
        operation: "uploadAttachment",
        page: "123",
        sourcePath: hostFile("notes.txt", "v1"),
      },
    ]);
    const attachment = items[0]?.["attachment"] as Record<string, unknown>;
    expect(attachment).toMatchObject({ fileName: "notes.txt", size: 2 });
    expect(attachment["existingId"]).toBeUndefined();
    expect(attachment["sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(writes("POST")).toEqual([]);
  });

  test("an approved upload sends the bytes that were proposed, not later edits", async () => {
    const path = hostFile("notes.txt", "proposed");
    const { sessionId } = await stage([
      {
        operation: "uploadAttachment",
        page: "123",
        sourcePath: path,
        versionMessage: "first cut",
      },
    ]);
    writeFileSync(path, "edited after the proposal");
    fetchMock.mockClear();
    const resolved = await resolveApproval(
      approvalsForSession(sessionId).at(-1)!.id,
      "approved",
    );
    expect(await uploadedFile()).toEqual({
      path: "/wiki/rest/api/content/123/child/attachment",
      name: "notes.txt",
      text: "proposed",
    });
    const form = writes("POST")[0]?.body as FormData;
    expect(form.get("comment")).toBe("first cut");
    expect(form.get("minorEdit")).toBe("true");
    const item = (resolved!.card.body as { items: Array<Record<string, any>> })
      .items[0];
    expect(item?.["attachment"]).toMatchObject({
      resultId: "att9",
      resultVersion: 1,
    });
  });

  test("a staged copy that changed is refused rather than uploaded", async () => {
    const { sessionId, items } = await stage([
      {
        operation: "uploadAttachment",
        page: "123",
        sourcePath: hostFile("notes.txt", "proposed"),
      },
    ]);
    const stagedId = (items[0]!["attachment"] as Record<string, string>)[
      "stagedAttachmentId"
    ]!;
    writeFileSync(
      resolveSessionAttachment(sessionId, stagedId)!.path,
      "tampered",
    );
    fetchMock.mockClear();
    const resolved = await resolveApproval(
      approvalsForSession(sessionId).at(-1)!.id,
      "approved",
    );
    expect(resolved?.card.status).toBe("failed");
    expect(resolved?.card.error).toMatch(/changed after it was approved/);
    expect(writes("POST")).toEqual([]);
  });

  test("an existing file name becomes a new version of that attachment", async () => {
    const sessionId = `cfl-${sessionCounter++}`;
    const source = stageSessionAttachment(sessionId, {
      name: "diagram-v3.png",
      mimeType: "image/png",
      bytes: new TextEncoder().encode("new png"),
      source: "upload",
    });
    await confluenceMutatePageTool.execute(
      {
        items: [
          {
            operation: "uploadAttachment",
            page: "123",
            fileName: "diagram.png",
            sourceAttachmentId: source.id,
          },
        ],
      } as never,
      { session: { sessionId } } as never,
    );
    const card = approvalsForSession(sessionId).at(-1)!;
    const item = (card.body as { items: Array<Record<string, any>> }).items[0];
    expect(item?.["attachment"]).toMatchObject({
      fileName: "diagram.png",
      existingId: "att1",
      baseVersion: 2,
    });
    fetchMock.mockClear();
    await resolveApproval(card.id, "approved");
    expect(await uploadedFile()).toEqual({
      path: "/wiki/rest/api/content/123/child/attachment/att1/data",
      name: "diagram.png",
      text: "new png",
    });
  });

  test("a new version refuses when someone uploaded one meanwhile", async () => {
    const { sessionId } = await stage([
      {
        operation: "uploadAttachment",
        attachmentId: "att1",
        sourcePath: hostFile("diagram.png", "mine"),
      },
    ]);
    attachmentVersion = 3;
    fetchMock.mockClear();
    try {
      const resolved = await resolveApproval(
        approvalsForSession(sessionId).at(-1)!.id,
        "approved",
      );
      expect(resolved?.card.status).toBe("failed");
      expect(resolved?.card.error).toMatch(/version 2 → 3/);
      expect(writes("POST")).toEqual([]);
    } finally {
      attachmentVersion = 2;
    }
  });

  test("a delete verifies the version and trashes the attachment", async () => {
    const { sessionId, items } = await stage([
      { operation: "deleteAttachment", page: "123", fileName: "diagram.png" },
    ]);
    expect(items[0]).toMatchObject({ pageId: "123", title: "Runbook" });
    fetchMock.mockClear();
    await resolveApproval(
      approvalsForSession(sessionId).at(-1)!.id,
      "approved",
    );
    expect(writes("DELETE")).toEqual([
      { path: "/wiki/api/v2/attachments/att1", body: undefined },
    ]);
  });

  test("the size cap applies to bytes read, not to a stale recorded size", async () => {
    const sessionId = `cfl-${sessionCounter++}`;
    const source = stageSessionAttachment(sessionId, {
      name: "grown.bin",
      mimeType: "application/octet-stream",
      bytes: new TextEncoder().encode("small"),
      source: "upload",
    });
    // The index still says 5 bytes; the file on disk is past the cap (sparse).
    truncateSync(source.path, MAX_ATTACHMENT_BYTES + 1);
    await expect(
      confluenceMutatePageTool.execute(
        {
          items: [
            {
              operation: "uploadAttachment",
              page: "123",
              sourceAttachmentId: source.id,
            },
          ],
        } as never,
        { session: { sessionId } } as never,
      ),
    ).rejects.toThrow(/larger than/);
    const hostPath = hostFile("big.bin", "");
    truncateSync(hostPath, MAX_ATTACHMENT_BYTES + 1);
    await expect(
      stage([
        { operation: "uploadAttachment", page: "123", sourcePath: hostPath },
      ]),
    ).rejects.toThrow(/larger than/);
  });

  test("incomplete attachment proposals fail at staging", async () => {
    await expect(
      stage([{ operation: "uploadAttachment", page: "123" }]),
    ).rejects.toThrow(/exactly one of sourceAttachmentId or sourcePath/);
    await expect(
      stage([
        {
          operation: "uploadAttachment",
          page: "123",
          sourcePath: "relative/notes.txt",
        },
      ]),
    ).rejects.toThrow(/absolute path/);
    await expect(
      stage([{ operation: "deleteAttachment", page: "123" }]),
    ).rejects.toThrow(/attachmentId or a fileName/);
    await expect(
      stage([
        { operation: "deleteAttachment", page: "123", fileName: "nope.png" },
      ]),
    ).rejects.toThrow(/no attachment named "nope.png"/);
    await expect(
      stage([
        {
          operation: "deleteAttachment",
          attachmentId: "att1",
          page: "999",
        },
      ]),
    ).rejects.toThrow(/belongs to page 123/);
    await expect(
      stage([
        {
          operation: "deleteAttachment",
          attachmentId: "att1",
          fileName: "other.png",
        },
      ]),
    ).rejects.toThrow(/named "diagram.png", not "other.png"/);
    await expect(
      stage([
        {
          operation: "deleteAttachment",
          attachmentId: "att1",
          addLabels: ["x"],
        },
      ]),
    ).rejects.toThrow(/does not change labels/);
  });
});
