/**
 * The browser tool groups (ordinary catalog groups, `tools/catalog.ts`):
 *   - `browser` — curated Playwright MCP browser tools (an mcp-proxy pack with
 *     schema overrides + param mapping, e.g. browser_fill → browser_type, and
 *     artifact-capture middleware); always usable, discovered like any other
 *     deferred tool.
 *   - `browser-raw-mcp` — the advanced escape hatch: a native tool calling raw
 *     Playwright MCP tools by name over the SAME session connection (lazily
 *     opened on first use, shared with the `browser` pack). Gated by the
 *     `browserRawMcp` Settings toggle, exactly like any other integration.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CWD, DATA_DIR } from "../../config.ts";
import { PLAYWRIGHT_MCP_CLI_PATH } from "../../runtimeAssets.ts";
import { defineAgentTool } from "../tool.ts";
import {
  recordNewArtifacts,
  runProxiedPackCall,
  snapshotArtifactFiles,
  type McpProxyMiddleware,
  type McpProxyToolGroupDefinition,
  type NativeToolGroupDefinition,
  type ProxiedToolSpec,
} from "./packRuntime.ts";
import {
  closeProxiedConnection,
  type McpToolResult,
  type ProxiedMcpConnection,
  type ProxiedServerSpec,
} from "./proxiedServer.ts";

/** Where a session's browser artifacts (screenshots, traces, …) live on disk. */
export function browserArtifactRoot(sessionId: string): string {
  return join(DATA_DIR, "session-artifacts", sessionId, "browser");
}

/** Browser executable paths Playwright MCP does not discover by default. */
function browserExecutablePath(): string | undefined {
  const configured =
    process.env.PA_BROWSER_EXECUTABLE_PATH?.trim() ||
    process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH?.trim();
  if (configured) return configured;
  const homeManagerChrome = join(
    homedir(),
    "Applications",
    "Home Manager Apps",
    "Google Chrome.app",
    "Contents",
    "MacOS",
    "Google Chrome",
  );
  return existsSync(homeManagerChrome) ? homeManagerChrome : undefined;
}

/** Playwright MCP spawn spec — keep args stable and add an explicit executable when Chrome lives outside Playwright's default macOS lookup paths. */
const playwrightServerSpec: ProxiedServerSpec = {
  name: "Playwright MCP",
  outputDir: browserArtifactRoot,
  spawn({ outputDir, headed }) {
    const args = [
      PLAYWRIGHT_MCP_CLI_PATH,
      "--output-dir",
      outputDir,
      "--isolated",
    ];
    const executablePath = browserExecutablePath();
    if (executablePath) args.push("--executable-path", executablePath);
    if (!headed) args.push("--headless");
    return {
      command: process.execPath,
      args,
      trustedEnv: { PLAYWRIGHT_MCP_OUTPUT_DIR: outputDir },
      cwd: CWD,
    };
  },
};

/** Artifact capture: diff the artifact dir around every call, record new files. */
const browserArtifactMiddleware: McpProxyMiddleware = {
  before: (sessionId) => snapshotArtifactFiles(browserArtifactRoot(sessionId)),
  after: (sessionId, label, result, state) =>
    recordNewArtifacts(
      sessionId,
      browserArtifactRoot(sessionId),
      state as Set<string>,
      label,
      result.name,
    ),
};

function normalizeUrl(url: unknown): string {
  const text = typeof url === "string" ? url.trim() : "";
  if (!text) throw new Error("url is required.");
  if (text.startsWith("http://") || text.startsWith("https://")) return text;
  if (text.startsWith("/")) return `http://localhost:5173${text}`;
  return text;
}

function normalizeViewportSize(params: { width?: unknown; height?: unknown }): {
  width: number;
  height: number;
} {
  const width = normalizeViewportDimension(params.width, "width");
  const height = normalizeViewportDimension(params.height, "height");
  return { width, height };
}

function normalizeViewportDimension(
  value: unknown,
  name: "width" | "height",
): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(number) || number < 100 || number > 8192)
    throw new Error(
      `${name} must be an integer between 100 and 8192 CSS pixels.`,
    );
  return number;
}

function artifactFileName(prefix: string, ext: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
}

/* --------------------------- page-state settling --------------------------- */

