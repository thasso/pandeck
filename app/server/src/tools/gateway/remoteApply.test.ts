/**
 * Applying gateway-prepared cards (Task-1463 P6b, AC5-AC9, P6-F4, P6-O4)
 * through the real approval runner (`resolveApproval`, `runAutoApprovals`,
 * boot recovery) and the real `jiraIssue`/`confluencePage` executors, with a
 * fake link port. Every outcome row is checked against the one invariant:
 * "nothing was written" appears exactly when the request never left or the
 * edge certified `effects: "none"`. No path reads local credentials or
 * fetches anything locally.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ApprovalCard } from "@assistant/shared";
import { afterEach, beforeEach, test, vi } from "vitest";

const localReads = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../jiraSettings.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../jiraSettings.ts")>();
  return {
    ...actual,
    getJiraToolConfig: () => {
      localReads.count += 1;
      return actual.getJiraToolConfig();
    },
  };
});
vi.mock("../../confluenceSettings.ts", async (importActual) => {
  const actual =
    await importActual<typeof import("../../confluenceSettings.ts")>();
  return {
    ...actual,
    getConfluenceToolConfig: () => {
      localReads.count += 1;
      return actual.getConfluenceToolConfig();
    },
  };
});

const { updateConfluenceSettings } =
  await import("../../confluenceSettings.ts");
const { approvalStore } = await import("../../db/approvalStore.ts");
const { sessionStore } = await import("../../db/sessionStore.ts");
const { updateJiraSettings } = await import("../../jiraSettings.ts");
const {
  approvalForId,
  createApproval,
  grantApprovalForSession,
  recoverAutoApprovalsOnBoot,
  resolveApproval,
  runAutoApprovals,
  setApprovalBroadcastForTests,
  setAutoApprovalDrainForTests,
} = await import("../../pendingApprovals.ts");
const {
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
  markDisconnected,
  remoteProductEnabled,
  remoteToolDispatchable,
  remoteToolsConnected,
} = await import("../../remoteTools.ts");
type RemoteApplyOutcome = Awaited<
  ReturnType<import("../../remoteTools.ts").RemoteToolPort["apply"]>
>;
// The executors under test register on import.
await import("../jira/jiraTools.ts");
await import("../confluence/confluenceTools.ts");
const { GATEWAY_CONTEXT } = await import("./remoteWriteRules.ts");
// The edge's own wording, so a change on either side shows here (F006).
const { SITE_CHANGED } = await import("../../gatewayTools/twoPhase.ts");

const SITE = "acme.atlassian.net";
const NOT_CLIENT_MODE =
  "This change was prepared on the credential gateway, which this server no longer uses. Nothing was written; ask for it again.";
const UNREACHABLE =
  "The credential gateway is unreachable. Nothing was written; ask for the change again.";
const CANNOT_SEND =
  "This proposal can't be sent to the gateway. Nothing was written; ask for it again.";
const NOT_OFFERED =
  "The gateway no longer offers this change. Nothing was written.";
const MAY_HAVE_WRITTEN =
  "The gateway did not confirm the result. Changes may have been written, and a change already sent can still finish within about a minute. Wait a minute, then check the site; ask again only for what is missing. Don't approve the same change again unchecked.";
const PARTIAL_EFFECTS =
  "Some failed changes may have been partly written before they failed; the card shows each item's outcome. Check the site and ask again only for what is missing. Don't approve the same change again unchecked.";
const TRIMMED = "Some result details were too long to return.";

const writeEntry = (name: string, product: string) => ({
  name,
  effect: "write",
  actionKey: `${product}:write`,
  twoPhase: true,
});
const LISTING = [
  writeEntry("jira_mutate_issue", "jira"),
  writeEntry("confluence_mutate_page", "confluence"),
];

const comment = (n: number) => ({
  clientId: `item-${n}`,
  issueKey: `OPS-${n}`,
  operation: "comment" as const,
  issueUrl: `https://${SITE}/browse/OPS-${n}`,
  commentBody: `Note ${n}`,
  fieldChanges: [],
});
const issueUrl = (n: number) => `https://${SITE}/browse/OPS-${n}`;

interface Sent {
  name: string;
  site: string;
  items: unknown[];
}
let sent: Sent[];
let answer: (request: Sent) => Promise<RemoteApplyOutcome>;
let uninstall: () => void = () => {};
let fetches: string[];
let sessionId: string;

function install(): void {
  uninstall();
  uninstall = installRemoteToolPort({
    callFile: () => Promise.reject(new Error("unused")),
    uploads: {
      open: () => Promise.reject(new Error("unused")),
      put: () => Promise.reject(new Error("unused")),
      release: () => {},
    },
    call: () => Promise.reject(new Error("unused")),
    prepare: () => Promise.reject(new Error("unused")),
    apply: (name, site, items) => {
      const request = { name, site, items: structuredClone(items) };
      sent.push(request);
      return answer(request);
    },
  });
}

const ok =
  (results: object[], effects: "none" | "possible" = "possible") =>
  (): Promise<RemoteApplyOutcome> =>
    Promise.resolve({
      outcome: "answer",
      answer: { ok: true, results, effects },
    });

beforeEach(async () => {
  sent = [];
  fetches = [];
  localReads.count = 0;
  sessionId = `remote-apply-${randomUUID()}`;
  sessionStore.upsert({
    id: sessionId,
    harness: "pi",
    agentType: "assistant",
    title: sessionId,
  });
  vi.stubGlobal("fetch", (input: unknown) => {
    fetches.push(String(input));
    return Promise.reject(new Error("no local fetch in client mode"));
  });
  setApprovalBroadcastForTests(() => {});
  setAutoApprovalDrainForTests(async () => {});
  answer = ok([{ effects: "possible", resultIssueUrl: issueUrl(1) }]);
  install();
  await updateJiraSettings({ enabled: true });
  updateConfluenceSettings({ enabled: true });
  applyListing(acceptRemoteTools(LISTING));
});

afterEach(async () => {
  uninstall();
  uninstall = () => {};
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await updateJiraSettings({ enabled: false });
  updateConfluenceSettings({ enabled: false });
  setApprovalBroadcastForTests(null);
  setAutoApprovalDrainForTests(null);
  // No outcome may read local credentials or fetch.
  assert.equal(localReads.count, 0, "local credential reads");
  assert.deepEqual(fetches, [], "local fetches");
});

function jiraCard(
  items: object[] = [comment(1)],
  /** `null` leaves the host out. */
  host: string | null = SITE,
): ApprovalCard {
  return createApproval({
    sessionId,
    kind: "jiraIssue",
    title: "Comment on OPS-1",
    body: {
      kind: "jiraIssue",
      ...(host !== null ? { jiraHost: host } : {}),
      items: items as never,
    },
    context: { ...GATEWAY_CONTEXT },
  });
}

