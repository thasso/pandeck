/**
 * Gateway cards end to end (Task-1463 P6b, plan v03 P6-F4 and P6-F1/F3):
 * the remote tool raises the card from the edge's real `tools.prepare`, and
 * `resolveApproval` applies it through the edge's real `tools.apply`, both
 * through the link's decoders, against the fetch-level fake Atlassian. The
 * card, its error or summary and the outcome prompt are what the user and
 * the agent see. Every value is fake.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalCard } from "@assistant/shared";
import { afterEach, test, vi } from "vitest";
import { updateConfluenceSettings } from "../../confluenceSettings.ts";
import * as linkDecoders from "../../gateway/clientMethods.ts";
import { encodeAtlassianCredential } from "../../gatewayTools/atlassian.ts";
import { createToolHost } from "../../gatewayTools/host.ts";
import { edgeTools } from "../../gatewayTools/tools.ts";
import {
  MCP_UPLOAD_UNAVAILABLE,
  UPLOAD_UNAVAILABLE,
} from "../../gatewayTools/confluenceMutatePage.ts";
import { SITE_CHANGED, STOPPED } from "../../gatewayTools/twoPhase.ts";
import { updateJiraSettings } from "../../jiraSettings.ts";
import {
  approvalsForSession,
  resolveApproval,
  setApprovalBroadcastForTests,
} from "../../pendingApprovals.ts";
import {
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
} from "../../remoteTools.ts";
import { listSessionAttachments } from "../../sessionAttachments.ts";
import { FAKE_CLOUD_ID } from "../../test/atlassianFake.ts";
import { stubConfluenceWriteFetch } from "../../test/confluenceMutateFetch.ts";
import { edgeRemotePort } from "../../test/edgeRemotePort.ts";
import { json, stubJiraFetch } from "../../test/jiraEdgeFetch.ts";
import { fakeJiraAnswer } from "../../test/jiraMutateFetch.ts";
import "../confluence/confluenceTools.ts";
import "../jira/jiraTools.ts";
import { remoteToolsFor } from "./remoteToolGroup.ts";

const SITE = "acme.atlassian.net";
/** The fake API token's value; a fake, like every value here. */
const SENTINEL = "FAKE-TOKEN-SENTINEL-0123456789";
const TOKEN = encodeAtlassianCredential({
  site: SITE,
  email: "me@x.test",
  token: SENTINEL,
});
const PARTIAL_EFFECTS =
  "Some failed changes may have been partly written before they failed; the card shows each item's outcome. Check the site and ask again only for what is missing. Don't approve the same change again unchecked.";

/** An OAuth credential whose access token is `accessToken`. */
const oauth = (accessToken: string): string =>
  JSON.stringify({
    kind: "atlassian-oauth",
    site: SITE,
    cloudId: FAKE_CLOUD_ID,
    accessToken,
    expiresAt: Date.now() + 600_000,
  });

let session = 0;

afterEach(async () => {
  vi.unstubAllGlobals();
  setApprovalBroadcastForTests(null);
  await updateJiraSettings({ enabled: false });
  updateConfluenceSettings({ enabled: false });
});

interface Run {
  card: ApprovalCard;
  outcomePrompt: string;
  /** The whole persisted card as JSON, for secret checks. */
  stored: string;
}

interface Options {
  credential?: string;
  /** The credential the apply reads, when not the prepare's. */
  applyCredential?: string;
  /** Reaches only the apply's caller. */
  applySignal?: AbortSignal;
}

/**
 * Connects the real edge for `product` and runs the gateway's write with
 * `items`: the session it proposed in. Throws the tool's refusal.
 */
async function propose(
  product: "jira" | "confluence",
  items: unknown[],
  options: Options,
): Promise<{ sessionId: string; uninstall: () => void }> {
  setApprovalBroadcastForTests(() => {});
  const credential = options.credential ?? TOKEN;
  const host = createToolHost(edgeTools(), { log: () => {} });
  let applying = false;
  const port = edgeRemotePort(
    host,
    () => ({
      clientId: "client-1",
      credential: () =>
        Promise.resolve({
          ok: true as const,
          credential: (applying && options.applyCredential) || credential,
        }),
      ...(applying && options.applySignal
        ? { signal: options.applySignal }
        : {}),
    }),
    linkDecoders,
  );
  const uninstall = installRemoteToolPort({
    ...port,
    apply: (name, site, sent) => {
      applying = true;
      return port.apply(name, site, sent);
    },
  });
  try {
    if (product === "jira") await updateJiraSettings({ enabled: true });
    else updateConfluenceSettings({ enabled: true });
    applyListing(acceptRemoteTools(host.list()));
    const tool = remoteToolsFor(product).find((candidate) =>
      candidate.name.includes("mutate"),
    )!;
    const sessionId = `remote-apply-edge-${(session += 1)}`;
    await tool.execute({ items }, {
      session: { sessionId },
      toolCallId: "call-1",
    } as never);
    return { sessionId, uninstall };
  } catch (err) {
    uninstall();
    throw err;
  }
}

