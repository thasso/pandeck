/**
 * Request order of `confluence_mutate_page`'s attachment staging and apply
 * (Task-1463 P5a, B2), as the network sees it: the local tool and its approval
 * executor over the REAL client and transport, with only the global `fetch`
 * faked and the settings stubbed.
 *
 * The expected traces are literals taken from the source before the move into
 * the shared modules (`tools/confluence/confluenceAttachments.ts` at
 * `a11d514`), not derived from the code under test:
 * - staging reads the attachment by id (`:201-207`), then the page
 *   (`:226-231`), then freezes the upload (`:254`) and only then looks the
 *   name up (`:255-257`); a delete never freezes (`:233-252`);
 * - apply reads the staged bytes (`:400`) before any request, then verifies
 *   the existing attachment (`:401-404`) or checks the name (`:405-411`), and
 *   uploads last (`:423-425`); a delete is a verify and a DELETE (`:392-398`).
 *
 * The freeze is a session-store write, so its place in the order shows as
 * state: each upload stages a NEW host file into a NEW session, so a staged
 * record seen inside the name lookup cannot have existed before the proposal.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../confluenceSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../confluenceSettings.ts")>()),
  getConfluenceToolConfig: () => ({
    host: "example.atlassian.net",
    atlassianEmail: "a@b.c",
    atlassianToken: "t",
  }),
}));

const { confluenceMutatePageTool } = await import("./confluenceTools.ts");
const { approvalsForSession, resolveApproval, setApprovalBroadcastForTests } =
  await import("../../pendingApprovals.ts");
const { listSessionAttachments, resolveSessionAttachment } =
  await import("../../sessionAttachments.ts");
const { setRetrySleepForTests } = await import("../../httpRetry.ts");

setApprovalBroadcastForTests(() => {});

const originalFetch = globalThis.fetch;

/** The page's attachments; a test moves a version like another uploader would. */
let attachments: Array<Record<string, unknown>> = [];
/** Pages that answer 404. */
let missingPages = new Set<string>();
/** Called inside the fake before it answers, so a test can observe state mid-flight. */
let onRequest: (event: string) => void = () => {};
let events: string[] = [];

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    id: "att1",
    title: "diagram.png",
    pageId: "123",
    // Present so these fixtures stay valid where a delete needs it.
    status: "current",
    mediaType: "image/png",
    fileSize: 4,
    version: { number: 2 },
    ...overrides,
  };
}

