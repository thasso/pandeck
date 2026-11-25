/**
 * The literal oracle for the local `confluence_mutate_page` uploads
 * (Task-1441 P8a, commit 1; P6B-F2's form): what the tool shows when it
 * proposes an upload (card title, summary, body, tool text), what its executor
 * reports when the card is approved (status, `resultSummary`, `resultUrl`, the
 * all-failed error, the applied items), and what each multipart upload carried
 * (path, file name, type, bytes, fields). Every expectation is a literal
 * captured from the local tool before P8a changed the upload body or any
 * routing; a later change must leave these lines alone.
 *
 * The only normalizations are the card id in the tool text, the temporary
 * directory of a host-path source (`/HOST`), and the random id a host-path copy
 * is staged under (`STAGED_<n>`, in order of appearance). The site is the
 * fetch-level fake Confluence (`test/confluenceMutateFetch.ts`), so the
 * gateway path can run the same cases against the same fake.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import {
  json,
  stubConfluenceWriteFetch,
  type ConfluenceWriteResponder,
  type SeenUpload,
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
const {
  approvalForId,
  approvalsForSession,
  resolveApproval,
  setApprovalBroadcastForTests,
} = await import("../../pendingApprovals.ts");
const { stageSessionAttachment } = await import("../../sessionAttachments.ts");

setApprovalBroadcastForTests(() => {});

const HOST = mkdtempSync(join(tmpdir(), "cfl-upload-oracle-"));

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(HOST, { recursive: true, force: true });
});

/** A host file under the oracle's temporary directory. */
function hostFile(name: string, content: string): string {
  const path = join(HOST, name);
  writeFileSync(path, content);
  return path;
}

interface UploadSent extends SeenUpload {
  path: string;
}

interface Observed {
  title: string;
  summary: string | undefined;
  text: string;
  body: unknown;
  status: string;
  resultSummary: string | undefined;
  resultUrl: string | undefined;
  error: string | undefined;
  /** What apply added to each item; the rest of the item is the card's. */
  outcomes: Outcome[];
  uploads: UploadSent[];
}

interface Outcome {
  resultPageId?: string;
  resultPageUrl?: string | null;
  resultVersion?: number | null;
  error?: string;
  warning?: string;
  attachment?: { resultId?: string | null; resultVersion?: number | null };
}

type Item = Record<string, unknown> & { attachment?: Record<string, unknown> };

const OUTCOME_KEYS = [
  "resultPageId",
  "resultPageUrl",
  "resultVersion",
  "error",
  "warning",
];
const ATTACHMENT_OUTCOME_KEYS = ["resultId", "resultVersion"];

/** Moves `keys` from `from` to a new record. */
function take(from: Record<string, unknown>, keys: string[]) {
  const taken: Record<string, unknown> = {};
  for (const key of keys)
    if (key in from) {
      taken[key] = from[key];
      delete from[key];
    }
  return taken;
}

/**
 * Splits an applied item into what apply added and the rest, which must be
 * the card's item unchanged.
 */
function outcomeOf(applied: Item): { outcome: Outcome; rest: Item } {
  const rest = structuredClone(applied);
  const outcome: Record<string, unknown> = take(rest, OUTCOME_KEYS);
  if (rest.attachment) {
    const added = take(rest.attachment, ATTACHMENT_OUTCOME_KEYS);
    if (Object.keys(added).length > 0) outcome["attachment"] = added;
  }
  return { outcome, rest };
}

interface UploadCase {
  name: string;
  /** The items, given this case's session (for its session attachments). */
  items: (sessionId: string) => unknown[];
  /** Answers before the fake site; `undefined` leaves a request to it. */
  answer?: () => ConfluenceWriteResponder;
  expected: Observed;
}

/** The values that differ per run, replaced by stable names. */
function normalized<T>(value: T): T {
  const staged = new Map<string, string>();
  const text = JSON.stringify(value)
    .replaceAll(HOST, "/HOST")
    .replace(/appr_\d+_[0-9a-f]{8}/g, "appr_ID")
    .replace(/\d{13}-[0-9a-z]{1,10}/g, (id) => {
      if (!staged.has(id)) staged.set(id, `STAGED_${staged.size + 1}`);
      return staged.get(id)!;
    });
  return text === undefined ? value : (JSON.parse(text) as T);
}

let session = 0;

