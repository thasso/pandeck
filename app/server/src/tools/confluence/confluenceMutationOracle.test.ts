/**
 * The literal oracle for the local `confluence_mutate_page` (Task-1463 P6b,
 * P6B-F2): what the tool shows when it proposes (card title, summary, body,
 * tool text) and what its executor reports when the card is approved
 * (status, `resultSummary`, `resultUrl`, the all-failed error), for each
 * operation and their mixes, with and without prepare warnings. Every
 * expectation is a literal captured from the code before P6b moved any of it;
 * a later change must leave these lines alone. The only normalization is the
 * card id inside the tool text's `pa://` link.
 *
 * The site is the fetch-level fake Confluence (`test/confluenceMutateFetch.ts`),
 * so the gateway path can run the same cases against the same fake.
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  json,
  stubConfluenceWriteFetch,
  type ConfluenceWriteResponder,
  type FakeConfluenceOptions,
} from "../../test/confluenceMutateFetch.ts";

vi.mock("../../confluenceSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../confluenceSettings.ts")>()),
  getConfluenceToolConfig: () => ({
    host: "acme.atlassian.net",
    atlassianEmail: "oracle@example.com",
    atlassianToken: "oracle-token",
  }),
}));

const { confluenceMutatePageTool } = await import("./confluenceTools.ts");
const { approvalsForSession, resolveApproval, setApprovalBroadcastForTests } =
  await import("../../pendingApprovals.ts");

setApprovalBroadcastForTests(() => {});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Observed {
  title: string;
  summary: string | undefined;
  text: string;
  body: unknown;
  status: string;
  resultSummary: string | undefined;
  resultUrl: string | undefined;
  error: string | undefined;
}

interface OracleCase {
  name: string;
  items: unknown[];
  options?: FakeConfluenceOptions;
  /** Answers before the fake site; `undefined` leaves a request to it. */
  answer?: () => ConfluenceWriteResponder;
  expected: Observed;
}

/** The card id is the one value that differs per run. */
const withoutCardId = (text: string): string =>
  text.replace(/appr_\d+_[0-9a-f]{8}/g, "appr_ID");

let session = 0;

async function observe(oracle: OracleCase): Promise<Observed> {
  const answer = oracle.answer?.();
  stubConfluenceWriteFetch(answer, oracle.options);
  const sessionId = `confluence-oracle-${(session += 1)}`;
  const result = await confluenceMutatePageTool.execute(
    { items: oracle.items } as never,
    { session: { sessionId }, toolCallId: "call-1" } as never,
  );
  const part = result.content[0];
  const proposed = approvalsForSession(sessionId).at(-1)!;
  const body = structuredClone(proposed.body);
  const { card } = await resolveApproval(proposed.id, "approved");
  return {
    title: proposed.title,
    summary: proposed.summary,
    text: withoutCardId(part?.type === "text" ? part.text : ""),
    body,
    status: card.status,
    resultSummary: card.resultSummary,
    resultUrl: card.resultUrl,
    error: card.error,
  };
}

/** Every request matching `refuse` fails with `status`. */
function refusing(
  refuse: (method: string, path: string) => boolean,
  status: number,
): () => ConfluenceWriteResponder {
  return () => (request) =>
    refuse(request.method, request.path)
      ? json({ message: "Refused by the fake site" }, status)
      : undefined;
}

