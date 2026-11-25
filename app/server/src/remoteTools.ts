/**
 * Client mode's gateway tools (Task-1398): the edge's tools Pandeck's agents
 * call through the client link (`tools.list`, `tools.call`, and on gateway
 * client 1.1 `tools.prepare` and `tools.apply`, `gatewayClientLink.ts`). The
 * catalog's remote group (`tools/gateway/remoteToolGroup.ts`) is built from
 * the set kept here.
 *
 * The link lists on every connect, before it publishes the connection, and
 * hands the listing to {@link applyListing}. The `actionKey` prefix names the
 * product, and {@link PRODUCTS} maps `jira`, `slack` and `confluence` to the
 * Settings toggle that turns their tools on. A name in {@link WRITE_TOOLS} is
 * decided there (Task-1463 P6b): it is accepted only as that row's two-phase
 * write, whose agent tool is the local one behind the local approval card,
 * and is never a read. A name in {@link FILE_TOOLS} is decided next
 * (Task-1441 P7a): it is accepted only as that row's file tool, whose agent
 * tool is the local one and whose answer is staged here, and is never an
 * ordinary read. Every other name is accepted only as a bounded read tool
 * that carries no `file`; a product in {@link PRODUCT_READS} accepts only the
 * names listed there. A name accepted once stays known for the boot, so a pi engine's
 * universe, registered at open, never outgrows the server's binding; a
 * dispatch checks the CURRENT listing, connection and product toggle before
 * any call. A pi open waits for the boot's first listing.
 *
 * Types are structural: nothing here imports `gateway/`.
 */
import { getConfluenceSettings } from "./confluenceSettings.ts";
import { GatewayUnavailableError } from "./gatewayLink.ts";
import { notifyIntegrationToolsChanged } from "./integrationToolChanges.ts";
import { getJiraSettings } from "./jiraSettings.ts";
import { getSlackRuntimeSettings } from "./slackSettings.ts";

/**
 * The mapped products and their Settings toggle: a listed tool is accepted
 * only when its `actionKey` prefix is a key here. UI text and catalog group
 * metadata live with the remote group and the catalog, not here.
 */
const PRODUCTS = {
  jira: () => getJiraSettings().enabled,
  slack: () => getSlackRuntimeSettings().enabled,
  confluence: () => getConfluenceSettings().enabled,
} as const;

export type RemoteProduct = keyof typeof PRODUCTS;

/**
 * Products that accept only these names (Task-1439 P3): any other entry of
 * the product is dropped, so a tool the edge adds later (the attachment
 * download, a write) stays out until a change here admits it on purpose.
 * Products without an entry accept every bounded read tool.
 */
const PRODUCT_READS: Partial<Record<RemoteProduct, ReadonlySet<string>>> = {
  confluence: new Set([
    "confluence_search",
    "confluence_get_page",
    "confluence_lookup",
  ]),
};

/**
 * The gateway writes Pandeck offers (Task-1463 P6b), by tool name: each is
 * the local tool of that name, proposing through the edge's `tools.prepare`
 * and raising the local approval card of `kind`. A listed entry of one of
 * these names is accepted only as this row's write.
 */
const WRITE_TOOLS = {
  jira_mutate_issue: { product: "jira", kind: "jiraIssue" },
  confluence_mutate_page: { product: "confluence", kind: "confluencePage" },
} as const satisfies Record<
  string,
  { product: RemoteProduct; kind: "jiraIssue" | "confluencePage" }
>;

export type RemoteWriteName = keyof typeof WRITE_TOOLS;

/** The local `confluence_download_attachment`'s cap, 100 MiB (OD-7a1 (a)). */
const CONFLUENCE_FILE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * The gateway file tools Pandeck offers (Task-1441 P7a, AC7 and H3), by tool
 * name: each is the local tool of that name, whose answer carries one file
 * Pandeck verifies and stages. A listed entry of one of these names is
 * accepted only as this row's file tool: a `read` of the row's `actionKey`
 * whose `file` names the row's `limitParam` and stays within `hardMaxBytes`,
 * the local definition's cap. The agent-facing half of each row, the local
 * definition and its result builder, is `FILE_ADAPTERS` in
 * `tools/gateway/remoteFiles.ts`, keyed by the same names; this half stays
 * here, dependency-light, so admission loads nothing of the tool graph.
 */
const FILE_TOOLS = {
  confluence_download_attachment: {
    product: "confluence",
    actionKey: "confluence:read",
    limitParam: "maxBytes",
    hardMaxBytes: CONFLUENCE_FILE_MAX_BYTES,
  },
} as const satisfies Record<
  string,
  {
    product: RemoteProduct;
    actionKey: string;
    limitParam: string;
    hardMaxBytes: number;
  }
>;

export type RemoteFileName = keyof typeof FILE_TOOLS;

