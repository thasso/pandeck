/**
 * The vault's Slack access view on the edge (`slack.ts`, Task-1453): PR1's
 * view decodes, anything else (another kind, a bad id, a token that would
 * not fit a header, a non-number expiry, an Atlassian view) is refused, and
 * `describe` answers only the workspace's name. Every value is fake.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { FAKE_ACCESS, FAKE_CLOUD_ID } from "../test/atlassianFake.ts";
import { FAKE_SLACK_TOKENS } from "../test/slackFake.ts";
import { createEdgeTools } from "./index.ts";
import { decodeSlackAccessView, describeSlackAccessView } from "./slack.ts";

const VIEW = {
  kind: "slack-oauth",
  teamId: "TFAKE0001",
  teamName: "Fake Workspace",
  workspaceHost: "fake-workspace.slack.com",
  userId: "UFAKE0001",
  scope: "search:read,channels:history",
  accessToken: FAKE_SLACK_TOKENS.directAccess,
  expiresAt: 1_800_000_000_000,
};

const text = (change: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...VIEW, ...change });

test("PR1's access view decodes, with and without a team name", () => {
  const { kind: _kind, ...fields } = VIEW;
  assert.deepEqual(decodeSlackAccessView(text()), fields);
  const { teamName: _name, ...nameless } = fields;
  assert.deepEqual(
    decodeSlackAccessView(text({ teamName: undefined })),
    nameless,
  );
  // An Enterprise Grid host and a `W` user id are Slack's too.
  assert.ok(
    decodeSlackAccessView(
      text({
        workspaceHost: "fake-org.enterprise.slack.com",
        userId: "WFAKE1",
      }),
    ),
  );
});

test("anything else is refused", () => {
  for (const [label, credential] of [
    ["not JSON", "{"],
    ["an array", "[]"],
    ["null", "null"],
    ["no kind", text({ kind: undefined })],
    ["another kind", text({ kind: "atlassian-oauth" })],
    [
      "an Atlassian view",
      JSON.stringify({
        kind: "atlassian-oauth",
        site: "x.atlassian.net",
        cloudId: FAKE_CLOUD_ID,
        accessToken: FAKE_ACCESS,
        expiresAt: 1,
      }),
    ],
    ["a non-T team id", text({ teamId: "XFAKE0001" })],
    ["a lowercase team id", text({ teamId: "tfake0001" })],
    ["a numeric team name", text({ teamName: 7 })],
    ["an empty team name", text({ teamName: "" })],
    ["a long team name", text({ teamName: "x".repeat(257) })],
    ["a foreign host", text({ workspaceHost: "fake.slack.com.evil.test" })],
    ["a bad user id", text({ userId: "BFAKE0001" })],
    ["no scope", text({ scope: undefined })],
    ["no access token", text({ accessToken: undefined })],
    ["an empty access token", text({ accessToken: "" })],
    [
      "a token with a space",
      text({ accessToken: `${FAKE_SLACK_TOKENS.directAccess} x` }),
    ],
    [
      "a token with a newline",
      text({ accessToken: `${FAKE_SLACK_TOKENS.directAccess}\nx` }),
    ],
    ["a long token", text({ accessToken: "x".repeat(8_193) })],
    ["a string expiry", text({ expiresAt: "1800000000000" })],
    ["no expiry", text({ expiresAt: undefined })],
  ] as const)
    assert.equal(decodeSlackAccessView(credential), undefined, label);
});

test("describe answers the workspace's name only, through the edge's tools", () => {
  const { slack } = createEdgeTools({ log: () => {} }).integrations;
  assert.deepEqual(slack.describe(text()), { teamName: "Fake Workspace" });
  assert.deepEqual(slack.describe(text({ teamName: undefined })), {});
  assert.equal(slack.describe(text({ kind: "atlassian-oauth" })), undefined);
  // The name is passed as the vault holds it: the page's rule is the route's.
  assert.deepEqual(describeSlackAccessView(text({ teamName: "a\u001bb" })), {
    teamName: "a\u001bb",
  });
});