const CASES: OracleCase[] = [
  {
    name: "create with a parent and labels",
    items: [
      {
        operation: "create",
        spaceKey: "ENG",
        title: "New page",
        parentPage: "123",
        body: "Hello",
        addLabels: ["a", "b"],
      },
    ],
    expected: {
      title: "Create page New page",
      summary: "create ENG/New page",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Create page New page](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "create",
            title: "New page",
            spaceKey: "ENG",
            spaceName: "Engineering",
            parentId: "123",
            parentTitle: "Page 123",
            body: "Hello",
            labelsAdded: ["a", "b"],
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 Confluence change(s)",
      resultUrl:
        "https://acme.atlassian.net/wiki/spaces/ENG/pages/456/New+page",
      error: undefined,
    },
  },
  {
    name: "edit append",
    items: [{ page: "123", body: "Added" }],
    expected: {
      title: "Edit Page 123",
      summary: "append Page 123",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Edit Page 123](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "edit",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            baseVersion: 7,
            body: "Added",
            placement: "append",
            currentBody: "Body\n\n[macro: toc]",
            lossyNodes: ["extension"],
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 Confluence change(s)",
      resultUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
      error: undefined,
    },
  },
  {
    name: "edit replace drops a macro, with a prepare warning",
    items: [{ page: "123", body: "Whole", placement: "replace" }],
    expected: {
      title: "Edit Page 123",
      summary: "replace Page 123 · 1 warning(s)",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Warnings: replacing Page 123 drops its extension node(s). Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Edit Page 123](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "edit",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            baseVersion: 7,
            body: "Whole",
            placement: "replace",
            currentBody: "Body\n\n[macro: toc]",
            lossyNodes: ["extension"],
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 Confluence change(s)",
      resultUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
      error: undefined,
    },
  },
  {
    name: "rename only",
    items: [{ page: "123", newTitle: "Renamed" }],
    expected: {
      title: "Edit Page 123",
      summary: "append Page 123",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Edit Page 123](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "edit",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            baseVersion: 7,
            newTitle: "Renamed",
            currentBody: "Body\n\n[macro: toc]",
            lossyNodes: ["extension"],
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 Confluence change(s)",
      resultUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
      error: undefined,
    },
  },
  {
    name: "label change whose label write fails",
    items: [
      { page: "123", body: "Added", addLabels: ["x"], removeLabels: ["y"] },
    ],
    answer: refusing(
      (method, path) => method === "POST" && path.endsWith("/label"),
      403,
    ),
    expected: {
      title: "Edit Page 123",
      summary: "append Page 123",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Edit Page 123](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "edit",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            baseVersion: 7,
            labelsAdded: ["x"],
            labelsRemoved: ["y"],
            body: "Added",
            placement: "append",
            currentBody: "Body\n\n[macro: toc]",
            lossyNodes: ["extension"],
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 Confluence change(s); 1 warning(s)",
      resultUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
      error: undefined,
    },
  },
  {
    name: "comment",
    items: [{ operation: "comment", page: "123", body: "Note" }],
    expected: {
      title: "Comment on Page 123",
      summary: "comment Page 123",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Comment on Page 123](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "comment",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            baseVersion: 7,
            body: "Note",
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 Confluence change(s)",
      resultUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123?c1",
      error: undefined,
    },
  },
  {
    name: "delete",
    items: [{ operation: "delete", page: "123" }],
    expected: {
      title: "Delete Page 123",
      summary: "delete Page 123 · 1 warning(s)",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Warnings: Page 123 would be moved to the trash, along with its comments. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Delete Page 123](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "delete",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            baseVersion: 7,
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 Confluence change(s)",
      resultUrl: undefined,
      error: undefined,
    },
  },
  {
    name: "attachment delete by name",
    items: [
      { operation: "deleteAttachment", page: "123", fileName: "diagram.png" },
    ],
    expected: {
      title: "Delete attachment diagram.png",
      summary: "delete diagram.png from Page 123 · 1 warning(s)",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Warnings: diagram.png would be moved to the trash; a page embedding it shows it as missing. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Delete attachment diagram.png](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "deleteAttachment",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            attachment: {
              fileName: "diagram.png",
              existingId: "att1",
              baseVersion: 2,
              mediaType: "image/png",
              size: 4,
            },
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 Confluence change(s)",
      resultUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
      error: undefined,
    },
  },
  {
    name: "two creates",
    items: [
      { operation: "create", spaceKey: "ENG", title: "One", body: "1" },
      { operation: "create", spaceKey: "ENG", title: "Two", body: "2" },
    ],
    expected: {
      title: "Create 2 Confluence pages",
      summary: "create ENG/One, create ENG/Two",
      text: "Prepared a Confluence proposal for 2 page(s) pending your approval. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Create 2 Confluence pages](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "create",
            title: "One",
            spaceKey: "ENG",
            spaceName: "Engineering",
            parentId: null,
            parentTitle: null,
            body: "1",
          },
          {
            clientId: "cfl_1",
            operation: "create",
            title: "Two",
            spaceKey: "ENG",
            spaceName: "Engineering",
            parentId: null,
            parentTitle: null,
            body: "2",
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 2 Confluence change(s)",
      resultUrl:
        "https://acme.atlassian.net/wiki/spaces/ENG/pages/456/New+page",
      error: undefined,
    },
  },
  {
    name: "mixed operations",
    items: [
      {
        operation: "create",
        spaceKey: "ENG",
        title: "Child",
        body: "Hi",
        parentPage: "123",
      },
      { page: "123", body: "Whole", placement: "replace" },
      { operation: "comment", page: "124", body: "Note" },
      { operation: "deleteAttachment", attachmentId: "att1" },
    ],
    expected: {
      title: "4 Confluence changes",
      summary:
        "create ENG/Child, replace Page 123, comment Page 124, delete diagram.png from Page 123 · 2 warning(s)",
      text: "Prepared a Confluence proposal for 4 page(s) pending your approval. Warnings: replacing Page 123 drops its extension node(s); diagram.png would be moved to the trash; a page embedding it shows it as missing. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [4 Confluence changes](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "create",
            title: "Child",
            spaceKey: "ENG",
            spaceName: "Engineering",
            parentId: "123",
            parentTitle: "Page 123",
            body: "Hi",
          },
          {
            clientId: "cfl_1",
            operation: "edit",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            baseVersion: 7,
            body: "Whole",
            placement: "replace",
            currentBody: "Body\n\n[macro: toc]",
            lossyNodes: ["extension"],
          },
          {
            clientId: "cfl_2",
            operation: "comment",
            pageId: "124",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/124",
            title: "Page 124",
            spaceKey: "ENG",
            spaceName: "Engineering",
            baseVersion: 7,
            body: "Note",
          },
          {
            clientId: "cfl_3",
            operation: "deleteAttachment",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            attachment: {
              fileName: "diagram.png",
              existingId: "att1",
              baseVersion: 2,
              mediaType: "image/png",
              size: 4,
            },
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 4 Confluence change(s)",
      resultUrl:
        "https://acme.atlassian.net/wiki/spaces/ENG/pages/456/New+page",
      error: undefined,
    },
  },
  {
    name: "partial failure: the comment is refused",
    items: [
      { page: "123", body: "Added" },
      { operation: "comment", page: "123", body: "Note" },
    ],
    answer: refusing(
      (method, path) => method === "POST" && path.endsWith("/footer-comments"),
      400,
    ),
    expected: {
      title: "2 Confluence changes",
      summary: "append Page 123, comment Page 123",
      text: "Prepared a Confluence proposal for 2 page(s) pending your approval. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [2 Confluence changes](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "edit",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            baseVersion: 7,
            body: "Added",
            placement: "append",
            currentBody: "Body\n\n[macro: toc]",
            lossyNodes: ["extension"],
          },
          {
            clientId: "cfl_1",
            operation: "comment",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            baseVersion: 7,
            body: "Note",
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 Confluence change(s); 1 failed",
      resultUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
      error: undefined,
    },
  },
  {
    name: "all failed: the only edit is refused",
    items: [{ page: "123", body: "Added" }],
    answer: refusing((method) => method === "PUT", 409),
    expected: {
      title: "Edit Page 123",
      summary: "append Page 123",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Edit Page 123](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "edit",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            baseVersion: 7,
            body: "Added",
            placement: "append",
            currentBody: "Body\n\n[macro: toc]",
            lossyNodes: ["extension"],
          },
        ],
      },
      status: "failed",
      resultSummary: undefined,
      resultUrl: undefined,
      error:
        'All 1 Confluence change(s) failed: Confluence API returned HTTP 409 for PUT /wiki/api/v2/pages/123: {"message":"Refused by the fake site"}',
    },
  },
];