function isRemoteProduct(value: string | undefined): value is RemoteProduct {
  return value !== undefined && Object.hasOwn(PRODUCTS, value);
}

function isWriteName(name: string): name is RemoteWriteName {
  return Object.hasOwn(WRITE_TOOLS, name);
}

function isFileName(name: string): name is RemoteFileName {
  return Object.hasOwn(FILE_TOOLS, name);
}

/** A file tool row's limit argument and cap (Task-1441 P7a, H3). */
export function remoteFileRow(name: RemoteFileName): {
  limitParam: string;
  hardMaxBytes: number;
} {
  const { limitParam, hardMaxBytes } = FILE_TOOLS[name];
  return { limitParam, hardMaxBytes };
}

/** A gateway read tool, called once with `tools.call`. */
export interface RemoteReadDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: "read";
  actionKey: string;
  product: RemoteProduct;
}

/**
 * A gateway write the edge runs in two phases. The listed description and
 * schema are not kept: the agent tool is the local definition.
 */
export interface RemoteWriteDescriptor {
  name: RemoteWriteName;
  effect: "write";
  actionKey: `${RemoteProduct}:write`;
  product: RemoteProduct;
  kind: (typeof WRITE_TOOLS)[RemoteWriteName]["kind"];
  twoPhase: true;
}

/** A file tool's limits as the edge listed them (Task-1441 P7a, H3). */
export interface RemoteFileLimits {
  /** The tool's own limit argument, the row's. */
  limitParam: string;
  defaultBytes: number;
  maxBytes: number;
}

/**
 * A gateway file tool, called with `tools.call` and answered with one file
 * (Task-1441 P7a). The listed description and schema are not kept: the
 * agent tool is the local definition.
 */
export interface RemoteFileDescriptor {
  name: RemoteFileName;
  effect: "read";
  actionKey: string;
  product: RemoteProduct;
  file: RemoteFileLimits;
}

export type RemoteToolDescriptor =
  RemoteReadDescriptor | RemoteWriteDescriptor | RemoteFileDescriptor;

/** The edge's answer to one call, as the link decodes it. */
export type RemoteToolAnswer =
  | { ok: true; text: string }
  | {
      ok: false;
      code:
        | "unknown_tool"
        | "invalid_params"
        | "tool_error"
        | "result_too_large"
        | "timeout"
        | "cancelled"
        | "failed";
      message: string;
    };

type RemoteToolFailure = Extract<RemoteToolAnswer, { ok: false }>;

/**
 * A file tool's answer as the link decodes it (Task-1441 P7a, H3): the file,
 * its size and digest already checked against the call's limit; a plain
 * success; or the failure, `timeout` and `cancelled` included. Its fields
 * are the edge's and unchecked beyond the wire's bounds: the tool's adapter
 * validates the text.
 */
export type RemoteFileAnswer =
  | {
      kind: "file";
      text: string;
      file: { name: string; mimeType: string; size: number; sha256: string };
      bytes: Uint8Array;
    }
  | { kind: "plain"; text: string }
  | ({ kind: "failure" } & Omit<RemoteToolFailure, "ok">);

/**
 * The edge's answer to `tools.prepare`, as the link decodes it (shallow): the
 * proposal for the credential's site, unchecked. Nothing was written.
 */
export type RemotePrepareAnswer =
  | { ok: true; site: string; items: unknown[]; warnings: string[] }
  | RemoteToolFailure;

/** Whether any write request left the edge. */
type RemoteEffects = "none" | "possible";

/** The edge's answer to `tools.apply`, as the link decodes it (shallow). */
export type RemoteApplyAnswer =
  | { ok: true; results: object[]; effects: RemoteEffects; trimmed?: true }
  | (RemoteToolFailure & {
      effects: RemoteEffects;
      itemEffects?: RemoteEffects[];
      results?: object[];
      trimmed?: true;
    });

/**
 * How a `tools.apply` went (Task-1463 P6b, P6-F4), never a message. Only
 * `notSent` proves the edge never saw the request. A decoded `answer`, a
 * failed one too, carries the edge's own `effects`, which alone says whether
 * anything was written (D6(i)); every other outcome, an error frame (`lost`)
 * included, may have written (D2).
 */
export type RemoteApplyOutcome =
  | { outcome: "notSent" }
  | { outcome: "answer"; answer: RemoteApplyAnswer }
  | { outcome: "lost" }
  | { outcome: "timeout" }
  | { outcome: "undecodable" };

/**
 * A call the link could not make, or an answer it would not take; the tool
 * group says why in fixed text. `unexpected_file` is a byte stream the call
 * did not ask for, or a file answer of the wrong shape or size, and
 * `corrupted_file` a file whose digest does not match; `file_busy` is a
 * file call while this server's one is still running (Task-1441 P7a).
 */