/** Proposes `items` with the gateway's write for `product` and approves the card. */
async function proposeAndApprove(
  product: "jira" | "confluence",
  items: unknown[],
  options: Options = {},
): Promise<Run> {
  const { sessionId, uninstall } = await propose(product, items, options);
  try {
    const proposed = approvalsForSession(sessionId).at(-1)!;
    const { card, outcomePrompt } = await resolveApproval(
      proposed.id,
      "approved",
    );
    return { card, outcomePrompt, stored: JSON.stringify(card) };
  } finally {
    uninstall();
  }
}

/** The refusal the agent sees when the edge's prepare refuses `items`. */
async function prepareRefusal(
  product: "jira" | "confluence",
  items: unknown[],
): Promise<string> {
  const refused = await propose(product, items, {}).then(
    ({ uninstall }) => {
      uninstall();
      return undefined;
    },
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  assert.ok(refused !== undefined, "the prepare was not refused");
  return refused;
}

/** How often `text` says nothing was written. */
const claims = (text: string) => text.match(/nothing was written/gi)?.length;

const jiraItems = (card: ApprovalCard) =>
  card.body.kind === "jiraIssue" ? card.body.items : [];
const confluenceItems = (card: ApprovalCard) =>
  card.body.kind === "confluencePage" ? card.body.items : [];

test("v03 case 1: a link added, then the field update refused: failed with the all-failed text and PARTIAL_EFFECTS, the link's resultOk kept", async () => {
  stubJiraFetch((request) =>
    request.method === "PUT" && request.path === "/rest/api/3/issue/STAR-1"
      ? json({ errorMessages: ["Field refused"] }, 400)
      : fakeJiraAnswer(request),
  );
  const { card, outcomePrompt } = await proposeAndApprove("jira", [
    {
      issue: "STAR-1",
      summary: "Linked summary",
      linkChanges: [
        { op: "add", type: "Blocks", direction: "outward", issue: "STAR-2" },
      ],
    },
  ]);
  const [item] = jiraItems(card);
  assert.equal(card.status, "failed");
  assert.ok(item?.error, "the item failed");
  assert.equal(
    card.error,
    `All 1 Jira change(s) failed: ${item.error} ${PARTIAL_EFFECTS}`,
  );
  assert.equal(item.linkChanges?.[0]?.resultOk, true);
  assert.ok(outcomePrompt.includes(PARTIAL_EFFECTS));
  assert.doesNotMatch(card.error, /nothing was written/i);
});

test("v03 case 4: two items stopped before writing: all failed, root none, Nothing was written", async () => {
  const seen = stubJiraFetch((request) => fakeJiraAnswer(request));
  const gone = new AbortController();
  gone.abort();
  const { card, outcomePrompt } = await proposeAndApprove(
    "jira",
    [
      { operation: "comment", issue: "STAR-1", commentBody: "One" },
      { operation: "comment", issue: "STAR-2", commentBody: "Two" },
    ],
    { applySignal: gone.signal },
  );
  assert.equal(card.status, "failed");
  assert.equal(
    card.error,
    `All 2 Jira change(s) failed: ${STOPPED}; ${STOPPED} Nothing was written.`,
  );
  assert.ok(outcomePrompt.includes("Nothing was written."));
  assert.deepEqual(
    seen.filter((request) => request.method === "POST"),
    [],
  );
});

test("P6a v03: a created key equal to the token finishes with issueKey '', a null result key and no link", async () => {
  const keyShaped = "TOKENKEY-123456";
  stubJiraFetch((request) =>
    fakeJiraAnswer(request, { createdKey: keyShaped }),
  );
  const { card, stored } = await proposeAndApprove(
    "jira",
    [
      {
        operation: "create",
        projectKey: "STAR",
        issueType: "Task",
        summary: "A new task",
      },
    ],
    {
      credential: encodeAtlassianCredential({
        site: SITE,
        email: "me@x.test",
        token: keyShaped,
      }),
    },
  );
  const [item] = jiraItems(card);
  assert.equal(card.status, "executed");
  assert.equal(card.resultSummary, "Applied 1 change(s)");
  assert.equal(card.resultUrl, undefined);
  assert.equal(item?.issueKey, "");
  assert.equal(item?.resultIssueKey, null);
  assert.equal(item?.resultIssueUrl, undefined);
  assert.ok(!stored.includes(keyShaped), "the token reached the card");
});

test("P6a v03: a rank order holding a key-shaped token finishes without the order", async () => {
  const fakeAccess = "OAUTHKEY-98765432";
  let ranked = false;
  stubJiraFetch((request) => {
    if (
      request.method === "PUT" &&
      request.path === "/rest/agile/1.0/issue/rank"
    )
      ranked = true;
    if (ranked && request.path === "/rest/api/3/search/jql")
      return json({
        issues: [{ key: "STAR-2" }, { key: fakeAccess }, { key: "STAR-1" }],
      });
    return fakeJiraAnswer(request);
  });
  const { card, stored } = await proposeAndApprove(
    "jira",
    [
      {
        operation: "rank",
        rankIssues: ["STAR-2", "STAR-3"],
        rankPosition: "before",
        rankTargetIssue: "STAR-1",
      },
    ],
    { credential: oauth(fakeAccess) },
  );
  const [item] = jiraItems(card);
  assert.equal(card.status, "executed");
  assert.equal(card.resultSummary, "Applied 1 change(s)");
  assert.equal(item?.rankResultOrder, undefined);
  assert.ok(item?.rankSteps, "the rank steps are kept");
  assert.ok(!stored.includes(fakeAccess), "the token reached the card");
});

test("P6a v03: a created page id equal to a 16-digit token finishes with a null page id and no link", async () => {
  const fakeAccess = "1234567890123456";
  const seen = stubConfluenceWriteFetch(undefined, { createdId: fakeAccess });
  const { card, stored } = await proposeAndApprove(
    "confluence",
    [
      {
        operation: "create",
        spaceKey: "ENG",
        title: "New page",
        body: "Hello",
      },
    ],
    { credential: oauth(fakeAccess) },
  );
  const [item] = confluenceItems(card);
  assert.equal(card.status, "executed");
  assert.equal(card.resultUrl, undefined);
  assert.equal(item?.resultPageId, null);
  assert.equal(item?.resultPageUrl, undefined);
  assert.ok(seen.some((request) => request.method === "POST"));
  assert.ok(!stored.includes(fakeAccess), "the token reached the card");
});

// --- the edge's own "nothing was written" (final-b C2, F006) -------------

test("a prepare refusal in the edge's D-W2 wording keeps its own claim and gains no second one", async () => {
  stubJiraFetch((request) =>
    request.path === "/rest/api/3/issue/STAR-404"
      ? json({ errorMessages: ["Issue does not exist"] }, 404)
      : fakeJiraAnswer(request),
  );
  const text = await prepareRefusal("jira", [
    { issue: "STAR-404", summary: "Renamed" },
  ]);
  assert.equal(text, "Jira answered HTTP 404. Nothing was written to Jira.");
  assert.equal(claims(text), 1, text);
});

test("a Confluence prepare gate's refusal is the edge's text as is, and the frozen copy is discarded", async () => {
  // This port drops `uploads`, as an edge before 1.3 would: its gate
  // refuses the item (v02 PR boundary), after Pandeck froze the file.
  stubConfluenceWriteFetch();
  const dir = mkdtempSync(join(tmpdir(), "remote-apply-edge-"));
  try {
    const path = join(dir, "x.txt");
    writeFileSync(path, "bytes");
    const text = await prepareRefusal("confluence", [
      { operation: "uploadAttachment", page: "123", sourcePath: path },
    ]);
    assert.equal(text, UPLOAD_UNAVAILABLE);
    // Client mode keeps P5b's text, never `/mcp`'s (P7b v07 R1).
    assert.notEqual(text, MCP_UPLOAD_UNAVAILABLE);
    assert.equal(claims(text), 1, text);
    assert.deepEqual(
      listSessionAttachments(`remote-apply-edge-${session}`),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an apply refused because the gateway's site changed is SITE_CHANGED as is, certified, nothing sent", async () => {
  const seen = stubJiraFetch((request) => fakeJiraAnswer(request));
  const { card, outcomePrompt } = await proposeAndApprove(
    "jira",
    [{ operation: "comment", issue: "STAR-1", commentBody: "One" }],
    {
      applyCredential: encodeAtlassianCredential({
        site: "other.atlassian.net",
        email: "me@x.test",
        token: SENTINEL,
      }),
    },
  );
  assert.equal(card.status, "failed");
  assert.equal(card.error, SITE_CHANGED);
  assert.equal(claims(card.error), 1);
  assert.ok(outcomePrompt.includes(SITE_CHANGED));
  assert.deepEqual(
    seen.filter((request) => request.method !== "GET"),
    [],
  );
});

test("an upstream reason that says nothing was written, on a path that may have written, gains no claim: the card ends with PARTIAL_EFFECTS", async () => {
  stubJiraFetch((request) =>
    request.method === "PUT" && request.path === "/rest/api/3/issue/STAR-1"
      ? json({ errorMessages: ["Nothing was written."] }, 400)
      : fakeJiraAnswer(request),
  );
  const { card } = await proposeAndApprove("jira", [
    {
      issue: "STAR-1",
      summary: "Linked summary",
      linkChanges: [
        { op: "add", type: "Blocks", direction: "outward", issue: "STAR-2" },
      ],
    },
  ]);
  const [item] = jiraItems(card);
  assert.equal(card.status, "failed");
  // The upstream reason, quoted by the edge in the item's own error.
  assert.match(item?.error ?? "", /Nothing was written\./);
  assert.equal(
    card.error,
    `All 1 Jira change(s) failed: ${item!.error} ${PARTIAL_EFFECTS}`,
  );
  assert.equal(claims(card.error), 1, "only the quoted upstream reason");
});
