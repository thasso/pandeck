/**
 * The trash-only delete guard of the shared Confluence mutation core
 * (Task-1463 P5a, B1 and AC7) over the REAL transport: real
 * `confluenceClient.ts` → `atlassianFetch` → `fetchWithRetry`, with only the
 * global `fetch` faked, so every assertion counts what reaches the network.
 *
 * A `delete` or `deleteAttachment` goes ahead only when its verification read
 * reports `status` exactly `"current"`, checked at prepare and again at apply.
 * That is proof from the read, not a conditional DELETE; these tests do not
 * cover a change made elsewhere between the read and the DELETE.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ConfluenceAttachmentMutationDisplay,
  ConfluencePageMutationItemDisplay,
} from "@assistant/shared/confluenceMutation";
import { AtlassianHttpError } from "./atlassian/atlassianFetch.ts";
import type { ConfluenceConfig } from "./atlassian/confluenceClient.ts";
import {
  buildConfluenceMutationItems,
  type ConfluenceMutateItemParams,
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

/** A status the fake site leaves out of its answer entirely. */
const OMITTED = Symbol("omitted");
type Status = unknown;

type Seen = { method: string; url: URL };
let seen: Seen[] = [];
let pageStatus: Status = "current";
let pageVersion = 7;
let pageGone = false;
let attachments: Array<Record<string, unknown>> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const withStatus = (status: Status) => (status === OMITTED ? {} : { status });

function attachment(status: Status = "current", version = 2) {
  return {
    id: "att1",
    title: "diagram.png",
    pageId: "123",
    ...withStatus(status),
    mediaType: "image/png",
    fileSize: 4,
    version: { number: version },
  };
}

const ADF = JSON.stringify({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
});

function site({ method, url }: Seen): Response {
  const path = url.pathname;
  if (method === "GET" && /^\/wiki\/api\/v2\/pages\/\d+$/.test(path)) {
    if (pageGone) return json({ message: "Not found" }, 404);
    return json({
      id: path.split("/").at(-1),
      title: "Runbook",
      ...withStatus(pageStatus),
      spaceId: "900",
      version: { number: pageVersion },
      body: { atlas_doc_format: { value: ADF } },
      _links: { webui: "/spaces/ENG/pages/123/Runbook" },
    });
  }
  if (method === "GET" && /^\/wiki\/api\/v2\/spaces\/\d+$/.test(path))
    return json({ id: "900", key: "ENG", name: "Engineering" });
  if (method === "GET" && path.endsWith("/attachments"))
    return json({
      results: attachments.filter(
        (row) => row["title"] === url.searchParams.get("filename"),
      ),
    });
  if (method === "GET" && path.startsWith("/wiki/api/v2/attachments/")) {
    const found = attachments.find(
      (row) => row["id"] === path.split("/").at(-1),
    );
    return found ? json(found) : json({ message: "Not found" }, 404);
  }
  if (method === "POST" && path.endsWith("/data"))
    return json({ id: "att1", version: { number: 3 } });
  if (method === "DELETE") return new Response(null, { status: 204 });
  if (method === "PUT" || (method === "POST" && path.endsWith("/label")))
    return json({});
  return json({ message: `unexpected ${method} ${path}` }, 500);
}

beforeEach(() => {
  seen = [];
  pageStatus = "current";
  pageVersion = 7;
  pageGone = false;
  attachments = [attachment()];
  setRetrySleepForTests(async () => {});
  globalThis.fetch = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const request = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
    };
    // A server reads a streamed upload whole before it answers; the
    // upload completes only then (Task-1441 P8a).
    if (init?.body instanceof ReadableStream)
      await new Response(init.body).arrayBuffer();
    seen.push(request);
    return site(request);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRetrySleepForTests(null);
});

const deletes = () => seen.filter((request) => request.method === "DELETE");
/** The request log as `METHOD path?query`, for comparing whole runs. */
const trace = () =>
  seen.map(({ method, url }) => `${method} ${url.pathname}${url.search}`);

/** The SHA-256 of the staged bytes `abc`: the body checks it as it streams. */
const ABC_SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const prepare = (items: ConfluenceMutateItemParams[]) =>
  buildConfluenceMutationItems(config, items, {
    freezeUpload: async () => ({
      name: "diagram.png",
      mimeType: "image/png",
      size: 3,
      sha256: ABC_SHA256,
      source: "/tmp/diagram.png",
      stagedAttachmentId: "staged-1",
    }),
  });

