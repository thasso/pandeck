/**
 * Confluence read fixtures (Task-1439 P2) shared by the local
 * characterization baseline (`confluenceReadBaseline.test.ts`) and the edge's
 * parity tests: one responder answering every request the three read tools
 * send, by path and query, the way Confluence Cloud would. An OAuth path is
 * matched without its `/ex/confluence/<cloudId>` prefix. Every value is fake.
 *
 * The baseline's expected texts were captured from these answers; changing an
 * answer here changes what the baseline means. Add new pages or routes for new
 * cases instead of editing existing ones.
 */

/** The site every fixture belongs to. */
export const CONFLUENCE_FIXTURE_SITE = "acme.atlassian.net";

/** A fixture answer: a JSON body and its HTTP status. */
export interface ConfluenceFixtureAnswer {
  status: number;
  body: unknown;
}

function ok(body: unknown): ConfluenceFixtureAnswer {
  return { status: 200, body };
}

function adf(...content: unknown[]): string {
  return JSON.stringify({ type: "doc", version: 1, content });
}

function paragraph(text: string): unknown {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

/** The full page: headings, a list, a code block and a macro Markdown lacks. */
const RUNBOOK_ADF = adf(
  {
    type: "heading",
    attrs: { level: 2 },
    content: [{ type: "text", text: "Deploy steps" }],
  },
  paragraph("Roll the canary first, then the fleet."),
  {
    type: "bulletList",
    content: [
      { type: "listItem", content: [paragraph("Build the image")] },
      { type: "listItem", content: [paragraph("Push to the registry")] },
    ],
  },
  {
    type: "codeBlock",
    attrs: { language: "sh" },
    content: [{ type: "text", text: "make deploy ENV=canary" }],
  },
  { type: "extension", attrs: { extensionKey: "toc" } },
  {
    type: "panel",
    attrs: { panelType: "info" },
    content: [paragraph("Ask in #ops before a fleet deploy.")],
  },
);

/** A plain page with no macro, so `lossyNodes` is empty. */
const NOTES_ADF = adf(paragraph("Meeting notes for the weekly sync."));

/** A legacy page: ADF answers an empty document, storage has the content. */
const LEGACY_STORAGE =
  '<h2>Old runbook</h2><p>Restart the <strong>legacy</strong> worker with <code>svc restart</code>.</p><ul><li>Check the queue</li><li>Check the <a href="https://status.example.test/">status page</a></li></ul>';

/** A long body for the `maxChars` cut: numbered sentences, about 3,900 characters. */
const LONG_TEXT = Array.from(
  { length: 60 },
  (_, index) => `Sentence ${index + 1} of the long page body.`,
).join(" ");

/**
 * A body of exactly 70,000 characters (the edge's ceiling test, D5): longer
 * than the edge's 60,000-character result limit, within local `maxChars`.
 */
export const HUGE_TEXT = `${"Huge page body ".repeat(4_666)}final word`;

interface FixturePage {
  title: string;
  spaceId: string;
  parentId: string | null;
  version: number;
  webui: string | null;
  adf: string;
  storage?: string;
}

const PAGES: Record<string, FixturePage> = {
  "101": {
    title: "Runbook",
    spaceId: "900",
    parentId: "100",
    version: 7,
    webui: "/spaces/ENG/pages/101/Runbook",
    adf: RUNBOOK_ADF,
  },
  // A legacy page with no `_links`, so its url is the fallback form.
  "102": {
    title: "Legacy runbook",
    spaceId: "900",
    parentId: null,
    version: 3,
    webui: null,
    adf: adf(),
    storage: LEGACY_STORAGE,
  },
  // Its space cannot be read: the page still answers, without space names.
  "103": {
    title: "Restricted space notes",
    spaceId: "999",
    parentId: null,
    version: 1,
    webui: "/spaces/SECRET/pages/103/Notes",
    adf: NOTES_ADF,
  },
  "104": {
    title: "Long page",
    spaceId: "900",
    parentId: "101",
    version: 12,
    webui: "/wiki/spaces/ENG/pages/104/Long+page",
    adf: adf(paragraph(LONG_TEXT)),
  },
  "106": {
    title: "Huge page",
    spaceId: "900",
    parentId: "101",
    version: 2,
    webui: "/spaces/ENG/pages/106/Huge+page",
    adf: adf(paragraph(HUGE_TEXT)),
  },
};

function pageAnswer(
  id: string,
  query: Record<string, string>,
): ConfluenceFixtureAnswer | undefined {
  const page = PAGES[id];
  if (!page) return undefined;
  const format = query["body-format"];
  return ok({
    id,
    status: "current",
    title: page.title,
    spaceId: page.spaceId,
    parentId: page.parentId,
    authorId: "acct-author",
    createdAt: "2026-01-01T09:00:00.000Z",
    version: {
      number: page.version,
      createdAt: "2026-03-04T05:06:07.000Z",
      message: "",
      authorId: "acct-editor",
    },
    body:
      format === "storage"
        ? page.storage === undefined
          ? {}
          : { storage: { value: page.storage, representation: "storage" } }
        : {
            atlas_doc_format: {
              value: page.adf,
              representation: "atlas_doc_format",
            },
          },
    ...(page.webui ? { _links: { webui: page.webui } } : {}),
  });
}

function comment(id: string, author: string, text: string): unknown {
  return {
    id,
    status: "current",
    version: { number: 1, authorId: author },
    body: {
      atlas_doc_format: { value: adf(paragraph(text)) },
    },
  };
}

/** A v2 listing; `next` is the cursor Confluence would hand back, if any. */
function listing(
  path: string,
  results: unknown[],
  next?: string,
): ConfluenceFixtureAnswer {
  return ok({
    results,
    _links: next ? { next: `${path}?cursor=${next}&limit=25` } : {},
  });
}

const SPACES = [
  {
    id: "900",
    key: "ENG",
    name: "Engineering",
    type: "global",
    status: "current",
    _links: { webui: "/spaces/ENG" },
  },
  {
    id: "901",
    key: "OPS",
    name: "Operations",
    type: "global",
    status: "current",
    _links: { webui: "/spaces/OPS" },
  },
  {
    id: "902",
    key: "~acct",
    name: "Personal space of an engineer",
    type: "personal",
    status: "current",
  },
];

const SEARCH_FILTERS_CQL =
  'type = "page" AND space in ("ENG", "OPS") AND text ~ "deploy" AND lastmodified >= "2026-01-01" order by lastmodified desc';

function searchAnswer(query: Record<string, string>): ConfluenceFixtureAnswer {
  const cql = query["cql"];
  if (cql === SEARCH_FILTERS_CQL)
    return ok({
      results: [
        {
          content: {
            id: "101",
            type: "page",
            title: "Runbook",
            status: "current",
          },
          title: "@@@hl@@@Runbook@@@endhl@@@",
          excerpt: "Roll the canary first, then @@@hl@@@deploy@@@endhl@@@ …",
          url: "/spaces/ENG/pages/101/Runbook",
          lastModified: "2026-03-04T05:06:07.000Z",
          resultGlobalContainer: {
            title: "Engineering",
            displayUrl: "/spaces/ENG",
          },
        },
        {
          content: { id: "205", type: "page", status: "current" },
          title: "",
          excerpt: "",
          url: "/wiki/spaces/OPS/pages/205",
          lastModified: "2026-02-01T00:00:00.000Z",
        },
      ],
      totalSize: 5,
      _links: { base: "https://acme.atlassian.net/wiki" },
    });
  if (cql === "id = 101")
    return ok({
      results: [
        {
          content: { id: "101", type: "page", title: "Runbook" },
          title: "Runbook",
          excerpt: "Roll the canary first",
          url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/101/Runbook",
          lastModified: "2026-03-04T05:06:07.000Z",
          resultGlobalContainer: { title: "Engineering" },
        },
      ],
      totalSize: 1,
    });
  return ok({ results: [], totalSize: 0 });
}

const ATTACHMENTS = [
  {
    id: "att501",
    title: "diagram.png",
    pageId: "101",
    mediaType: "image/png",
    fileSize: 2048,
    version: { number: 2 },
    downloadLink: "/download/attachments/101/diagram.png?version=2&api=v2",
  },
  {
    id: "att502",
    title: "notes.txt",
    pageId: "101",
    mediaType: "text/plain",
    _links: { download: "/wiki/download/attachments/101/notes.txt" },
  },
];

/**
 * The fixture answer for one request, or undefined when no fixture covers it
 * (a test answers that as 404). `path` is the site-relative path.
 */
export function confluenceReadAnswer(
  method: string,
  path: string,
  query: Record<string, string>,
): ConfluenceFixtureAnswer | undefined {
  if (method !== "GET") return undefined;
  if (path === "/wiki/rest/api/search") return searchAnswer(query);

  if (path === "/wiki/api/v2/spaces") {
    if (query["keys"] === "ENG" && query["limit"] === "1")
      return ok({ results: [SPACES[0]] });
    if (query["keys"]) return ok({ results: [] });
    return listing(path, SPACES, "spc%2Fpage%3D2");
  }
  if (path === "/wiki/api/v2/spaces/900") return ok(SPACES[0]);
  if (path === "/wiki/api/v2/spaces/999")
    return {
      status: 403,
      body: { message: "Not permitted to view space 999" },
    };
  if (path === "/wiki/api/v2/spaces/900/pages")
    return listing(
      path,
      [
        { id: "100", title: "Engineering home", status: "current" },
        {
          id: "101",
          title: "Runbook",
          status: "current",
          parentId: "100",
        },
        { id: "104", title: "Long page", status: "draft", parentId: "101" },
      ],
      "tree2",
    );

  const page = path.match(/^\/wiki\/api\/v2\/pages\/(\d+)$/);
  if (page?.[1]) return pageAnswer(page[1], query);

  if (path === "/wiki/api/v2/pages/101/footer-comments")
    return listing(
      path,
      [
        comment("c1", "acct-a", "Does the canary step need approval?"),
        comment("c2", "acct-b", "Updated the registry name."),
        { id: "c3", version: { number: 2 }, body: {} },
      ],
      "fc2",
    );
  if (path === "/wiki/api/v2/footer-comments/c1/children")
    return listing(
      path,
      [
        comment("c11", "acct-b", "Yes, from the on-call lead."),
        comment("c12", "acct-a", "Thanks."),
      ],
      "rp2",
    );
  if (path.match(/^\/wiki\/api\/v2\/footer-comments\/c\d+\/children$/))
    return listing(path, []);
  if (path === "/wiki/api/v2/pages/101/labels")
    return listing(
      path,
      [{ name: "runbook" }, { name: "" }, { name: "ops" }],
      "lbl2",
    );
  if (path === "/wiki/api/v2/pages/101/children")
    return listing(path, [
      {
        id: "104",
        title: "Long page",
        status: "draft",
        parentId: "101",
      },
      { id: "105", title: "Rollback", status: "current", parentId: "101" },
    ]);
  if (path === "/wiki/api/v2/pages/101/attachments")
    return listing(path, ATTACHMENTS, "att2");
  return undefined;
}
