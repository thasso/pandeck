/**
 * Gateway cards end to end (Task-1463 P6b, plan v03 P6-F4 and P6-F1/F3):
 * the remote tool raises the card from the edge's real `tools.prepare`, and
 * `resolveApproval` applies it through the edge's real `tools.apply`, both
 * through the link's decoders, against the fetch-level fake Atlassian. The
 * card, its error or summary and the outcome prompt are what the user and
 * the agent see. Every value is fake.
 */
import assert from "node:assert/strict";
import type { ApprovalCard } from "@assistant/shared";
import { afterEach, test, vi } from "vitest";
import { updateConfluenceSettings } from "../../confluenceSettings.ts";
import * as linkDecoders from "../../gateway/clientMethods.ts";
import { encodeAtlassianCredential } from "../../gatewayTools/atlassian.ts";
import { createToolHost } from "../../gatewayTools/host.ts";
import { edgeTools } from "../../gatewayTools/tools.ts";
import { STOPPED } from "../../gatewayTools/twoPhase.ts";
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

/**
 * Proposes `items` with the gateway's write for `product` and approves the
 * card. `applySignal` reaches only the apply's caller.
 */
async function proposeAndApprove(
  product: "jira" | "confluence",
  items: unknown[],
  options: { credential?: string; applySignal?: AbortSignal } = {},
): Promise<Run> {
  setApprovalBroadcastForTests(() => {});
  const credential = options.credential ?? TOKEN;
  const host = createToolHost(edgeTools(), { log: () => {} });
  let applying = false;
  const port = edgeRemotePort(
    host,
    () => ({
      clientId: "client-1",
      credential: () => Promise.resolve({ ok: true as const, credential }),
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