const approve = (card: ApprovalCard) => resolveApproval(card.id, "approved");

/** Approves `card` and answers its error, asserting nothing was sent. */
async function refusedBeforeSend(card: ApprovalCard): Promise<string> {
  const { card: decided } = await approve(card);
  assert.equal(decided.status, "failed");
  assert.deepEqual(sent, []);
  return decided.error!;
}

// --- the send -----------------------------------------------------------

test("a gateway card sends its proposal form and executes with the local summary and link (AC5, AC8)", async () => {
  // Stale result fields on the card never travel; `issueKey` always does.
  const card = jiraCard([
    { ...comment(1) },
    {
      clientId: "item-2",
      issueKey: "",
      operation: "create",
      createProjectKey: "OPS",
      createIssueType: "Task",
      createSummary: "New one",
      fieldChanges: [],
    },
  ]);
  const stored = approvalStore.get(card.id)!;
  stored.card.body = {
    ...stored.card.body,
    items: (stored.card.body as { items: object[] }).items.map((item) => ({
      ...item,
      error: "an earlier run",
      warning: "stale",
    })),
  } as never;
  approvalStore.update(stored);
  answer = ok([
    { effects: "possible", resultIssueUrl: issueUrl(1) },
    {
      effects: "possible",
      resultIssueKey: "OPS-9",
      createdIssueKey: "OPS-9",
      resultIssueUrl: issueUrl(9),
    },
  ]);

  const { card: decided, outcomePrompt } = await approve(card);

  assert.deepEqual(sent, [
    {
      name: "jira_mutate_issue",
      site: SITE,
      items: [
        comment(1),
        {
          clientId: "item-2",
          issueKey: "",
          operation: "create",
          createProjectKey: "OPS",
          createIssueType: "Task",
          createSummary: "New one",
          fieldChanges: [],
        },
      ],
    },
  ]);
  assert.equal(decided.status, "executed");
  assert.equal(decided.resultSummary, "Applied 2 change(s) (created OPS-9)");
  assert.equal(decided.resultUrl, issueUrl(1));
  const items = (approvalForId(card.id)!.body as { items: object[] }).items;
  assert.deepEqual(items, [
    { ...comment(1), resultIssueUrl: issueUrl(1) },
    {
      clientId: "item-2",
      issueKey: "OPS-9",
      operation: "create",
      createProjectKey: "OPS",
      createIssueType: "Task",
      createSummary: "New one",
      fieldChanges: [],
      resultIssueKey: "OPS-9",
      resultIssueUrl: issueUrl(9),
    },
  ]);
  assert.match(
    outcomePrompt,
    /Result: Applied 2 change\(s\) \(created OPS-9\)/,
  );
  assert.match(
    outcomePrompt,
    /URL: https:\/\/acme\.atlassian\.net\/browse\/OPS-1/,
  );
});