test.each(CASES.map((oracle) => [oracle.name, oracle] as const))(
  "local confluence_mutate_page oracle: %s",
  async (_name, oracle) => {
    expect(await observe(oracle)).toEqual(oracle.expected);
  },
);

// ---------------------------------------------------------------------------
// The gateway path (Task-1463 P6b, P6B-F2): given the proposal the shared
// prepare builds for the same input on the same fake site, the remote tool
// raises the card and tool text pinned above, literal for literal. Applying it
// follows at the end of this file.

const { updateConfluenceSettings } =
  await import("../../confluenceSettings.ts");
const { buildConfluenceMutationItems } =
  await import("../../confluenceMutate.ts");
const { acceptRemoteTools, applyListing, installRemoteToolPort } =
  await import("../../remoteTools.ts");
const { remoteToolsFor } = await import("../gateway/remoteToolGroup.ts");
const { approvalStore } = await import("../../db/approvalStore.ts");

const SITE = {
  host: "acme.atlassian.net",
  atlassianEmail: "oracle@example.com",
  atlassianToken: "oracle-token",
};

async function observeGateway(
  oracle: OracleCase,
): Promise<Pick<Observed, "title" | "summary" | "text" | "body">> {
  stubConfluenceWriteFetch(oracle.answer?.(), oracle.options);
  const uninstall = installRemoteToolPort({
    call: () => Promise.reject(new Error("unused")),
    // What the edge's `tools.prepare` answers: the shared prepare's proposal.
    prepare: async (_name, args, signal) => ({
      ok: true,
      site: SITE.host,
      ...(await buildConfluenceMutationItems(SITE, args.items as never, {
        signal,
        freezeUpload: () => {
          throw new Error("no uploads in the oracle");
        },
      })),
    }),
    apply: () => Promise.reject(new Error("unused")),
  });
  updateConfluenceSettings({ enabled: true });
  try {
    applyListing(
      acceptRemoteTools([
        {
          name: "confluence_mutate_page",
          effect: "write",
          actionKey: "confluence:write",
          twoPhase: true,
        },
      ]),
    );
    const tool = remoteToolsFor("confluence")[0]!;
    const sessionId = `confluence-oracle-gateway-${(session += 1)}`;
    const result = await tool.execute({ items: oracle.items }, {
      session: { sessionId },
      toolCallId: "call-1",
    } as never);
    const part = result.content[0];
    const proposed = approvalsForSession(sessionId).at(-1)!;
    expect(approvalStore.get(proposed.id)?.context).toEqual({
      via: "gateway",
    });
    return {
      title: proposed.title,
      summary: proposed.summary,
      text: withoutCardId(part?.type === "text" ? part.text : ""),
      body: structuredClone(proposed.body),
    };
  } finally {
    uninstall();
    updateConfluenceSettings({ enabled: false });
  }
}

