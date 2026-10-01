/**
 * Tests for the proxied MCP connection layer (`proxiedServer.ts`) and the
 * curated browser pack riding on it (`browserGroups.ts`), using the injectable
 * client factory (no real Playwright/npx spawn).
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/mcp/toolGroups/proxiedServer.test.ts
 *
 * Covers: lazy connect on first call + connection reuse, the Playwright spawn
 * spec, curated param mapping (browser_fill → browser_type), page-state
 * settling after actions ([Task-440](pa://task/440)), the navigate `waitFor`
 * condition, screenshot filename injection + artifact middleware recording new
 * files into the side-store, and browser_close tearing the connection down
 * (with a later call reconnecting lazily).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CWD } from "../../config.ts";
import { PLAYWRIGHT_MCP_CLI_PATH } from "../../runtimeAssets.ts";
import type { AgentTool, ToolCallContext } from "../tool.ts";
import { browserArtifactRoot, settleDeadlineMs } from "./browserGroups.ts";
import {
  listProxiedConnections,
  setProxiedClientFactoryForTests,
  type ProxiedMcpClient,
  type ProxiedSpawnSpec,
} from "./proxiedServer.ts";
import { deleteToolGroupSessionData, toolsForToolGroup } from "./registry.ts";
import { listSessionArtifacts } from "./packRuntime.ts";

interface FakeProxy {
  spawns: ProxiedSpawnSpec[];
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  closeCount: number;
}

function installFakeProxy(
  onCall?: (
    name: string,
    args: Record<string, unknown>,
  ) => { content?: unknown; isError?: unknown } | void,
): FakeProxy {
  const fake: FakeProxy = { spawns: [], calls: [], closeCount: 0 };
  setProxiedClientFactoryForTests(async (spawn) => {
    fake.spawns.push(spawn);
    const client: ProxiedMcpClient = {
      async callTool(name, args) {
        fake.calls.push({ name, args });
        const result = onCall?.(name, args);
        return result ?? { content: [{ type: "text", text: `ok:${name}` }] };
      },
      async close() {
        fake.closeCount += 1;
      },
      pid: 4242,
      onUnexpectedClose() {},
    };
    return client;
  });
  return fake;
}

const sessionsToClean: string[] = [];

function trackSession(sessionId: string): void {
  sessionsToClean.push(sessionId);
}

/** One page state as Playwright MCP formats it, so settling compares real trees. */
function pageState(tree: string): { content: unknown[] } {
  return {
    content: [
      {
        type: "text",
        text: `### Page state\n- Page Snapshot:\n\`\`\`yaml\n${tree}\n\`\`\`\n`,
      },
    ],
  };
}

/** Snapshot trees the fake serves in order; the last one repeats forever. */
function snapshotSequence(trees: string[]) {
  let index = 0;
  return (name: string) => {
    if (name !== "browser_snapshot") return undefined;
    const tree = trees[Math.min(index, trees.length - 1)]!;
    index += 1;
    return pageState(tree);
  };
}

function browserTool(name: string): AgentTool {
  const tool = [
    ...toolsForToolGroup("browser"),
    ...toolsForToolGroup("browser-raw-mcp"),
  ].find((t) => t.name === name);
  assert.ok(tool, `tool ${name} exists in the browser tool groups`);
  return tool;
}

function ctxFor(sessionId: string): ToolCallContext {
  return {
    toolCallId: `call-${Date.now()}`,
    session: { sessionId, harness: "pi", agentType: "workshop" },
  };
}

/** Keep the settle budget (and with it the poll cadence) test-fast. */
const previousSettleMs = process.env.PA_BROWSER_SETTLE_MS;

beforeEach(() => {
  process.env.PA_BROWSER_SETTLE_MS = "200";
});

afterEach(() => {
  for (const sessionId of sessionsToClean.splice(0))
    deleteToolGroupSessionData(sessionId);
  setProxiedClientFactoryForTests(undefined);
  if (previousSettleMs === undefined) delete process.env.PA_BROWSER_SETTLE_MS;
  else process.env.PA_BROWSER_SETTLE_MS = previousSettleMs;
});