test("a Confluence gateway card applies on the gateway too", async () => {
  const card = createApproval({
    sessionId,
    kind: "confluencePage",
    title: "Comment on Page",
    body: {
      kind: "confluencePage",
      confluenceHost: SITE,
      items: [
        {
          clientId: "item-1",
          operation: "comment",
          pageId: "123",
          title: "Page",
          body: "Hi",
        },
      ],
    },
    context: { ...GATEWAY_CONTEXT },
  });
  answer = ok([
    {
      effects: "possible",
      resultPageId: "123",
      resultPageUrl: `https://${SITE}/wiki/spaces/X/pages/123`,
    },
  ]);
  const { card: decided } = await approve(card);
  assert.equal(sent[0]?.name, "confluence_mutate_page");
  assert.equal(decided.status, "executed");
  assert.equal(decided.resultSummary, "Applied 1 Confluence change(s)");
  assert.equal(decided.resultUrl, `https://${SITE}/wiki/spaces/X/pages/123`);
});

// --- the outcome table, row by row (P6-F4, P6b v03) ----------------------

interface Row {
  name: string;
  items?: object[];
  outcome: () => Promise<RemoteApplyOutcome>;
  status: "executed" | "failed";
  text: string;
  /** Whether this outcome may say nothing was written. */
  certified: boolean;
  /** The card body's items after the outcome, when not the sent ones. */
  merged?: object[];
}

const answered = (answer: object) => (): Promise<RemoteApplyOutcome> =>
  Promise.resolve({ outcome: "answer", answer } as RemoteApplyOutcome);
const edgeFailure = (
  effects: "none" | "possible",
  extra: object = {},
  message = "The site changed since this was prepared.",
) => answered({ ok: false, code: "tool_error", message, effects, ...extra });

