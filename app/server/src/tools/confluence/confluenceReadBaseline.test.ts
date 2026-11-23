/**
 * Characterization baseline for the three local Confluence read tools
 * (Task-1439 P2, AC1a): the exact `content[0].text` each answers for the
 * fixtures in `test/confluenceReadFixtures.ts`, through the real client and
 * transport with only the global `fetch` stubbed.
 *
 * The expected texts in `__fixtures__/confluenceReadBaseline/` were captured
 * once from the implementation before the read path moved to
 * `confluenceRead.ts`, and are frozen: a failure here means the tool's text
 * changed (values, key order or whitespace), and the code is what gets fixed,
 * never the fixture.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CONFLUENCE_FIXTURE_SITE,
  confluenceReadAnswer,
} from "../../test/confluenceReadFixtures.ts";

vi.mock("../../confluenceSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../confluenceSettings.ts")>()),
  getConfluenceToolConfig: () => ({
    host: CONFLUENCE_FIXTURE_SITE,
    atlassianEmail: "me@x.test",
    atlassianToken: "FAKE-TOKEN",
  }),
}));

const { confluenceSearchTool, confluenceGetPageTool, confluenceLookupTool } =
  await import("./confluenceTools.ts");

type Tool = {
  execute: (
    params: never,
    ctx: never,
  ) => Promise<{
    content?: Array<{ type: string; text?: string }>;
  }>;
};

const FIXTURE_DIR = new URL(
  "./__fixtures__/confluenceReadBaseline/",
  import.meta.url,
);

/** Every case: its fixture file name, the tool and the arguments. */
const CASES: Array<[name: string, tool: Tool, params: unknown]> = [
  [
    "search-filters",
    confluenceSearchTool,
    {
      text: "deploy",
      spaceKeys: ["ENG", "OPS"],
      updatedSince: "2026-01-01",
      maxResults: 2,
    },
  ],
  ["search-raw-cql", confluenceSearchTool, { cql: "id = 101" }],
  ["search-empty", confluenceSearchTool, { title: "nothing matches" }],
  [
    "get-page-all-sections",
    confluenceGetPageTool,
    {
      page: "https://acme.atlassian.net/wiki/spaces/ENG/pages/101/Runbook",
      includeComments: true,
      includeLabels: true,
      includeChildren: true,
      includeAttachments: true,
    },
  ],
  ["get-page-plain", confluenceGetPageTool, { page: "101" }],
  ["get-page-storage-fallback", confluenceGetPageTool, { page: "102" }],
  ["get-page-space-unreadable", confluenceGetPageTool, { page: "103" }],
  [
    "get-page-truncated",
    confluenceGetPageTool,
    { page: "104", maxChars: 1000 },
  ],
  [
    "lookup-spaces",
    confluenceLookupTool,
    { kind: "spaces", query: "eng", cursor: "spc-page-1", maxResults: 3 },
  ],
  [
    "lookup-page-tree-by-page",
    confluenceLookupTool,
    { kind: "pageTree", page: "101" },
  ],
  [
    "lookup-page-tree-by-space",
    confluenceLookupTool,
    { kind: "pageTree", spaceKey: "ENG" },
  ],
  ["lookup-labels", confluenceLookupTool, { kind: "labels", page: "101" }],
  [
    "lookup-attachments",
    confluenceLookupTool,
    { kind: "attachments", page: "101", maxResults: 2 },
  ],
  ["lookup-comments", confluenceLookupTool, { kind: "comments", page: "101" }],
  [
    "lookup-replies",
    confluenceLookupTool,
    { kind: "replies", commentId: "c1", cursor: "rp1" },
  ],
];

beforeEach(() => {
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local Confluence read text (frozen baseline)", () => {
  test.each(CASES)("%s", async (name, tool, params) => {
    const result = await tool.execute(
      params as never,
      { session: { sessionId: "baseline" } } as never,
    );
    const block = result.content?.[0];
    const text = block?.type === "text" ? block.text : undefined;
    const expected = readFileSync(new URL(`${name}.txt`, FIXTURE_DIR), "utf8");
    // `toBe` is `Object.is`: for strings, exact equality, byte for byte.
    expect(typeof text).toBe("string");
    expect(text).toBe(expected);
  });
});