test.each(CASES.map((oracle) => [oracle.name, oracle] as const))(
  "gateway confluence_mutate_page oracle: %s",
  async (_name, oracle) => {
    const { title, summary, text, body } = oracle.expected;
    expect(await observeGateway(oracle)).toEqual({
      title,
      summary,
      text,
      body,
    });
  },
);

// ---------------------------------------------------------------------------
// Applying the gateway card (Task-1463 P6b, M2): the port runs the edge's own
// tool host, prepare and apply, through the wire's decoders, against the same
// fake site. The card raised is the literal above; approved, it ends with the
// literal status, summary, URL and error, plus exactly the suffix the apply
// table adds for that case (`remoteApply.ts`), and its items as the local
// apply leaves them.

const { createToolHost } = await import("../../gatewayTools/host.ts");
const { edgeTools } = await import("../../gatewayTools/tools.ts");
const { encodeAtlassianCredential } =
  await import("../../gatewayTools/atlassian.ts");
const { edgeRemotePort } = await import("../../test/edgeRemotePort.ts");
const linkDecoders = await import("../../gateway/clientMethods.ts");
const { approvalForId } = await import("../../pendingApprovals.ts");

const PARTIAL_EFFECTS =
  "Some failed changes may have been partly written before they failed; the card shows each item's outcome. Check the site and ask again only for what is missing. Don't approve the same change again unchecked.";

/** What the gateway adds to a case's literal; every other case adds nothing. */
const GATEWAY_SUFFIX: Record<string, string> = {
  // The refused write reached Confluence: it may have written.
  "partial failure: the comment is refused": PARTIAL_EFFECTS,
  "all failed: the only edit is refused": PARTIAL_EFFECTS,
};

/** The edge's own text for an item, where it differs from the local one. */
interface EdgeTexts {
  error?: string;
  warning?: string;
}

/**
 * The edge's own texts by case and item: it never passes an upstream body
 * on (P6a vetting), so these replace the local item errors and warnings,
 * an error inside the all-failed text too.
 */