const ROWS: Row[] = [
  {
    name: "notSent",
    outcome: () => Promise.resolve({ outcome: "notSent" }),
    status: "failed",
    text: UNREACHABLE,
    certified: true,
  },
  ...(["lost", "timeout", "undecodable"] as const).map((outcome): Row => ({
    name: outcome,
    outcome: () => Promise.resolve({ outcome }),
    status: "failed",
    text: MAY_HAVE_WRITTEN,
    certified: false,
  })),
  {
    name: "a failure certified effects none",
    outcome: edgeFailure("none"),
    status: "failed",
    text: "The site changed since this was prepared. Nothing was written.",
    certified: true,
  },
  {
    name: "a certified failure whose message the link cut at 500",
    outcome: edgeFailure("none", {}, "x".repeat(500)),
    status: "failed",
    text: `${"x".repeat(500)}… Nothing was written.`,
    certified: true,
  },
  {
    name: "a certified failure that already says so",
    outcome: edgeFailure("none", {}, "Refused. Nothing was written."),
    status: "failed",
    text: "Refused. Nothing was written.",
    certified: true,
  },
  {
    name: "a certified failure in the edge's SITE_CHANGED wording keeps its own claim, once",
    outcome: edgeFailure("none", {}, SITE_CHANGED),
    status: "failed",
    text: SITE_CHANGED,
    certified: true,
  },
  {
    name: "a certified failure cut at 500 that already said so earlier",
    outcome: edgeFailure(
      "none",
      {},
      `Refused; nothing was written. ${"x".repeat(470)}`,
    ),
    status: "failed",
    text: `Refused; nothing was written. ${"x".repeat(470)}…`,
    certified: true,
  },
  {
    name: "a failure with possible effects whose message says nothing was written",
    outcome: edgeFailure("possible", {}, SITE_CHANGED),
    status: "failed",
    text: MAY_HAVE_WRITTEN,
    certified: false,
  },
  {
    name: "a certified failure without a message",
    outcome: edgeFailure("none", {}, ""),
    status: "failed",
    text: "jira_mutate_issue failed on the gateway. Nothing was written.",
    certified: true,
  },
  {
    name: "an unknown tool, certified",
    outcome: answered({
      ok: false,
      code: "unknown_tool",
      message: "No such tool.",
      effects: "none",
    }),
    status: "failed",
    text: NOT_OFFERED,
    certified: true,
  },
  {
    name: "a failure with possible effects and checked results",
    items: [comment(1), comment(2)],
    outcome: edgeFailure("possible", {
      results: [
        { effects: "possible", resultIssueUrl: issueUrl(1) },
        { effects: "none", error: "Stopped before it started." },
      ],
    }),
    status: "failed",
    text: MAY_HAVE_WRITTEN,
    certified: false,
    merged: [
      { ...comment(1), resultIssueUrl: issueUrl(1) },
      { ...comment(2), error: "Stopped before it started." },
    ],
  },
  {
    name: "a failure with possible effects and one bad record",
    items: [comment(1), comment(2)],
    outcome: edgeFailure("possible", {
      results: [
        { effects: "possible", resultIssueUrl: issueUrl(1) },
        { effects: "none", error: "x", surprise: true },
      ],
    }),
    status: "failed",
    text: MAY_HAVE_WRITTEN,
    certified: false,
  },
  {
    name: "a success with a foreign-host link",
    outcome: ok([
      {
        effects: "possible",
        resultIssueUrl: "https://evil.example/browse/OPS-1",
      },
    ]),
    status: "failed",
    text: MAY_HAVE_WRITTEN,
    certified: false,
  },
  {
    name: "a success with one record too few",
    items: [comment(1), comment(2)],
    outcome: ok([{ effects: "possible", resultIssueUrl: issueUrl(1) }]),
    status: "failed",
    text: MAY_HAVE_WRITTEN,
    certified: false,
  },
  {
    name: "a success whose root says none while a record says possible",
    outcome: ok([{ effects: "possible", error: "Refused." }], "none"),
    status: "failed",
    text: MAY_HAVE_WRITTEN,
    certified: false,
  },
  {
    name: "every item failed, root none",
    items: [comment(1), comment(2)],
    outcome: ok(
      [
        { effects: "none", error: "Stopped." },
        { effects: "none", error: "Stopped." },
      ],
      "none",
    ),
    status: "failed",
    text: "All 2 Jira change(s) failed: Stopped.; Stopped. Nothing was written.",
    certified: true,
    merged: [
      { ...comment(1), error: "Stopped." },
      { ...comment(2), error: "Stopped." },
    ],
  },
  {
    name: "every item failed, root possible",
    outcome: ok([{ effects: "possible", error: "HTTP 403" }]),
    status: "failed",
    text: `All 1 Jira change(s) failed: HTTP 403 ${PARTIAL_EFFECTS}`,
    certified: false,
    merged: [{ ...comment(1), error: "HTTP 403" }],
  },
  {
    name: "every item failed, an empty error still counts as failed",
    outcome: ok([{ effects: "none", error: "" }], "none"),
    status: "failed",
    text: "All 1 Jira change(s) failed:  Nothing was written.",
    certified: true,
    merged: [{ ...comment(1), error: "" }],
  },
  {
    name: "one item failed after it may have written",
    items: [comment(1), comment(2)],
    outcome: ok([
      { effects: "possible", resultIssueUrl: issueUrl(1) },
      { effects: "possible", error: "HTTP 400" },
    ]),
    status: "executed",
    text: `Applied 1 change(s); 1 failed ${PARTIAL_EFFECTS}`,
    certified: false,
  },
  {
    name: "one item failed before it wrote anything",
    items: [comment(1), comment(2)],
    outcome: ok([
      { effects: "possible", resultIssueUrl: issueUrl(1) },
      { effects: "none", error: "Stopped." },
    ]),
    status: "executed",
    text: "Applied 1 change(s); 1 failed",
    certified: false,
  },
  {
    name: "a trimmed success",
    outcome: answered({
      ok: true,
      effects: "possible",
      trimmed: true,
      results: [{ effects: "possible", resultIssueUrl: issueUrl(1) }],
    }),
    status: "executed",
    text: `Applied 1 change(s) ${TRIMMED}`,
    certified: false,
  },
  {
    name: "a trimmed success with a partial failure keeps both notices",
    items: [comment(1), comment(2)],
    outcome: answered({
      ok: true,
      effects: "possible",
      trimmed: true,
      results: [
        { effects: "possible", resultIssueUrl: issueUrl(1) },
        { effects: "possible", error: "HTTP 400" },
      ],
    }),
    status: "executed",
    text: `Applied 1 change(s); 1 failed ${TRIMMED} ${PARTIAL_EFFECTS}`,
    certified: false,
  },
];