/**
 * A client-rendered page reaches `load` long before the tree that means
 * anything exists: the shell paints a placeholder and fills in once its data
 * (or WebSocket) arrives, so the page state Playwright MCP returns with an
 * action races the first meaningful render — a navigate to this very app used
 * to report a 54-byte "Connecting…" tree ([Task-440](pa://task/440)).
 *
 * Every curated action that changes what the page shows therefore re-snapshots
 * until the accessibility tree HOLDS STILL, and returns the SETTLED tree in
 * place of the racing one. Two guards, both learned from driving the real app:
 *   - Stability is a WINDOW, not a single repeat — a placeholder waiting on a
 *     socket repeats happily, and a 500 ms window still settled on "Connecting…"
 *     under load.
 *   - A tree that offers nothing but a live region (`status`/`progressbar`/
 *     `alert`) is a LOADING SHELL and never counts as settled however still it
 *     holds; only the budget ends that wait. "Nothing but" is the point: a
 *     `role=alert` on a page that also has a form or a heading is an ERROR the
 *     agent must read, not a page still coming up.
 * This needs no per-app readiness hook, and the intermediate trees are
 * discarded, so the cost is latency, never agent context. `browser_snapshot`
 * stays a raw read — it is how an agent watches a page that is still moving.
 *
 * What the settled result carries: Playwright MCP rebuilds `Page`, `Open tabs`
 * and `Modal state` from live tab state on EVERY response, so a snapshot's
 * copies are fresher than the action's. `Ran Playwright code`, `Result` and
 * `Events` are not rebuilt — `Events` in particular reports download
 * start/finish and new console entries as a DELTA since the previous capture —
 * so those sections are carried over from the action instead of being dropped.
 */
const SETTLE_DEFAULT_MS = 8000;
const SETTLE_MAX_POLL_MS = 150;
const SETTLE_STABLE_MS = 750;
/** A loading shell is small, has a live region, and offers nothing to act on. */
const LOADING_SHELL_MAX_CHARS = 600;
const LIVE_REGION_ROLE = /^\s*-\s*'?(status|progressbar|alert)\b/m;
const ACTIONABLE_ROLE =
  /^\s*-\s*'?(button|link|textbox|searchbox|combobox|checkbox|radio|slider|spinbutton|switch|menuitem|option|tab|heading|main|navigation|complementary|contentinfo|form|dialog|table|list|listitem|article)\b/m;
/** Sections Playwright MCP does not rebuild per response (see the module note). */
const ACTION_ONLY_SECTIONS = ["Ran Playwright code", "Result", "Events"];

/** Settle budget for one action; `PA_BROWSER_SETTLE_MS=0` disables settling. */
export function settleDeadlineMs(): number {
  const raw = process.env.PA_BROWSER_SETTLE_MS?.trim();
  if (!raw) return SETTLE_DEFAULT_MS;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : SETTLE_DEFAULT_MS;
}

/** Poll cadence: at most 150 ms, and at least eight polls inside the budget. */
function settlePollMs(deadlineMs: number): number {
  return Math.max(10, Math.min(SETTLE_MAX_POLL_MS, Math.floor(deadlineMs / 8)));
}