async function observe(oracle: UploadCase): Promise<Observed> {
  const seen = stubConfluenceWriteFetch(oracle.answer?.());
  const sessionId = `confluence-upload-oracle-${(session += 1)}`;
  const result = await confluenceMutatePageTool.execute(
    { items: oracle.items(sessionId) } as never,
    { session: { sessionId }, toolCallId: "call-1" } as never,
  );
  const part = result.content[0];
  const proposed = approvalsForSession(sessionId).at(-1)!;
  const body = structuredClone(proposed.body);
  const before = seen.length;
  const { card } = await resolveApproval(proposed.id, "approved");
  const applied = approvalForId(proposed.id)?.body as unknown as {
    items: Item[];
  };
  const split = applied.items.map(outcomeOf);
  expect(split.map((part) => part.rest)).toEqual(
    (body as { items: unknown[] }).items,
  );
  const uploads = seen
    .slice(before)
    .filter((request) => request.upload !== undefined)
    .map((request) => ({ path: request.path, ...request.upload! }));
  return normalized({
    title: proposed.title,
    summary: proposed.summary,
    text: part?.type === "text" ? part.text : "",
    body,
    status: card.status,
    resultSummary: card.resultSummary,
    resultUrl: card.resultUrl,
    error: card.error,
    outcomes: split.map((part) => part.outcome),
    uploads,
  });
}

/** A session attachment `diagram-v3.png` under the id `src-1`. */
function sessionSource(sessionId: string): string {
  return stageSessionAttachment(sessionId, {
    id: "src-1",
    name: "diagram-v3.png",
    mimeType: "image/png",
    bytes: new TextEncoder().encode("new png"),
    source: "upload",
  }).id;
}

/** The attachment `att2`, `spec.pdf`, version 4 on page 123. */
const specPdf: () => ConfluenceWriteResponder = () => (request) =>
  request.method === "GET" && request.path === "/wiki/api/v2/attachments/att2"
    ? json({
        id: "att2",
        title: "spec.pdf",
        pageId: "123",
        status: "current",
        mediaType: "application/pdf",
        fileSize: 9,
        version: { number: 4 },
      })
    : undefined;