test.each(ROWS.map((row) => [row.name, row] as const))(
  "outcome row: %s",
  async (_name, row) => {
    const items = row.items ?? [comment(1)];
    const card = jiraCard(items);
    answer = row.outcome;
    const { card: decided, outcomePrompt } = await approve(card);
    assert.equal(sent.length, 1);
    assert.equal(decided.status, row.status);
    const text =
      row.status === "executed" ? decided.resultSummary : decided.error;
    assert.equal(text, row.text);
    // The invariant (P6-F4, D2, D6(i)).
    assert.equal(/nothing was written/i.test(text!), row.certified, text);
    assert.ok(outcomePrompt.includes(row.text));
    const body = (approvalForId(card.id)!.body as { items: object[] }).items;
    if (row.merged) assert.deepEqual(body, row.merged);
    else if (row.status === "failed") assert.deepEqual(body, items);
  },
);

// --- before the send (AC6, P6-O4) ---------------------------------------

test("a switch to local mode refuses a pending gateway card, reading no local credential", async () => {
  const card = jiraCard();
  uninstall();
  assert.equal(await refusedBeforeSend(card), NOT_CLIENT_MODE);
});

test("a card that is no valid proposal, or not for an Atlassian site, is never sent", async () => {
  assert.equal(
    await refusedBeforeSend(jiraCard([comment(1)], "evil.example")),
    CANNOT_SEND,
  );
  assert.equal(
    await refusedBeforeSend(jiraCard([comment(1)], null)),
    CANNOT_SEND,
  );
  assert.equal(
    await refusedBeforeSend(jiraCard([{ ...comment(1), surprise: 1 }])),
    CANNOT_SEND,
  );
  assert.equal(
    await refusedBeforeSend(
      jiraCard([{ ...comment(1), commentBody: "x".repeat(1_100_000) }]),
    ),
    CANNOT_SEND,
  );
});

test("an approval waits for a boot's first listing, and gives up after 15 s with nothing written", async () => {
  install(); // a fresh boot: no listing yet
  const waiting = approve(jiraCard());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent, []);
  applyListing(acceptRemoteTools(LISTING));
  assert.equal((await waiting).card.status, "executed");
  assert.equal(sent.length, 1);

  sent = [];
  install();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const timedOut = approve(jiraCard());
  await vi.advanceTimersByTimeAsync(15_000);
  const { card: decided } = await timedOut;
  assert.equal(decided.error, UNREACHABLE);
  assert.deepEqual(sent, []);
});

test("after the wait, a dropped link, a toggle off or a lost two-phase offer refuse with nothing written", async () => {
  markDisconnected();
  assert.equal(await refusedBeforeSend(jiraCard()), UNREACHABLE);
  applyListing(acceptRemoteTools(LISTING));

  await updateJiraSettings({ enabled: false });
  assert.equal(
    await refusedBeforeSend(jiraCard()),
    "Jira tools are disabled. Enable them in Settings → Jira. Nothing was written.",
  );
  await updateJiraSettings({ enabled: true });

  applyListing(
    acceptRemoteTools([{ ...LISTING[0], twoPhase: undefined }, LISTING[1]]),
  );
  assert.equal(await refusedBeforeSend(jiraCard()), NOT_OFFERED);
});

/**
 * P6-O4: nothing is awaited between the recheck and the send, so a change on
 * any microtask either lands before the recheck (refused, nothing sent) or
 * after the send. Flipping the link, the listing or the toggle after `k`
 * microtasks, for every `k` across the approval, the apply never starts
 * while what it was checked against no longer holds. An `await` before
 * `port.apply` breaks this for some `k`.
 */