/** How long one tree must hold to count as settled (never more than half the budget). */
function settleStableMs(deadlineMs: number): number {
  return Math.min(SETTLE_STABLE_MS, Math.floor(deadlineMs / 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The comparable part of one result: its accessibility tree, so an action's
 * page state and a plain snapshot of the same page compare equal despite the
 * action's own "Ran Playwright code" preamble. Playwright MCP returns the tree
 * inline as fenced YAML for `browser_snapshot` but writes it to a timestamped
 * `page-*.yml` in the output dir after an ACTION, and a filename changes on
 * every call — so a linked tree is read back from the artifact dir, never
 * compared as text.
 */
function pageStateKey(result: McpToolResult, sessionId: string): string {
  const text = resultText(result);
  const trees = text.match(/```yaml\n[\s\S]*?```/g);
  if (trees) return trees.join("\n").trim();
  const linked = text.match(/[\w.-]+\.yml/g)?.at(-1);
  if (linked) {
    const file = join(browserArtifactRoot(sessionId), linked);
    try {
      if (existsSync(file)) return readFileSync(file, "utf8").trim();
    } catch {
      // Unreadable artifact: fall through to the raw text.
    }
  }
  return text.trim();
}

/** Whether a tree is still just a loading indicator (see the module note above). */
function isLoadingShell(key: string): boolean {
  return (
    key.length <= LOADING_SHELL_MAX_CHARS &&
    LIVE_REGION_ROLE.test(key) &&
    !ACTIONABLE_ROLE.test(key)
  );
}

/** Text of every content block, joined the way the agent will read it. */
function resultText(result: McpToolResult): string {
  return result.content
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

/**
 * The action's own `### …` sections that a later snapshot does not reproduce,
 * so settling never swallows a download notice or the code that ran.
 */
function carriedOverSections(action: McpToolResult): string {
  return resultText(action)
    .split(/^### /m)
    .slice(1)
    .filter((section) =>
      ACTION_ONLY_SECTIONS.includes(section.split("\n", 1)[0]!.trim()),
    )
    .map((section) => `### ${section.trimEnd()}`)
    .join("\n");
}

/** The settled snapshot, under the action's name and keeping its action-only sections. */
function settledResult(
  action: McpToolResult,
  snapshot: McpToolResult,
): McpToolResult {
  const carried = carriedOverSections(action);
  return {
    ...snapshot,
    name: action.name,
    content: carried
      ? [{ type: "text", text: carried }, ...snapshot.content]
      : snapshot.content,
  };
}

/** Poll snapshots until one tree holds; best effort — a failed poll returns what we have. */
async function settledPageState(
  connection: ProxiedMcpConnection,
  action: McpToolResult,
): Promise<McpToolResult> {
  if (action.isError) return action;
  const budget = settleDeadlineMs();
  const pollMs = settlePollMs(budget);
  const stableMs = settleStableMs(budget);
  const deadline = Date.now() + budget;
  let key = pageStateKey(action, connection.sessionId);
  let stableSince = Date.now();
  let latest = action;
  let polls = 0;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let snapshot: McpToolResult;
    try {
      snapshot = await connection.call("browser_snapshot", {});
    } catch {
      return latest;
    }
    if (snapshot.isError) return latest;
    polls += 1;
    latest = settledResult(action, snapshot);
    const next = pageStateKey(snapshot, connection.sessionId);
    if (next !== key) {
      key = next;
      stableSince = Date.now();
      continue;
    }
    if (isLoadingShell(next)) continue;
    if (Date.now() - stableSince >= stableMs) return latest;
  }
  if (polls === 0) return latest;
  return {
    ...latest,
    content: [
      ...latest.content,
      {
        type: "text",
        text: isLoadingShell(key)
          ? `Note: ${budget} ms after ${action.name} the page still showed only a loading indicator — it may need longer, or it may be stuck. Re-run browser_snapshot, or navigate with waitFor.`
          : `Note: the page was still changing ${budget} ms after ${action.name}, so this tree may be mid-update. Call browser_snapshot again to see where it landed.`,
      },
    ],
  };
}

/** Run an upstream action and return the page state it settles into. */
function settledAction(
  connection: ProxiedMcpConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  return connection
    .call(name, args)
    .then((result) => settledPageState(connection, result));
}

/**
 * Optional explicit readiness condition for an app slower than the settle
 * budget (or one that settles on an intermediate tree). Maps onto Playwright
 * MCP's `browser_wait_for`; an unmet condition comes back as its error.
 */
async function waitForCondition(
  connection: ProxiedMcpConnection,
  waitFor: unknown,
): Promise<McpToolResult | undefined> {
  if (!waitFor || typeof waitFor !== "object") return undefined;
  const { text, timeMs } = waitFor as { text?: unknown; timeMs?: unknown };
  const args: Record<string, unknown> = {};
  if (typeof text === "string" && text.trim()) args.text = text.trim();
  if (typeof timeMs === "number" && timeMs > 0) args.time = timeMs / 1000;
  if (Object.keys(args).length === 0) return undefined;
  return connection.call("browser_wait_for", args);
}

const curatedBrowserTools: ProxiedToolSpec[] = [
  {
    name: "browser_navigate",
    label: "Browser Navigate",
    description:
      "Navigate the session-scoped Playwright browser to a local path or URL. Returns the page state the app settles into, not the tree at page load; pass waitFor when an app needs longer or has a known readiness marker.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" },
        waitFor: {
          type: "object",
          additionalProperties: false,
          description:
            "Optional readiness condition applied before the page state is captured.",
          properties: {
            text: {
              type: "string",
              description: "Wait until this text appears on the page.",
            },
            timeMs: {
              type: "integer",
              minimum: 0,
              maximum: 60000,
              description:
                "Sleep this long before capturing the page state (not a timeout for text).",
            },
          },
        },
      },
      required: ["url"],
    },
    call: async (connection, p) => {
      const result = await connection.call("browser_navigate", {
        url: normalizeUrl(p.url),
      });
      if (result.isError) return result;
      const waited = await waitForCondition(connection, p.waitFor);
      if (waited?.isError) return waited;
      return settledPageState(connection, result);
    },
  },
  {
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "Return a Playwright accessibility snapshot of the current page, exactly as it looks right now.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    call: (connection) => connection.call("browser_snapshot", {}),
  },
  {
    name: "browser_click",
    label: "Browser Click",
    description:
      "Click an element using Playwright MCP's snapshot target reference. Returns the page state the click settles into.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        element: { type: "string" },
        target: { type: "string" },
        ref: { type: "string", description: "Deprecated alias for target." },
      },
      required: ["target"],
    },
    call: (connection, p) =>
      settledAction(connection, "browser_click", {
        element: p.element ?? p.target,
        target: p.target ?? p.ref,
      }),
  },
  {
    name: "browser_fill",
    label: "Browser Fill",
    description:
      "Fill/type text into an element using a snapshot target reference. Returns the page state the input settles into.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        element: { type: "string" },
        target: { type: "string" },
        ref: { type: "string", description: "Deprecated alias for target." },
        text: { type: "string" },
        submit: { type: "boolean" },
      },
      required: ["target", "text"],
    },
    call: (connection, p) =>
      settledAction(connection, "browser_type", {
        element: p.element ?? p.target,
        target: p.target ?? p.ref,
        text: p.text,
        submit: Boolean(p.submit),
      }),
  },
  {
    name: "browser_press",
    label: "Browser Press",
    description:
      "Press a keyboard key in the browser. Returns the page state the key settles into.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { key: { type: "string" } },
      required: ["key"],
    },
    call: (connection, p) =>
      settledAction(connection, "browser_press_key", { key: p.key }),
  },
  {
    name: "browser_resize_viewport",
    label: "Browser Resize Viewport",
    description:
      "Resize the session-scoped browser viewport for desktop, narrow, or mobile-layout checks.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        width: {
          type: "integer",
          minimum: 100,
          maximum: 8192,
          description: "Viewport width in CSS pixels.",
        },
        height: {
          type: "integer",
          minimum: 100,
          maximum: 8192,
          description: "Viewport height in CSS pixels.",
        },
      },
      required: ["width", "height"],
    },
    call: (connection, p) =>
      connection.call("browser_resize", normalizeViewportSize(p)),
  },
  {
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Take a screenshot stored as a session artifact, never in the repo working tree.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { label: { type: "string" }, fullPage: { type: "boolean" } },
    },
    call: (connection, p) =>
      connection.call("browser_take_screenshot", {
        type: "png",
        fullPage: Boolean(p.fullPage),
        filename: join(
          browserArtifactRoot(connection.sessionId),
          artifactFileName("screenshot", "png"),
        ),
      }),
  },
  {
    name: "browser_console",
    label: "Browser Console",
    description: "List recent browser console messages.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        level: { type: "string", enum: ["error", "warning", "info", "debug"] },
        all: { type: "boolean" },
      },
    },
    call: (connection, p) =>
      connection.call("browser_console_messages", {
        level: p.level ?? "warning",
        all: Boolean(p.all),
      }),
  },
  {
    name: "browser_network",
    label: "Browser Network",
    description:
      "List recent browser network requests, including failed requests.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { static: { type: "boolean" }, filter: { type: "string" } },
    },
    call: (connection, p) =>
      connection.call("browser_network_requests", {
        static: Boolean(p.static),
        ...(p.filter ? { filter: p.filter } : {}),
      }),
  },
  {
    name: "browser_close",
    label: "Browser Close",
    description: "Close the session-scoped browser/MCP process.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    call: async (connection) => {
      const result = await connection.call("browser_close", {});
      await closeProxiedConnection(connection.sessionId);
      return result;
    },
  },
];

