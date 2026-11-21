/**
 * D-W2 (`writeFailure.ts`, Task-1463): one case per rule, in order, with
 * sentinels. `BODY_SENTINEL` sits in Jira's raw body (the error's message)
 * outside `errorMessages`, `REASON_SENTINEL` inside them, and the token and
 * its Basic forms are offered too: the body never shows, the reasons only for
 * a write call's 4xx, the credential never. Wrapped cases run the shared core
 * over a stubbed `fetch`. Every value is fake.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { JiraIssueMutationItemDisplay } from "@assistant/shared/jiraMutation";
import { AtlassianHttpError } from "../atlassian/atlassianFetch.ts";
import { setRetrySleepForTests } from "../httpRetry.ts";
import { applyJiraMutationItems } from "../jiraMutateApply.ts";
import {
  JiraMutationError,
  JiraWriteHttpError,
} from "../jiraMutationErrors.ts";
import { JiraReadRefusal } from "../jiraRead.ts";
import { assertNoCredential } from "../test/credentialOracle.ts";
import { json, stubJiraFetch } from "../test/jiraEdgeFetch.ts";
import { jiraConfigOf } from "./atlassian.ts";
import { FAKE_ACCESS } from "../test/atlassianFake.ts";
import type { AtlassianCredential } from "./descriptor.ts";
import { describeWriteFailure } from "./writeFailure.ts";

const TOKEN = "FAKE-TOKEN-SENTINEL-0123456789";
const CREDENTIAL: AtlassianCredential = {
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: TOKEN,
};
const OAUTH: AtlassianCredential = {
  site: "acme.atlassian.net",
  cloudId: "00000000-0000-4000-8000-00000000fa4e",
  accessToken: FAKE_ACCESS,
};
const BASIC = Buffer.from(`me@x.test:${TOKEN}`).toString("base64");
const BODY_SENTINEL = "BODY-SENTINEL-raw-jira-body";
const REASON_SENTINEL = "REASON-SENTINEL summary is too long";
const TOKEN_REMEDY =
  "Atlassian rejected the credential; reconnect Jira in Pandeck's Settings.";
const OAUTH_REMEDY =
  "Atlassian rejected the credential; sign in with Atlassian again on the gateway's page.";
const FORBIDDEN = [BODY_SENTINEL, TOKEN, BASIC, BASIC.replace(/=+$/, "")];

afterEach(() => {
  vi.unstubAllGlobals();
  setRetrySleepForTests(null);
});

const body = `{"errorMessages":["${REASON_SENTINEL}"],"x":"${BODY_SENTINEL} ${TOKEN} ${BASIC}"}`;
const writeError = (status: number, reasons?: readonly string[]) =>
  new JiraWriteHttpError(
    `Jira API returned HTTP ${status} for POST /rest/api/3/issue: ${body}`,
    status,
    reasons,
  );
const readError = (status: number, reasons?: readonly string[]) =>
  new AtlassianHttpError(
    `Jira API returned HTTP ${status} for GET /rest/api/3/issue/STAR-1: ${body}`,
    status,
    reasons,
  );

function describe(err: unknown, credential = CREDENTIAL): string {
  const text = describeWriteFailure(err, credential);
  for (const forbidden of FORBIDDEN)
    assert.ok(!text.includes(forbidden), `${text} holds ${forbidden}`);
  assertNoCredential(text, credential);
  return text;
}

test("rule 1: an abort is rethrown, by its name or by a phase signal", () => {
  const abort = new DOMException("aborted", "AbortError");
  assert.throws(
    () => describeWriteFailure(abort, CREDENTIAL),
    (err) => err === abort,
  );
  const controller = new AbortController();
  controller.abort();
  const other = writeError(400, [REASON_SENTINEL]);
  assert.throws(
    () => describeWriteFailure(other, CREDENTIAL, [controller.signal]),
    (err) => err === other,
  );
});

test("rule 2: the code's own text, vetted and capped at 1,000", () => {
  assert.equal(
    describe(new JiraMutationError("Requested transition is not available.")),
    "Requested transition is not available.",
  );
  const long = describe(new JiraMutationError("x".repeat(1_500)));
  assert.equal(long.length, 1_000);
  assert.ok(long.endsWith("…"));
  assert.equal(
    describe(new JiraMutationError(`transition named ${TOKEN}`)),
    "transition named [redacted]",
  );
  assert.equal(
    describe(new JiraMutationError("Authorization: x")),
    "[redacted]: x",
  );
});

test("rule 3: 401 and 403 are the credential's remedy, for writes and reads", () => {
  for (const err of [
    writeError(401, [REASON_SENTINEL]),
    writeError(403, [REASON_SENTINEL]),
    readError(401),
    readError(403, [REASON_SENTINEL]),
  ]) {
    assert.equal(describe(err), TOKEN_REMEDY);
    assert.equal(describe(err, OAUTH), OAUTH_REMEDY);
  }
});

test("rule 4: a write call's 4xx shows Jira's reasons when present and safe", () => {
  assert.equal(
    describe(writeError(400, [REASON_SENTINEL, "  ", "field x is required"])),
    `Jira refused the change (HTTP 400): ${REASON_SENTINEL}; field x is required`,
  );
  assert.equal(
    describe(writeError(404, [REASON_SENTINEL])),
    `Jira refused the change (HTTP 404): ${REASON_SENTINEL}`,
  );
  assert.equal(
    describe(writeError(400)),
    "Jira refused the change (HTTP 400).",
  );
  // Each span that carries the secret, or a marker, reads "[redacted]".
  for (const [unsafe, shown] of [
    [`token ${TOKEN}`, "token [redacted]"],
    [`x ${BASIC}`, "x [redacted]"],
    [`x ${BASIC.replace(/=+$/, "")}`, "x [redacted]"],
    ["Bearer abc", "[redacted]abc"],
    ["TOKEN-SENTINEL-0123", "[redacted]"],
  ])
    assert.equal(
      describe(writeError(400, [REASON_SENTINEL, unsafe!])),
      `Jira refused the change (HTTP 400): ${REASON_SENTINEL}; ${shown}`,
      unsafe,
    );
  const capped = describe(writeError(400, ["r".repeat(800)]));
  assert.equal(capped.length, 500);
  assert.equal(
    describe(writeError(400, ["a\u0000b"])),
    "Jira refused the change (HTTP 400): a b",
  );
});

test("rule 5: a read's 4xx and any 5xx show the status alone", () => {
  assert.equal(
    describe(readError(400, [REASON_SENTINEL])),
    "Jira answered HTTP 400.",
  );
  assert.equal(
    describe(readError(404, [REASON_SENTINEL])),
    "Jira answered HTTP 404.",
  );
  assert.equal(
    describe(writeError(503, [REASON_SENTINEL])),
    "Jira answered HTTP 503.",
  );
});

test("rule 6: a read refusal is its fixed edge text", () => {
  assert.equal(
    describe(
      new JiraReadRefusal(
        "jql_empty",
        `jql ${BODY_SENTINEL} must not be empty`,
      ),
    ),
    "jql must not be empty.",
  );
});

test("rule 7: anything else is fixed, saying the change may or may not have landed", () => {
  for (const err of [
    new Error(`socket hang up ${BODY_SENTINEL} ${TOKEN}`),
    new TypeError("fetch failed"),
    BODY_SENTINEL,
    undefined,
  ])
    assert.equal(
      describe(err),
      "The request to Jira failed; the change may or may not have been applied.",
    );
});

const config = jiraConfigOf(CREDENTIAL);

/** Runs apply on one item with the mapper; answers the item's row error. */
async function applyOne(item: JiraIssueMutationItemDisplay): Promise<string> {
  await assert.rejects(
    applyJiraMutationItems(config, [item], {
      fieldMap: () => Promise.reject(new Error("unused")),
      describeError: (err) => describeWriteFailure(err, CREDENTIAL),
    }),
    JiraMutationError,
  );
  const error = item.error ?? "";
  for (const forbidden of FORBIDDEN)
    assert.ok(!error.includes(forbidden), `${error} holds ${forbidden}`);
  assertNoCredential(error, CREDENTIAL);
  return error;
}

