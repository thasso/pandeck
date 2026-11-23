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
      return {};
    },
  ),
}));

const { atlassianFetch } = await import("./atlassian/atlassianFetch.ts");
const { confluenceDelete, confluencePut } =
  await import("./atlassian/confluenceClient.ts");
const { applyConfluenceMutationItems } =
  await import("./confluenceMutateApply.ts");
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

describe("the moved modules throw only typed errors (AC4)", () => {
  test.each([
    "confluenceMutate.ts",
    "confluenceMutateApply.ts",
    "confluenceAttachmentChange.ts",
    "confluenceMutationErrors.ts",
  ])("%s contains no `new Error(`", (module) => {
    const source = readFileSync(new URL(module, import.meta.url), "utf8");
    expect(source).not.toContain("new Error(");
  });
});
