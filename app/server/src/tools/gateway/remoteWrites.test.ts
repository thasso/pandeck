/**
 * Client mode's gateway writes (Task-1463 P6b, AC2-AC4): the remote tool is
 * the local definition; a call rechecks connection, toggle and the two-phase
 * listing before `tools.prepare`; only a proposal that passes the closed
 * validators for an Atlassian site becomes the local card, with the server-only
 * gateway context. Every refusal says nothing was written (L-a, D6). The card
 * parity with the local tool is in the two literal oracles.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "vitest";
import { updateConfluenceSettings } from "../../confluenceSettings.ts";
import { approvalStore } from "../../db/approvalStore.ts";
import { updateJiraSettings } from "../../jiraSettings.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";
import {
  ROUTE_UNSUPPORTED,
  approvalsForSession,
  resolveApproval,
  setApprovalBroadcastForTests,
} from "../../pendingApprovals.ts";
import {
  RemoteToolRefusal,
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
  markDisconnected,
  type RemotePrepareAnswer,
} from "../../remoteTools.ts";
import { confluenceMutatePageTool } from "../confluence/confluenceTools.ts";
import { jiraMutateIssueTool } from "../jira/jiraTools.ts";
import { remoteToolsFor } from "./remoteToolGroup.ts";
import { GATEWAY_CONTEXT } from "./remoteWrites.ts";

setApprovalBroadcastForTests(() => {});

const writeEntry = (name: string, product: string) => ({
  name,
  description: "The edge's own one-call text.",
  inputSchema: { type: "object", properties: {} },
  effect: "write",
  actionKey: `${product}:write`,
  twoPhase: true,
});
const JIRA_WRITE = writeEntry("jira_mutate_issue", "jira");
const CONFLUENCE_WRITE = writeEntry("confluence_mutate_page", "confluence");

const COMMENT_ITEM = {
  clientId: "item-1",
  issueKey: "OPS-1",
  operation: "comment",
  issueUrl: "https://acme.atlassian.net/browse/OPS-1",
  commentBody: "Done",
  fieldChanges: [],
};

let prepared: { name: string; args: unknown; signal: AbortSignal }[] = [];
let applied: string[] = [];
let answer: () => Promise<RemotePrepareAnswer>;
let uninstall: () => void = () => {};
let session = 0;
let sessionId = "";

beforeEach(async () => {
  prepared = [];
  applied = [];
  sessionId = `remote-writes-${(session += 1)}`;
  answer = () =>
    Promise.resolve({
      ok: true,
      site: "acme.atlassian.net",
      items: [structuredClone(COMMENT_ITEM)],
      warnings: [],
    });
  uninstall = installRemoteToolPort({
    call: () => Promise.reject(new Error("unused")),
    prepare: (name, args, signal) => {
      prepared.push({ name, args, signal });
      return answer();
    },
    apply: (name) => {
      applied.push(name);
      return Promise.resolve({ outcome: "notSent" });
    },
  });
  await updateJiraSettings({ enabled: true });
  updateConfluenceSettings({ enabled: true });
  applyListing(acceptRemoteTools([JIRA_WRITE, CONFLUENCE_WRITE]));
});

afterEach(async () => {
  uninstall();
  await updateJiraSettings({ enabled: false });
  updateConfluenceSettings({ enabled: false });
});

const ctx = (signal?: AbortSignal) =>
  ({
    session: { sessionId },
    toolCallId: "call-7",
    ...(signal ? { signal } : {}),
  }) as ToolCallContext;

const remote = (product: "jira" | "confluence") =>
  remoteToolsFor(product).find((tool) => tool.name.includes("mutate"))!;

const fails = async (run: Promise<unknown>, message: string): Promise<void> => {
  await assert.rejects(run, (err: unknown) => {
    assert.equal((err as Error).message, message);
    return true;
  });
  assert.deepEqual(approvalsForSession(sessionId), []);
};

test("each remote write is the local tool by name, label, description, schema and search hint (AC2)", () => {
  for (const [product, local] of [
    ["jira", jiraMutateIssueTool],
    ["confluence", confluenceMutatePageTool],
  ] as const) {
    const tool = remote(product);
    const fields = (t: typeof local) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      parameters: t.parameters,
      searchHint: t.searchHint,
    });
    assert.deepEqual(fields(tool), fields(local));
    assert.equal(tool.description, local.description);
    assert.equal(
      JSON.stringify(tool.parameters),
      JSON.stringify(local.parameters),
    );
    // The catalog classifies it; the tool carries no class of its own.
    assert.equal(tool.sideEffects, undefined);
    assert.equal((tool as { remoteWrite?: true }).remoteWrite, true);
  }
});

test("a proposal becomes the local card with the gateway context, the local text and terminate (AC4)", async () => {
  const caller = new AbortController();
  const result = await remote("jira").execute(
    { items: [{ operation: "comment", issue: "OPS-1", comment: "Done" }] },
    ctx(caller.signal),
  );
  assert.deepEqual(
    prepared.map(({ name, args }) => [name, args]),
    [
      [
        "jira_mutate_issue",
        { items: [{ operation: "comment", issue: "OPS-1", comment: "Done" }] },
      ],
    ],
  );
  assert.equal(prepared[0]!.signal, caller.signal);
  const [card] = approvalsForSession(sessionId);
  assert.ok(card);
  assert.equal(card.kind, "jiraIssue");
  assert.equal(card.title, "Comment on OPS-1");
  assert.equal(card.summary, "comment OPS-1");
  assert.equal(card.sourceToolCallId, "call-7");
  assert.deepEqual(card.body, {
    kind: "jiraIssue",
    jiraHost: "acme.atlassian.net",
    items: [COMMENT_ITEM],
  });
  assert.deepEqual(approvalStore.get(card.id)?.context, { via: "gateway" });
  assert.deepEqual(GATEWAY_CONTEXT, { via: "gateway" });
  assert.equal(result.terminate, true);
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: `Prepared a Jira edit proposal for 1 issue(s) pending your approval. Do not claim Jira changed until the approved result appears. When you ask the user to decide, link the card: [Comment on OPS-1](pa://approval/${card.id}).`,
    },
  ]);
});

test("until the executors route gateway cards, approving one fails closed before any apply (M1 interim, P6B-F3)", async () => {
  await remote("jira").execute({ items: [] }, ctx());
  const [card] = approvalsForSession(sessionId);
  const { card: decided } = await resolveApproval(card!.id, "approved");
  assert.equal(decided.status, "failed");
  assert.equal(decided.error, ROUTE_UNSUPPORTED);
  assert.deepEqual(applied, []);
});

test("before prepare: no link, a product toggle off, or a listing without the two-phase write refuse with nothing written (AC3)", async () => {
  const tool = remote("jira");
  markDisconnected();
  await fails(
    tool.execute({ items: [] }, ctx()),
    "The credential gateway is unreachable. Nothing was written.",
  );
  applyListing(acceptRemoteTools([JIRA_WRITE, CONFLUENCE_WRITE]));
  await updateJiraSettings({ enabled: false });
  await fails(
    tool.execute({ items: [] }, ctx()),
    "Jira tools are disabled. Enable them in Settings → Jira. Nothing was written.",
  );
  await updateJiraSettings({ enabled: true });
  applyListing(
    acceptRemoteTools([
      { ...JIRA_WRITE, twoPhase: undefined },
      CONFLUENCE_WRITE,
    ]),
  );
  await fails(
    tool.execute({ items: [] }, ctx()),
    "The gateway no longer offers this change. Nothing was written.",
  );
  updateConfluenceSettings({ enabled: false });
  await fails(
    remote("confluence").execute({ items: [] }, ctx()),
    "Confluence tools are disabled. Enable them in Settings → Confluence. Nothing was written.",
  );
  assert.deepEqual(prepared, []);
});

test("the link's refusals: unreachable, no tools, an undecodable answer (AC3)", async () => {
  const tool = remote("jira");
  for (const [code, message] of [
    [
      "gateway_unavailable",
      "The credential gateway is unreachable. Nothing was written.",
    ],
    [
      "tools_unavailable",
      "The credential gateway runs no tools. Nothing was written.",
    ],
    [
      "undecodable",
      "The gateway answered something this server can't show as a proposal; nothing was prepared.",
    ],
  ] as const) {
    answer = () => Promise.reject(new RemoteToolRefusal(code));
    await fails(tool.execute({ items: [] }, ctx()), message);
  }
});

test("each prepare failure code, in text that says nothing was written (AC3, L-a, D6)", async () => {
  const tool = remote("jira");
  const cases: [RemotePrepareAnswer, string][] = [
    [
      { ok: false, code: "tool_error", message: "No such issue OPS-9." },
      "No such issue OPS-9. Nothing was written.",
    ],
    [
      { ok: false, code: "invalid_params", message: "items: required" },
      "items: required Nothing was written.",
    ],
    // The edge's own claim is not doubled.
    [
      {
        ok: false,
        code: "tool_error",
        message: "The site changed. Nothing was written.",
      },
      "The site changed. Nothing was written.",
    ],
    [
      { ok: false, code: "tool_error", message: "" },
      "jira_mutate_issue failed on the gateway. Nothing was written.",
    ],
    [
      { ok: false, code: "unknown_tool", message: "x" },
      "The gateway no longer offers this change. Nothing was written.",
    ],
    [
      { ok: false, code: "result_too_large", message: "x" },
      "The gateway's proposal is too large. Nothing was written.",
    ],
    [
      { ok: false, code: "timeout", message: "" },
      "The gateway did not prepare the change in time. Nothing was written.",
    ],
    [
      { ok: false, code: "cancelled", message: "" },
      "The call was cancelled. Nothing was written.",
    ],
    [
      { ok: false, code: "failed", message: "boom" },
      "jira_mutate_issue failed on the gateway. Nothing was written.",
    ],
  ];
  for (const [failure, message] of cases) {
    answer = () => Promise.resolve(failure);
    await fails(tool.execute({ items: [] }, ctx()), message);
  }
});

test("an edge refusal the link cut at 500 characters shows the cut and the client's claim (L-a)", async () => {
  // As the decoder hands on a 1,200-character refusal: its first 500.
  const cut = `${"The proposal was refused because ".repeat(40)}`.slice(0, 500);
  answer = () =>
    Promise.resolve({ ok: false, code: "tool_error", message: cut });
  await fails(
    remote("jira").execute({ items: [] }, ctx()),
    `${cut}… Nothing was written.`,
  );
  // Even when the cut text happens to end with the claim's words.
  const ending = `${"x".repeat(479)} nothing was written.`;
  assert.equal(ending.length, 500);
  answer = () =>
    Promise.resolve({ ok: false, code: "tool_error", message: ending });
  await fails(
    remote("jira").execute({ items: [] }, ctx()),
    `${ending}… Nothing was written.`,
  );
});

test("a proposal that fails the closed validator raises no card (AC3, P6-F2)", async () => {
  const tool = remote("jira");
  const UNEXPECTED =
    "The gateway answered something this server can't show as a proposal; nothing was prepared.";
  for (const items of [
    [],
    Array.from({ length: 11 }, () => COMMENT_ITEM),
    // A result path in a prepare answer.
    [{ ...COMMENT_ITEM, error: "done before approval" }],
    // A key the item type lacks.
    [{ ...COMMENT_ITEM, extra: 1 }],
    // A create whose key is not the empty one.
    [{ ...COMMENT_ITEM, operation: "create", createProjectKey: "OPS" }],
    // A Confluence item is not a Jira item.
    [{ clientId: "cfl_0", operation: "comment", pageId: "1" }],
  ]) {
    answer = () =>
      Promise.resolve({
        ok: true,
        site: "acme.atlassian.net",
        items,
        warnings: [],
      });
    await fails(tool.execute({ items: [] }, ctx()), UNEXPECTED);
  }
});

test("only an Atlassian site the edge's pattern admits becomes the card host (AC3, D3)", async () => {
  const tool = remote("jira");
  const UNEXPECTED =
    "The gateway answered something this server can't show as a proposal; nothing was prepared.";
  for (const site of [
    "https://acme.atlassian.net",
    "acme.atlassian.net.evil",
    "acme.atlassian.net/",
    "ACME.atlassian.net",
    `${"a".repeat(64)}.atlassian.net`,
    "-acme.atlassian.net",
    "atlassian.net",
    "",
  ]) {
    answer = () =>
      Promise.resolve({
        ok: true,
        site,
        items: [COMMENT_ITEM],
        warnings: [],
      });
    await fails(tool.execute({ items: [] }, ctx()), UNEXPECTED);
  }
  for (const site of ["a.atlassian.net", `${"a".repeat(63)}.atlassian.net`]) {
    answer = () =>
      Promise.resolve({ ok: true, site, items: [COMMENT_ITEM], warnings: [] });
    await tool.execute({ items: [] }, ctx());
    assert.equal(
      (approvalsForSession(sessionId).at(-1)!.body as { jiraHost?: string })
        .jiraHost,
      site,
    );
  }
});

test("the client's site pattern is the edge's, text for text (D3)", () => {
  const pattern = (path: string, name: string) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const match = new RegExp(`const ${name} = (/.+/);\\n`).exec(source);
    assert.ok(match, `${name} in ${path}`);
    return match[1];
  };
  assert.equal(
    pattern("./remoteWrites.ts", "ATLASSIAN_SITE_RE"),
    pattern("../../gatewayTools/atlassian.ts", "SITE_RE"),
  );
});
