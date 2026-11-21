/**
 * The shared Confluence read module (Task-1439 P2): the local tools use its
 * schema and description objects, the three schemas are closed at the root,
 * and every input refusal of the read path is a typed `ConfluenceReadRefusal`
 * whose message is still the local tool's text. Every value is fake.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConfluenceReadRefusal } from "./atlassian/confluenceClient.ts";
import {
  CONFLUENCE_GET_PAGE_DESCRIPTION,
  CONFLUENCE_GET_PAGE_SCHEMA,
  CONFLUENCE_LOOKUP_DESCRIPTION,
  CONFLUENCE_LOOKUP_SCHEMA,
  CONFLUENCE_SEARCH_DESCRIPTION,
  CONFLUENCE_SEARCH_SCHEMA,
  buildSearchCql,
  normalizePageInput,
  runConfluenceLookup,
} from "./confluenceRead.ts";
import {
  CONFLUENCE_FIXTURE_SITE,
  confluenceReadAnswer,
} from "./test/confluenceReadFixtures.ts";
import {
  confluenceGetPageTool,
  confluenceLookupTool,
  confluenceSearchTool,
} from "./tools/confluence/confluenceTools.ts";

const CONFIG = {
  host: CONFLUENCE_FIXTURE_SITE,
  atlassianEmail: "me@x.test",
  atlassianToken: "FAKE-TOKEN",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The refusal `run` throws, checked for its code and its unchanged text. */
async function refusal(
  run: () => unknown,
  code: string,
  message: string,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ConfluenceReadRefusal);
  expect((caught as ConfluenceReadRefusal).code).toBe(code);
  expect((caught as Error).message).toBe(message);
}

describe("local read tools", () => {
  test("use the shared schema and description objects", () => {
    expect(confluenceSearchTool.parameters).toBe(CONFLUENCE_SEARCH_SCHEMA);
    expect(confluenceSearchTool.description).toBe(
      CONFLUENCE_SEARCH_DESCRIPTION,
    );
    expect(confluenceGetPageTool.parameters).toBe(CONFLUENCE_GET_PAGE_SCHEMA);
    expect(confluenceGetPageTool.description).toBe(
      CONFLUENCE_GET_PAGE_DESCRIPTION,
    );
    expect(confluenceLookupTool.parameters).toBe(CONFLUENCE_LOOKUP_SCHEMA);
    expect(confluenceLookupTool.description).toBe(
      CONFLUENCE_LOOKUP_DESCRIPTION,
    );
  });

  test("close their schemas at the root", () => {
    for (const schema of [
      CONFLUENCE_SEARCH_SCHEMA,
      CONFLUENCE_GET_PAGE_SCHEMA,
      CONFLUENCE_LOOKUP_SCHEMA,
    ])
      expect(schema.additionalProperties).toBe(false);
  });
});

describe("input refusals", () => {
  test("page input", async () => {
    await refusal(
      () => normalizePageInput(" "),
      "page_missing",
      "A Confluence page id or URL is required.",
    );
    await refusal(
      () => normalizePageInput("SENTINEL"),
      "page_unparsable",
      'Could not read a page id from "SENTINEL". Pass the numeric page id or a Confluence page URL.',
    );
  });

  test("search filters", async () => {
    await refusal(
      () => buildSearchCql({ text: "x", updatedSince: "SENTINEL" }),
      "updated_since_format",
      "updatedSince must be a YYYY-MM-DD date.",
    );
    await refusal(
      () => buildSearchCql({ spaceKeys: [] }),
      "search_filters_missing",
      "Give at least one of text, title, label, spaceKeys or updatedSince, or pass a raw cql query.",
    );
  });

  test("lookup scopes and an unknown space", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = new URL(String(input));
        const answer = confluenceReadAnswer(
          "GET",
          url.pathname,
          Object.fromEntries(url.searchParams),
        );
        return new Response(JSON.stringify(answer?.body ?? {}), {
          status: answer?.status ?? 404,
        });
      }),
    );
    await refusal(
      () => runConfluenceLookup(CONFIG, { kind: "pageTree" }, {}),
      "page_tree_scope_missing",
      "kind=pageTree needs either page (children of it) or spaceKey.",
    );
    await refusal(
      () => runConfluenceLookup(CONFIG, { kind: "replies" }, {}),
      "replies_comment_missing",
      "kind=replies needs the commentId to read replies of.",
    );
    await refusal(
      () =>
        runConfluenceLookup(
          CONFIG,
          { kind: "pageTree", spaceKey: "SENTINEL" },
          {},
        ),
      "space_not_found",
      'Confluence space "SENTINEL" was not found, or the Atlassian account cannot see it.',
    );
  });
});