export class RemoteToolRefusal extends Error {
  constructor(
    readonly code:
      | "gateway_unavailable"
      | "tools_unavailable"
      | "undecodable"
      | "unexpected_file"
      | "corrupted_file"
      | "file_busy",
  ) {
    super(code);
  }
}

/** The gateway's tool calls, as the client link offers them. */
export interface RemoteToolPort {
  call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<RemoteToolAnswer>;
  /**
   * A write's proposal; nothing is written. Throws {@link RemoteToolRefusal}
   * when the link can't ask or can't read the answer.
   */
  prepare(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<RemotePrepareAnswer>;
  /** Applies approved items once; never throws and takes no caller signal. */
  apply(
    name: string,
    site: string,
    items: unknown[],
  ): Promise<RemoteApplyOutcome>;
  /**
   * A file tool's call (Task-1441 P7a, G1): bounded for a file's transfer,
   * decoded only as a file answer at most `expect.maxBytes`, and one at a
   * time per server. `use` runs on the answer while the call still holds
   * that slot, so staging finishes before another file call may start; the
   * slot is kept past a timeout or cancel until the edge's late answer or
   * the connection's end retires the request. Throws
   * {@link RemoteToolRefusal}.
   */
  callFile<R>(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    expect: { maxBytes: number },
    use: (answer: RemoteFileAnswer) => R | Promise<R>,
  ): Promise<R>;
}

const MAX_TOOLS = 64;
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_DESCRIPTION = 1_024;
const MAX_SCHEMA = 4_096;
/** The product is the `actionKey`'s prefix; {@link PRODUCTS} says which map. */
const ACTION_KEY_RE = /^([a-z]+):[a-z_]{1,32}$/;

let port: RemoteToolPort | undefined;
const known = new Map<string, RemoteToolDescriptor>();
let current = new Set<string>();
let connected = false;
let resolveFirstListing!: () => void;
let firstListing = new Promise<void>((resolve) => {
  resolveFirstListing = resolve;
});

/** Installs the client link's port; answers its uninstall. */
export function installRemoteToolPort(next: RemoteToolPort): () => void {
  port = next;
  return () => {
    if (port !== next) return;
    port = undefined;
    known.clear();
    current = new Set();
    connected = false;
    firstListing = new Promise<void>((resolve) => {
      resolveFirstListing = resolve;
    });
  };
}

/** The installed port, in client mode only. */
export function remoteToolPort(): RemoteToolPort | undefined {
  return port;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * One listed entry, in four steps (Task-1463 P6b v04, Task-1441 P7a AC7):
 * the shape and the mapped product first; then a {@link WRITE_TOOLS} name is
 * decided as that row's write, and a {@link FILE_TOOLS} name as that row's
 * file tool, and neither reaches the read path; then every other name as a
 * bounded read. A reserved name's description and schema are neither checked
 * nor kept (the edge's Jira write schema is over {@link MAX_SCHEMA}).
 */
function accepted(value: unknown): RemoteToolDescriptor | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  const { name } = entry;
  const actionKey = typeof entry.actionKey === "string" ? entry.actionKey : "";
  const product = ACTION_KEY_RE.exec(actionKey)?.[1];
  if (typeof name !== "string" || !NAME_RE.test(name)) return undefined;
  if (!isRemoteProduct(product)) return undefined;
  if (isWriteName(name)) return acceptedWrite(name, entry, product);
  if (isFileName(name)) return acceptedFile(name, entry, product);
  return acceptedRead(name, entry, product);
}

const isSafeIn = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= min &&
  (value as number) <= max;

/**
 * A reserved file name: its row's file tool, else nothing. Its `file` names
 * the row's limit argument, a `maxBytes` within the local cap and a
 * `defaultBytes` within that (H3).
 */
function acceptedFile(
  name: RemoteFileName,
  entry: Record<string, unknown>,
  product: RemoteProduct,
): RemoteFileDescriptor | undefined {
  const row = FILE_TOOLS[name];
  const file = record(entry.file);
  if (
    entry.effect !== "read" ||
    entry.actionKey !== row.actionKey ||
    product !== row.product ||
    !file ||
    file.limitParam !== row.limitParam ||
    !isSafeIn(file.maxBytes, 1, row.hardMaxBytes) ||
    !isSafeIn(file.defaultBytes, 1, file.maxBytes as number)
  )
    return undefined;
  return {
    name,
    effect: "read",
    actionKey: row.actionKey,
    product: row.product,
    file: {
      limitParam: row.limitParam,
      defaultBytes: file.defaultBytes as number,
      maxBytes: file.maxBytes as number,
    },
  };
}

/** A reserved name: its row's two-phase write, else nothing. */
function acceptedWrite(
  name: RemoteWriteName,
  entry: Record<string, unknown>,
  product: RemoteProduct,
): RemoteWriteDescriptor | undefined {
  const row = WRITE_TOOLS[name];
  const actionKey = `${row.product}:write` as const;
  if (
    entry.effect !== "write" ||
    entry.actionKey !== actionKey ||
    entry.twoPhase !== true ||
    product !== row.product
  )
    return undefined;
  return {
    name,
    effect: "write",
    actionKey,
    product: row.product,
    kind: row.kind,
    twoPhase: true,
  };
}

/**
 * Any other name: a read tool of the product within the bounds. An entry
 * that carries `file` is dropped (P7A-R4): only a {@link FILE_TOOLS} row may
 * answer a file, so a file tool this server does not know never becomes a
 * read whose every call fails.
 */
function acceptedRead(
  name: string,
  entry: Record<string, unknown>,
  product: RemoteProduct,
): RemoteReadDescriptor | undefined {
  const { description, inputSchema, effect, actionKey } = entry;
  const schema = record(inputSchema);
  if (
    Object.hasOwn(entry, "file") ||
    typeof description !== "string" ||
    description.length < 1 ||
    description.length > MAX_DESCRIPTION ||
    !schema ||
    schema.type !== "object" ||
    JSON.stringify(schema).length > MAX_SCHEMA ||
    effect !== "read" ||
    typeof actionKey !== "string" ||
    PRODUCT_READS[product]?.has(name) === false
  )
    return undefined;
  return {
    name,
    description,
    inputSchema: schema,
    effect,
    actionKey,
    product,
  };
}

/**
 * The listing's entries Pandeck offers its agents: the first 64, the
 * reserved writes and the read tools of a mapped product within the bounds,
 * a name listed twice not at all.
 */
export function acceptRemoteTools(listing: unknown): RemoteToolDescriptor[] {
  if (!Array.isArray(listing)) return [];
  const entries = listing.slice(0, MAX_TOOLS);
  const names = entries.map((entry) => record(entry)?.name);
  const tools = entries
    .map(accepted)
    .filter(
      (tool): tool is RemoteToolDescriptor =>
        tool !== undefined &&
        names.indexOf(tool.name) === names.lastIndexOf(tool.name),
    );
  const dropped = listing.length - tools.length;
  if (dropped > 0)
    console.log(`[remote-tools] dropped ${dropped} gateway tool(s)`);
  return tools;
}

function changed(): void {
  try {
    notifyIntegrationToolsChanged();
  } catch (err) {
    console.error("[remote-tools] a tool-change subscriber failed:", err);
  }
}

/** A connect's accepted listing; known names stay for the boot. */
export function applyListing(tools: readonly RemoteToolDescriptor[]): void {
  for (const tool of tools) known.set(tool.name, tool);
  current = new Set(tools.map((tool) => tool.name));
  connected = true;
  resolveFirstListing();
  changed();
}

/** The link's published connection ended. */
export function markDisconnected(): void {
  connected = false;
  changed();
}

/**
 * Settles once this boot's first listing is applied; outside client mode at
 * once. Rejects with the gateway-unavailable refusal after `ms`.
 */
export function remoteToolsReady(ms: number): Promise<void> {
  if (!port) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new GatewayUnavailableError()), ms);
    void firstListing.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Every remote tool of `product` accepted this boot, first-accepted order. */
export function knownRemoteTools(
  product: RemoteProduct,
): RemoteToolDescriptor[] {
  return [...known.values()].filter((tool) => tool.product === product);
}

/** Whether `product`'s tools are turned on in Settings. */
export function remoteProductEnabled(product: RemoteProduct): boolean {
  return PRODUCTS[product]();
}

/** A remote group's gate: connected and its product turned on in Settings. */
export function remoteToolGate(product: RemoteProduct): boolean {
  return connected && remoteProductEnabled(product);
}

/**
 * Whether `name` may be called now: connected, listed now, product on; with
 * `"two-phase"`, also listed as a two-phase write.
 */
export function remoteToolDispatchable(
  name: string,
  requires?: "two-phase",
): boolean {
  const tool = known.get(name);
  return (
    tool !== undefined &&
    (requires !== "two-phase" || (tool.effect === "write" && tool.twoPhase)) &&
    connected &&
    current.has(name) &&
    remoteProductEnabled(tool.product)
  );
}

/**
 * The file limits `name` may be called with now: connected, listed now as
 * a file tool, product on; else undefined (Task-1441 P7a). A file call checks
 * this before the call and again on the answer, against the same limits.
 */
export function remoteFileLimits(name: string): RemoteFileLimits | undefined {
  const tool = known.get(name);
  return tool && "file" in tool && remoteToolDispatchable(name)
    ? tool.file
    : undefined;
}

/** Whether the link holds a published connection. */
export function remoteToolsConnected(): boolean {
  return connected;
}