function applyDeps(): ConfluenceApplyDeps & { errors: unknown[] } {
  const errors: unknown[] = [];
  return {
    errors,
    describeError: (err) => {
      errors.push(err);
      return errorText(err);
    },
    stagedBytes: async () => new TextEncoder().encode("abc"),
  };
}

const pageDeleteItem = (): ConfluencePageMutationItemDisplay => ({
  clientId: "cfl_0",
  operation: "delete",
  pageId: "123",
  pageUrl: "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Runbook",
  title: "Runbook",
  baseVersion: 7,
});

const attachmentDeleteItem = (): ConfluencePageMutationItemDisplay => ({
  clientId: "cfl_0",
  operation: "deleteAttachment",
  pageId: "123",
  pageUrl: "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Runbook",
  title: "Runbook",
  attachment: {
    fileName: "diagram.png",
    existingId: "att1",
    baseVersion: 2,
    mediaType: "image/png",
    size: 4,
  } satisfies ConfluenceAttachmentMutationDisplay,
});

/** Runs prepare and returns what it threw. */
async function prepareError(items: ConfluenceMutateItemParams[]) {
  return prepare(items).then(
    () => expect.unreachable("prepare should have refused"),
    (err: unknown) => err,
  );
}

/** Applies items that should all fail; returns the deps that saw the errors. */
async function applyFailing(items: ConfluencePageMutationItemDisplay[]) {
  const deps = applyDeps();
  await expect(
    applyConfluenceMutationItems(config, items, deps),
  ).rejects.toBeInstanceOf(ConfluenceMutationError);
  return deps;
}

/** Every refused status, and how the refusal shows it. */
const REFUSED: Array<[label: string, status: Status, shown: string]> = [
  ["omitted", OMITTED, "unknown"],
  ["null", null, "unknown"],
  ["42", 42, "unknown"],
  ['""', "", "unknown"],
  ['"Current"', "Current", "unknown"],
  ['"trashed"', "trashed", "trashed"],
  ['"<script>"', "<script>", "unknown"],
];

const pageRefusal = (shown: string) =>
  `Page 123 is not confirmed current (status ${shown}); nothing was deleted.`;
const attachmentRefusal = (shown: string) =>
  `diagram.png is not confirmed current (status ${shown}); nothing was deleted.`;

describe("B1: delete, prepare (the page read)", () => {
  test.each(REFUSED)("status %s refuses", async (_label, status, shown) => {
    pageStatus = status;
    const err = await prepareError([{ operation: "delete", page: "123" }]);
    expect(err).toBeInstanceOf(ConfluenceMutationError);
    expect((err as Error).message).toBe(pageRefusal(shown));
    expect(deletes()).toEqual([]);
  });

  test('status "current" is proposed; the approved apply sends exactly one DELETE', async () => {
    const { items, warnings } = await prepare([
      { operation: "delete", page: "123" },
    ]);
    expect(items).toMatchObject([
      { operation: "delete", pageId: "123", baseVersion: 7 },
    ]);
    expect(warnings).toEqual([
      "Runbook would be moved to the trash, along with its comments",
    ]);
    expect(deletes()).toEqual([]);
    await applyConfluenceMutationItems(config, items, applyDeps());
    expect(deletes().map(({ url }) => url.pathname)).toEqual([
      "/wiki/api/v2/pages/123",
    ]);
  });
});

describe("B1: delete, apply (readVerifiedPage)", () => {
  test.each(REFUSED)("status %s refuses", async (_label, status, shown) => {
    pageStatus = status;
    const items = [pageDeleteItem()];
    const deps = await applyFailing(items);
    expect(items[0]?.error).toBe(pageRefusal(shown));
    expect(deps.errors[0]).toBeInstanceOf(ConfluenceMutationError);
    expect(trace()).toEqual([
      "GET /wiki/api/v2/pages/123?body-format=atlas_doc_format",
    ]);
  });

  test("the version is checked first", async () => {
    pageStatus = "trashed";
    pageVersion = 8;
    const items = [pageDeleteItem()];
    await applyFailing(items);
    expect(items[0]?.error).toMatch(/changed since this proposal.*7 → 8/);
    expect(deletes()).toEqual([]);
  });

  test('status "current" sends exactly one DELETE', async () => {
    const items = [pageDeleteItem()];
    await applyConfluenceMutationItems(config, items, applyDeps());
    expect(items[0]?.error).toBeUndefined();
    expect(deletes().map(({ url }) => url.pathname)).toEqual([
      "/wiki/api/v2/pages/123",
    ]);
  });
});