test("lazy connect, playwright spawn spec, and connection reuse", async () => {
  const ID = `proxied-lazy-${Date.now()}`;
  const fake = installFakeProxy();
  trackSession(ID);
  assert.equal(fake.spawns.length, 0, "no spawn before the first tool call");

  const navigate = browserTool("browser_navigate");
  const result = await navigate.execute({ url: "/settings" }, ctxFor(ID));
  assert.equal(fake.spawns.length, 1, "connected lazily on first call");
  const spawn = fake.spawns[0]!;
  assert.equal(spawn.command, process.execPath);
  assert.deepEqual(spawn.args.slice(0, 4), [
    PLAYWRIGHT_MCP_CLI_PATH,
    "--output-dir",
    browserArtifactRoot(ID),
    "--isolated",
  ]);
  assert.equal(spawn.args.at(-1), "--headless");
  const executablePathIndex = spawn.args.indexOf("--executable-path");
  if (executablePathIndex !== -1)
    assert.ok(
      spawn.args[executablePathIndex + 1],
      "executable path has a value",
    );
  assert.deepEqual(spawn.trustedEnv, {
    PLAYWRIGHT_MCP_OUTPUT_DIR: browserArtifactRoot(ID),
  });
  assert.equal(spawn.cwd, CWD);
  // Local path is normalized onto the dev server origin.
  assert.deepEqual(fake.calls[0], {
    name: "browser_navigate",
    args: { url: "http://localhost:5173/settings" },
  });
  // Navigate answers with the settled page state, i.e. the last snapshot.
  assert.match(
    (result.content[0] as { text: string }).text,
    /ok:browser_snapshot/,
  );

  await browserTool("browser_snapshot").execute({}, ctxFor(ID));
  assert.equal(fake.spawns.length, 1, "second call reuses the connection");
  const runtime = listProxiedConnections().find((c) => c.sessionId === ID);
  assert.ok(runtime, "connection is tracked");
  assert.equal(runtime.status, "running");
  assert.equal(runtime.pid, 4242);
});

test("browser_fill maps onto browser_type with the curated params", async () => {
  const ID = `proxied-fill-${Date.now()}`;
  const fake = installFakeProxy();
  trackSession(ID);

  await browserTool("browser_fill").execute(
    { target: "e12", element: "Name field", text: "hello" },
    ctxFor(ID),
  );
  assert.deepEqual(fake.calls[0], {
    name: "browser_type",
    args: {
      element: "Name field",
      target: "e12",
      text: "hello",
      submit: false,
    },
  });
});

/** The pre-connect tree this app actually served ([Task-440](pa://task/440)). */
const CONNECTING_TREE = "- status [ref=e4]:\n  - generic [ref=e7]: Connecting…";
const READY_TREE =
  '- main [ref=e9]:\n  - heading "Sessions" [level=1] [ref=e10]\n  - button "New session" [ref=e11]';

/** Everything the agent reads, across all content blocks. */
function textOf(result: { content: unknown[] }): string {
  return result.content
    .map((block) => (block as { text?: string }).text ?? "")
    .join("\n");
}

test("browser_navigate returns the tree the page settles into, not the placeholder it loads with", async () => {
  const ID = `proxied-settle-${Date.now()}`;
  const fake = installFakeProxy(
    snapshotSequence([CONNECTING_TREE, CONNECTING_TREE, READY_TREE]),
  );
  trackSession(ID);

  // This is a state-machine assertion, not a scheduler benchmark. Drive the
  // settle clock explicitly so a loaded CI worker cannot consume the 200 ms
  // test budget before the fake has served its READY tree.
  vi.useFakeTimers();
  try {
    const pending = browserTool("browser_navigate").execute(
      { url: "/" },
      ctxFor(ID),
    );
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;

    const text = textOf(result);
    assert.match(
      text,
      /heading "Sessions"/,
      "the settled tree reaches the agent",
    );
    assert.doesNotMatch(
      text,
      /Connecting…/,
      "a loading shell never counts as settled, however still it holds",
    );
    assert.doesNotMatch(text, /Note:/, "the page did settle");
    assert.ok(
      fake.calls.filter((call) => call.name === "browser_snapshot").length >= 4,
      "kept polling past the repeated placeholder trees",
    );
  } finally {
    vi.useRealTimers();
  }
});

test("a page stuck on a loading indicator returns it with a note saying so", async () => {
  const ID = `proxied-stuck-${Date.now()}`;
  installFakeProxy((name) =>
    name === "browser_snapshot" ? pageState(CONNECTING_TREE) : undefined,
  );
  trackSession(ID);

  const result = await browserTool("browser_navigate").execute(
    { url: "/" },
    ctxFor(ID),
  );

  const text = textOf(result);
  assert.match(text, /Connecting…/, "the last observed tree is still returned");
  assert.match(
    text,
    /200 ms after browser_navigate the page still showed only a loading indicator/,
    "the agent is told the app never came up, instead of reading it as empty",
  );
});