export const browserToolGroup: McpProxyToolGroupDefinition = {
  kind: "mcp-proxy",
  id: "browser",
  label: "Browser testing",
  description:
    "Curated Playwright MCP browser tools for normal local web UI testing.",
  server: playwrightServerSpec,
  tools: curatedBrowserTools,
  middleware: browserArtifactMiddleware,
};

type RawMcpCallParams = {
  tool?: unknown;
  params?: Record<string, unknown>;
  label?: unknown;
};

/** Raw escape hatch: gated by the raw pack, served by the browser pack's connection. */
const browserMcpCallTool = defineAgentTool<RawMcpCallParams>({
  name: "browser_mcp_call",
  label: "Raw Browser MCP Call",
  description:
    "Advanced escape hatch: call a raw Playwright MCP tool by name when the standard browser_* tools cannot perform the needed action.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      tool: { type: "string" },
      params: { type: "object" },
      label: { type: "string" },
    },
    required: ["tool"],
  },
  executionMode: "sequential",
  async execute(params, ctx) {
    return runProxiedPackCall({
      connectionPack: browserToolGroup,
      sessionId: ctx.session.sessionId,
      toolName: "browser_mcp_call",
      artifactLabel:
        typeof params.label === "string"
          ? params.label
          : "Raw Browser MCP Call",
      call: (connection) =>
        connection.call(String(params.tool), params.params ?? {}),
    });
  },
});

export const rawBrowserToolGroup: NativeToolGroupDefinition = {
  kind: "native",
  id: "browser-raw-mcp",
  label: "Raw browser MCP",
  description:
    "Advanced escape hatch for Playwright MCP capabilities missing from the standard browser tools.",
  tools: [browserMcpCallTool],
};