describe("B1: deleteAttachment, prepare (the attachment record)", () => {
  const byId = { operation: "deleteAttachment", attachmentId: "att1" } as const;
  const byName = {
    operation: "deleteAttachment",
    page: "123",
    fileName: "diagram.png",
  } as const;

  test.each(REFUSED)(
    "status %s refuses, by id and by name",
    async (_label, status, shown) => {
      attachments = [attachment(status)];
      for (const request of [byId, byName]) {
        const err = await prepareError([request]);
        expect(err).toBeInstanceOf(ConfluenceMutationError);
        expect((err as Error).message).toBe(attachmentRefusal(shown));
      }
      expect(deletes()).toEqual([]);
    },
  );

  test('status "current" is proposed; the approved apply sends exactly one DELETE', async () => {
    for (const request of [byId, byName]) {
      seen = [];
      const { items } = await prepare([request]);
      expect(items[0]?.attachment).toMatchObject({
        existingId: "att1",
        baseVersion: 2,
      });
      expect(deletes()).toEqual([]);
      await applyConfluenceMutationItems(config, items, applyDeps());
      expect(deletes().map(({ url }) => url.pathname)).toEqual([
        "/wiki/api/v2/attachments/att1",
      ]);
    }
  });
});

describe("B1: deleteAttachment, apply (verifiedExistingId)", () => {
  test.each(REFUSED)("status %s refuses", async (_label, status, shown) => {
    attachments = [attachment(status)];
    const items = [attachmentDeleteItem()];
    const deps = await applyFailing(items);
    expect(items[0]?.error).toBe(attachmentRefusal(shown));
    expect(deps.errors[0]).toBeInstanceOf(ConfluenceMutationError);
    expect(trace()).toEqual(["GET /wiki/api/v2/attachments/att1"]);
  });

  test("the version is checked first", async () => {
    attachments = [attachment("trashed", 3)];
    const items = [attachmentDeleteItem()];
    await applyFailing(items);
    expect(items[0]?.error).toMatch(/changed since this proposal.*2 → 3/);
    expect(deletes()).toEqual([]);
  });

  test('status "current" sends exactly one DELETE', async () => {
    const items = [attachmentDeleteItem()];
    await applyConfluenceMutationItems(config, items, applyDeps());
    expect(items[0]?.error).toBeUndefined();
    expect(deletes().map(({ url }) => url.pathname)).toEqual([
      "/wiki/api/v2/attachments/att1",
    ]);
  });
});

