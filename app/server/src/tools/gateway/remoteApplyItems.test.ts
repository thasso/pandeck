/**
 * Item granularity of a gateway apply (Task-1463 P6b, P6-O1): once the
 * edge's caller goes away during item 1, item 1 finishes and item 2 never
 * starts; the client, whose link lost the answer, fails the card with "may
 * have written" and merges nothing. The edge's real tool host behind the
 * port, the fetch-level fake Jira; every value is fake.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import * as linkDecoders from "../../gateway/clientMethods.ts";
import { createToolHost } from "../../gatewayTools/host.ts";
import { edgeTools } from "../../gatewayTools/tools.ts";
import { encodeAtlassianCredential } from "../../gatewayTools/atlassian.ts";
import { updateJiraSettings } from "../../jiraSettings.ts";
import {
  approvalForId,
  approvalsForSession,
  resolveApproval,
  setApprovalBroadcastForTests,
} from "../../pendingApprovals.ts";
import {
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
} from "../../remoteTools.ts";
import { edgeRemotePort } from "../../test/edgeRemotePort.ts";
import { stubJiraFetch } from "../../test/jiraEdgeFetch.ts";
import { fakeJiraAnswer, isWrite } from "../../test/jiraMutateFetch.ts";
import "../jira/jiraTools.ts";
import { remoteToolsFor } from "./remoteToolGroup.ts";

const SITE = "acme.atlassian.net";
const MAY_HAVE_WRITTEN =
  "The gateway did not confirm the result. Changes may have been written, and a change already sent can still finish within about a minute. Wait a minute, then check the site; ask again only for what is missing. Don't approve the same change again unchecked.";

afterEach(async () => {
  vi.unstubAllGlobals();
  setApprovalBroadcastForTests(null);
  await updateJiraSettings({ enabled: false });
});

test("a caller gone during item 1 lets item 1 finish, never starts item 2, and the lost answer fails the card unmerged", async () => {
  setApprovalBroadcastForTests(() => {});
  const gone = new AbortController();
  const seen = stubJiraFetch(async (request) => {
    // The link drops while item 1's comment is in flight.
    if (request.method === "POST" && request.path.endsWith("/comment"))
      gone.abort();
    return fakeJiraAnswer(request);
  });
  const credential = encodeAtlassianCredential({
    site: SITE,
    email: "me@x.test",
    token: "FAKE-TOKEN",
  });
  const host = createToolHost(edgeTools(), { log: () => {} });
  const edge = edgeRemotePort(
    host,
    () => ({
      clientId: "client-1",
      credential: () => Promise.resolve({ ok: true as const, credential }),
      signal: gone.signal,
    }),
    linkDecoders,
  );
  const answered: unknown[] = [];
  const uninstall = installRemoteToolPort({
    ...edge,
    // The edge answered; the link never read it.
    apply: async (name, site, items) => {
      answered.push(await edge.apply(name, site, items));
      return { outcome: "lost" };
    },
  });
  try {
    await updateJiraSettings({ enabled: true });
    applyListing(acceptRemoteTools(host.list()));
    const tool = remoteToolsFor("jira").find(
      (candidate) => candidate.name === "jira_mutate_issue",
    )!;
    const sessionId = "remote-apply-items";
    await tool.execute(
      {
        items: [
          { operation: "comment", issue: "STAR-1", commentBody: "One" },
          { operation: "comment", issue: "STAR-2", commentBody: "Two" },
        ],
      },
      { session: { sessionId }, toolCallId: "call-1" } as never,
    );
    const card = approvalsForSession(sessionId).at(-1)!;
    const proposed = structuredClone(card.body);

    const { card: decided } = await resolveApproval(card.id, "approved");
    assert.equal(decided.status, "failed");
    assert.equal(decided.error, MAY_HAVE_WRITTEN);
    assert.deepEqual(
      seen.filter(isWrite).map((request) => request.path),
      ["/rest/api/3/issue/STAR-1/comment"],
    );
    // What the edge would have said: item 1 written, item 2 stopped.
    assert.deepEqual(
      answered.map((outcome) =>
        (
          outcome as {
            answer: { effects: string; results: { effects: string }[] };
          }
        ).answer.results.map((record) => record.effects),
      ),
      [["possible", "none"]],
    );
    assert.deepEqual(approvalForId(card.id)?.body, proposed);
  } finally {
    uninstall();
  }
});