test("a live-region error on a compact page settles instead of being read as loading", async () => {
  const ID = `proxied-alert-${Date.now()}`;
  const errorTree = [
    '- alert [ref=e3]: "Wrong password"',
    "- form [ref=e4]:",
    '  - textbox "Password" [ref=e5]',
    '  - button "Sign in" [ref=e6]',
  ].join("\n");
  const fake = installFakeProxy((name) =>
    name === "browser_snapshot" ? pageState(errorTree) : undefined,
  );
  trackSession(ID);

  const result = await browserTool("browser_click").execute(
    { target: "e6", element: "Sign in" },
    ctxFor(ID),
  );

  const text = textOf(result);
  assert.match(text, /Wrong password/, "the agent gets the error it must read");
  assert.doesNotMatch(
    text,
    /Note:/,
    "an alert next to a form is an error, not a page still coming up",
  );
  assert.ok(
    fake.calls.filter((call) => call.name === "browser_snapshot").length < 8,
    "settled in the window instead of burning the whole budget",
  );
});

test("action-only sections survive settling", async () => {
  const ID = `proxied-sections-${Date.now()}`;
  installFakeProxy((name) =>
    name === "browser_snapshot"
      ? pageState(READY_TREE)
      : {
          content: [
            {
              type: "text",
              text:
                "### Ran Playwright code\n```js\nawait page.getByRole('button').click();\n```\n" +
                '### Events\n- Downloaded file report.csv to "downloads/report.csv"\n' +
                "### Page\n- Page URL: http://localhost:5173/\n",
            },
          ],
        },
  );
  trackSession(ID);

  const result = await browserTool("browser_click").execute(
    { target: "e6", element: "Export" },
    ctxFor(ID),
  );

  const text = textOf(result);
  assert.match(
    text,
    /Downloaded file report\.csv/,
    "a download notice is a delta Playwright never repeats — it must be carried over",
  );
  assert.match(text, /Ran Playwright code/, "the code that ran is kept");
  assert.match(text, /heading "Sessions"/, "and the settled tree is appended");
});

test("a page that never holds still returns the last tree with a warning", async () => {
  const ID = `proxied-unsettled-${Date.now()}`;
  let tick = 0;
  installFakeProxy((name) =>
    name === "browser_snapshot"
      ? pageState(`- main [ref=e2]: tick ${(tick += 1)}`)
      : undefined,
  );
  trackSession(ID);

  const result = await browserTool("browser_navigate").execute(
    { url: "/" },
    ctxFor(ID),
  );

  const text = textOf(result);
  assert.match(text, /tick \d+/, "the last observed tree is still returned");
  assert.match(
    text,
    /still changing 200 ms after browser_navigate/,
    "the agent is told the tree may be mid-update",
  );
  assert.match(text, /Call browser_snapshot again/);
});

test("an empty PA_BROWSER_SETTLE_MS falls back to the default instead of disabling settling", () => {
  delete process.env.PA_BROWSER_SETTLE_MS;
  const unset = settleDeadlineMs();
  assert.ok(unset > 0, "settling is on by default");
  process.env.PA_BROWSER_SETTLE_MS = "  ";
  assert.equal(
    settleDeadlineMs(),
    unset,
    "a blank value is unset, not a zero budget",
  );
  process.env.PA_BROWSER_SETTLE_MS = "0";
  assert.equal(settleDeadlineMs(), 0, "only an explicit 0 disables settling");
});

test("a file-linked tree is compared by content, not by its timestamped name", async () => {
  const ID = `proxied-linked-${Date.now()}`;
  // Playwright MCP writes the tree to a fresh page-<timestamp>.yml per call;
  // comparing those links as text would mean a page can never settle.
  mkdirSync(browserArtifactRoot(ID), { recursive: true });
  let written = 0;
  installFakeProxy(() => {
    const file = `page-2026-08-13T00-00-0${(written += 1)}.yml`;
    writeFileSync(join(browserArtifactRoot(ID), file), READY_TREE);
    return {
      content: [
        {
          type: "text",
          text: `### Page\n### Snapshot\n- [Snapshot](./${file})\n`,
        },
      ],
    };
  });
  trackSession(ID);

  const result = await browserTool("browser_navigate").execute(
    { url: "/" },
    ctxFor(ID),
  );

  assert.doesNotMatch(
    textOf(result),
    /Note:/,
    "an unchanging page settles instead of chasing a new filename every poll",
  );
});