test.each([
  ["the link drops", () => markDisconnected()],
  [
    "the listing loses the two-phase offer",
    () =>
      applyListing(
        acceptRemoteTools([LISTING[0], { ...LISTING[1], twoPhase: undefined }]),
      ),
  ],
  ["the toggle goes off", () => updateConfluenceSettings({ enabled: false })],
] as const)(
  "no microtask lands between the recheck and the send: %s (P6-O4)",
  async (_name, flip) => {
    const restore = () => {
      applyListing(acceptRemoteTools(LISTING));
      updateConfluenceSettings({ enabled: true });
    };
    const confluenceCard = () =>
      createApproval({
        sessionId,
        kind: "confluencePage",
        title: "Comment on Page",
        body: {
          kind: "confluencePage",
          confluenceHost: SITE,
          items: [
            {
              clientId: "item-1",
              operation: "comment",
              pageId: "123",
              title: "Page",
              body: "Hi",
            },
          ],
        },
        context: { ...GATEWAY_CONTEXT },
      });
    let stale = 0;
    answer = () => {
      // What the send was checked against must still hold as it leaves.
      if (
        !remoteToolsConnected() ||
        !remoteProductEnabled("confluence") ||
        !remoteToolDispatchable("confluence_mutate_page", "two-phase")
      )
        stale += 1;
      return Promise.resolve({
        outcome: "answer",
        answer: {
          ok: true,
          results: [{ effects: "possible" }],
          effects: "possible",
        },
      });
    };
    let refused = 0;
    let applied = 0;
    for (let k = 0; k < 400 && applied < 5; k += 1) {
      restore();
      const before = sent.length;
      const decided = approve(confluenceCard());
      for (let tick = 0; tick < k; tick += 1) await Promise.resolve();
      flip();
      const { card } = await decided;
      if (sent.length > before) applied += 1;
      else {
        assert.equal(card.status, "failed");
        refused += 1;
      }
    }
    restore();
    assert.equal(stale, 0, "an apply left after its check stopped holding");
    assert.ok(refused > 0, "some flip landed before the recheck");
    assert.equal(applied, 5, "the sweep reached past the send");
  },
);

test("rejecting a gateway card sends nothing", async () => {
  const card = jiraCard();
  const { card: decided } = await resolveApproval(card.id, "rejected");
  assert.equal(decided.status, "rejected");
  assert.deepEqual(sent, []);
});

// --- grants, idle and boot (AC9) ------------------------------------------

test("a session grant covers gateway cards, which execute at idle oldest first", async () => {
  grantApprovalForSession(sessionId, "jira:comment", false);
  const first = jiraCard([comment(1)]);
  const second = jiraCard([comment(2)]);
  assert.equal(first.autoApproved, true);
  answer = (request) =>
    ok([
      {
        effects: "possible",
        resultIssueUrl: issueUrl(request.items.length === 1 ? sent.length : 0),
      },
    ])();
  await runAutoApprovals(sessionId);
  assert.deepEqual(
    sent.map((request) => (request.items[0] as { issueKey: string }).issueKey),
    ["OPS-1", "OPS-2"],
  );
  assert.equal(approvalForId(first.id)?.status, "executed");
  assert.equal(approvalForId(second.id)?.status, "executed");
});

test("a covered gateway card resumed at boot waits for the delayed first listing", async () => {
  grantApprovalForSession(sessionId, "jira:comment", false);
  const card = jiraCard();
  install(); // the restart: no listing yet
  const runs: Promise<void>[] = [];
  recoverAutoApprovalsOnBoot((id) => {
    if (id === sessionId) runs.push(runAutoApprovals(id));
  });
  assert.equal(runs.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent, []);
  applyListing(acceptRemoteTools(LISTING));
  await Promise.all(runs);
  assert.equal(sent.length, 1);
  assert.equal(approvalForId(card.id)?.status, "executed");
});

test("a gateway card persisted as executing is not retried at boot", async () => {
  grantApprovalForSession(sessionId, "jira:comment", false);
  const card = jiraCard();
  const stored = approvalStore.get(card.id)!;
  stored.card.status = "executing";
  approvalStore.update(stored);
  const offered: string[] = [];
  recoverAutoApprovalsOnBoot((id) => offered.push(id));
  for (const id of offered) await runAutoApprovals(id);
  assert.ok(!offered.includes(sessionId));
  assert.equal(approvalForId(card.id)?.status, "executing");
  assert.deepEqual(sent, []);
});