function sprintItem(): JiraIssueMutationItemDisplay {
  return {
    clientId: "item-1",
    issueKey: "",
    operation: "sprint",
    fieldChanges: [],
    sprint: {
      sprintId: 5,
      name: "Sprint 5",
      state: "future",
      changes: [{ field: "name", from: "Sprint 5", to: "Sprint 5b" }],
    },
  };
}

test("wrapped: a sprint re-read's 403 and 404 keep the read's fixed inner text", async () => {
  for (const [status, inner] of [
    [403, TOKEN_REMEDY],
    [404, "Jira answered HTTP 404."],
  ] as const) {
    stubJiraFetch((seen) =>
      seen.method === "POST" ? json({}) : new Response(body, { status }),
    );
    assert.equal(
      await applyOne(sprintItem()),
      `Jira sprint 5 could not be read: ${inner} Find the sprint id with jira_lookup kind=sprints.`,
    );
  }
});

function rankItem(): JiraIssueMutationItemDisplay {
  return {
    clientId: "item-1",
    issueKey: "STAR-2",
    operation: "rank",
    fieldChanges: [],
    rankIssueKeys: ["STAR-2"],
    rankPosition: "before",
    rankTargetIssueKey: "STAR-1",
    rankSteps: [
      { issueKey: "STAR-2", placement: "before", relativeToIssueKey: "STAR-1" },
    ],
  };
}

test("wrapped: a rank 207 shows a 4xx entry's reasons, the remedy for 401/403, the status for a 5xx", async () => {
  const cases: Array<[entries: unknown[], inner: string]> = [
    [
      [{ issueId: 2, status: 400, errors: [REASON_SENTINEL] }],
      `Jira refused the change (HTTP 400): ${REASON_SENTINEL}`,
    ],
    [[{ issueId: 2, status: 401, errors: [REASON_SENTINEL] }], TOKEN_REMEDY],
    [[{ issueId: 2, status: 403, errors: [REASON_SENTINEL] }], TOKEN_REMEDY],
    [
      [{ issueId: 2, status: 502, errors: [REASON_SENTINEL] }],
      "Jira answered HTTP 502.",
    ],
  ];
  for (const [entries, inner] of cases) {
    stubJiraFetch((seen) =>
      seen.method === "PUT" ? json({ entries }, 207) : undefined,
    );
    assert.equal(
      await applyOne(rankItem()),
      `Ranking STAR-2 before STAR-1 failed: ${inner}. No rank operation was applied.`,
    );
  }
});

test("a piece of the token inside a longer text reads [redacted]: rule 2's own text and rule 4's reasons (Task-1463 fix-1 F001)", () => {
  const piece = TOKEN.slice(5, 21);
  const own = describe(
    new JiraMutationError(`Transition "Move ${piece}" is not available.`),
  );
  assert.equal(own, 'Transition "Move [redacted]" is not available.');
  const reasons = describe(
    writeError(400, ["field x is required", `invalid near ${piece} here`]),
  );
  assert.equal(
    reasons,
    "Jira refused the change (HTTP 400): field x is required; invalid near [redacted] here",
  );
  for (const text of [own, reasons]) assertNoCredential(text, CREDENTIAL);
});