const CASES: UploadCase[] = [
  {
    name: "a new file from a host path, with a version message",
    items: () => [
      {
        operation: "uploadAttachment",
        page: "123",
        sourcePath: hostFile("notes.txt", "proposed"),
        versionMessage: "first cut",
      },
    ],
    expected: {
      title: "Upload notes.txt",
      summary: "upload notes.txt to Page 123",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Upload notes.txt](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "uploadAttachment",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            attachment: {
              fileName: "notes.txt",
              mediaType: "text/plain",
              size: 8,
              source: "/HOST/notes.txt",
              stagedAttachmentId: "STAGED_1",
              sha256:
                "81e766d8978e574dc9655e6143e02bb7826dd82dbe0b84c7c969e91abee021c5",
            },
            versionMessage: "first cut",
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 Confluence change(s)",
      resultUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
      error: undefined,
      outcomes: [
        {
          resultPageId: "123",
          resultPageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
          attachment: { resultId: "att9", resultVersion: 1 },
        },
      ],
      uploads: [
        {
          path: "/wiki/rest/api/content/123/child/attachment",
          fileName: "notes.txt",
          mediaType: "text/plain",
          text: "proposed",
          fields: [
            ["minorEdit", "true"],
            ["comment", "first cut"],
          ],
        },
      ],
    },
  },
  {
    name: "a session attachment as a new version by file name",
    items: (sessionId) => [
      {
        operation: "uploadAttachment",
        page: "123",
        fileName: "diagram.png",
        sourceAttachmentId: sessionSource(sessionId),
      },
    ],
    expected: {
      title: "Upload diagram.png",
      summary: "upload diagram.png to Page 123 · 1 warning(s)",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Warnings: diagram.png already exists on the page; the upload becomes version 3. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Upload diagram.png](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "uploadAttachment",
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
              size: 7,
              source: "session attachment diagram-v3.png",
              stagedAttachmentId: "src-1",
              sha256:
                "102c0e3e439cae5c9b55f93b666189bcf203e968b817d0e427e0e3bd751b54c8",
            },
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 Confluence change(s)",
      resultUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
      error: undefined,
      outcomes: [
        {
          resultPageId: "123",
          resultPageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
          attachment: { resultId: "att1", resultVersion: 3 },
        },
      ],
      uploads: [
        {
          path: "/wiki/rest/api/content/123/child/attachment/att1/data",
          fileName: "diagram.png",
          mediaType: "image/png",
          text: "new png",
          fields: [["minorEdit", "true"]],
        },
      ],
    },
  },
  {
    name: "source.bin uploaded as a new file named report.bin",
    items: () => [
      {
        operation: "uploadAttachment",
        page: "123",
        fileName: "report.bin",
        sourcePath: hostFile("source.bin", "\u0000\u0001binaryÿ"),
      },
    ],
    expected: {
      title: "Upload report.bin",
      summary: "upload report.bin to Page 123",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Upload report.bin](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "uploadAttachment",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            attachment: {
              fileName: "report.bin",
              mediaType: "application/octet-stream",
              size: 10,
              source: "/HOST/source.bin",
              stagedAttachmentId: "STAGED_1",
              sha256:
                "1bb35fa9f34646443d1600867d7ca30496c11f1ab9e678fdfd9cae1d5affca01",
            },
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 Confluence change(s)",
      resultUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
      error: undefined,
      outcomes: [
        {
          resultPageId: "123",
          resultPageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
          attachment: { resultId: "att9", resultVersion: 1 },
        },
      ],
      uploads: [
        {
          path: "/wiki/rest/api/content/123/child/attachment",
          fileName: "report.bin",
          mediaType: "application/octet-stream",
          text: "\u0000\u0001binaryÿ",
          fields: [["minorEdit", "true"]],
        },
      ],
    },
  },
  {
    name: "draft.pdf as a new version of the attachment titled spec.pdf",
    items: () => [
      {
        operation: "uploadAttachment",
        attachmentId: "att2",
        sourcePath: hostFile("draft.pdf", "%PDF-draft"),
      },
    ],
    answer: specPdf,
    expected: {
      title: "Upload spec.pdf",
      summary: "upload spec.pdf to Page 123 · 1 warning(s)",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Warnings: spec.pdf already exists on the page; the upload becomes version 5. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Upload spec.pdf](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "uploadAttachment",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            attachment: {
              fileName: "spec.pdf",
              existingId: "att2",
              baseVersion: 4,
              mediaType: "application/pdf",
              size: 10,
              source: "/HOST/draft.pdf",
              stagedAttachmentId: "STAGED_1",
              sha256:
                "a97f98fd3b316cb534e5baf5ea7074e39787f2c0923e1fb321b035876f2a24bb",
            },
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 Confluence change(s)",
      resultUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
      error: undefined,
      outcomes: [
        {
          resultPageId: "123",
          resultPageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
          attachment: { resultId: "att2", resultVersion: 3 },
        },
      ],
      uploads: [
        {
          path: "/wiki/rest/api/content/123/child/attachment/att2/data",
          fileName: "spec.pdf",
          mediaType: "application/pdf",
          text: "%PDF-draft",
          fields: [["minorEdit", "true"]],
        },
      ],
    },
  },
  {
    name: "one session attachment uploaded to two pages",
    items: (sessionId) => {
      const id = sessionSource(sessionId);
      return [
        { operation: "uploadAttachment", page: "123", sourceAttachmentId: id },
        { operation: "uploadAttachment", page: "124", sourceAttachmentId: id },
      ];
    },
    expected: {
      title: "Upload 2 Confluence attachments",
      summary:
        "upload diagram-v3.png to Page 123, upload diagram-v3.png to Page 124",
      text: "Prepared a Confluence proposal for 2 page(s) pending your approval. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Upload 2 Confluence attachments](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "uploadAttachment",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            attachment: {
              fileName: "diagram-v3.png",
              mediaType: "image/png",
              size: 7,
              source: "session attachment diagram-v3.png",
              stagedAttachmentId: "src-1",
              sha256:
                "102c0e3e439cae5c9b55f93b666189bcf203e968b817d0e427e0e3bd751b54c8",
            },
          },
          {
            clientId: "cfl_1",
            operation: "uploadAttachment",
            pageId: "124",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/124",
            title: "Page 124",
            spaceKey: "ENG",
            spaceName: "Engineering",
            attachment: {
              fileName: "diagram-v3.png",
              mediaType: "image/png",
              size: 7,
              source: "session attachment diagram-v3.png",
              stagedAttachmentId: "src-1",
              sha256:
                "102c0e3e439cae5c9b55f93b666189bcf203e968b817d0e427e0e3bd751b54c8",
            },
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 2 Confluence change(s)",
      resultUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
      error: undefined,
      outcomes: [
        {
          resultPageId: "123",
          resultPageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
          attachment: { resultId: "att9", resultVersion: 1 },
        },
        {
          resultPageId: "124",
          resultPageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/124",
          attachment: { resultId: "att9", resultVersion: 1 },
        },
      ],
      uploads: [
        {
          path: "/wiki/rest/api/content/123/child/attachment",
          fileName: "diagram-v3.png",
          mediaType: "image/png",
          text: "new png",
          fields: [["minorEdit", "true"]],
        },
        {
          path: "/wiki/rest/api/content/124/child/attachment",
          fileName: "diagram-v3.png",
          mediaType: "image/png",
          text: "new png",
          fields: [["minorEdit", "true"]],
        },
      ],
    },
  },
  {
    name: "an edit and an upload",
    items: () => [
      { page: "123", body: "Added" },
      {
        operation: "uploadAttachment",
        page: "123",
        sourcePath: hostFile("mixed.txt", "mixed"),
      },
    ],
    expected: {
      title: "2 Confluence changes",
      summary: "append Page 123, upload mixed.txt to Page 123",
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
            operation: "uploadAttachment",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            attachment: {
              fileName: "mixed.txt",
              mediaType: "text/plain",
              size: 5,
              source: "/HOST/mixed.txt",
              stagedAttachmentId: "STAGED_1",
              sha256:
                "3f8fee624f43b2a9d685353269a0ab3eac785863ab6227636db1060fba1855e0",
            },
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 2 Confluence change(s)",
      resultUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
      error: undefined,
      outcomes: [
        {
          resultPageId: "123",
          resultPageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
          resultVersion: 8,
        },
        {
          resultPageId: "123",
          resultPageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
          attachment: { resultId: "att9", resultVersion: 1 },
        },
      ],
      uploads: [
        {
          path: "/wiki/rest/api/content/123/child/attachment",
          fileName: "mixed.txt",
          mediaType: "text/plain",
          text: "mixed",
          fields: [["minorEdit", "true"]],
        },
      ],
    },
  },
  {
    name: "all failed: the upload is refused",
    items: () => [
      {
        operation: "uploadAttachment",
        page: "123",
        sourcePath: hostFile("refused.txt", "refused"),
      },
    ],
    answer: () => (request) =>
      request.upload !== undefined
        ? json({ message: "Refused by the fake site" }, 400)
        : undefined,
    expected: {
      title: "Upload refused.txt",
      summary: "upload refused.txt to Page 123",
      text: "Prepared a Confluence proposal for 1 page(s) pending your approval. Do not claim Confluence changed until the approved result appears. When you ask the user to decide, link the card: [Upload refused.txt](pa://approval/appr_ID).",
      body: {
        kind: "confluencePage",
        confluenceHost: "acme.atlassian.net",
        items: [
          {
            clientId: "cfl_0",
            operation: "uploadAttachment",
            pageId: "123",
            pageUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
            title: "Page 123",
            spaceKey: "ENG",
            spaceName: "Engineering",
            attachment: {
              fileName: "refused.txt",
              mediaType: "text/plain",
              size: 7,
              source: "/HOST/refused.txt",
              stagedAttachmentId: "STAGED_1",
              sha256:
                "83c874d33e8bff73caaa762c79cd1ed101d727c7f20fe4972c67e67978292f23",
            },
          },
        ],
      },
      status: "failed",
      resultSummary: undefined,
      resultUrl: undefined,
      error:
        'All 1 Confluence change(s) failed: Confluence API returned HTTP 400 for POST /wiki/rest/api/content/123/child/attachment: {"message":"Refused by the fake site"}',
      outcomes: [
        {
          error:
            'Confluence API returned HTTP 400 for POST /wiki/rest/api/content/123/child/attachment: {"message":"Refused by the fake site"}',
        },
      ],
      uploads: [
        {
          path: "/wiki/rest/api/content/123/child/attachment",
          fileName: "refused.txt",
          mediaType: "text/plain",
          text: "refused",
          fields: [["minorEdit", "true"]],
        },
      ],
    },
  },
];

test.each(CASES.map((oracle) => [oracle.name, oracle] as const))(
  "local confluence_mutate_page upload oracle: %s",
  async (_name, oracle) => {
    expect(await observe(oracle)).toEqual(oracle.expected);
  },
);