const GATEWAY_ITEM_TEXTS: Record<string, (EdgeTexts | undefined)[]> = {
  "label change whose label write fails": [
    {
      warning:
        "label changes failed: add x: Atlassian rejected the credential; reconnect Jira in Pandeck's Settings.",
    },
  ],
  "partial failure: the comment is refused": [
    undefined,
    { error: "Confluence refused the change (HTTP 400)." },
  ],
  "all failed: the only edit is refused": [
    { error: "Confluence refused the change (HTTP 409)." },
  ],
};

const withSuffix = (text: string | undefined, suffix: string | undefined) =>
  text === undefined || suffix === undefined ? text : `${text} ${suffix}`;

type AppliedBody = { items: EdgeTexts[] };

/** The local items with the edge's item texts, and the error text to match. */
function withEdgeTexts(
  name: string,
  local: AppliedBody,
  error: string | undefined,
): { body: AppliedBody; error: string | undefined } {
  const edge = GATEWAY_ITEM_TEXTS[name] ?? [];
  // Every local error and warning has its edge text pinned.
  local.items.forEach((item, index) => {
    expect(item.error !== undefined).toBe(edge[index]?.error !== undefined);
    expect(item.warning !== undefined).toBe(edge[index]?.warning !== undefined);
  });
  let shown = error;
  const body = structuredClone(local);
  body.items.forEach((item, index) => {
    const texts = edge[index];
    if (texts?.error !== undefined) {
      shown = shown?.replace(item.error!, texts.error);
      item.error = texts.error;
    }
    if (texts?.warning !== undefined) item.warning = texts.warning;
  });
  return { body, error: shown };
}

async function observeGatewayApply(
  oracle: OracleCase,
): Promise<Observed & { applied: unknown }> {
  stubConfluenceWriteFetch(oracle.answer?.(), oracle.options);
  const credential = encodeAtlassianCredential({
    site: SITE.host,
    email: SITE.atlassianEmail,
    token: SITE.atlassianToken,
  });
  const host = createToolHost(
    edgeTools({ confluenceDeletes: { page: true, attachment: true } }),
    { log: () => {} },
  );
  const uninstall = installRemoteToolPort(
    edgeRemotePort(
      host,
      () => ({
        clientId: "oracle-client",
        credential: () => Promise.resolve({ ok: true as const, credential }),
      }),
      linkDecoders,
    ),
  );
  updateConfluenceSettings({ enabled: true });
  try {
    applyListing(acceptRemoteTools(host.list()));
    const tool = remoteToolsFor("confluence").find(
      (candidate) => candidate.name === "confluence_mutate_page",
    )!;
    const sessionId = `confluence-oracle-apply-${(session += 1)}`;
    const result = await tool.execute({ items: oracle.items }, {
      session: { sessionId },
      toolCallId: "call-1",
    } as never);
    const part = result.content[0];
    const proposed = approvalsForSession(sessionId).at(-1)!;
    const body = structuredClone(proposed.body);
    const { card } = await resolveApproval(proposed.id, "approved");
    return {
      title: proposed.title,
      summary: proposed.summary,
      text: withoutCardId(part?.type === "text" ? part.text : ""),
      body,
      status: card.status,
      resultSummary: card.resultSummary,
      resultUrl: card.resultUrl,
      error: card.error,
      applied: approvalForId(proposed.id)?.body,
    };
  } finally {
    uninstall();
    updateConfluenceSettings({ enabled: false });
  }
}

/** The local apply's items for the same case, the gateway's reference. */
async function locallyApplied(oracle: OracleCase): Promise<unknown> {
  await observe(oracle);
  const sessionId = `confluence-oracle-${session}`;
  return approvalForId(approvalsForSession(sessionId).at(-1)!.id)?.body;
}

test.each(CASES.map((oracle) => [oracle.name, oracle] as const))(
  "gateway confluence_mutate_page apply oracle: %s",
  async (name, oracle) => {
    const local = await locallyApplied(oracle);
    vi.unstubAllGlobals();
    const { applied, ...observed } = await observeGatewayApply(oracle);
    const suffix = GATEWAY_SUFFIX[name];
    const edge = withEdgeTexts(
      name,
      local as AppliedBody,
      oracle.expected.error,
    );
    expect(observed).toEqual({
      ...oracle.expected,
      resultSummary: withSuffix(oracle.expected.resultSummary, suffix),
      error: withSuffix(edge.error, suffix),
    });
    expect(applied).toEqual(edge.body);
  },
);
