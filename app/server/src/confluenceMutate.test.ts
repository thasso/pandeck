/**
 * The shared Confluence mutation core (Task-1463 P5a) against a mocked
 * `atlassianFetch`, to see the exact argument lists the client hands the
 * transport; what reaches the network is covered in
 * `confluenceMutateTransport.test.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { ConfluencePageMutationItemDisplay } from "@assistant/shared/confluenceMutation";

vi.mock("./atlassian/atlassianFetch.ts", async (importActual) => ({
  ...(await importActual<typeof import("./atlassian/atlassianFetch.ts")>()),
  atlassianFetch: vi.fn(
    async (
      _config: unknown,
      _product: unknown,
      method: string,
      path: string,
    ) => {
      if (method === "GET" && /\/wiki\/api\/v2\/pages\/\d+$/.test(path))
        return {
          id: "123",
          title: "Runbook",
          status: "current",
          spaceId: "900",
          version: { number: 7 },
          body: {
            atlas_doc_format: {
              value: JSON.stringify({ type: "doc", version: 1, content: [] }),
            },
          },
        };
      if (method === "GET" && path === "/wiki/api/v2/attachments/att1")
        return { id: "att1", status: "current", version: { number: 2 } };
      return {};
    },
  ),
}));

const { atlassianFetch } = await import("./atlassian/atlassianFetch.ts");
const { confluenceDelete, confluencePut } =
  await import("./atlassian/confluenceClient.ts");
const { applyConfluenceMutationItems } =
  await import("./confluenceMutateApply.ts");
const { MAX_MUTATION_ITEMS, buildConfluenceMutationItems } =
  await import("./confluenceMutate.ts");
const { ConfluenceMutationError } =
  await import("./confluenceMutationErrors.ts");
const { errorText } = await import("./errors.ts");
const fetchMock = vi.mocked(atlassianFetch);

const config = {
  host: "example.atlassian.net",
  atlassianEmail: "a@b.c",
  atlassianToken: "t",
};

describe("confluencePut and confluenceDelete call options (AC5a)", () => {
  test("options reach the transport; without them the argument list is as before", async () => {
    const { signal } = new AbortController();
    fetchMock.mockClear();
    await confluencePut(config, "/p", { a: 1 }, undefined, { signal });
    await confluenceDelete(config, "/d", undefined, { signal });
    await confluencePut(config, "/p", { a: 1 });
    await confluenceDelete(config, "/d");
    expect(fetchMock.mock.calls).toEqual([
      [config, "Confluence", "PUT", "/p", { a: 1 }, undefined, { signal }],
      [config, "Confluence", "DELETE", "/d", undefined, undefined, { signal }],
      [config, "Confluence", "PUT", "/p", { a: 1 }],
      [config, "Confluence", "DELETE", "/d", undefined, undefined],
    ]);
  });
});

describe("the item cap the edge's result bound rests on", () => {
  test("prepare refuses more than MAX_MUTATION_ITEMS items before any request", async () => {
    expect(MAX_MUTATION_ITEMS).toBe(10);
    const items = Array.from({ length: MAX_MUTATION_ITEMS + 1 }, () => ({
      operation: "comment" as const,
      page: "123",
      body: "Note",
    }));
    fetchMock.mockClear();
    const refusal = buildConfluenceMutationItems(config, items, {});
    await expect(refusal).rejects.toBeInstanceOf(ConfluenceMutationError);
    await expect(refusal).rejects.toThrow(
      "At most 10 Confluence mutation items are supported per approval.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("apply without a signal keeps every call's exact arguments (AC5a)", () => {
  test("PUT and DELETE keep 5 and 6 arguments, and no call carries a signal", async () => {
    const items: ConfluencePageMutationItemDisplay[] = [
      {
        clientId: "cfl_0",
        operation: "edit",
        pageId: "123",
        baseVersion: 7,
        body: "Added",
        placement: "append",
        labelsAdded: ["a"],
        labelsRemoved: ["b"],
      },
      { clientId: "cfl_1", operation: "delete", pageId: "123", baseVersion: 7 },
      {
        clientId: "cfl_2",
        operation: "edit",
        pageId: "123",
        baseVersion: 7,
        newTitle: "Renamed",
      },
    ];
    fetchMock.mockClear();
    await applyConfluenceMutationItems(config, items, {
      describeError: errorText,
    });
    for (const item of items) expect(item.error, item.clientId).toBeUndefined();
    const calls = fetchMock.mock.calls;
    const byMethod = (method: string) =>
      calls.filter((call) => call[2] === method);
    expect(byMethod("PUT").map((call) => call.length)).toEqual([5, 5]);
    expect(byMethod("DELETE").map((call) => call.length)).toEqual([6, 6]);
    // GETs and POSTs go through confluenceGet/confluencePost, which always
    // pass options; none of them names a signal.
    for (const call of calls)
      expect(JSON.stringify(call[6] ?? {}), String(call[3])).not.toContain(
        "signal",
      );
    for (const call of calls)
      expect(
        call.some(
          (arg) => typeof arg === "object" && arg !== null && "signal" in arg,
        ),
        String(call[3]),
      ).toBe(false);
  });
});

const MOVED_MODULES = [
  "confluenceMutate.ts",
  "confluenceMutateApply.ts",
  "confluenceAttachmentChange.ts",
  "confluenceMutationErrors.ts",
  "../../shared/confluenceMutation.ts",
];
const sourceOf = (module: string) =>
  readFileSync(new URL(module, import.meta.url), "utf8");

describe("the moved modules throw only typed errors (AC4)", () => {
  test.each(MOVED_MODULES)("%s contains no `new Error(`", (module) => {
    expect(sourceOf(module)).not.toContain("new Error(");
  });
});

describe("trash only (AC7)", () => {
  test("each delete hands the transport the exact path, no body and no query", async () => {
    fetchMock.mockClear();
    await applyConfluenceMutationItems(
      config,
      [
        {
          clientId: "cfl_0",
          operation: "delete",
          pageId: "123",
          baseVersion: 7,
        },
        {
          clientId: "cfl_1",
          operation: "deleteAttachment",
          pageId: "123",
          attachment: {
            fileName: "diagram.png",
            existingId: "att1",
            baseVersion: 2,
            mediaType: "image/png",
            size: 4,
          },
        },
      ],
      { describeError: errorText },
    );
    expect(fetchMock.mock.calls.filter((call) => call[2] === "DELETE")).toEqual(
      [
        [
          config,
          "Confluence",
          "DELETE",
          "/wiki/api/v2/pages/123",
          undefined,
          undefined,
        ],
        [
          config,
          "Confluence",
          "DELETE",
          "/wiki/api/v2/attachments/att1",
          undefined,
          undefined,
        ],
      ],
    );
  });

  // Secondary to the request tests (B4): no operation, flag or parameter for
  // a permanent delete or for addressing the trash.
  test.each(MOVED_MODULES)(
    "%s names no purge and no trashed status",
    (module) => {
      const source = sourceOf(module);
      expect(source).not.toMatch(/purge/i);
      expect(source).not.toContain("status=trashed");
      expect(source).not.toContain('"trashed"');
    },
  );
});