test("browser_click settles too, and settling never fails an action", async () => {
  const ID = `proxied-click-settle-${Date.now()}`;
  const fake = installFakeProxy((name) => {
    if (name === "browser_snapshot") throw new Error("snapshot unavailable");
    return undefined;
  });
  trackSession(ID);

  const result = await browserTool("browser_click").execute(
    { target: "e7", element: "Save" },
    ctxFor(ID),
  );

  assert.equal(fake.calls[0]!.name, "browser_click");
  assert.equal(fake.calls[1]!.name, "browser_snapshot");
  assert.match(
    textOf(result),
    /ok:browser_click/,
    "a failing settle poll falls back to the action's own result",
  );
});

test("browser_navigate waitFor maps onto browser_wait_for and surfaces an unmet condition", async () => {
  const ID = `proxied-waitfor-${Date.now()}`;
  const fake = installFakeProxy();
  trackSession(ID);

  await browserTool("browser_navigate").execute(
    { url: "/", waitFor: { text: "Sessions", timeMs: 2500 } },
    ctxFor(ID),
  );
  assert.deepEqual(fake.calls[1], {
    name: "browser_wait_for",
    args: { text: "Sessions", time: 2.5 },
  });

  const unmet = installFakeProxy((name) =>
    name === "browser_wait_for"
      ? {
          content: [{ type: "text", text: "Timed out waiting for text" }],
          isError: true,
        }
      : undefined,
  );
  const OTHER = `proxied-waitfor-unmet-${Date.now()}`;
  trackSession(OTHER);
  await assert.rejects(
    browserTool("browser_navigate").execute(
      { url: "/", waitFor: { text: "Never" } },
      ctxFor(OTHER),
    ),
    /Timed out waiting for text/,
  );
  assert.equal(
    unmet.calls.some((call) => call.name === "browser_snapshot"),
    false,
    "an unmet condition is reported instead of a settled tree",
  );
});

test("screenshot injects a session artifact filename and the middleware records new files", async () => {
  const ID = `proxied-shot-${Date.now()}`;
  const fake = installFakeProxy((name, args) => {
    if (name === "browser_take_screenshot")
      writeFileSync(String(args.filename), "png-bytes");
  });
  trackSession(ID);

  const result = await browserTool("browser_screenshot").execute(
    { label: "after change" },
    ctxFor(ID),
  );
  const call = fake.calls[0]!;
  assert.equal(call.name, "browser_take_screenshot");
  assert.equal(call.args.type, "png");
  assert.ok(
    String(call.args.filename).startsWith(browserArtifactRoot(ID)),
    "filename is forced into the artifact dir",
  );

  const details = result.details as {
    artifacts: Array<{
      label: string;
      kind: string;
      url: string;
      mimeType: string;
    }>;
  };
  assert.equal(details.artifacts.length, 1);
  assert.equal(details.artifacts[0]!.label, "after change");
  assert.equal(details.artifacts[0]!.kind, "screenshot");
  assert.equal(details.artifacts[0]!.mimeType, "image/png");
  assert.ok(
    details.artifacts[0]!.url.startsWith(
      `/api/session-artifacts/${encodeURIComponent(ID)}/browser/`,
    ),
  );
  assert.match(
    (result.content[0] as { text: string }).text,
    /Session artifacts:/,
  );

  const stored = listSessionArtifacts(ID);
  assert.equal(stored.length, 1, "artifact is persisted in the side-store");
  assert.equal(stored[0]!.sourceTool, "browser_take_screenshot");
});

test("proxied MCP isError results reject instead of being reported as success", async () => {
  const ID = `proxied-error-${Date.now()}`;
  installFakeProxy(() => ({
    content: [{ type: "text", text: "upstream failed" }],
    isError: true,
  }));
  trackSession(ID);

  await assert.rejects(
    browserTool("browser_snapshot").execute({}, ctxFor(ID)),
    /upstream failed/,
  );
});

test("browser_close tears the connection down and a later call reconnects", async () => {
  const ID = `proxied-close-${Date.now()}`;
  const fake = installFakeProxy();
  trackSession(ID);

  await browserTool("browser_navigate").execute(
    { url: "http://localhost:5173/" },
    ctxFor(ID),
  );
  assert.ok(listProxiedConnections().some((c) => c.sessionId === ID));

  await browserTool("browser_close").execute({}, ctxFor(ID));
  assert.equal(fake.closeCount, 1, "browser_close closes the client");
  assert.equal(
    listProxiedConnections().some((c) => c.sessionId === ID),
    false,
    "connection untracked",
  );

  // A later call reconnects lazily, same as the very first call.
  await browserTool("browser_snapshot").execute({}, ctxFor(ID));
  assert.equal(fake.spawns.length, 2);
  assert.ok(listProxiedConnections().some((c) => c.sessionId === ID));
});