describe("B1: replaying an approved delete sends no second DELETE", () => {
  test.each([
    [
      "trashed, same version",
      () => {
        pageStatus = "trashed";
      },
      pageRefusal("trashed"),
    ],
    [
      "no status",
      () => {
        pageStatus = OMITTED;
      },
      pageRefusal("unknown"),
    ],
    [
      "404",
      () => {
        pageGone = true;
      },
      null,
    ],
  ])("page: second verify read %s", async (_label, trashIt, refusal) => {
    const { items } = await prepare([{ operation: "delete", page: "123" }]);
    const first = await applyConfluenceMutationItems(
      config,
      items,
      applyDeps(),
    );
    expect(first.succeeded).toBe(1);
    trashIt();
    const deps = await applyFailing(items);
    if (refusal) {
      expect(items[0]?.error).toBe(refusal);
      expect(deps.errors[0]).toBeInstanceOf(ConfluenceMutationError);
    } else {
      expect(deps.errors[0]).toBeInstanceOf(AtlassianHttpError);
      expect(deps.errors[0]).not.toBeInstanceOf(ConfluenceWriteHttpError);
      expect((deps.errors[0] as AtlassianHttpError).status).toBe(404);
      expect(items[0]?.error).toBe(errorText(deps.errors[0]));
    }
    expect(deletes()).toHaveLength(1);
  });

  test.each([
    [
      "trashed, same version",
      () => {
        attachments = [attachment("trashed")];
      },
      attachmentRefusal("trashed"),
    ],
    [
      "no status",
      () => {
        attachments = [attachment(OMITTED)];
      },
      attachmentRefusal("unknown"),
    ],
    [
      "404",
      () => {
        attachments = [];
      },
      null,
    ],
  ])("attachment: second verify read %s", async (_label, trashIt, refusal) => {
    const { items } = await prepare([
      { operation: "deleteAttachment", page: "123", fileName: "diagram.png" },
    ]);
    const first = await applyConfluenceMutationItems(
      config,
      items,
      applyDeps(),
    );
    expect(first.succeeded).toBe(1);
    trashIt();
    const deps = await applyFailing(items);
    if (refusal) {
      expect(items[0]?.error).toBe(refusal);
      expect(deps.errors[0]).toBeInstanceOf(ConfluenceMutationError);
    } else {
      expect(deps.errors[0]).toBeInstanceOf(AtlassianHttpError);
      expect(deps.errors[0]).not.toBeInstanceOf(ConfluenceWriteHttpError);
      expect((deps.errors[0] as AtlassianHttpError).status).toBe(404);
      expect(items[0]?.error).toBe(errorText(deps.errors[0]));
    }
    expect(deletes()).toHaveLength(1);
  });
});

describe("B1: the guard did not spread to other operations", () => {
  /** Prepare and apply one item; everything observable about the run. */
  async function run(request: ConfluenceMutateItemParams) {
    seen = [];
    const prepared = await prepare([request]);
    const items = structuredClone(prepared.items);
    const result = await applyConfluenceMutationItems(
      config,
      items,
      applyDeps(),
    );
    return { prepared, items, result, trace: trace() };
  }

  const edit: ConfluenceMutateItemParams = {
    operation: "edit",
    page: "123",
    body: "More",
    newTitle: "Renamed",
    addLabels: ["x"],
  };
  const newVersion: ConfluenceMutateItemParams = {
    operation: "uploadAttachment",
    page: "123",
    fileName: "diagram.png",
    sourcePath: "/tmp/diagram.png",
  };

  test.each([
    ["trashed", "trashed"],
    ["no status", OMITTED],
  ] as const)(
    "an edit of a page read with %s runs exactly as with current",
    async (_label, status) => {
      const baseline = await run(edit);
      expect(baseline.trace.filter((line) => line.startsWith("PUT"))).toEqual([
        "PUT /wiki/api/v2/pages/123",
      ]);
      pageStatus = status;
      expect(await run(edit)).toEqual(baseline);
    },
  );

  test.each([
    ["trashed", "trashed"],
    ["no status", OMITTED],
  ] as const)(
    "a new version of an attachment read with %s uploads exactly as with current",
    async (_label, status) => {
      const baseline = await run(newVersion);
      expect(baseline.trace).toContain(
        "POST /wiki/rest/api/content/123/child/attachment/att1/data",
      );
      attachments = [attachment(status)];
      expect(await run(newVersion)).toEqual(baseline);
    },
  );
});

describe("AC7: trash only", () => {
  test("a page delete and an attachment delete each send one DELETE to the exact path, with no query", async () => {
    await applyConfluenceMutationItems(
      config,
      [pageDeleteItem(), attachmentDeleteItem()],
      applyDeps(),
    );
    expect(
      deletes().map(({ url }) => ({ path: url.pathname, search: url.search })),
    ).toEqual([
      { path: "/wiki/api/v2/pages/123", search: "" },
      { path: "/wiki/api/v2/attachments/att1", search: "" },
    ]);
  });

  test("a delete whose verify read answers 404 records the error and sends no DELETE", async () => {
    pageGone = true;
    attachments = [];
    const items = [pageDeleteItem(), attachmentDeleteItem()];
    const deps = await applyFailing(items);
    for (const err of deps.errors)
      expect((err as AtlassianHttpError).status).toBe(404);
    expect(items.map((item) => Boolean(item.error))).toEqual([true, true]);
    expect(deletes()).toEqual([]);
  });
});