/** `METHOD class` for each request, the class naming what was asked for. */
function classify(method: string, url: URL): string {
  const path = url.pathname;
  if (/^\/wiki\/api\/v2\/pages\/\d+$/.test(path)) return `${method} page`;
  if (/^\/wiki\/api\/v2\/pages\/\d+\/attachments$/.test(path))
    return `${method} attachments by name ${url.searchParams.get("filename")}`;
  if (/^\/wiki\/api\/v2\/attachments\/[^/]+$/.test(path))
    return `${method} attachment`;
  if (/^\/wiki\/api\/v2\/spaces\/\d+$/.test(path)) return `${method} space`;
  if (path.endsWith("/data")) return `${method} …/data`;
  if (path.endsWith("/child/attachment")) return `${method} …/child/attachment`;
  return `${method} ${path}`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function answer(method: string, url: URL): Response {
  const path = url.pathname;
  const page = path.match(/^\/wiki\/api\/v2\/pages\/(\d+)$/)?.[1];
  if (page) {
    if (missingPages.has(page)) return json({ message: "Not found" }, 404);
    return json({
      id: page,
      title: "Runbook",
      status: "current",
      spaceId: "900",
      version: { number: 7 },
    });
  }
  if (/^\/wiki\/api\/v2\/pages\/\d+\/attachments$/.test(path))
    return json({
      results: attachments.filter(
        (row) => row["title"] === url.searchParams.get("filename"),
      ),
    });
  const id = path.match(/^\/wiki\/api\/v2\/attachments\/([^/]+)$/)?.[1];
  if (id && method === "GET") {
    const found = attachments.find((row) => row["id"] === id);
    return found ? json(found) : json({ message: "Not found" }, 404);
  }
  if (path === "/wiki/api/v2/spaces/900")
    return json({ id: "900", key: "ENG", name: "Engineering" });
  if (path.endsWith("/data"))
    return json({ id: "att1", version: { number: 3 } });
  if (path.endsWith("/child/attachment"))
    return json({ results: [{ id: "att9", version: { number: 1 } }] });
  if (method === "DELETE") return new Response(null, { status: 204 });
  return json({ message: `unexpected ${method} ${path}` }, 500);
}

beforeEach(() => {
  attachments = [attachment()];
  missingPages = new Set();
  onRequest = () => {};
  events = [];
  setRetrySleepForTests(async () => {});
  globalThis.fetch = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const event = classify(method, url);
    events.push(event);
    onRequest(event);
    return answer(method, url);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRetrySleepForTests(null);
});

let sessionCounter = 0;
const newSession = () => `cfl-order-${process.pid}-${sessionCounter++}`;

/** A file on this host that no session has staged yet. */
function hostFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cfl-order-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

async function propose(sessionId: string, item: Record<string, unknown>) {
  await confluenceMutatePageTool.execute(
    { items: [item] } as never,
    { session: { sessionId } } as never,
  );
  const card = approvalsForSession(sessionId).at(-1);
  if (!card || card.body.kind !== "confluencePage")
    throw new Error("no confluence approval staged");
  return card;
}

/** Names of the session's staged records, as they are at this moment. */
const stagedNames = (sessionId: string) =>
  listSessionAttachments(sessionId).map((record) => record.name);

describe("staging order (old-source traces)", () => {
  test("upload by page and fileName: page, then freeze, then the name lookup", async () => {
    const sessionId = newSession();
    const seen: Record<string, string[]> = {};
    onRequest = (event) => {
      seen[event] = stagedNames(sessionId);
    };
    await propose(sessionId, {
      operation: "uploadAttachment",
      page: "123",
      fileName: "renamed.txt",
      sourcePath: hostFile("notes.txt", "v1"),
    });
    expect(events).toEqual([
      "GET page",
      "GET attachments by name renamed.txt",
      "GET space",
    ]);
    // Not staged when the page was read, staged by the time of the lookup.
    expect(seen["GET page"]).toEqual([]);
    expect(seen["GET attachments by name renamed.txt"]).toEqual(["notes.txt"]);
  });

  test("upload by page without fileName looks up the frozen record's name", async () => {
    const sessionId = newSession();
    const seen: Record<string, string[]> = {};
    onRequest = (event) => {
      seen[event] = stagedNames(sessionId);
    };
    await propose(sessionId, {
      operation: "uploadAttachment",
      page: "123",
      sourcePath: hostFile("fresh-notes.txt", "v1"),
    });
    expect(events).toEqual([
      "GET page",
      "GET attachments by name fresh-notes.txt",
      "GET space",
    ]);
    expect(seen["GET page"]).toEqual([]);
    expect(seen["GET attachments by name fresh-notes.txt"]).toEqual([
      "fresh-notes.txt",
    ]);
  });

  test("upload by attachmentId: attachment, then page, then freeze; no name lookup", async () => {
    const sessionId = newSession();
    const seen: Record<string, string[]> = {};
    onRequest = (event) => {
      seen[event] = stagedNames(sessionId);
    };
    await propose(sessionId, {
      operation: "uploadAttachment",
      attachmentId: "att1",
      sourcePath: hostFile("diagram.png", "mine"),
    });
    expect(events).toEqual(["GET attachment", "GET page", "GET space"]);
    expect(seen["GET attachment"]).toEqual([]);
    expect(seen["GET page"]).toEqual([]);
    // Frozen after the page read: the space read comes after staging.
    expect(seen["GET space"]).toEqual(["diagram.png"]);
  });

  test("upload whose page read fails: the page only, and nothing is staged", async () => {
    const sessionId = newSession();
    missingPages = new Set(["404"]);
    await expect(
      propose(sessionId, {
        operation: "uploadAttachment",
        page: "404",
        sourcePath: hostFile("notes.txt", "v1"),
      }),
    ).rejects.toThrow(/HTTP 404/);
    expect(events).toEqual(["GET page"]);
    expect(stagedNames(sessionId)).toEqual([]);
  });

  test("upload by an attachmentId on another page: the attachment only", async () => {
    const sessionId = newSession();
    attachments = [attachment({ id: "att5", pageId: "555" })];
    await expect(
      propose(sessionId, {
        operation: "uploadAttachment",
        attachmentId: "att5",
        page: "123",
        sourcePath: hostFile("notes.txt", "v1"),
      }),
    ).rejects.toThrow(/belongs to page 555, not 123/);
    expect(events).toEqual(["GET attachment"]);
    expect(stagedNames(sessionId)).toEqual([]);
  });

  test("deleteAttachment by id: attachment, then page; never staged", async () => {
    const sessionId = newSession();
    await propose(sessionId, {
      operation: "deleteAttachment",
      attachmentId: "att1",
    });
    expect(events).toEqual(["GET attachment", "GET page", "GET space"]);
    expect(stagedNames(sessionId)).toEqual([]);
  });

  test("deleteAttachment by name: page, then the name lookup; never staged", async () => {
    const sessionId = newSession();
    await propose(sessionId, {
      operation: "deleteAttachment",
      page: "123",
      fileName: "diagram.png",
    });
    expect(events).toEqual([
      "GET page",
      "GET attachments by name diagram.png",
      "GET space",
    ]);
    expect(stagedNames(sessionId)).toEqual([]);
  });
});

describe("apply order (old-source traces)", () => {
  async function approve(sessionId: string) {
    events = [];
    return resolveApproval(
      approvalsForSession(sessionId).at(-1)!.id,
      "approved",
    );
  }

  test("upload onto an existing attachment: verify, then POST …/data", async () => {
    const sessionId = newSession();
    await propose(sessionId, {
      operation: "uploadAttachment",
      attachmentId: "att1",
      sourcePath: hostFile("diagram.png", "mine"),
    });
    await approve(sessionId);
    expect(events).toEqual(["GET attachment", "POST …/data"]);
  });

  test("upload as a new file: name check, then POST …/child/attachment", async () => {
    const sessionId = newSession();
    await propose(sessionId, {
      operation: "uploadAttachment",
      page: "123",
      sourcePath: hostFile("brand-new.txt", "v1"),
    });
    await approve(sessionId);
    expect(events).toEqual([
      "GET attachments by name brand-new.txt",
      "POST …/child/attachment",
    ]);
  });

  test("upload whose staged bytes changed: no request at all", async () => {
    const sessionId = newSession();
    const card = await propose(sessionId, {
      operation: "uploadAttachment",
      attachmentId: "att1",
      sourcePath: hostFile("diagram.png", "mine"),
    });
    const stagedId = (
      card.body as {
        items: Array<{ attachment?: { stagedAttachmentId?: string } }>;
      }
    ).items[0]!.attachment!.stagedAttachmentId!;
    writeFileSync(resolveSessionAttachment(sessionId, stagedId)!.path, "other");
    const resolved = await approve(sessionId);
    expect(resolved?.card.error).toMatch(/changed after it was approved/);
    expect(events).toEqual([]);
  });

  test("upload whose attachment moved on: the verify only, no POST", async () => {
    const sessionId = newSession();
    await propose(sessionId, {
      operation: "uploadAttachment",
      attachmentId: "att1",
      sourcePath: hostFile("diagram.png", "mine"),
    });
    attachments = [attachment({ version: { number: 3 } })];
    const resolved = await approve(sessionId);
    expect(resolved?.card.error).toMatch(/version 2 → 3/);
    expect(events).toEqual(["GET attachment"]);
  });

  test("deleteAttachment: verify, then one DELETE", async () => {
    const sessionId = newSession();
    await propose(sessionId, {
      operation: "deleteAttachment",
      page: "123",
      fileName: "diagram.png",
    });
    await approve(sessionId);
    expect(events).toEqual(["GET attachment", "DELETE attachment"]);
  });
});
